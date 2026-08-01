/**
 * Project the context store's knowledge onto the 8 base tables as ClickHouse
 * COMMENTs (table-level + per-column), so humans and tools browsing the DB see
 * meaning inline. One-directional: context_store is the source of truth,
 * comments are a courtesy projection — agents never read comments as context.
 *
 *   npx tsx scripts/comment-tables.ts
 */
import { command, query, closeDb } from "../src/core/db.js";
import { env } from "../src/core/env.js";

// ── shared envelope column comments (data-verified, see convention:envelope) ──

const ENVELOPE: Record<string, string> = {
  id: "Event UUID. Tables are ordered by id first (legacy event-SDK template) — never filter by it",
  timestamp: "Event time, second precision",
  user_id: "28-char traveller id; never null; the top-of-funnel join key across all tables",
  application_id: "Visa application id; empty/null before application_started (card clicks, searches); the join key after",
  app_session_id: "Session id; unique per application_started row, reused by that application's downstream funnel events",
  device: "Device model string",
  device_type: "Values: ios, android, web-user-b2c, Desktop (inconsistent casing; web-user-b2c + Desktop = web cohort)",
  os: "Values: iOS, Android, Windows, Mac OS X, Linux. NULL on ~18% of android rows — bucket NULL/'' as 'unknown'",
  app_version: "Client app version, e.g. 7.45.2",
  client_lib: "Event SDK: mobile-rn | web-js",
  geoip_country_code: "User country from GeoIP, uppercase ISO-2",
  geoip_subdivision_1_code: "User region/state from GeoIP",
  city: "User city from GeoIP",
  client_ip: "Client IP address",
  latitude: "GeoIP latitude",
  longitude: "GeoIP longitude",
  locale: "Client locale",
  language: "Client language",
  funnel_type: "Values: b2c (~86%), b2c_afc (~10%), b2c_black (~4%)",
  co_travelers: "Number of co-travellers on the application",
  is_guest: "1 = guest (not logged in)",
  is_referral: "1 = arrived via referral",
  is_enterprise: "1 = enterprise/B2B user",
  is_guest_browse: "1 = guest browsing mode (destination_card_clicked only)",
  gclid: "Google Ads click id; present (~22%) => paid search acquisition",
  fbclid: "Facebook click id; present (~10%) => paid social acquisition",
  gad_source: "Google Ads source parameter",
  citizenship: "Traveller citizenship, lowercase ISO-2 — plus literal value 'other'",
  destination: "Destination country, UPPERCASE ISO-2",
  is_back_filled: "HYGIENE: 1 = backfilled row — exclude from every metric (is_back_filled != 1)",
  duplicate_id: "HYGIENE: non-null => this row IS a duplicate copy — filter duplicate_id IS NULL. The referenced id resolves to no row; never join on it",
};

// ── per-table: table comment + event-specific column comments ──

