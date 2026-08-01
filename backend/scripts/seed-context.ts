/**
 * Seed the context_store from base_context.md — pure code, no LLM.
 *
 *   npm run seed            # seeds v1; refuses to run twice
 *   npm run seed -- --force # drops context_store and reseeds
 *
 * Entities are namespaced so getContext(topic) can filter:
 *   overview:* entity:* table:* convention:* metric:* known_issue:* join_map:* guide:*
 */
import { readFile } from "fs/promises";
import { command, insert, query, tableExists, closeDb } from "../src/core/db.js";

interface SeedEntry {
  entity: string;
  definition_md: string;
}

const SOURCE = "base_context.md";

// ── parsing ──────────────────────────────────────────────────────

function sectionBody(md: string, heading: string): string {
  const re = new RegExp(`^## \\d+\\. ${heading}\\s*$`, "m");
  const match = re.exec(md);
  if (!match) throw new Error(`Section not found in ${SOURCE}: "${heading}"`);
  const start = match.index + match[0].length;
  const rest = md.slice(start);
  const next = rest.search(/^## \d+\./m);
  return (next === -1 ? rest : rest.slice(0, next))
    .replace(/^---\s*$/gm, "")
    .trim();
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Paragraphs of the form: **Term** — definition  (or **Term** = definition) */
function boldTermParagraphs(body: string, prefix: string): SeedEntry[] {
  const entries: SeedEntry[] = [];
  for (const para of body.split(/\n\s*\n/)) {
    const m = /^\*\*(.+?)\*\*\s*(—|=)/.exec(para.trim());
    if (!m || !m[1]) continue;
    const term = m[1].replace(/\s*\(.*\)\s*$/, "").trim();
    entries.push({ entity: `${prefix}:${slugify(term)}`, definition_md: para.trim() });
  }
  return entries;
}

/** Section 3 markdown table → one entry per event table + the instrumentation note. */
function parseTables(body: string): SeedEntry[] {
  const entries: SeedEntry[] = [];
  const rowRe = /^\|\s*`(\w+)`\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(body)) !== null) {
    const [, name, kind, emitted, cols] = m;
    entries.push({
      entity: `table:${name}`,
      definition_md:
        `**\`${name}\`** — ${kind} event table. Emitted when: ${emitted}. ` +
        `Key event-specific columns: ${cols}. Common envelope (device, os, geo, ` +
        `app version, session, timestamps) plus these columns. Joins on ` +
        `\`user_id\` and \`application_id\`.`,
    });
  }
  if (entries.length !== 8) {
    throw new Error(`Expected 8 event tables in ${SOURCE}, parsed ${entries.length}`);
  }
  const note = /\*\*Instrumentation note:\*\*([\s\S]+?)$/m.exec(body);
  if (note?.[1]) {
    entries.push({
      entity: "convention:event_table_template",
      definition_md: `**Instrumentation note:**${note[1].trim()}`,
    });
  }
  return entries;
}

/** Section 5 numbered list → one entry per known issue K1..K7. */
function parseKnownIssues(body: string): SeedEntry[] {
  const entries: SeedEntry[] = [];
  const itemRe = /^\d+\.\s+\*\*(K\d+)\s*—\s*(.+?)\*\*([\s\S]*?)(?=^\d+\.\s+\*\*K|\s*$)/gm;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(body)) !== null) {
    const [, id, title, rest] = m;
    entries.push({
      entity: `known_issue:${id}`,
      definition_md: `**${id} — ${title}**${(rest ?? "").replace(/\n\s+/g, " ").trimEnd()}`,
    });
  }
  if (entries.length !== 7) {
    throw new Error(`Expected 7 known issues in ${SOURCE}, parsed ${entries.length}`);
  }
  return entries;
}

async function parseBaseContext(path: string): Promise<SeedEntry[]> {
  const md = await readFile(path, "utf-8");
  const entries: SeedEntry[] = [
    { entity: "overview:business", definition_md: sectionBody(md, "Business overview") },
    ...boldTermParagraphs(sectionBody(md, "Entity definitions"), "entity"),
    ...parseTables(sectionBody(md, "The eight raw event tables")),
    ...boldTermParagraphs(sectionBody(md, "Metric definitions"), "metric"),
    ...parseKnownIssues(sectionBody(md, "Known-issues log")),
    { entity: "join_map:core", definition_md: sectionBody(md, "Entity relationships \\(join map\\)") },
    { entity: "guide:funnel_analysis", definition_md: sectionBody(md, "How to analyse the funnel") },
  ];

  // The blockquote in §4 redefines the funnel-conversion denominator — too
  // important to leave buried inside another entry.
  const funnelNote = /> Note on funnel conversion:[\s\S]+?dashboards\./.exec(md);
  if (funnelNote) {
    entries.push({
      entity: "metric:funnel_conversion",
      definition_md: funnelNote[0].replace(/^> ?/gm, "").replace(/\n/g, " ").trim(),
    });
  }
  return entries;
}

// ── main ─────────────────────────────────────────────────────────

const force = process.argv.includes("--force");

// base_context.md lives at the repo root (shared data), one level above backend/
const entries = await parseBaseContext(
  new URL("../../base_context.md", import.meta.url).pathname,
);

if (force && (await tableExists("context_store"))) {
  console.log("• --force: dropping context_store");
  await command("DROP TABLE context_store");
}

await command(`
  CREATE TABLE IF NOT EXISTS context_store (
    entry_id      String,
    entity        String,
    definition_md String,
    version       UInt32,
    updated_at    DateTime64(3),
    source_spec   String,
    change_note   String,
    run_id        String
  ) ENGINE = MergeTree
  ORDER BY (entity, version)
`);

const seeded = await query<{ n: string }>(
  `SELECT count() AS n FROM context_store WHERE source_spec = '${SOURCE}'`,
);
if (Number(seeded[0]?.n ?? 0) > 0) {
  console.error(
    `context_store already has ${seeded[0]!.n} rows from ${SOURCE}. ` +
      `Re-run with --force to drop and reseed.`,
  );
  await closeDb();
  process.exit(1);
}

const now = new Date().toISOString().replace("T", " ").replace("Z", "");
await insert(
  "context_store",
  entries.map((e) => ({
    entry_id: `${e.entity}:v1`,
    entity: e.entity,
    definition_md: e.definition_md,
    version: 1,
    updated_at: now,
    source_spec: SOURCE,
    change_note: "initial seed from base_context.md",
    run_id: "seed",
  })),
);

console.log(`✓ Seeded ${entries.length} v1 entries into context_store:`);
for (const e of entries) console.log(`    ${e.entity}`);
await closeDb();
