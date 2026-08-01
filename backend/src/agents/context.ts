/**
 * ② Context Agent — read side.
 *
 * getContext() assembles a prompt-ready markdown bundle from context_store:
 *   - core entries (overview, conventions, join map, guide) are ALWAYS included
 *   - `include` adds whole categories: ["table", "metric"] or ["*"] for everything
 *   - `topic` additionally pulls any entry whose text matches the search terms
 *
 * Reads always resolve latest version per entity. One ClickHouse round-trip per
 * run: the latest-version snapshot is cached in-process; updateContext() must
 * call invalidateContextCache() after writing.
 */
import { z } from "zod";
import { query, insert } from "../core/db.js";
import { env } from "../core/env.js";
import { complete, loadPrompt, stripFences } from "../core/llm.js";
import type { Ctx } from "../core/tracing.js";
import { step, scoreRun } from "../core/tracing.js";

export interface ContextEntry {
  entity: string;
  definition_md: string;
  version: number;
  source_spec: string;
  change_note: string;
}

export interface ContextBundle {
  /** Prompt-ready markdown, grouped by category with version annotations. */
  markdown: string;
  /** The selected entries, for tracing (entity → version). */
  entries: ContextEntry[];
}

/** Categories included in every bundle regardless of `include`. */
const CORE_PREFIXES = ["overview", "convention", "join_map", "guide"];

/** Render order and human headings for the markdown bundle. */
const CATEGORY_HEADINGS: [string, string][] = [
  ["overview", "Business overview"],
  ["convention", "Conventions (follow these in every query)"],
  ["join_map", "Join map"],
  ["guide", "Analysis guide"],
  ["entity", "Entity definitions"],
  ["table", "Tables (existing — base + spec-created)"],
  ["metric", "Metric definitions (current)"],
  ["known_issue", "Known issues"],
];

let cache: ContextEntry[] | null = null;

export function invalidateContextCache(): void {
  cache = null;
}

async function latestEntries(): Promise<ContextEntry[]> {
  cache ??= await query<ContextEntry>(`
    SELECT entity, definition_md, toUInt32(version) AS version, source_spec, change_note
    FROM context_store
    ORDER BY entity ASC, version DESC
    LIMIT 1 BY entity
  `);
  return cache;
}

function category(entity: string): string {
  return entity.split(":")[0] ?? entity;
}

export interface GetContextOptions {
  /** Category prefixes to include beyond the core, e.g. ["table", "metric"]. "*" = everything. */
  include?: string[];
  /** Free-text lookup: pulls entries whose entity or text matches any term (>2 chars). */
  topic?: string;
}

export async function getContext(
  opts: GetContextOptions = {},
): Promise<ContextBundle> {
  const all = await latestEntries();
  const selected = new Map<string, ContextEntry>();

  for (const e of all) {
    if (CORE_PREFIXES.includes(category(e.entity))) selected.set(e.entity, e);
  }

  for (const inc of opts.include ?? []) {
    if (inc === "*") {
      for (const e of all) selected.set(e.entity, e);
    } else {
      for (const e of all) {
        if (category(e.entity) === inc) selected.set(e.entity, e);
      }
    }
  }

  if (opts.topic) {
    const terms = opts.topic
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
    for (const e of all) {
      const hay = `${e.entity} ${e.definition_md}`.toLowerCase();
      if (terms.some((t) => hay.includes(t))) selected.set(e.entity, e);
    }
  }

  const entries = [...selected.values()];
  const parts: string[] = [];
  for (const [cat, heading] of CATEGORY_HEADINGS) {
    const group = entries
      .filter((e) => category(e.entity) === cat)
      .sort((a, b) => a.entity.localeCompare(b.entity));
    if (group.length === 0) continue;
    parts.push(`## ${heading}`);
    for (const e of group) {
      const src = e.version > 1 ? `, updated by ${e.source_spec}` : "";
      parts.push(`${e.definition_md}\n*[${e.entity} v${e.version}${src}]*`);
    }
  }

  return { markdown: parts.join("\n\n"), entries };
}

// ── write side: updateContext (pipeline step ②) ──────────────────
// ONLY callable from the instrumentation flow — enforced structurally: it
// requires the instrumentation result as input, which only the pipeline has.
// Analytics reads context (getContext/lookupContext); it never writes.
// LLM proposes entry content; code enforces completeness, namespaces, and all
// bookkeeping (versions, run_id, timestamps). Human approval gates the write.

const UpdateProposalSchema = z.object({
  entries: z
    .array(
      z.object({
        entity: z
          .string()
          .regex(
            /^(table|spec|metric|funnel|entity|convention|known_issue):[a-z0-9_]+$/i,
          ),
        definition_md: z.string().min(20),
        change_note: z.string().min(5),
      }),
    )
    .min(1),
  /** One-liners where new findings contradict existing context — the UI's "contradiction surfaced" chip. */
  warnings: z.array(z.string()).optional(),
});
export type ContextUpdateProposal = z.infer<typeof UpdateProposalSchema>;

