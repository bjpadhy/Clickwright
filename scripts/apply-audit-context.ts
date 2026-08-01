/**
 * Apply the 2026-08-01 data-audit findings to context_store as new versions.
 * Every entry carries source_spec='data_audit' and a change_note explaining
 * the correction. Versions are computed per entity (existing max + 1).
 *
 *   npx tsx scripts/apply-audit-context.ts           # refuses to run twice
 *   npx tsx scripts/apply-audit-context.ts --force   # deletes prior audit rows first
 */
import { command, insert, query, closeDb } from "../src/core/db.js";

const SOURCE = "data_audit";

interface AuditEntry {
  entity: string;
  definition_md: string;
  change_note: string;
}

const ENTRIES: AuditEntry[] = [
  {
    entity: "entity:application",
    change_note:
      "Corrected: base_context claimed an integer visa_issuance_eta_days column; actual column is eta_shown Nullable(String) with bucket values. Verified against ClickHouse schema + data.",
    definition_md:
      "**Application** — one visa application, identified by `application_id`. Created at the " +
      "**application_started** step, so events *before* it (card clicks, searches) carry an empty " +
      "`application_id`. Records the chosen destination, purpose, and co-traveller count. " +
      "⚠ **Correction (data-verified):** the ETA column is `eta_shown Nullable(String)` with bucket " +
      "values `'3-5 days'`, `'5-7 days'`, `'7-10 days'`, `'24 hours'` — there is **no** " +
      "`visa_issuance_eta_days` integer column. Any ETA analysis must parse these string ranges, " +
      "and note `'24 hours'` mixes units with the day buckets.",
  },
  {
    entity: "convention:sessionization",
    change_note:
      "New: base_context defines conversion per session but never names the column or its semantics. Measured from data.",
    definition_md:
      "**Sessionization (data-verified).** Every table carries `app_session_id Nullable(String)` " +
      "(0 nulls observed in base data). Measured semantics: each `application_started` row has a " +
      "UNIQUE session id (154,413 rows = 154,413 distinct sessions); downstream funnel events " +
      "reuse the session of their application (all 7,054 purchase sessions also appear in " +
      "application_started). There is no cross-journey session id. Practical consequence: " +
      "**'conversion = purchases ÷ sessions' resolves to purchases ÷ application_started rows**; " +
      "for funnel work prefer `metric:funnel_conversion` (purchases ÷ users who started an " +
      "application). Never invent sessions from timestamp gaps.",
  },
  {
    entity: "convention:data_hygiene",
    change_note:
      "New: dedup/backfill mechanics were undocumented in base_context. Semantics and impact measured from data.",
    definition_md:
      "**Data hygiene — apply to EVERY query on EVERY table.** " +
      "(1) **Duplicates:** `duplicate_id Nullable(String)` — a non-null value means the row IS a " +
      "duplicate copy. The referenced id does not resolve to any surviving row (0/4,756 in " +
      "application_started), so never join on it; simply filter `duplicate_id IS NULL`. ~3% of rows. " +
      "(2) **Backfill:** exclude `is_back_filled = 1` (~2% of rows). " +
      "(3) Measured impact on purchase_completed: 7,054 raw → 6,715 clean (**−4.8%**) — any metric " +
      "computed without both filters is ~5% wrong. " +
      "(4) **OS trap:** `os` is NULL on ~18% of android rows in the base tables, and appears as " +
      "empty string `''` in ndjson-loaded spec tables — always bucket " +
      "`os IS NULL OR os = ''` as `'unknown'`.",
  },
  {
    entity: "convention:envelope",
    change_note:
      "New: base_context described the envelope as 'device, os, geo, app version, session, timestamps'; actual envelope is ~30 columns with messy values. Enumerated from live schema + data.",
    definition_md:
      "**Common envelope — ~30 columns shared by all event tables (data-verified).** " +
      "Identity/time: `id UUID`, `timestamp DateTime` (second precision), `user_id String` " +
      "(28 chars, never null), `application_id Nullable(String)`, `app_session_id Nullable(String)`. " +
      "Device: `device`, `device_type` — exact values `'ios'`, `'android'`, `'web-user-b2c'`, " +
      "`'Desktop'` (inconsistent casing; `'web-user-b2c'` + `'Desktop'` together form the web " +
      "cohort); `os` — values `'iOS'`, `'Android'`, `'Windows'`, `'Mac OS X'`, `'Linux'`, NULL " +
      "(see convention:data_hygiene); `app_version`, `client_lib` (`mobile-rn`/`web-js`). " +
      "Geo: `geoip_country_code`, `geoip_subdivision_1_code`, `city`, `client_ip`, `latitude`, " +
      "`longitude`, `locale`, `language`. " +
      "Journey: `funnel_type` — values `'b2c'` (~86%), `'b2c_afc'` (~10%), `'b2c_black'` (~4%); " +
      "`co_travelers UInt8`; `citizenship` (lowercase ISO-2 **plus literal `'other'`**); " +
      "`destination` (UPPERCASE ISO-2). " +
      "Flags: `is_guest`, `is_referral`, `is_enterprise`, `is_guest_browse` (destination_card_clicked only). " +
      "Acquisition: `gclid` (~22% present ⇒ paid search), `fbclid` (~10%), `gad_source`. " +
      "Hygiene: `is_back_filled`, `duplicate_id`.",
  },
  {
    entity: "table:document_uploaded",
    change_note:
      "Enriched: base_context omitted scan_mode and failed_attempt_threshold columns. Verified against live schema.",
    definition_md:
      "**`document_uploaded`** — funnel event table. Emitted when: passport image submitted. " +
      "Event-specific columns: `doc_type`, `capture_mode`, `scan_mode`, `retry_count UInt8`, " +
      "`failed_attempt_threshold UInt8`, `is_crossed_failed_attempt_threshold UInt8` (the " +
      "capture-quality proxy — see metric:passport_capture_pass_rate). Common envelope plus these. " +
      "Joins on `user_id` and `application_id` (application_id always present here).",
  },
  {
    entity: "table:purchase_completed",
    change_note:
      "Enriched: base_context omitted coupon_name, discount_amount, insurance_added, plan_selected. Coupon values enumerated from data.",
    definition_md:
      "**`purchase_completed`** — funnel event table, the **conversion** event. Emitted when: " +
      "payment succeeds. Event-specific columns: `value Float64` (revenue, in `currency` — 9 " +
      "currencies observed, avg INR ≈ 5,035 vs avg USD ≈ 44: NEVER aggregate value across " +
      "currencies without grouping), `currency`, `coupon_applied UInt8`, `coupon_name` — observed " +
      "values `SUMMER20`, `ATLYS15`, `WELCOME`, `FIRST10` —, `discount_amount Float64`, " +
      "`insurance_added UInt8`, `insurance_amount Float64`, `plan_selected`. Common envelope plus " +
      "these. Joins on `user_id` and `application_id` (always present here).",
  },
  {
    entity: "known_issue:K2",
    change_note:
      "Upgraded from 'being monitored' to confirmed + quantified: Android capture-failure rate measured monthly, escalating 6%→33.5% Jan→Jun.",
    definition_md:
      "**K2 — Passport scan model update (Apr 2026) — CONFIRMED & ESCALATING (data-verified).** " +
      "Android `is_crossed_failed_attempt_threshold` rate by month: Jan 6.0% → Feb 9.7% → Mar 8.5% " +
      "→ Apr 11.7% → **May 23.4% → Jun 33.5%**, while iOS holds flat at ~8–10%. This is the " +
      "strongest anomaly in the base data. When capture/upload metrics look bad on Android, " +
      "attribute to K2 before hypothesising anything new.",
  },
  {
    entity: "known_issue:K1",
    change_note:
      "Added analysis hint: K1 is not visible in monthly os-level aggregates; requires app_version and/or geo cuts. Prevents false refutation.",
    definition_md:
      "**K1 — iOS WebKit OTP autofill regression.** On recent iOS builds the payment OTP field " +
      "fails to autofill, and some users abandon at the pay step. Payment-heavy geos (Gulf card " +
      "users) are most exposed. Watch `pay_now_clicked → purchase_completed` for iOS. " +
      "**Analysis hint (data-verified):** NOT visible in monthly os-level aggregates — iOS " +
      "pay→purchase is flat ~25–27% Jan–Jun. If present, it surfaces only when cut by " +
      "`app_version` (recent iOS builds) and/or geo (Gulf/AED payers). Do not refute K1 from a " +
      "coarse cut.",
  },
  {
    entity: "metric:conversion_rate",
    change_note:
      "Clarified the session denominator using measured app_session_id semantics; points to funnel_conversion as the safe funnel denominator.",
    definition_md:
      "**Conversion rate** = completed purchases ÷ **sessions**. A session is a single app-open / " +
      "web visit. This is the headline number reported to leadership. " +
      "**Clarification (data-verified):** the session column is `app_session_id`; in the base data " +
      "each application_started row is its own unique session, so this denominator resolves to " +
      "application starts. For funnel analysis prefer `metric:funnel_conversion` " +
      "(purchases ÷ users who started an application). Cross-journey sessions cannot be counted " +
      "from this schema. Apply convention:data_hygiene filters before counting either side.",
  },
];

