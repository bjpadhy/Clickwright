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
import { query } from "../core/db.js";
import { env } from "../core/env.js";
import { complete, loadPrompt, stripFences } from "../core/llm.js";
import type { Ctx } from "../core/tracing.js";
import { step } from "../core/tracing.js";

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
