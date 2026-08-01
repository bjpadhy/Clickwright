/**
 * ① Instrumentation Agent — spec.md + events.ndjson → live, loaded ClickHouse tables.
 *
 * Flow: profile per event type → Context Agent (bundle + live reconciliation) →
 * LLM proposes DDL + reasoning → approval gate → execute + load + verify.
 * Any failure (parse, collision, ClickHouse error, count mismatch, human
 * rejection) is fed back verbatim to the LLM and the proposal regenerates —
 * the self-healing loop. Every attempt is traced.
 *
 * Knowledge comes ONLY from the Context Agent (getContext / reconcileWithLive).
 * The database is touched only to execute DDL and load rows.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { command, insert, rowCount } from "../core/db.js";
import { step, type Ctx } from "../core/tracing.js";
import { complete, loadPrompt, stripFences } from "../core/llm.js";
import { profileRecords, profileSummary } from "../core/profiler.js";
import { getContext, reconcileWithLive } from "./context.js";

// ── types ────────────────────────────────────────────────────────

const ProposalSchema = z.object({
  reasoning: z.string().min(1),
  tables: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_]*$/),
        event: z.string().min(1),
        purpose: z.string().min(1),
        ddl: z.string().min(1),
      }),
    )
    .min(1),
});
export type InstrumentationProposal = z.infer<typeof ProposalSchema>;

export interface Approval {
  approved: boolean;
  feedback?: string;
}
/** The human gate: approve executes the DDL byte-for-byte; reject sends the
 * feedback to the LLM as a traced regeneration. The human never edits SQL. */
export type ApprovalCallback = (
  proposal: InstrumentationProposal,
  attempt: number,
) => Promise<Approval>;

export const autoApprove: ApprovalCallback = async () => ({ approved: true });

export interface LoadedTable {
  name: string;
  event: string;
  purpose: string;
  rowsInFile: number;
  rowsLoaded: number;
}

export interface InstrumentationResult {
  reasoning: string;
  tables: LoadedTable[];
  newEnvelopeFields: string[];
  attempts: number;
}

// ── envelope knowledge (mirrors convention:envelope in the context store) ──

const ENVELOPE_FIELDS = new Set([
  "id", "timestamp", "user_id", "application_id", "app_session_id",
  "device", "device_type", "os", "app_version", "client_lib",
  "geoip_country_code", "geoip_subdivision_1_code", "city", "client_ip",
  "latitude", "longitude", "locale", "language",
  "funnel_type", "co_travelers", "citizenship", "destination",
  "is_guest", "is_referral", "is_enterprise", "is_guest_browse",
  "gclid", "fbclid", "gad_source",
  "is_back_filled", "duplicate_id",
]);

// ── helpers ──────────────────────────────────────────────────────

/** Flatten one level of nesting (payment.amount → payment_amount), drop the
 * "event" discriminator, normalize booleans to 0/1 for UInt8 columns. */
export function flattenRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (key === "event") continue;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      for (const [k2, v2] of Object.entries(val as Record<string, unknown>)) {
        out[`${key}_${k2}`] = typeof v2 === "boolean" ? Number(v2) : v2;
      }
    } else {
      out[key] = typeof val === "boolean" ? Number(val) : val;
    }
  }
  return out;
}

function groupByEvent(
  rows: Record<string, unknown>[],
): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const event = String(row["event"] ?? "unknown_event");
    if (!groups.has(event)) groups.set(event, []);
    groups.get(event)!.push(row);
  }
  return groups;
}

// ── main ─────────────────────────────────────────────────────────

const MAX_EXEC_ATTEMPTS = 3; // self-healing budget (ClickHouse/load errors)
const MAX_TOTAL_ATTEMPTS = 6; // hard cap including parse failures + rejections

export interface RunInstrumentationOptions {
  specDir: string;
  trace: Ctx;
  approve?: ApprovalCallback;
  /** Injectable LLM call — tests pass a mock; production uses complete(). */
  llm?: (parent: Ctx, name: string, prompt: string) => Promise<string>;
}

