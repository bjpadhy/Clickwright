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
import { command, insert, query, rowCount } from "../core/db.js";
import { step, scoreRun, emitRunEvent, type Ctx } from "../core/tracing.js";
import { complete, loadPrompt, stripFences } from "../core/llm.js";
import { profileRecords, profileSummary, type NdjsonProfile } from "../core/profiler.js";
import {
  planTable, renderCreateTable, renderRationale, parseEventPurposes, renderTableContextEntry,
  type TablePlan,
} from "../core/ddl.js";
import { getContext, reconcileWithLive } from "./context.js";

// ── types ────────────────────────────────────────────────────────

/** Hard caps — a verbose rationale is rejected and regenerated, so the FE panel
 * always renders 1-2 tight statements per field. */
/** Length is a presentation concern — truncate, never reject a sound schema for it. */
const clamp = (n: number) => z.string().transform((v) => v.trim().slice(0, n));
const RationaleSchema = z.object({
  ordering_key: clamp(240),
  partitioning: clamp(160),
  types_codecs: clamp(340),
  deviations: clamp(240).default("").catch(""),
});

/** One concurrent call designs one table. */
const TableProposalSchema = z.object({
  table: z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    event: z.string().min(1),
    purpose: z.string().min(1).max(140, "purpose must be <= 140 chars"),
    ddl: z.string().min(1),
  }),
  rationale: RationaleSchema,
});

const ProposalSchema = z.object({
  reasoning: z.string().min(1),
  tables: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_]*$/),
        event: z.string().min(1),
        purpose: z.string().min(1),
        ddl: z.string().min(1),
        // structured per-table rationale — the FE renders this as its own panel
        rationale: RationaleSchema.optional(),
      }),
    )
    .min(1),
});
export type InstrumentationProposal = z.infer<typeof ProposalSchema>;

const DesignSchema = z.object({
  ddl: z.string().min(40),
  rationale: RationaleSchema,
});

export interface Approval {
  approved: boolean;
  feedback?: string;
  /** Who decided — written into the trace via the approval span's output. */
  identity?: string;
}
/** The human gate: approve executes the DDL byte-for-byte; reject sends the
 * feedback to the LLM as a traced regeneration. The human never edits SQL. */
export type ApprovalCallback = (
  proposal: InstrumentationProposal,
  attempt: number,
) => Promise<Approval>;

export const autoApprove: ApprovalCallback = async () => ({ approved: true });

/** Errors that retrying cannot fix — surfaced immediately instead of burning attempts. */
export class FatalInstrumentationError extends Error {}

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
  /** Ready-to-store `table:*` context entries, synthesised from measurements —
   * the Context Agent stores these verbatim instead of asking a model. */
  tableEntries: Array<{ entity: string; definition_md: string; change_note: string }>;
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
  // Collisions (top-level `payment_amount` + nested `payment.amount`) get a
  // deterministic __2 suffix. The profiler flattens with THIS same function,
  // so the LLM sees the suffixed column and the loader writes it — consistent.
  const put = (name: string, value: unknown) => {
    let key = name;
    for (let i = 2; key in out; i++) key = `${name}__${i}`;
    out[key] = typeof value === "boolean" ? Number(value) : value;
  };
  for (const [key, val] of Object.entries(row)) {
    if (key === "event") continue;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      for (const [k2, v2] of Object.entries(val as Record<string, unknown>)) {
        put(`${key}_${k2}`, v2);
      }
    } else {
      put(key, val);
    }
  }
  return out;
}

/**
 * Column names declared by a CREATE TABLE, however it is formatted. Splits the
 * top-level column list on depth-zero commas (so Enum8('a' = 1, 'b' = 2) and
 * CODEC(Delta(8), ZSTD(1)) stay intact) and takes each item's leading identifier.
 * INDEX / CONSTRAINT / PROJECTION clauses are skipped.
 */