export interface ContextApproval {
  approved: boolean;
  feedback?: string;
  /** Who decided — written into the trace via the approval span's output. */
  identity?: string;
}
export type ContextApprovalCallback = (
  proposal: ContextUpdateProposal,
  attempt: number,
) => Promise<ContextApproval>;
export const autoApproveContext: ContextApprovalCallback = async () => ({
  approved: true,
});

export interface ContextUpdateInput {
  specName: string; // e.g. "01_express_checkout"
  specText: string;
  runId: string;
  instrumentation: {
    reasoning: string;
    newEnvelopeFields: string[];
    tables: { name: string; event: string; purpose: string; rowsLoaded: number }[];
  };
}

const TABLES_SCOPE =
  "ONLY the `table:<name>` entries — one per created table. Emit no other namespaces in this response.";
const REST_SCOPE =
  "ONLY the non-table entries: the `spec:<name>` summary, any new `metric:`/`funnel:`/`entity:` definitions, " +
  "and updated versions of existing `convention:`/`known_issue:` entries. Do NOT emit any `table:` entries.";

const MAX_UPDATE_ATTEMPTS = 5;

export interface ContextUpdateResult {
  entries: ContextEntry[];
  /** Contradictions between new findings and existing context — surfaced, never hidden. */
  warnings: string[];
}

