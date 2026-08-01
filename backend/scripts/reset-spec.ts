/**
 * Roll back everything one or more spec runs produced: drop the tables the run
 * created and delete its context_store rows. Because the store is versioned and
 * append-only, deleting a run's rows automatically restores the previous
 * versions as "latest" — no restore logic needed.
 *
 *   npx tsx scripts/reset-spec.ts 01_express_checkout 02_group_family
 *   npx tsx scripts/reset-spec.ts --all-specs        # every non-seed, non-audit run
 *
 * Never touches: base tables, seed rows (base_context.md), audit rows (data_audit).
 */
import { command, query, closeDb } from "../src/core/db.js";

const PROTECTED_SOURCES = ["base_context.md", "data_audit"];

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: npx tsx scripts/reset-spec.ts <specName...> | --all-specs");
  process.exit(1);
}

let specs: string[];
if (args.includes("--all-specs")) {
  const rows = await query<{ s: string }>(`
    SELECT DISTINCT source_spec AS s FROM context_store
    WHERE source_spec NOT IN (${PROTECTED_SOURCES.map((p) => `'${p}'`).join(",")})
  `);
  specs = rows.map((r) => r.s);
} else {
  specs = args.filter((a) => !a.startsWith("--"));
  const banned = specs.filter((s) => PROTECTED_SOURCES.includes(s));
  if (banned.length) {
    console.error(`refusing to reset protected sources: ${banned.join(", ")}`);
    process.exit(1);
  }
}

if (specs.length === 0) {
  console.log("nothing to reset — no spec-run rows in context_store");
  await closeDb();
  process.exit(0);
}
const specList = specs.map((s) => `'${s}'`).join(",");

// 1. The store knows which tables each spec created
const tableRows = await query<{ entity: string }>(`
  SELECT DISTINCT entity FROM context_store
  WHERE source_spec IN (${specList}) AND entity LIKE 'table:%'
`);
const tables = tableRows.map((r) => r.entity.slice("table:".length));

for (const t of tables) {
  await command(`DROP TABLE IF EXISTS ${t}`);
  console.log(`✓ dropped table ${t}`);
}

// 2. Delete the runs' context rows — prior versions become latest again
const before = await query<{ n: string }>(`SELECT count() AS n FROM context_store`);
await command(`
  ALTER TABLE context_store DELETE WHERE source_spec IN (${specList})
  SETTINGS mutations_sync = 2
`);
const after = await query<{ n: string }>(`SELECT count() AS n FROM context_store`);
console.log(
  `✓ context_store: ${before[0]?.n} → ${after[0]?.n} rows (removed ${Number(before[0]?.n) - Number(after[0]?.n)} from: ${specs.join(", ")})`,
);

// 3. Verify the restored state
const latest = await query<{ entity: string; version: string; source_spec: string }>(`
  SELECT entity, version, source_spec FROM context_store
  ORDER BY entity ASC, version DESC LIMIT 1 BY entity
`);
const stale = latest.filter((e) => specs.includes(e.source_spec));
if (stale.length) {
  console.error(`✗ rows from reset specs still present: ${stale.map((e) => e.entity).join(", ")}`);
  process.exit(1);
}
console.log(`✓ verified: ${latest.length} entities, none sourced from the reset specs`);
await closeDb();