export function parseDeclaredColumns(ddl: string): string[] {
  const open = ddl.indexOf("(");
  if (open === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < ddl.length; i++) {
    const ch = ddl[i];
    if (ch === "'") {
      // skip a string literal, honouring '' escapes
      i++;
      while (i < ddl.length && !(ddl[i] === "'" && ddl[i + 1] !== "'")) {
        if (ddl[i] === "'" && ddl[i + 1] === "'") i++;
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return [];

  const body = ddl.slice(open + 1, end);
  const items: string[] = [];
  let buf = "";
  depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "'") {
      buf += ch;
      i++;
      while (i < body.length && !(body[i] === "'" && body[i + 1] !== "'")) {
        if (body[i] === "'" && body[i + 1] === "'") { buf += body[i]; i++; }
        buf += body[i];
        i++;
      }
      buf += body[i] ?? "";
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { items.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) items.push(buf);

  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item || /^(index|constraint|projection|primary\s+key)\b/i.test(item)) continue;
    const m = /^`?([a-z_][a-z0-9_]*)`?\s/i.exec(item);
    if (m?.[1]) out.push(m[1]);
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

const MAX_TABLE_TRIES = 3; // per-table self-heal budget (parallel generation)
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
    const specName = path.basename(opts.specDir.replace(/\/+$/, ""));
    const tablePlans = new Map<string, TablePlan>();
    const spec = await readFile(path.join(opts.specDir, "spec.md"), "utf-8");
    const raw = await readFile(path.join(opts.specDir, "events.ndjson"), "utf-8");
    const rows = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    // ── profile (pure code) ──
    const groups = groupByEvent(rows);
    const eventProfiles = new Map<string, string>();
    const eventNewFields = new Map<string, string[]>();
    const eventProfileData = new Map<string, NdjsonProfile>();
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
          eventProfileData.set(event, p);
          const section = `### event: ${event} (${records.length} rows)\n${profileSummary(p)}`;
          sections.push(section);
          eventProfiles.set(event, section);
          const perEvent = p.fields.filter((f) => !ENVELOPE_FIELDS.has(f.field)).map((f) => f.field);
          eventNewFields.set(event, perEvent);
          for (const f of perEvent) fresh.add(f);
        }
        return { profileText: sections.join("\n\n"), newFields: [...fresh] };
      },
    );

    // ── context via the Context Agent only ──
    // independent reads — the store and the live schema do not depend on each other
    const [bundle, recon] = await Promise.all([
      step(span, "context_load", {}, async () => {
        const b = await getContext({
          core: ["convention", "join_map"],
          include: ["table"],
          brief: ["table"],
          require: ["convention:envelope", "convention:data_hygiene", "join_map:core"],
        });
        const byCat = new Map<string, number>();
        for (const e of b.entries) {
          const cat = e.entity.split(":")[0] ?? "";
          byCat.set(cat, (byCat.get(cat) ?? 0) + 1);
        }
        return Object.assign(b, {
          summary: {
            entities: b.entries.length,
            byCategory: Object.fromEntries(byCat),
            updatedEntries: b.entries
              .filter((e) => e.version > 1)
              .map((e) => `${e.entity} v${e.version}`),
          },
        });
      }),
      step(span, "schema_reconciliation", {}, () => reconcileWithLive()),
    ]);

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
      // 1. generate — ONE CALL PER EVENT, CONCURRENTLY. Output tokens dominate
      //    latency, so N smaller parallel generations beat one big sequential
      //    one (~5x on a 5-event spec). Each table dry-runs and self-heals on
      //    its own; siblings are unaffected.
      let proposal: InstrumentationProposal;
      try {
        proposal = await step(
          span,
          `ddl_generation_attempt_${attempt}`,
          { feedback, events: [...groups.keys()], mode: "deterministic+purposes" },
          async (genSpan) => {
            // 1. Schemas are SYNTHESISED IN CODE from the measured profile: type
            //    choice, LowCardinality, ordering key and partitioning are all
            //    arithmetic on stats, so there is nothing for a model to get
            //    wrong — and it costs no tokens and no time.
            const plans = await step(genSpan, "ddl_synthesis", {}, async () => {
              const out = new Map<string, ReturnType<typeof planTable>>();
              for (const [event] of groups) {
                const profile = eventProfileData.get(event);
                if (!profile) throw new Error(`no profile for ${event}`);
                const plan = planTable(event, profile);
                if (liveNames.has(plan.name))
                  // Synthesis is deterministic: retrying produces the identical
                  // plan, so a collision is terminal. Say what to do about it.
                  throw new FatalInstrumentationError(
                    `table \`${plan.name}\` already exists — this spec appears to be instrumented already. ` +
                      `Reset it first: npx tsx scripts/reset-spec.ts ${specName}`,
                  );
                out.set(event, plan);
                tablePlans.set(event, plan);
              }
              return out;
            }).then((m) => m as Map<string, ReturnType<typeof planTable>>);

            // 2. Purposes come from the spec itself — the PM already described every
            //    event. Only events the spec failed to describe need a model.
            const parsed = parseEventPurposes(spec);
            const purposes: Record<string, string> = {};
            for (const [event, desc] of parsed) purposes[event] = desc;

            // 3. A ClickHouse engineer designs each table FROM the measured facts:
            //    codecs, Enum8 vs LowCardinality, ordering-key order for pruning.
            //    Code validated the arithmetic; this is the judgement that earns the
            //    marks. Per table, concurrent, with the deterministic plan as both
            //    the starting point and the fallback if a design is rejected.
            const tables = await Promise.all(
              [...plans.entries()].map(([event, plan]) =>
                step(genSpan, `design_${event}`, { event }, async (dSpan) => {
                  const purpose =
                    purposes[event]?.slice(0, 140) ?? `${event} events for this feature`;
                  const baseline = renderCreateTable(plan, purpose);
                  const expected = new Set(plan.columns.map((c) => c.name));
                  let designFeedback = feedback;
                  let lastDdl = "";

                  for (let tryN = 1; tryN <= MAX_TABLE_TRIES; tryN++) {
                    try {
                      const prompt = await loadPrompt("instrument_design_table", {
                        event,
                        profile: eventProfiles.get(event) ?? "",
                        baseline,
                        spec,
                        conventions: reconNotes
                          ? `${bundle.markdown}\n\n## Live-schema warnings\n${reconNotes}`
                          : bundle.markdown,
                        feedback: designFeedback
                          ? `\n<feedback>\nYour previous design was rejected: ${designFeedback}\n</feedback>\n`
                          : "",
                      });
                      const text = await llm(dSpan, `design_${event}`, prompt);
                      const design = DesignSchema.parse(JSON.parse(stripFences(text)));
                      // a trailing semicolon is idiomatic, not an error — strip it,
                      // then reject only a genuine second statement
                      const ddl = design.ddl.trim().replace(/;+\s*$/, "");
                      lastDdl = ddl;

                      if (!/^create\s+table\s/i.test(ddl))
                        throw new Error("must be a single CREATE TABLE statement");
                      // a ';' inside a quoted COMMENT is legal SQL — strip string
                      // literals before looking for a genuine second statement
                      if (ddl.replace(/'(?:[^']|'')*'/g, "''").includes(";"))
                        throw new Error("only one statement allowed (found a second statement)");
                      if (!new RegExp(`create\\s+table\\s+\`?${event}\`?[\\s(]`, "i").test(ddl))
                        throw new Error(`the table must be named ${event}`);
                      // every measured field must survive, and nothing invented.
                      // Parse the column list for real: a line-anchored backtick
                      // regex misses a single-line DDL or unbackticked names, which
                      // would silently reject every design and fall back to baseline.
                      const declared = new Set(parseDeclaredColumns(ddl));
                      const dropped = [...expected].filter((c) => !declared.has(c));
                      if (dropped.length)
                        throw new Error(`these measured columns are missing: ${dropped.join(", ")}`);
                      const invented = [...declared].filter((c) => !expected.has(c));
                      if (invented.length)
                        throw new Error(`these columns are not in the profile: ${invented.join(", ")}`);
                      await command(`EXPLAIN AST ${ddl}`); // ClickHouse must parse it

                      return { name: event, event, purpose, ddl, rationale: design.rationale };
                    } catch (error) {
                      designFeedback = error instanceof Error ? error.message : String(error);
                      emitRunEvent({
                        type: "log",
                        name: "design_rejected",
                        payload: {
                          event,
                          attempt: tryN,
                          reason: designFeedback.slice(0, 300),
                          // the offending SQL, or a rejection is undiagnosable
                          ddl: lastDdl.slice(0, 1200),
                        },
                      });
                    }
                  }

                  // every design attempt failed — ship the deterministic schema
                  emitRunEvent({
                    type: "log",
                    name: "design_fallback",
                    payload: { event, note: "using the deterministic baseline schema" },
                  });
                  return {
                    name: event,
                    event,
                    purpose,
                    ddl: baseline,
                    rationale: renderRationale(plan),
                  };
                }),
              ),
            );

            // 3. Dry-run every statement — cheap, and proves the synthesis.
            await step(genSpan, "dry_run", { tables: tables.map((t) => t.name) }, async () => {
              for (const t of tables) await command(`EXPLAIN AST ${t.ddl}`);
              return { passed: tables.length };
            });

            return ProposalSchema.parse({
              reasoning: tables
                .map(
                  (t) =>
                    `## ${t.name}\n- **Ordering key** — ${t.rationale.ordering_key}\n- **Partitioning** — ${t.rationale.partitioning}\n- **Types & codecs** — ${t.rationale.types_codecs}${t.rationale.deviations ? `\n- **Deviations & flags** — ${t.rationale.deviations}` : ""}`,
                )
                .join("\n\n"),
              tables,
            });
          },
        );
      } catch (error) {
        if (error instanceof FatalInstrumentationError) throw error;
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
              const t0 = Date.now();
              await command(table.ddl);
              created.push(table.name);
              emitRunEvent({
                type: "log",
                name: "ddl_statement",
                payload: { statement: `CREATE TABLE ${table.name}`, ok: true, ms: Date.now() - t0 },
              });
            }
            for (const table of proposal.tables) {
              const t0 = Date.now();
              const records = groups.get(table.event) ?? [];
              const flat = records.map(flattenRow);
              for (let i = 0; i < flat.length; i += 5000) {
                await insert(table.name, flat.slice(i, i + 5000));
              }
              const loadedCount = await rowCount(table.name);
              emitRunEvent({
                type: "log",
                name: "data_load",
                payload: { table: table.name, rows: loadedCount, ok: loadedCount === records.length, ms: Date.now() - t0 },
              });
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

        scoreRun(span, "self_heal_attempts", attempt,
          attempt === 1 ? "clean first attempt" : `${attempt - 1} failed attempt(s) healed`);
        scoreRun(span, "rows_verified", 1,
          `${loaded.reduce((s, t) => s + t.rowsLoaded, 0)} rows, counts match file`);
        return {
          reasoning: proposal.reasoning,
          tables: loaded,
          newEnvelopeFields: newFields,
          attempts: attempt,
          tableEntries: loaded.map((t) => {
            const plan = tablePlans.get(t.event);
            const executed = proposal.tables.find((x) => x.name === t.name);
            // Document the schema that RAN, not the baseline: the designer is told
            // to reorder the key for pruning, so the baseline's join key and
            // ordering would be wrong in the store the analytics agent reads.
            if (plan && executed) {
              const orderBy = /ORDER BY \(([^)]+)\)/i.exec(executed.ddl)?.[1];
              if (orderBy) {
                const cols = orderBy.split(",").map((c) => c.trim().replace(/`/g, ""));
                plan.orderBy = cols;
              }
            }
            return {
              entity: `table:${t.name}`,
              definition_md: plan
                ? renderTableContextEntry(plan, t.purpose, specName)
                : `**\`${t.name}\`** — ${t.purpose}`,
              change_note: `New table from spec ${specName}; documented from measured profile (${t.rowsLoaded} rows).`,
            };
          }),
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