// ── main ─────────────────────────────────────────────────────────

const force = process.argv.includes("--force");

const existing = await query<{ n: string }>(
  `SELECT count() AS n FROM context_store WHERE source_spec = '${SOURCE}'`,
);
if (Number(existing[0]?.n ?? 0) > 0) {
  if (!force) {
    console.error(
      `context_store already has ${existing[0]!.n} rows from ${SOURCE}. Re-run with --force.`,
    );
    await closeDb();
    process.exit(1);
  }
  console.log("• --force: deleting prior data_audit rows");
  await command(
    `ALTER TABLE context_store DELETE WHERE source_spec = '${SOURCE}' SETTINGS mutations_sync = 2`,
  );
}

const versions = await query<{ entity: string; v: string }>(
  `SELECT entity, max(version) AS v FROM context_store GROUP BY entity`,
);
const maxVersion = new Map(versions.map((r) => [r.entity, Number(r.v)]));

const now = new Date().toISOString().replace("T", " ").replace("Z", "");
const rows = ENTRIES.map((e) => {
  const version = (maxVersion.get(e.entity) ?? 0) + 1;
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

console.log(`✓ Applied ${rows.length} audit entries:`);
for (const r of rows) console.log(`    ${r.entity} → v${r.version}`);
await closeDb();
