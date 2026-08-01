/**
 * Targeted reset of one or more specs. Thin wrapper over src/core/reset.ts so
 * there is exactly one implementation of "what is safe to drop".
 *
 *   npx tsx scripts/reset-spec.ts 01_express_checkout
 *   npx tsx scripts/reset-spec.ts --all-specs
 *   npx tsx scripts/reset-spec.ts --orphans
 *
 * For a full reset (including run history and chat) use `npm run reset -- --all`.
 */
import { closeDb } from "../src/core/db.js";
import { instrumentedSpecs, isProtectedSource, resetSpecs, sweepOrphans } from "../src/core/reset.js";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: reset-spec.ts <specName...> | --all-specs | --orphans");
  process.exit(1);
}

if (args.includes("--all-specs") || args.includes("--orphans")) {
  const orphans = await sweepOrphans();
  for (const t of orphans.dropped) console.log(`✓ dropped orphan ${t}`);
  for (const t of orphans.skipped) console.log(`• kept ${t} — created by an optimization run`);
}

const named = args.filter((a) => !a.startsWith("--"));
const banned = named.filter(isProtectedSource);
if (banned.length) {
  console.error(`refusing to reset protected sources: ${banned.join(", ")}`);
  process.exit(1);
}
const specs = args.includes("--all-specs") ? await instrumentedSpecs() : named;

if (specs.length === 0) {
  console.log("no specs to reset");
} else {
  const r = await resetSpecs(specs);
  for (const t of r.droppedTables ?? []) console.log(`✓ dropped ${t}`);
  console.log(`✓ context_store ${r.contextRowsBefore} → ${r.contextRowsAfter} rows (${specs.join(", ")})`);
}
await closeDb();
