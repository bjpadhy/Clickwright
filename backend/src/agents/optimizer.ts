/**
 * Optimizer agent — turns an approved optimization suggestion into DDL and
 * executes it, behind the same human gate as instrumentation.
 *
 * This is the only agent in the pipeline that mutates existing schema, so the
 * statement whitelist below is a hard safety boundary, not a lint: it runs BEFORE
 * the human sees anything, so a confused model or a prompt-injected suggestion
 * cannot put a DROP in front of a reviewer who is clicking approve quickly.
 *
 * The human never edits SQL — approve executes byte-for-byte, reject sends the
 * feedback back to the model, exactly like the DDL gate.
 */
import { z } from "zod";
import { command } from "../core/db.js";
import { complete, loadPrompt, stripFences } from "../core/llm.js";
import { step, type Ctx } from "../core/tracing.js";
import type { Suggestion } from "../observe/advisor.js";

const ProposalSchema = z.object({
  reasoning: z.string().min(1),
  statements: z.array(z.string().min(1)).min(1).max(4),
  /** What the operator should see change, in plain terms. */
  expectedEffect: z.string().min(1),
});
export type OptimizationProposal = z.infer<typeof ProposalSchema>;

export interface OptimizationApproval {
  approved: boolean;
  feedback?: string;
  identity?: string;
}
export type OptimizationApprovalCallback = (
  proposal: OptimizationProposal,
  attempt: number,
) => Promise<OptimizationApproval>;

export interface OptimizationResult {
  reasoning: string;
  statements: string[];
  expectedEffect: string;
  attempts: number;
}

/**
 * Statement forms the optimizer is allowed to emit. Anything else — DROP, DELETE,
 * TRUNCATE, RENAME, INSERT, a mutation, or several statements crammed into one
 * string — is rejected before the approval gate.
 */
const ALLOWED: Array<{ label: string; pattern: RegExp }> = [
  { label: "ALTER TABLE … MODIFY TTL", pattern: /^alter\s+table\s+[\w.`"]+\s+modify\s+ttl\s+/i },
  {
    label: "ALTER TABLE … ADD COLUMN",
    pattern: /^alter\s+table\s+[\w.`"]+\s+add\s+column\s+/i,
  },
  {
    label: "ALTER TABLE … MODIFY COLUMN",
    pattern: /^alter\s+table\s+[\w.`"]+\s+modify\s+column\s+/i,
  },
  {
    label: "CREATE MATERIALIZED VIEW",
    pattern: /^create\s+materialized\s+view\s+(if\s+not\s+exists\s+)?[\w.`"]+/i,
  },
  { label: "OPTIMIZE TABLE", pattern: /^optimize\s+table\s+[\w.`"]+/i },
];

/** Forms that must never appear, even nested inside an otherwise-allowed statement. */
const FORBIDDEN = /\b(drop|truncate|rename|attach|detach|delete\s+where|insert\s+into|grant|revoke|system\s+)\b/i;

export function assertSafeStatement(raw: string): void {
  const sql = raw.trim().replace(/;+\s*$/, "").trim();

  if (sql.length === 0) throw new Error("Empty statement.");

  // A trailing semicolon is stripped above; anything left means multiple
  // statements smuggled into one string.
  if (sql.includes(";")) {
    throw new Error(
      `Only one statement per array entry is allowed; found several in: ${sql.slice(0, 80)}…`,
    );
  }

  const allowed = ALLOWED.find((form) => form.pattern.test(sql));
  if (!allowed) {
    throw new Error(
      `Statement form is not permitted. Allowed forms: ${ALLOWED.map((a) => a.label).join(", ")}. ` +
        `Offending statement: ${sql.slice(0, 120)}`,
    );
  }

  // CREATE MATERIALIZED VIEW legitimately contains a SELECT; the forbidden list
  // is checked against the whole statement so "CREATE MV … AS SELECT … ; DROP"
  // style payloads and "ALTER … DELETE WHERE" mutations are both caught.
  if (FORBIDDEN.test(sql)) {
    const match = FORBIDDEN.exec(sql);
    throw new Error(
      `Statement contains the forbidden keyword "${match?.[0]?.trim()}": ${sql.slice(0, 120)}`,
    );
  }
}

export function assertSafeProposal(proposal: OptimizationProposal): void {
  for (const statement of proposal.statements) assertSafeStatement(statement);
}

const MAX_ATTEMPTS = 4;

export interface RunOptimizationOptions {
  suggestion: Suggestion;
  trace: Ctx;
  approve: OptimizationApprovalCallback;
  llm?: (parent: Ctx, name: string, prompt: string) => Promise<string>;
  schemaContext: string;
}

export async function runOptimization(
  opts: RunOptimizationOptions,
): Promise<OptimizationResult> {
  const llm =
    opts.llm ??
    ((parent: Ctx, name: string, prompt: string) =>
      complete(parent, name, prompt, { maxTokens: 3000 }));

  return step(
    opts.trace,
    "optimization",
    { suggestion: opts.suggestion.action, target: opts.suggestion.targetTable },
    async (span) => {
      let feedback = "";

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let proposal: OptimizationProposal;
        try {
          proposal = await step(
            span,
            `optimization_generation_attempt_${attempt}`,
            { feedback },
            async (genSpan) => {
              const prompt = await loadPrompt("optimization_ddl", {
                action: opts.suggestion.action,
                why: opts.suggestion.why,
                target_table: opts.suggestion.targetTable ?? "(none)",
                schema: opts.schemaContext,
                feedback: feedback
                  ? `\n# Feedback on your previous attempt — fix this\n${feedback}\n`
                  : "",
              });
              const text = await llm(genSpan, "optimization_ddl", prompt);
              const parsed = ProposalSchema.parse(JSON.parse(stripFences(text)));
              assertSafeProposal(parsed);
              return parsed;
            },
          );
        } catch (error) {
          feedback = `Your output was rejected before review: ${error instanceof Error ? error.message : String(error)}`;
          continue;
        }

        const approval = await step(
          span,
          `optimization_approval_attempt_${attempt}`,
          { statements: proposal.statements },
          () => opts.approve(proposal, attempt),
        );
        if (!approval.approved) {
          feedback = `A human reviewer rejected the proposal: ${approval.feedback ?? "no reason given"}`;
          continue;
        }

        await step(
          span,
          `optimization_execution_attempt_${attempt}`,
          { statements: proposal.statements },
          async () => {
            for (const statement of proposal.statements) {
              // Re-checked immediately before execution: the gate approved these
              // exact strings, and nothing may reach command() unvalidated.
              assertSafeStatement(statement);
              await command(statement);
            }
            return { executed: proposal.statements.length };
          },
        );

        return {
          reasoning: proposal.reasoning,
          statements: proposal.statements,
          expectedEffect: proposal.expectedEffect,
          attempts: attempt,
        };
      }

      throw new Error(
        `Optimization gave up after ${MAX_ATTEMPTS} attempts. Last feedback: ${feedback}`,
      );
    },
  );
}