const TABLES: Record<string, { comment: string; columns: Record<string, string> }> = {
  destination_card_clicked: {
    comment:
      "Funnel step 1/4: user taps a destination card. ~85% of rows have empty application_id (no application exists yet) — join on user_id. Filter duplicate_id IS NULL AND is_back_filled != 1. Source: base event stream; documented in context_store.",
    columns: {
      visa_type: "Visa type shown on the card",
      card_type: "Card variant shown",
      page_version: "Landing page version",
      flow: "Product flow the click came from",
    },
  },
  application_started: {
    comment:
      "Funnel step 2/4: user starts a visa application. Creates application_id; every row is its own unique app_session_id (the practical 'sessions' denominator for conversion). Filter duplicate_id IS NULL AND is_back_filled != 1. Documented in context_store.",
    columns: {
      purpose: "Trip purpose",
      eta_shown: "Predicted turnaround shown to user — STRING buckets: '3-5 days', '5-7 days', '7-10 days', '24 hours' (mixes units; parse before math). There is no integer eta column",
      flow: "Product flow the application started from",
    },
  },
  document_uploaded: {
    comment:
      "Funnel step 3/4: passport image submitted (KYC). Capture quality proxy: is_crossed_failed_attempt_threshold. WARNING K2: Android threshold-crossing rate escalated 6%→33.5% Jan→Jun 2026 (scan model update). Filter duplicate_id IS NULL AND is_back_filled != 1. Documented in context_store.",
    columns: {
      doc_type: "Document type (passport)",
      capture_mode: "How the image was captured",
      scan_mode: "Scanner mode used",
      retry_count: "Capture retries before success",
      failed_attempt_threshold: "Threshold configured for failed captures",
      is_crossed_failed_attempt_threshold: "1 = user crossed the failed-capture threshold — capture-quality failure proxy (see metric passport_capture_pass_rate)",
    },
  },
  purchase_completed: {
    comment:
      "Funnel step 4/4 — THE CONVERSION EVENT: payment succeeded. Revenue = value in currency (9 currencies, avg INR≈5035 vs USD≈44 — NEVER sum value across currencies without grouping). Filter duplicate_id IS NULL AND is_back_filled != 1 (raw 7054 → clean 6715). Documented in context_store.",
    columns: {
      value: "Revenue amount, denominated in `currency` — never aggregate across currencies",
      currency: "ISO currency of value (INR, AED, USD, GBP, AUD, SAR, QAR, OMR, SGD)",
      coupon_applied: "1 = a coupon was applied",
      coupon_name: "Coupon code: SUMMER20 (K6 campaign), ATLYS15, WELCOME, FIRST10",
      discount_amount: "Discount applied, in `currency`",
      insurance_added: "1 = travel insurance added",
      insurance_amount: "Insurance amount, in `currency`",
      plan_selected: "Plan/tier selected at purchase",
    },
  },
  search_typed: {
    comment:
      "Supporting event: user types a destination search. Engagement noise for funnel math unless a question needs it. ~85% empty application_id — join on user_id. Filter duplicate_id IS NULL AND is_back_filled != 1.",
    columns: {
      search_term: "What the user typed",
      results_count: "Number of results returned",
      source: "Where the search was initiated",
    },
  },
  landing_page_scrolled: {
    comment:
      "Supporting event: user scrolls a landing page. Engagement noise for funnel math unless a question needs it. ~85% empty application_id — join on user_id. Filter duplicate_id IS NULL AND is_back_filled != 1.",
    columns: {
      scroll_depth_pct: "Max scroll depth reached, percent",
      time_on_page_s: "Time on page, seconds",
      page_version: "Landing page version",
    },
  },
  auth_completed: {
    comment:
      "Supporting event: user finishes login/signup. ~16% empty application_id (auth may precede an application) — join on user_id. Filter duplicate_id IS NULL AND is_back_filled != 1.",
    columns: {
      auth_method: "Authentication method used",
      is_new_user: "1 = first-time signup",
      attempts: "Auth attempts before success",
    },
  },
  pay_now_clicked: {
    comment:
      "Supporting event: user taps Pay Now at checkout (intent, not conversion — purchase_completed is conversion). WARNING K1: iOS OTP autofill regression may suppress pay→purchase on recent iOS builds; only visible cut by app_version and/or Gulf geos. Filter duplicate_id IS NULL AND is_back_filled != 1.",
    columns: {
      payment_method: "Payment method chosen",
      amount: "Amount at pay-now, in `currency` — never sum across currencies",
      currency: "ISO currency of amount",
      coupon_applied: "1 = a coupon was applied",
      plan_selected: "Plan/tier selected",
    },
  },
};

// ── apply ────────────────────────────────────────────────────────

const liveCols = await query<{ table: string; name: string }>(`
  SELECT table, name FROM system.columns
  WHERE database = '${env.clickhouse.database}'
`);
const colsByTable = new Map<string, Set<string>>();
for (const r of liveCols) {
  if (!colsByTable.has(r.table)) colsByTable.set(r.table, new Set());
  colsByTable.get(r.table)!.add(r.name);
}

const esc = (s: string) => s.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

let tablesDone = 0;
let colsDone = 0;
for (const [table, spec] of Object.entries(TABLES)) {
  const live = colsByTable.get(table);
  if (!live) {
    console.warn(`! ${table} not found in database — skipped`);
    continue;
  }

  await command(`ALTER TABLE ${table} MODIFY COMMENT '${esc(spec.comment)}'`);
  tablesDone++;

  const comments: Record<string, string> = { ...ENVELOPE, ...spec.columns };
  const clauses = Object.entries(comments)
    .filter(([col]) => live.has(col))
    .map(([col, text]) => `COMMENT COLUMN ${col} '${esc(text)}'`);
  await command(`ALTER TABLE ${table} ${clauses.join(", ")}`);
  colsDone += clauses.length;
  console.log(`✓ ${table}: table comment + ${clauses.length} column comments`);
}

// context_store gets a comment too — it is the store being projected
await command(
  `ALTER TABLE context_store MODIFY COMMENT '${esc(
    "Clickwright versioned knowledge store. Append-only; reads resolve latest version per entity (ORDER BY version DESC LIMIT 1 BY entity). Source of truth for all agent context — table/column comments elsewhere are projections of this store.",
  )}'`,
);

console.log(`\nDone: ${tablesDone} tables, ${colsDone} column comments applied.`);
await closeDb();
