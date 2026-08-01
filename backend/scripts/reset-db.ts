/**
 * Reset the database to "provided data only".
 *
 *   npm run reset                  drop every spec's tables + context rows, sweep orphans
 *   npm run reset -- --runs        …and clear run history (runs_log)
 *   npm run reset -- --chat        …and clear conversations, messages, insight cache, boards
 *   npm run reset -- --all         everything above
 *   npm run reset -- --spec 01_express_checkout   just that one spec
 *   npm run reset -- --dry-run     show what would happen, change nothing
 *
 * Never touches the 8 provided event tables, and never drops an application table
 * (see PRODUCT_TABLES in src/core/reset.ts — add new ones there).
 */
import { closeDb, query } from "../src/core/db.js";
import {
  BASE_TABLES,
  PRODUCT_TABLES,
  instrumentedSpecs,
  resetSpecs,
  sweepOrphans,
  truncateProduct,
} from "../src/core/reset.js";

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const all = has("--all");
const dryRun = has("--dry-run");
const clearRuns = all || has("--runs");
const clearChat = all || has("--chat");

const specIndex = args.indexOf("--spec");
const onlySpec = specIndex !== -1 ? args[specIndex + 1] : undefined;

const specs = onlySpec ? [onlySpec] : await instrumentedSpecs();

if (dryRun) {
  console.log("DRY RUN — nothing will be changed\n");
  console.log(`specs that would be reset: ${specs.length ? specs.join(", ") : "(none)"}`);
  const live = await query<{ name: string }>(
    `SELECT name FROM system.tables WHERE database = currentDatabase() AND NOT is_temporary ORDER BY name`,
  );
  const artifacts = live
    .map((r) => r.name)
    .filter((n) => !BASE_TABLES.has(n) && !PRODUCT_TABLES.has(n) && !n.startsWith(".inner"));
  console.log(`spec tables present:       ${artifacts.length ? artifacts.join(", ") : "(none)"}`);
  console.log(`would clear runs_log:      ${clearRuns}`);
  console.log(`would clear chat + boards: ${clearChat}`);
  await closeDb();
  process.exit(0);
}

const result = await resetSpecs(specs);
for (const t of result.droppedTables ?? []) console.log(`✓ dropped ${t}`);
for (const t of result.skipped ?? []) console.log(`• skipped ${t} — protected table`);
if (specs.length) {
  console.log(
    `✓ context_store ${result.contextRowsBefore} → ${result.contextRowsAfter} rows (removed from: ${specs.join(", ")})`,
  );
}

const orphans = await sweepOrphans();
for (const t of orphans.dropped) console.log(`✓ dropped orphan ${t} — from a run that failed before documenting it`);
for (const t of orphans.skipped) console.log(`• kept ${t} — created by an optimization run, not a spec`);

if (clearRuns) {
  await truncateProduct("runs_log");
  console.log("✓ cleared runs_log (run history)");
}

if (clearChat) {
  for (const t of ["conversations", "messages", "insight_cache", "dashboards"]) {
    await truncateProduct(t);
  }
  console.log("✓ cleared conversations, messages, insight_cache, dashboards");
}

// verify, rather than assume
const live = await query<{ name: string; rows: string }>(`
  SELECT name, toString(total_rows) AS rows FROM system.tables
  WHERE database = currentDatabase() AND NOT is_temporary ORDER BY name
`);
const leftover = live
  .map((r) => r.name)
  .filter((n) => !BASE_TABLES.has(n) && !PRODUCT_TABLES.has(n) && !n.startsWith(".inner"));
const missingBase = [...BASE_TABLES].filter((b) => !live.some((r) => r.name === b));

console.log("\nfinal state:");
for (const r of live.filter((x) => BASE_TABLES.has(x.name))) {
  console.log(`  base    ${r.name.padEnd(26)} ${Number(r.rows).toLocaleString()} rows`);
}
for (const r of live.filter((x) => PRODUCT_TABLES.has(x.name))) {
  console.log(`  product ${r.name.padEnd(26)} ${Number(r.rows).toLocaleString()} rows`);
}
if (missingBase.length) {
  console.error(`\n✗ PROVIDED TABLE MISSING: ${missingBase.join(", ")}`);
  process.exitCode = 1;
} else if (leftover.length) {
  console.error(`\n✗ spec tables still present: ${leftover.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("\n✓ clean: provided data + application tables only");
}
await closeDb();