export async function updateContext(
  input: ContextUpdateInput,
  trace: Ctx,
  opts: {
    approve?: ContextApprovalCallback;
    llm?: (parent: Ctx, name: string, prompt: string) => Promise<string>;
  } = {},
): Promise<ContextUpdateResult> {
  const approve = opts.approve ?? autoApproveContext;
  const llm =
    opts.llm ??
    ((p: Ctx, n: string, prompt: string) =>
      complete(p, n, prompt, { maxTokens: 8000 }));

  return step(trace, "context_update", { spec: input.specName }, async (span) => {
    const current = await getContext({ include: ["*"] });
    const existingEntities = new Set(current.entries.map((e) => e.entity));
    const createdTables = new Set(input.instrumentation.tables.map((t) => t.name));

    const tablesSummary = input.instrumentation.tables
      .map((t) => `- ${t.name} (event: ${t.event}, ${t.rowsLoaded} rows loaded): ${t.purpose}`)
      .join("\n");

    let feedback = "";
    for (let attempt = 1; attempt <= MAX_UPDATE_ATTEMPTS; attempt++) {
      // 1. generate + validate
      let proposal: ContextUpdateProposal;
      try {
        proposal = await step(
          span,
          `update_generation_attempt_${attempt}`,
          { feedback },
          async (genSpan) => {
            // Two concurrent halves — table docs vs feature/metric/convention
            // knowledge. Output tokens dominate latency, so splitting the
            // generation roughly halves this step's wall clock.
            const vars = {
              context: current.markdown,
              spec: input.specText,
              tables_summary: tablesSummary,
              new_fields: input.instrumentation.newEnvelopeFields.join(", ") || "(none)",
              reasoning: input.instrumentation.reasoning,
              feedback: feedback
                ? `\n# Feedback on your previous attempt — fix this\n${feedback}\n`
                : "",
            };
            const [tablesText, restText] = await Promise.all([
              loadPrompt("context_update", { ...vars, scope: TABLES_SCOPE }).then((p) =>
                llm(genSpan, "context_update_tables", p),
              ),
              loadPrompt("context_update", { ...vars, scope: REST_SCOPE }).then((p) =>
                llm(genSpan, "context_update_knowledge", p),
              ),
            ]);
            const half = (t: string) =>
              UpdateProposalSchema.partial({ entries: true }).parse(JSON.parse(stripFences(t)));
            const a = half(tablesText);
            const b = half(restText);
            const parsed = UpdateProposalSchema.parse({
              entries: [...(a.entries ?? []), ...(b.entries ?? [])],
              warnings: [...(a.warnings ?? []), ...(b.warnings ?? [])],
            });

            const covered = new Set(
              parsed.entries
                .filter((e) => e.entity.startsWith("table:"))
                .map((e) => e.entity.slice("table:".length)),
            );
            const missing = [...createdTables].filter((t) => !covered.has(t));
            if (missing.length)
              throw new Error(`Missing table entries for created tables: ${missing.join(", ")}`);

            const phantom = parsed.entries.filter(
              (e) =>
                e.entity.startsWith("table:") &&
                !createdTables.has(e.entity.slice("table:".length)) &&
                !existingEntities.has(e.entity),
            );
            if (phantom.length)
              throw new Error(
                `table: entries must reference created or already-documented tables; offending: ${phantom.map((e) => e.entity).join(", ")}`,
              );
            return parsed;
          },
        );
      } catch (error) {
        feedback = `Your output was rejected: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }

      // 2. human approval gate — reject feedback goes back to the LLM, traced
      const approval = await step(
        span,
        `update_approval_attempt_${attempt}`,
        { entities: proposal.entries.map((e) => e.entity) },
        () => approve(proposal, attempt),
      );
      if (!approval.approved) {
        feedback = `A human reviewer rejected the proposal: ${approval.feedback ?? "no reason given"}`;
        continue;
      }

      // 3. code owns the bookkeeping: versions, run_id, timestamps, insert
      const versions = await query<{ entity: string; v: string }>(
        `SELECT entity, max(version) AS v FROM context_store GROUP BY entity`,
      );
      const maxVersion = new Map(versions.map((r) => [r.entity, Number(r.v)]));
      const now = new Date().toISOString().replace("T", " ").replace("Z", "");

      const rows = proposal.entries.map((e) => {
        const version = (maxVersion.get(e.entity) ?? 0) + 1;
        return {
          entry_id: `${e.entity}:v${version}`,
          entity: e.entity,
          definition_md: e.definition_md,
          version,
          updated_at: now,
          source_spec: input.specName,
          change_note: e.change_note,
          run_id: input.runId,
        };
      });
      await insert("context_store", rows);
      invalidateContextCache();

      scoreRun(span, "context_entries_written", rows.length);
      scoreRun(span, "context_update_attempts", attempt,
        attempt === 1 ? "clean first attempt" : `${attempt - 1} failed attempt(s) healed`);
      return {
        entries: rows.map((r) => ({
          entity: r.entity,
          definition_md: r.definition_md,
          version: r.version,
          source_spec: r.source_spec,
          change_note: r.change_note,
        })),
        warnings: proposal.warnings ?? [],
      };
    }

    throw new Error(
      `updateContext gave up after ${MAX_UPDATE_ATTEMPTS} attempts. Last feedback: ${feedback}`,
    );
  });
}

// ── smart lookup (LLM-as-retriever) ──────────────────────────────
// Mid-analysis questions ("payment failing on Apple devices?") need semantic
// retrieval, not substring matching. The LLM reads a tiny index of the whole
// store (entity + first line, ~1.5k tokens) and picks the relevant entries —
// no embeddings needed at this corpus size. Falls back to term matching if
// the LLM call fails, so a lookup can never crash an analysis.

export async function lookupContext(
  parent: Ctx,
  question: string,
  llm: (
    parent: Ctx,
    name: string,
    prompt: string,
  ) => Promise<string> = (p, n, prompt) =>
    complete(p, n, prompt, { maxTokens: 500 }),
): Promise<ContextBundle> {
  return step(parent, "context_lookup", { question }, async (span) => {
    const all = await latestEntries();
    const byEntity = new Map(all.map((e) => [e.entity, e]));

    let picked: ContextEntry[] = [];
    try {
      const index = all
        .map((e) => `${e.entity} — ${e.definition_md.split("\n")[0]?.slice(0, 160)}`)
        .join("\n");
      const prompt = await loadPrompt("context_lookup", { question, index });
      const text = await llm(span, "context_lookup", prompt);
      const ids = JSON.parse(stripFences(text)) as unknown;
      if (!Array.isArray(ids)) throw new Error("retriever did not return an array");
      picked = ids
        .filter((id): id is string => typeof id === "string")
        .slice(0, 8)
        .map((id) => byEntity.get(id))
        .filter((e): e is ContextEntry => e !== undefined);
    } catch {
      // fallback: dumb term matching — better than returning nothing
      const bundle = await getContext({ topic: question });
      picked = bundle.entries.filter(
        (e) => !CORE_PREFIXES.includes(category(e.entity)),
      );
    }

    const markdown = picked
      .map((e) => `${e.definition_md}\n*[${e.entity} v${e.version}]*`)
      .join("\n\n");
    return { markdown, entries: picked };
  });
}

// ── reconciliation service ───────────────────────────────────────
// Agents never introspect the database for knowledge; the Context Agent is the
// single component that knows both the documentation and how to verify it
// against reality. This is a safety check, not a context source.

export interface Reconciliation {
  /** Every table that exists in the database right now. */
  liveTables: string[];
  /** Documented in context_store but missing from the database (stale docs / failed run). */
  documentedNotLive: string[];
  /** Exists in the database but undocumented (manual create / half-finished run). */
  liveNotDocumented: string[];
}

const INTERNAL_TABLES = new Set(["context_store", "runs_log"]);

export async function reconcileWithLive(): Promise<Reconciliation> {
  const rows = await query<{ name: string }>(`
    SELECT name FROM system.tables
    WHERE database = '${env.clickhouse.database}' AND NOT is_temporary
  `);
  const liveTables = rows
    .map((r) => r.name)
    .filter((n) => !INTERNAL_TABLES.has(n) && !n.startsWith(".inner"));

  const documented = (await latestEntries())
    .filter((e) => category(e.entity) === "table")
    .map((e) => e.entity.slice("table:".length));

  const live = new Set(liveTables);
  const doc = new Set(documented);
  return {
    liveTables,
    documentedNotLive: documented.filter((t) => !live.has(t)),
    liveNotDocumented: liveTables.filter((t) => !doc.has(t)),
  };
}
