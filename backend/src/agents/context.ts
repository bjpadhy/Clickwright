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
  /** Categories collapsed to one line per entity (name + first sentence) instead of
   * full text. Big token saving when a caller only needs to know something exists. */
  brief?: string[];
  /** Core categories to include; defaults to all of them. Narrow it when a caller
   * genuinely needs only some rules (e.g. DDL needs conventions, not metrics guides). */
  core?: string[];
  /** Entities/categories the caller REQUIRES. Throws if the store cannot supply
   * them — a silent empty bundle is how prompts start hallucinating. */
  require?: string[];
}

function firstSentence(md: string): string {
  const text = md.replace(/\n+/g, " ").replace(/\*\*/g, "").trim();
  const m = /^(.{0,220}?[.;])\s/.exec(text);
  return (m?.[1] ?? text.slice(0, 220)).trim();
}

export async function getContext(
  opts: GetContextOptions = {},
): Promise<ContextBundle> {
  const all = await latestEntries();
  const selected = new Map<string, ContextEntry>();
  const coreWanted = opts.core ?? CORE_PREFIXES;

  for (const e of all) {
    if (coreWanted.includes(category(e.entity))) selected.set(e.entity, e);
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

  // Verify the bundle actually contains what the caller depends on. Failing loudly
  // here beats handing a prompt an empty section and getting invented answers.
  const missing = (opts.require ?? []).filter((req) =>
    req.includes(":")
      ? !entries.some((e) => e.entity === req)
      : !entries.some((e) => category(e.entity) === req),
  );
  if (missing.length > 0) {
    throw new Error(
      `context bundle is missing required knowledge: ${missing.join(", ")} — refusing to build a prompt without it`,
    );
  }

  const brief = new Set(opts.brief ?? []);
  const parts: string[] = [];
  for (const [cat, heading] of CATEGORY_HEADINGS) {
    const group = entries
      .filter((e) => category(e.entity) === cat)
      .sort((a, b) => a.entity.localeCompare(b.entity));
    if (group.length === 0) continue;
    if (brief.has(cat)) {
      parts.push(
        `## ${heading} (names + one-line summaries)\n` +
          group.map((e) => `- ${e.entity} v${e.version}: ${firstSentence(e.definition_md)}`).join("\n"),
      );
      continue;
    }
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

const ProposedEntrySchema = z.object({
  entity: z
    .string()
    .regex(
      /^(table|spec|metric|funnel|entity|convention|known_issue):[a-z0-9_]+$/i,
    ),
  definition_md: z.string().min(20).transform((s) => s.slice(0, 2400)),
  change_note: z.string().min(5).max(200, "change_note must be one clause <= 200 chars"),
});

/** Real contradictions only — the UI's "contradiction surfaced" chip. */
const WarningsSchema = z
  .array(z.string().max(300, "each warning must be one sentence <= 300 chars"))
  .max(3, "at most 3 warnings — only genuine contradictions")
  .optional();

const UpdateProposalSchema = z.object({
  entries: z
    .array(ProposedEntrySchema)
    .min(1)
    .max(16, "at most 16 entries per spec — emit only what genuinely changed"),
  warnings: WarningsSchema,
});

/**
 * One generation half's output, which is NOT a whole proposal.
 *
 * A half legitimately has nothing to add: CONVENTION_SCOPE tells the model
 * outright to return an empty entries array when this spec disproved nothing,
 * which is the common case. Validating a half with `.partial({entries: true})`
 * made the key optional but left the `.min(1)` floor intact, so the moment the
 * model did what it was told and sent `[]`, the parse threw `too_small` and
 * burned the whole 40-second generation. Retries could not fix it — the prompt
 * kept asking for the same empty array.
 *
 * The >=1 floor belongs on the MERGED proposal, which always carries the
 * deterministic table entries.
 */
const HalfProposalSchema = z.object({
  entries: z
    .array(ProposedEntrySchema)
    .max(16, "at most 16 entries per spec — emit only what genuinely changed")
    .optional(),
  warnings: WarningsSchema,
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
    /** Code-synthesised `table:*` entries — stored verbatim, no model needed.
     * REQUIRED: the validator demands one entry per created table, so a caller
     * that omits these would fail at runtime after minutes of work. */
    tableEntries: Array<{ entity: string; definition_md: string; change_note: string }>;
  };
}

/** Two independent halves — generated concurrently because neither needs the other,
 * and output tokens are what cost wall-clock. Quality is unaffected: each call sees
 * the same context and is responsible for a disjoint set of entities. */
const FEATURE_SCOPE =
  "ONLY these: the `spec:<name>` summary, and any new `metric:` / `funnel:` / `entity:` " +
  "definitions this feature's questions require. Emit NO `table:`, `convention:` or " +
  "`known_issue:` entries and NO warnings — another reviewer owns those.";
const CONVENTION_SCOPE =
  "ONLY these: updated versions of EXISTING `convention:` / `known_issue:` entries that " +
  "this spec has proven something new about, plus the `warnings` array for genuine " +
  "contradictions. Emit NO `table:`, `spec:`, `metric:`, `funnel:` or `entity:` entries. " +
  "If nothing existing was disproven, return an empty entries array.";

const MAX_UPDATE_ATTEMPTS = 3;

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
  // The feature half typically produces 200-500 tokens (a spec summary + 1-3
  // metric definitions). 3000 is generous; 8000 was burning output budget on
  // thinking tokens that dominate wall-clock.
  const llm =
    opts.llm ??
    ((p: Ctx, n: string, prompt: string) =>
      complete(p, n, prompt, { maxTokens: 3000 }));

  return step(trace, "context_update", { spec: input.specName }, async (span) => {
    // The updater must know what already exists (to avoid duplicates) but only
    // needs FULL text of the entries it might revise — conventions and known
    // issues. Everything else goes in as one-liners.
    // The feature half needs to see existing entries to avoid duplicates, but
    // conventions in FULL are irrelevant to it (it never emits conventions).
    // Brief everything for the feature half — smaller prompt, same awareness.
    const current = await getContext({
      include: ["*"],
      brief: ["table", "metric", "funnel", "entity", "spec", "overview", "guide"],
      require: ["convention:envelope", "convention:data_hygiene"],
    });
    // Feature half context: same entries but ALL categories are brief (including
    // conventions). This preserves the overview and structure the LLM needs to
    // write a meaningful spec summary while cutting convention prose.
    const featureContextMd = current.entries
      .map((e) => {
        const cat = e.entity.split(":")[0] ?? "";
        // Conventions → one-liner only; everything else → already brief from current
        if (cat === "convention" || cat === "known_issue" || cat === "join_map" || cat === "guide") {
          const first = e.definition_md.replace(/\n+/g, " ").replace(/\*\*/g, "").trim();
          const m = /^(.{0,160}?[.;])\s/.exec(first);
          return `- ${e.entity} v${e.version}: ${(m?.[1] ?? first.slice(0, 160)).trim()}`;
        }
        return `- ${e.entity} v${e.version}: ${e.definition_md.split("\n")[0]?.slice(0, 160) ?? ""}`;
      })
      .join("\n");
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
              context: "", // overridden per-half with tailored context
              spec: input.specText,
              tables_summary: tablesSummary,
              new_fields: input.instrumentation.newEnvelopeFields.join(", ") || "(none)",
              // only the deviation lines matter here — the codec/ordering prose is
              // for the human reviewing the DDL gate, not for documenting meaning
              reasoning:
                input.instrumentation.reasoning
                  .split("\n")
                  .filter((l) => /Deviations|##/.test(l))
                  .join("\n") || "(no deviations flagged)",
              feedback: feedback
                ? `\n# Feedback on your previous attempt — fix this\n${feedback}\n`
                : "",
            };
            // Table docs are already synthesised from measurements — storing them
            // verbatim removes half this step's generation. The model is left with
            // the part that genuinely needs judgement: the feature summary, the
            // metrics its questions require, and contradictions with the store.
            const deterministic = input.instrumentation.tableEntries;
            const tableEntriesText = deterministic.length
              ? deterministic.map((e) => `- ${e.entity}: ${e.definition_md}`).join("\n")
              : "(none — emit table: entries yourself)";

            // Two disjoint halves, generated CONCURRENTLY. Neither needs the other's
            // output and each owns a distinct set of entities, so splitting halves the
            // wall clock (output tokens dominate) without changing what is produced.
            const half = (scope: string, callName: string, contextMd: string) =>
              loadPrompt("context_write_knowledge", {
                ...vars,
                context: contextMd,
                scope,
                table_entries: tableEntriesText,
              })
                .then((prompt) => llm(genSpan, callName, prompt))
                .then((text) => HalfProposalSchema.parse(JSON.parse(stripFences(text))));

            // The conventions half exists to catch contradictions between the new
            // spec and existing conventions. When instrumentation flagged no
            // deviations AND no new envelope fields appeared, there is nothing to
            // contradict — skip the call entirely (~50% wall-clock saving).
            const hasDeviations = vars.reasoning !== "(no deviations flagged)";
            const hasNewFields = input.instrumentation.newEnvelopeFields.length > 0;
            const needsConventionReview = hasDeviations || hasNewFields;

            const [feature, conventions] = await Promise.all([
              // Feature half: small context (just existing metrics/specs/entities)
              half(FEATURE_SCOPE, "context_write_feature", featureContextMd),
              needsConventionReview
                // Conventions half: full context (needs convention text to check contradictions)
                ? half(CONVENTION_SCOPE, "context_write_conventions", current.markdown)
                : Promise.resolve({ entries: [] as z.infer<typeof UpdateProposalSchema>["entries"], warnings: [] as string[] }),
            ]);
            const parsed = UpdateProposalSchema.parse({
              entries: [
                ...deterministic,
                ...(feature.entries ?? []),
                ...(conventions.entries ?? []),
              ],
              warnings: conventions.warnings ?? [],
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
      // current.entries already contains every entity's latest version (fetched
      // via getContext({ include: ["*"] }) above) — no need for another round-trip.
      const maxVersion = new Map(current.entries.map((e) => [e.entity, e.version]));
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
      const prompt = await loadPrompt("context_retrieve_relevant", { question, index });
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

/** The application's own storage — not event data, so it must never appear as
 * "live but undocumented" in a reconciliation warning (that noise makes the DDL
 * agent think it should document or avoid them). */
const INTERNAL_TABLES = new Set([
  "context_store", "runs_log", "conversations", "messages", "dashboards",
  "optimization_suggestions", "schema_changelog", "trace_summaries",
]);

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
