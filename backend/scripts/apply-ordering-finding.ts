/**
 * Record the event-ordering trap the Analytics Agent surfaced (Q3's caveat about
 * negative elapsed times) and that was then verified directly against the base
 * tables. base_context.md claims funnel order follows timestamp ascending within
 * an application; measurement says that holds for only ~half the rows.
 *
 *   npx tsx scripts/apply-ordering-finding.ts [--force]
 */
import { command, insert, query, closeDb } from "../src/core/db.js";

const SOURCE = "data_audit_ordering";

const ENTRIES = [
  {
    entity: "convention:event_ordering",
    change_note:
      "New: measured that ~48% of downstream funnel events precede their upstream event within the same application — timestamps do not encode funnel order.",
    definition_md:
      "**Event ordering is NOT reliable — measured, contradicts base_context §6/§7.** " +
      "Within a single `application_id`, downstream events frequently carry EARLIER timestamps " +
      "than their upstream events. Verified counts: `purchase_completed` precedes the first " +
      "`pay_now_clicked` in **3,034 of 6,393 applications (47.5%)**; precedes `document_uploaded` " +
      "in **3,371 of 7,054 (47.8%)**; `document_uploaded` precedes `application_started` in " +
      "**923 of 20,446 (4.5%)**. " +
      "Consequences: (1) **never compute durations** between two funnel events on the base tables " +
      "(`dateDiff` yields large negative averages — e.g. web cohorts at −190s to −253s); " +
      "(2) **do not use `windowFunnel`/`sequenceMatch` with a time window** on these tables, and " +
      "do not require timestamp ordering in funnel logic; " +
      "(3) count funnel stages as **set membership** — `uniqExact(user_id)` or `uniqExact(application_id)` " +
      "reaching each stage within the reporting window — not as time-ordered sequences. " +
      "Spec-created tables (e.g. the express_checkout_* family) are internally consistent enough for " +
      "sub-step latency fields the client itself measured (`payment_latency_ms`), but cross-table " +
      "elapsed times remain unsafe. Surfaced by the Analytics Agent, verified against raw data.",
  },
  {
    entity: "guide:funnel_analysis",
    change_note:
      "Corrected: removed the instruction to compute stages in timestamp order and to prefer windowFunnel — measurement shows ordering is unreliable (see convention:event_ordering).",
    definition_md:
      "- Compute step counts as `uniq(user_id)` (or `application_id` past application start) per stage, " +
      "over a time window, as **set membership** — NOT in timestamp order. " +
      "⚠ **Correction (data-verified):** the previous guidance to order stages by `timestamp` and to " +
      "prefer `windowFunnel`/`sequenceMatch` is unsafe here — ~48% of applications have downstream " +
      "events timestamped before upstream ones (see `convention:event_ordering`). Use time only to " +
      "bound the reporting window, never to order stages within an application.\n" +
      "- Always cut by at least device, geo, and destination before concluding.\n" +
      "- Push aggregation into ClickHouse; interpret the aggregates, don't read raw rows.\n" +
      "- Duration/latency questions cannot be answered from cross-table timestamps; use only " +
      "client-measured latency fields where a spec provides them.",
  },
];

const force = process.argv.includes("--force");
const existing = await query<{ n: string }>(
  `SELECT count() AS n FROM context_store WHERE source_spec = {s:String}`,
  { s: SOURCE },
);
if (Number(existing[0]?.n ?? 0) > 0) {
  if (!force) {
    console.error(`already applied (${existing[0]!.n} rows). Use --force to redo.`);
    await closeDb();
    process.exit(1);
  }
  await command(
    `ALTER TABLE context_store DELETE WHERE source_spec = '${SOURCE}' SETTINGS mutations_sync = 2`,
  );
}

const versions = await query<{ entity: string; v: string }>(
  `SELECT entity, max(version) AS v FROM context_store GROUP BY entity`,
);
const maxV = new Map(versions.map((r) => [r.entity, Number(r.v)]));
const now = new Date().toISOString().replace("T", " ").replace("Z", "");

const rows = ENTRIES.map((e) => {
  const version = (maxV.get(e.entity) ?? 0) + 1;
  return {
    entry_id: `${e.entity}:v${version}`,
    entity: e.entity,
    definition_md: e.definition_md,
    version,
    updated_at: now,
    source_spec: SOURCE,
    change_note: e.change_note,
    run_id: SOURCE,
  };
});
await insert("context_store", rows);
console.log("✓ applied:");
for (const r of rows) console.log(`    ${r.entity} → v${r.version}`);
await closeDb();