export async function runInstrumentation(
  opts: RunInstrumentationOptions,
): Promise<InstrumentationResult> {
  const approve = opts.approve ?? autoApprove;
  const llm =
    opts.llm ??
    ((parent: Ctx, name: string, prompt: string) =>
      complete(parent, name, prompt, { maxTokens: 8000 }));

  return step(opts.trace, "instrumentation", { specDir: opts.specDir }, async (span) => {
    const spec = await readFile(path.join(opts.specDir, "spec.md"), "utf-8");
    const raw = await readFile(path.join(opts.specDir, "events.ndjson"), "utf-8");
    const rows = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // ── profile (pure code) ──
    const groups = groupByEvent(rows);
    const { profileText, newFields } = await step(
      span,
      "profile",
      { rows: rows.length, events: [...groups.keys()] },
      async () => {
        const sections: string[] = [];
        const fresh = new Set<string>();
        for (const [event, records] of groups) {
          const flat = records.map(flattenRow);
          const p = profileRecords(flat, event);
          sections.push(`### event: ${event} (${records.length} rows)\n${profileSummary(p)}`);
          for (const f of p.fields) {
            if (!ENVELOPE_FIELDS.has(f.field)) fresh.add(f.field);
          }
        }
        return { profileText: sections.join("\n\n"), newFields: [...fresh] };
      },
    );

    // ── context via the Context Agent only ──
    const bundle = await getContext({ include: ["table"] });
    const recon = await step(span, "schema_reconciliation", {}, () =>
      reconcileWithLive(),
    );
    const reconNotes = [
      recon.documentedNotLive.length
        ? `WARNING — documented but missing from the database: ${recon.documentedNotLive.join(", ")}`
        : "",
      recon.liveNotDocumented.length
        ? `WARNING — live but undocumented: ${recon.liveNotDocumented.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    // ── generate → approve → execute → load → verify, with self-healing ──
    let feedback = "";
    let execAttempts = 0;
    const liveNames = new Set(recon.liveTables);

    for (let attempt = 1; attempt <= MAX_TOTAL_ATTEMPTS; attempt++) {
      // 1. generate
      let proposal: InstrumentationProposal;
      try {
        proposal = await step(
          span,
          `ddl_generation_attempt_${attempt}`,
          { feedback },
          async (genSpan) => {
            const prompt = await loadPrompt("ddl", {
              context: bundle.markdown,
              live_tables: recon.liveTables.join(", "),
              reconciliation_notes: reconNotes,
              spec,
              profile: profileText,
              new_fields: newFields.join(", ") || "(none)",
              feedback: feedback
                ? `\n# Feedback on your previous attempt — fix this\n${feedback}\n`
                : "",
            });
            const text = await llm(genSpan, "ddl", prompt);
            const parsed = ProposalSchema.parse(JSON.parse(stripFences(text)));

            const missing = [...groups.keys()].filter(
              (e) => !parsed.tables.some((t) => t.event === e),
            );
            if (missing.length)
              throw new Error(`Proposal is missing tables for events: ${missing.join(", ")}`);
            const collisions = parsed.tables.filter((t) => liveNames.has(t.name));
            if (collisions.length)
              throw new Error(
                `Table names already exist in the database: ${collisions.map((t) => t.name).join(", ")} — choose different names`,
              );
            const unsafe = parsed.tables.filter(
              (t) => !/^\s*create\s+table\s/i.test(t.ddl),
            );
            if (unsafe.length)
              throw new Error(
                `Only single CREATE TABLE statements are allowed; offending: ${unsafe.map((t) => t.name).join(", ")}`,
              );
            return parsed;
          },
        );
      } catch (error) {
        feedback = `Your output was rejected before execution: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }

      // 2. approval gate — approve executes byte-for-byte; reject regenerates
      const approval = await step(
        span,
        `approval_attempt_${attempt}`,
        { tables: proposal.tables.map((t) => t.name) },
        () => approve(proposal, attempt),
      );
      if (!approval.approved) {
        feedback = `A human reviewer rejected the proposal: ${approval.feedback ?? "no reason given"}`;
        continue;
      }

      // 3. execute + load + verify — any error rolls back this attempt's tables
      const created: string[] = [];
      try {
        const loaded = await step(
          span,
          `ddl_execution_attempt_${attempt}`,
          { tables: proposal.tables.map((t) => t.name) },
          async () => {
            const results: LoadedTable[] = [];
            for (const table of proposal.tables) {
              await command(table.ddl);
              created.push(table.name);
            }
            for (const table of proposal.tables) {
              const records = groups.get(table.event) ?? [];
              const flat = records.map(flattenRow);
              for (let i = 0; i < flat.length; i += 5000) {
                await insert(table.name, flat.slice(i, i + 5000));
              }
              const loadedCount = await rowCount(table.name);
              if (loadedCount !== records.length) {
                throw new Error(
                  `Row count mismatch for ${table.name}: file has ${records.length}, table has ${loadedCount}`,
                );
              }
              results.push({
                name: table.name,
                event: table.event,
                purpose: table.purpose,
                rowsInFile: records.length,
                rowsLoaded: loadedCount,
              });
            }
            return results;
          },
        );

        return {
          reasoning: proposal.reasoning,
          tables: loaded,
          newEnvelopeFields: newFields,
          attempts: attempt,
        };
      } catch (error) {
        for (const name of created.reverse()) {
          await command(`DROP TABLE IF EXISTS ${name}`).catch(() => {});
        }
        execAttempts++;
        if (execAttempts >= MAX_EXEC_ATTEMPTS) throw error;
        feedback = `Executing your DDL (or loading data into it) failed with this ClickHouse error — fix the DDL accordingly:\n${error instanceof Error ? error.message : String(error)}`;
      }
    }

    throw new Error(
      `Instrumentation gave up after ${MAX_TOTAL_ATTEMPTS} attempts. Last feedback: ${feedback}`,
    );
  });
}
