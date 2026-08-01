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
