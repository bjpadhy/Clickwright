/**
 * Execution-backed verification.
 *
 * A reading judge can only say whether a query LOOKS right. This one writes an
 * independent query by a different route, runs it read-only, and compares the
 * numbers — the only method here that catches "valid SQL, wrong question": a
 * mistaken denominator or a join that fanned rows out produces a real number
 * that every other check accepts.
 *
 * Disagreement is not treated as proof the original is wrong; it is proof that
 * one of the two is, which is reported honestly and drops confidence to low.
 */
import { z } from "zod";
import { queryReadonly } from "../core/db.js";
import { step, recordQuery, type Ctx } from "../core/tracing.js";
import { loadPrompt, stripFences } from "../core/llm.js";

const VerificationSchema = z.object({
  verification_sql: z.string().min(20),
  // Prose fields are truncated, never rejected: throwing away a completed
  // execution-backed comparison because its comment ran 20 characters long would
  // discard the one check that catches "valid SQL, wrong question".
  recomputes: z.string().transform((s) => s.slice(0, 160)).default(""),
  expected_to_match: z.string().default(""),
  definition_ok: z.boolean().default(true),
  answers_question: z.boolean().default(true),
  concern: z.string().transform((s) => s.slice(0, 300)).default(""),
});

export interface VerificationResult {
  /** null when no comparable figure could be produced — unknown, not "passed". */
  agreed: boolean | null;
  originalValue: number | null;
  verifiedValue: number | null;
  /** Relative difference between the two figures, when both exist. */
  relativeDelta: number | null;
  sql: string;
  recomputes: string;
  definitionOk: boolean;
  answersQuestion: boolean;
  concern: string;
  note: string;
}

/** Two figures agree when they are within 2% relatively, or 0.005 absolute for rates. */
function agrees(a: number, b: number): boolean {
  const absTol = Math.abs(a) <= 1 && Math.abs(b) <= 1 ? 0.005 : 0;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) <= Math.max(absTol, scale * 0.02);
}

export interface VerifyInput {
  question: string;
  taskTitle: string;
  taskQuestion: string;
  sql: string;
  rows: Record<string, unknown>[];
  /** Whole-result-set figures, when the result was too large to show in full.
   * These are the numbers a reader acts on, so they are what a second query
   * should have to reproduce. */
  digest: string;
  /** The same figures as values, so a verifier that targets one can be checked
   * against it — searching only the sample rows reported "inconclusive" for
   * exactly the population figures we most want verified. */
  digestRow?: Record<string, unknown>;
  definitions: string;
  schemas: string;
}

export async function verifyTask(
  parent: Ctx,
  input: VerifyInput,
  guard: (sql: string) => string,
  llm: (parent: Ctx, name: string, prompt: string) => Promise<string>,
): Promise<VerificationResult | null> {
  return step(parent, "verify", { task: input.taskTitle }, async (span) => {
    const prompt = await loadPrompt("analytics_verify_query", {
      question: input.question,
      task: `${input.taskTitle} — ${input.taskQuestion}`,
      sql: input.sql,
      result: JSON.stringify(input.rows.slice(0, 12)),
      digest: input.digest,
      definitions: input.definitions,
      schemas: input.schemas,
    });

    let plan: z.infer<typeof VerificationSchema>;
    try {
      plan = VerificationSchema.parse(JSON.parse(stripFences(await llm(span, "verify", prompt))));
    } catch (error) {
      // a verifier that cannot produce a query tells us nothing — it must not be
      // reported as agreement
      return {
        agreed: null,
        originalValue: null,
        verifiedValue: null,
        relativeDelta: null,
        sql: "",
        recomputes: "",
        definitionOk: true,
        answersQuestion: true,
        concern: "",
        note: `verification could not be written: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
      } satisfies VerificationResult;
    }

    let verifiedValue: number | null = null;
    let ran = "";
    try {
      ran = guard(plan.verification_sql);
      const rows = await queryReadonly<Record<string, unknown>>(ran);
      recordQuery(span, "verification_result", ran, rows);
      const first = rows[0];
      if (first) {
        const raw = first["verified_value"] ?? Object.values(first)[0];
        const n = Number(raw);
        if (Number.isFinite(n)) verifiedValue = n;
      }
    } catch (error) {
      return {
        agreed: null,
        originalValue: null,
        verifiedValue: null,
        relativeDelta: null,
        sql: ran,
        recomputes: plan.recomputes,
        definitionOk: plan.definition_ok,
        answersQuestion: plan.answers_question,
        concern: plan.concern,
        note: `verification query failed: ${error instanceof Error ? (error.message.split("\n")[0] ?? error.message).slice(0, 140) : String(error)}`,
      } satisfies VerificationResult;
    }

    // the figure it claims to reproduce, from the original result — the whole-set
    // profile first, since a population figure is the one worth checking
    const col = plan.expected_to_match;
    let originalValue: number | null = null;
    for (const row of [...(input.digestRow ? [input.digestRow] : []), ...input.rows]) {
      const v = Number((row as Record<string, unknown>)[col]);
      if (Number.isFinite(v)) {
        originalValue = v;
        break;
      }
    }
    if (originalValue === null && input.rows.length === 1) {
      const firstRow = input.rows[0];
      const only = firstRow
        ? Object.values(firstRow).map(Number).filter((v) => Number.isFinite(v))
        : [];
      if (only.length === 1 && only[0] !== undefined) originalValue = only[0];
    }

    if (originalValue === null || verifiedValue === null) {
      return {
        agreed: null,
        originalValue,
        verifiedValue,
        relativeDelta: null,
        sql: ran,
        recomputes: plan.recomputes,
        definitionOk: plan.definition_ok,
        answersQuestion: plan.answers_question,
        concern: plan.concern,
        note: `no comparable figure (expected_to_match="${col}") — verification inconclusive, not passed`,
      } satisfies VerificationResult;
    }

    const ok = agrees(originalValue, verifiedValue);
    const scale = Math.max(Math.abs(originalValue), Math.abs(verifiedValue), 1e-9);
    return {
      agreed: ok,
      originalValue,
      verifiedValue,
      relativeDelta: Math.abs(originalValue - verifiedValue) / scale,
      sql: ran,
      recomputes: plan.recomputes,
      definitionOk: plan.definition_ok,
      answersQuestion: plan.answers_question,
      concern: plan.concern,
      note: ok
        ? `an independently written query reproduced ${col} (${verifiedValue})`
        : `an independently written query got ${verifiedValue} where the analysis reported ${originalValue} — one of them is wrong`,
    } satisfies VerificationResult;
  });
}
