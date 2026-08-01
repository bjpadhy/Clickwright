/**
 * Seed data for the mock backend.
 *
 * Every string here is fixture content standing in for what a real
 * Instrumentation / Context / Analytics Agent would return. When the backend
 * lands, this file goes away — nothing outside `src/mock` imports it.
 */

import type {
  Answer,
  AnswerKey,
  ChangelogEntry,
  Conversation,
  Dashboard,
  HistoryEntry,
  RunRecord,
  Series,
  Spec,
  SpecId,
  SpecStatus,
  Trace,
} from "@/api/types"

export const SPECS: Record<SpecId, Spec> = {
  ec: {
    id: "ec",
    file: "express_checkout.md",
    name: "Express Checkout",
    events: "6 event types · 412,908 sampled events",
  },
  ve: {
    id: "ve",
    file: "visa_eta_widget.md",
    name: "Visa ETA Widget",
    events: "4 event types · 118,204 sampled events",
  },
  rf: {
    id: "rf",
    file: "referral_credits.md",
    name: "Referral Credits",
    events: "5 event types · 88,410 sampled events",
  },
  wa: {
    id: "wa",
    file: "whatsapp_status_alerts.md",
    name: "WhatsApp Status Alerts",
    events: "6 event types · 96,882 sampled events",
  },
  tp: {
    id: "tp",
    file: "saved_traveller_profiles.md",
    name: "Saved Traveller Profiles",
    events: "4 event types · 61,240 sampled events",
  },
}

/** Specs a user can actually run from the "New spec" screen. */
export const RUNNABLE_SPECS: SpecId[] = ["ec", "ve", "rf"]

export const RUNS: Record<SpecId, RunRecord> = {
  ec: {
    specId: "ec",
    brief:
      "PM brief: replace the 3-step pay flow with one tap for returning users. OTP is auto-filled from SMS where the OS allows it. Success metric: checkout completion. Guardrail: payment failure rate. Rollout: 50% of returning users, all destinations.",
    ndjson: [
      '{"event":"checkout_shown","user_id":88123401,"application_id":504420,"platform":"ios","region":"AE","ts":"2026-08-01T06:14:02.113Z"}',
      '{"event":"otp_sent","user_id":88123401,"provider":"twilio","sender_id":"ATLYS-OTP","ts":"2026-08-01T06:14:09.402Z"}',
      '{"event":"success","user_id":88123401,"amount_usd":118.00,"method":"upi_saved","latency_ms":11240,"ts":"2026-08-01T06:14:21.900Z"}',
    ],
    log: [
      {
        icon: "ti-book-2",
        tone: "info",
        text: "Loaded base_context v1.3 — 3 entities, 14 metric definitions, 6 known issues",
      },
      {
        icon: "ti-table",
        tone: "info",
        text: "Inspected 10 live tables via system.columns + 90d of system.query_log — shared keys: user_id UInt64, application_id UInt64",
      },
      {
        icon: "ti-file-text",
        tone: "info",
        text: "Parsed spec — 6 event types; sampled 400 raw NDJSON events, inferred types and null rates",
      },
      {
        icon: "ti-binary",
        tone: "info",
        text: "otp_latency_ms p99 = 41,203 → UInt32 + T64 codec · amounts → Decimal(10,2), never Float · session_id 0% null → UUID",
      },
      {
        icon: "ti-key",
        tone: "info",
        text: "Scored 4 ordering-key candidates against historical query patterns → (event_type, platform, event_time, user_id) wins, pruning score 0.87",
      },
      {
        icon: "ti-alert-triangle",
        tone: "warn",
        text: 'Naming conflict: spec calls the final event "success" but the funnel convention is "completed" — normalized, flagged for the Context Agent',
      },
      {
        icon: "ti-circle-check",
        tone: "ok",
        text: "Dry-run passed on staging clone — 2 statements ready for human review",
      },
    ],
    revisionLog: {
      icon: "ti-pencil",
      tone: "ok",
      text: "Reviewer note applied — TTL extended 18 → 24 MONTH · re-validated on staging clone",
    },
    ddl: `CREATE TABLE atlys.express_checkout_events
(
    event_time      DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    event_type      LowCardinality(String),  -- shown|opted_in|otp_sent|otp_filled|completed|fallback
    user_id         UInt64,
    application_id  UInt64,
    session_id      UUID,
    destination     LowCardinality(String),
    platform        Enum8('ios' = 1, 'android' = 2, 'web' = 3),
    region          LowCardinality(String),
    payment_method  LowCardinality(String),
    otp_latency_ms  UInt32 CODEC(T64, ZSTD(1)),
    amount_usd      Decimal(10, 2),
    is_fallback     Bool,
    attrs           Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (event_type, platform, event_time, user_id)
TTL toDateTime(event_time) + INTERVAL 18 MONTH  -- per base_context §data-retention
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW atlys.mv_express_checkout_daily
ENGINE = AggregatingMergeTree
ORDER BY (day, platform, region)
AS SELECT
    toDate(event_time) AS day, platform, region,
    uniqState(user_id) AS shown_users,
    uniqStateIf(user_id, event_type = 'completed') AS completed_users,
    avgIfState(otp_latency_ms, event_type = 'otp_filled') AS otp_ms
FROM atlys.express_checkout_events
GROUP BY day, platform, region;`,
    rationale: [
      {
        icon: "ti-key",
        title: "Ordering key",
        text: "(event_type, platform, event_time, user_id) — low-cardinality prefix first: matches 87% of WHERE patterns mined from 90d of system.query_log; time third for range scans inside pruned granules.",
      },
      {
        icon: "ti-calendar",
        title: "Partitioning",
        text: "toYYYYMM — ~14M rows/month projected keeps parts merge-friendly, and TTL can drop whole partitions for free.",
      },
      {
        icon: "ti-binary",
        title: "Types & codecs",
        text: "Enum8 + LowCardinality for segments; Decimal(10,2) for money; T64+ZSTD on latency measured 4.1× compression in the dry-run.",
      },
      {
        icon: "ti-clock",
        title: "TTL",
        text: "18 months, per the retention policy in base_context §data-retention — surfaced to the reviewer rather than assumed.",
      },
    ],
    mv: {
      name: "mv_express_checkout_daily · AggregatingMergeTree",
      note: "Earns its keep: the PM funnel dashboard reads ~2k pre-aggregated rows instead of scanning 14M events per load.",
    },
    exec: [
      "CREATE TABLE atlys.express_checkout_events — OK (0.41s)",
      "CREATE MATERIALIZED VIEW atlys.mv_express_checkout_daily — OK (0.18s)",
      "Backfill: 412,908 events from specs/express_checkout.ndjson — OK (2.9s)",
      "Smoke: count() = 412,908 · uniq(user_id) = 96,412 · parts = 3 — OK",
    ],
    diff: [
      {
        sign: "+",
        text: "entity: express_checkout_session — one per application_id per attempt; joins funnel on user_id",
      },
      {
        sign: "+",
        text: "metric: express_checkout_conversion = uniq(completed) / uniq(shown), cut by platform × region",
      },
      {
        sign: "~",
        text: "metric: checkout_conversion — now excludes the express path (was: all pay_now_clicked)",
      },
      {
        sign: "+",
        text: "known issue link: iOS WebKit OTP autofill ↔ express_checkout_events.is_fallback",
      },
    ],
    warn: 'base_context v1.3 measures "conversion" from application_started; spec §2 measures from checkout_shown. Both definitions kept under scoped names — the Analytics Agent will cite which one it uses.',
    trace: { id: "tr_ec_7f31", tokens: "3,412", cost: "$0.048", duration: "12.4s + human" },
    contextTrace: { id: "tr_cx_9a02", tokens: "2,207", cost: "$0.027", duration: "2.1s" },
    table: "atlys.express_checkout_events",
    mvShort: "mv_express_checkout_daily",
    backfill: "412,908 events backfilled",
    durations: ["1.2s", "6.4s", "human", "3.6s", "2.1s"],
    changelogTable: "express_checkout_events + 1 MV created",
    changelogContext:
      "+2 metrics, +1 entity, 1 contradiction surfaced (conversion definition)",
  },

  ve: {
    specId: "ve",
    brief:
      "PM brief: show a live “visa in X days” prediction on every destination page, with a confidence band. Success metric: widget → application CTR. The prediction engine is the core product promise — accuracy telemetry matters.",
    ndjson: [
      '{"event":"eta_shown","user_id":90233114,"destination":"th","predicted_days":4,"band":"high","ts":"2026-08-01T09:02:44.001Z"}',
      '{"event":"cta_clicked","user_id":90233114,"destination":"th","platform":"android","ts":"2026-08-01T09:03:01.220Z"}',
    ],
    log: [
      {
        icon: "ti-book-2",
        tone: "info",
        text: "Loaded latest base_context — reusing entity destination and metric prediction_accuracy",
      },
      {
        icon: "ti-file-text",
        tone: "info",
        text: "Spec declares 4 event types; sampled 280 NDJSON events — predicted_days ≤ 90 → UInt16",
      },
      {
        icon: "ti-key",
        tone: "info",
        text: "PM brief §3 slices everything by destination first → destination leads the ordering key",
      },
      {
        icon: "ti-clock",
        tone: "info",
        text: "No money fields; widget telemetry, not financial record → 12-month TTL",
      },
      {
        icon: "ti-circle-check",
        tone: "ok",
        text: "Dry-run passed on staging clone — 2 statements ready for human review",
      },
    ],
    revisionLog: {
      icon: "ti-pencil",
      tone: "ok",
      text: "Reviewer note applied — re-validated on staging clone",
    },
    ddl: `CREATE TABLE atlys.visa_eta_widget_events
(
    event_time      DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    event_type      LowCardinality(String),  -- viewed|expanded|eta_shown|cta_clicked
    user_id         UInt64,
    destination     LowCardinality(String),
    predicted_days  UInt16,
    confidence_band Enum8('high' = 1, 'medium' = 2, 'low' = 3),
    platform        Enum8('ios' = 1, 'android' = 2, 'web' = 3),
    attrs           Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (destination, event_type, event_time)
TTL toDateTime(event_time) + INTERVAL 12 MONTH;

CREATE MATERIALIZED VIEW atlys.mv_eta_accuracy_daily
ENGINE = AggregatingMergeTree
ORDER BY (day, destination)
AS SELECT
    toDate(event_time) AS day, destination,
    avgState(predicted_days) AS avg_eta,
    uniqState(user_id)       AS viewers
FROM atlys.visa_eta_widget_events
GROUP BY day, destination;`,
    rationale: [
      {
        icon: "ti-key",
        title: "Ordering key",
        text: "destination leads — every PM question about this widget slices by destination first (brief §3). Not a copy-paste of the funnel key.",
      },
      {
        icon: "ti-calendar",
        title: "Partitioning",
        text: "toYYYYMM — low volume (~4M/mo); monthly parts stay small and mergeable.",
      },
      {
        icon: "ti-binary",
        title: "Types",
        text: "UInt16 fits ≤90-day ETAs; Enum8 for confidence bands and platform.",
      },
      {
        icon: "ti-clock",
        title: "TTL",
        text: "12 months — telemetry, not a financial record; shorter retention is cheaper and sufficient.",
      },
    ],
    mv: {
      name: "mv_eta_accuracy_daily · AggregatingMergeTree",
      note: "Feeds the accuracy-vs-actual dashboard; joins later against purchase_completed on destination + day.",
    },
    exec: [
      "CREATE TABLE atlys.visa_eta_widget_events — OK (0.29s)",
      "CREATE MATERIALIZED VIEW atlys.mv_eta_accuracy_daily — OK (0.12s)",
      "Backfill: 118,204 events from specs/visa_eta_widget.ndjson — OK (1.1s)",
      "Smoke: count() = 118,204 · uniq(user_id) = 41,209 — OK",
    ],
    diff: [
      {
        sign: "+",
        text: "entity: eta_widget_session — widget impressions grouped per user per destination page view",
      },
      {
        sign: "+",
        text: "metric: eta_ctr = uniq(cta_clicked) / uniq(viewed), cut by destination × band",
      },
    ],
    warn: "Gap found: base_context has no freshness SLA for prediction_accuracy even though the widget shows it live. Added as an open TODO for the data team.",
    trace: { id: "tr_ve_2c11", tokens: "2,644", cost: "$0.031", duration: "9.8s + human" },
    contextTrace: { id: "tr_cx_5b77", tokens: "1,902", cost: "$0.022", duration: "1.8s" },
    table: "atlys.visa_eta_widget_events",
    mvShort: "mv_eta_accuracy_daily",
    backfill: "118,204 events backfilled",
    durations: ["0.9s", "5.1s", "human", "2.2s", "1.8s"],
    changelogTable: "visa_eta_widget_events + 1 MV created",
    changelogContext: "+1 metric, +1 entity, 1 gap flagged (accuracy freshness SLA)",
  },

  rf: {
    specId: "rf",
    brief:
      "PM brief: give ₹500, get ₹500. Referral links travel over WhatsApp, plain links and QR at airports. Success metric: k-factor. Guardrail: credit fraud — finance wants referrer-level lookups for audits.",
    ndjson: [
      '{"event":"invite_sent","referrer_user_id":77120944,"channel":"whatsapp","ts":"2026-08-01T08:41:12.551Z"}',
      '{"event":"credit_earned","referrer_user_id":77120944,"referee_user_id":90441280,"amount_inr":500.00,"ts":"2026-08-01T10:02:19.008Z"}',
    ],
    log: [
      {
        icon: "ti-book-2",
        tone: "info",
        text: "Loaded latest base_context — no referral entities exist yet; designing from scratch",
      },
      {
        icon: "ti-binary",
        tone: "info",
        text: "5 event types; referee unknown until signup → referee_user_id UInt64 DEFAULT 0 (no Nullable in key paths)",
      },
      {
        icon: "ti-key",
        tone: "info",
        text: "Fraud review (brief §5) needs referrer lookups → referrer_user_id goes into the ordering key",
      },
      {
        icon: "ti-clock",
        tone: "info",
        text: "Credits are money → Decimal(10,2) INR · 24-month TTL per finance retention",
      },
      {
        icon: "ti-circle-check",
        tone: "ok",
        text: "Dry-run passed on staging clone — 2 statements ready for human review",
      },
    ],
    revisionLog: {
      icon: "ti-pencil",
      tone: "ok",
      text: "Reviewer note applied — re-validated on staging clone",
    },
    ddl: `CREATE TABLE atlys.referral_events
(
    event_time        DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    event_type        LowCardinality(String),  -- invite_sent|link_opened|signup|first_purchase|credit_earned
    referrer_user_id  UInt64,
    referee_user_id   UInt64 DEFAULT 0,
    channel           LowCardinality(String),  -- whatsapp|link|qr|email
    destination       LowCardinality(String),
    credit_amount_inr Decimal(10, 2),
    attrs             Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (event_type, referrer_user_id, event_time)
TTL toDateTime(event_time) + INTERVAL 24 MONTH;

CREATE MATERIALIZED VIEW atlys.mv_referral_kfactor_daily
ENGINE = AggregatingMergeTree
ORDER BY (day, channel)
AS SELECT
    toDate(event_time) AS day, channel,
    uniqState(referrer_user_id) AS referrers,
    uniqStateIf(referee_user_id, event_type = 'signup') AS signups
FROM atlys.referral_events
GROUP BY day, channel;`,
    rationale: [
      {
        icon: "ti-key",
        title: "Ordering key",
        text: "(event_type, referrer_user_id, event_time) — finance audits look up a referrer’s full history; point lookups prune to a handful of granules.",
      },
      {
        icon: "ti-calendar",
        title: "Partitioning",
        text: "toYYYYMM — aligned with the 24-month TTL so expiry is a free partition drop.",
      },
      {
        icon: "ti-binary",
        title: "Types",
        text: "DEFAULT 0 instead of Nullable for the unknown referee — Nullable costs an extra file and can’t sit in the key.",
      },
      {
        icon: "ti-clock",
        title: "TTL",
        text: "24 months — money movement, finance retention policy applies.",
      },
    ],
    mv: {
      name: "mv_referral_kfactor_daily · AggregatingMergeTree",
      note: "K-factor per channel per day without scanning raw events — the growth team refreshes this hourly.",
    },
    exec: [
      "CREATE TABLE atlys.referral_events — OK (0.31s)",
      "CREATE MATERIALIZED VIEW atlys.mv_referral_kfactor_daily — OK (0.14s)",
      "Backfill: 88,410 events from specs/referral_credits.ndjson — OK (0.9s)",
      "Smoke: count() = 88,410 · uniq(referrer_user_id) = 22,051 — OK",
    ],
    diff: [
      {
        sign: "+",
        text: "entity: referral — referrer/referee pair, joined on referee_user_id → user_id",
      },
      {
        sign: "+",
        text: "metric: k_factor = signups / active referrers, weekly, cut by channel",
      },
      { sign: "~", text: "metric: acquisition_channel — enum extended with referral" },
    ],
    warn: "",
    trace: { id: "tr_rf_8d20", tokens: "2,913", cost: "$0.036", duration: "10.2s + human" },
    contextTrace: { id: "tr_cx_6e19", tokens: "1,844", cost: "$0.021", duration: "1.7s" },
    table: "atlys.referral_events",
    mvShort: "mv_referral_kfactor_daily",
    backfill: "88,410 events backfilled",
    durations: ["1.0s", "5.6s", "human", "2.4s", "1.7s"],
    changelogTable: "referral_events + 1 MV created",
    changelogContext: "+1 metric, +1 entity added to context",
  },

  wa: {
    specId: "wa",
    brief:
      "PM brief: push application status changes over WhatsApp with deep links back into the tracker. Success metric: read rate. Guardrail: opt-outs. Templates localised in 9 languages.",
    ndjson: [],
    log: [
      {
        icon: "ti-book-2",
        tone: "info",
        text: "Loaded base_context v1.2 — reusing entities application and traveller; no messaging entities yet",
      },
      {
        icon: "ti-table",
        tone: "info",
        text: "Inspected live tables — application_id join confirmed; auth_completed carries the phone_verified flag",
      },
      {
        icon: "ti-file-text",
        tone: "info",
        text: "Parsed spec — 6 event types; sampled 350 NDJSON events; template_id cardinality 42 → LowCardinality",
      },
      {
        icon: "ti-key",
        tone: "info",
        text: "Delivery-funnel queries filter by event_type then template → (event_type, template_id, event_time)",
      },
      {
        icon: "ti-circle-check",
        tone: "ok",
        text: "Dry-run passed on staging clone — 2 statements approved by reviewer",
      },
    ],
    ddl: `CREATE TABLE atlys.whatsapp_alert_events
(
    event_time     DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    event_type     LowCardinality(String),  -- queued|sent|delivered|read|cta_clicked|opt_out
    user_id        UInt64,
    application_id UInt64,
    template_id    LowCardinality(String),
    locale         LowCardinality(String),
    attrs          Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (event_type, template_id, event_time)
TTL toDateTime(event_time) + INTERVAL 12 MONTH;

CREATE MATERIALIZED VIEW atlys.mv_alert_delivery_daily
ENGINE = AggregatingMergeTree
ORDER BY (day, template_id, locale)
AS SELECT
    toDate(event_time) AS day, template_id, locale,
    uniqState(user_id)                           AS delivered,
    uniqStateIf(user_id, event_type = 'read')    AS readers,
    uniqStateIf(user_id, event_type = 'opt_out') AS opt_outs
FROM atlys.whatsapp_alert_events
GROUP BY day, template_id, locale;`,
    rationale: [
      {
        icon: "ti-key",
        title: "Ordering key",
        text: "(event_type, template_id, event_time) — delivery-funnel queries always cut by step then template; time last for range pruning.",
      },
      {
        icon: "ti-calendar",
        title: "Partitioning",
        text: "toYYYYMM — ~9M rows/mo projected; aligned with 12-month TTL drops.",
      },
      {
        icon: "ti-binary",
        title: "Types",
        text: "LowCardinality template_id (42 values) and locale (9 languages); no money fields.",
      },
      {
        icon: "ti-clock",
        title: "TTL",
        text: "12 months — messaging telemetry, default retention.",
      },
    ],
    mv: {
      name: "mv_alert_delivery_daily · AggregatingMergeTree",
      note: "Read and opt-out rates per template per locale — powers the lifecycle dashboard without raw scans.",
    },
    exec: [],
    diff: [
      { sign: "+", text: "entity: whatsapp_alert — one per status transition per application" },
      {
        sign: "+",
        text: "metric: alert_read_rate = uniq(read) / uniq(delivered), by template × locale",
      },
      {
        sign: "~",
        text: "gap flagged: opt_out events have no counterpart in the base funnel — added to known issues",
      },
    ],
    warn: 'base_context claimed "all notifications are email" (§channels) — stale since this feature. Section rewritten and marked superseded.',
    trace: { id: "tr_wa_55aa", tokens: "3,102", cost: "$0.041", duration: "11.2s + human" },
    contextTrace: { id: "tr_cx_31f0", tokens: "1,876", cost: "$0.022", duration: "1.9s" },
    table: "atlys.whatsapp_alert_events",
    mvShort: "mv_alert_delivery_daily",
    backfill: "96,882 events backfilled",
  },

  tp: {
    specId: "tp",
    brief:
      "PM brief: save traveller documents once, re-use across applications and co-travellers. Success metric: repeat-application time-to-submit. Compliance: document expiry must be flaggable.",
    ndjson: [],
    log: [
      {
        icon: "ti-book-2",
        tone: "info",
        text: "Loaded base_context v1.1 — entities traveller and document already defined; extending them",
      },
      {
        icon: "ti-table",
        tone: "info",
        text: "document_uploaded shares the doc_type vocabulary — reused its enum values verbatim",
      },
      {
        icon: "ti-key",
        tone: "info",
        text: "Access pattern is per-user profile lookups, not funnel scans → user_id leads the ordering key",
      },
      {
        icon: "ti-stack-2",
        tone: "warn",
        text: "MV cost check: projected <40 queries/day on aggregates — MV rejected, not worth the merge overhead",
      },
      {
        icon: "ti-circle-check",
        tone: "ok",
        text: "Dry-run passed on staging clone — 1 statement approved by reviewer",
      },
    ],
    ddl: `CREATE TABLE atlys.traveller_profile_events
(
    event_time  DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    event_type  LowCardinality(String),  -- created|doc_attached|reused|expired_doc_flagged
    user_id     UInt64,
    profile_id  UUID,
    doc_type    LowCardinality(String),
    attrs       Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (user_id, event_type, event_time)  -- per-user lookups: different access pattern, different key
TTL toDateTime(event_time) + INTERVAL 24 MONTH;`,
    rationale: [
      {
        icon: "ti-key",
        title: "Ordering key",
        text: "(user_id, event_type, event_time) — point lookups per traveller; deliberately different from the funnel tables’ key.",
      },
      {
        icon: "ti-calendar",
        title: "Partitioning",
        text: "toYYYYMM — low volume; monthly parts stay tiny.",
      },
      {
        icon: "ti-binary",
        title: "Types",
        text: "UUID profile_id; doc_type reuses the existing enum vocabulary from document_uploaded.",
      },
      {
        icon: "ti-clock",
        title: "TTL",
        text: "24 months — compliance wants expiry audits across visa cycles.",
      },
    ],
    mv: {
      name: "MV skipped — rejected by cost check",
      note: "Projected query volume (<40/day) didn’t justify merge overhead. The rejection and its numbers are recorded in the trace.",
    },
    exec: [],
    diff: [
      {
        sign: "+",
        text: "entity: traveller_profile — links traveller → documents; joins on user_id",
      },
      {
        sign: "+",
        text: "metric: profile_reuse_rate = applications with reused profile / all applications",
      },
    ],
    warn: "",
    trace: { id: "tr_tp_9d12", tokens: "2,890", cost: "$0.038", duration: "10.1s + human" },
    contextTrace: { id: "tr_cx_44b8", tokens: "1,701", cost: "$0.019", duration: "1.6s" },
    table: "atlys.traveller_profile_events",
    mvShort: "— skipped (cost check)",
    backfill: "61,240 events backfilled",
  },
}

export const ANSWERS: Record<AnswerKey, Answer> = {
  express: {
    key: "express",
    short: "Express Checkout impact",
    traceId: "tr_an_4be1",
    queryMs: "94ms",
    steps: [
      {
        label: "Context retrieved",
        detail: "v{ctx} · picked express_checkout_conversion + known-issue: iOS OTP autofill",
      },
      {
        label: "SQL planned",
        detail: "3 queries · uniqMerge over mv_express_checkout_daily — no raw rows to the LLM",
      },
      { label: "Executed on ClickHouse", detail: "94ms total · 2,046 aggregate rows returned" },
      { label: "Anomaly scan", detail: "platform × region MAD outlier: ios·AE at −3.1σ" },
      { label: "Insight composed", detail: "grounded in 2 context entries · confidence scored" },
    ],
    headline:
      "Express Checkout lifts overall conversion +11.8pp — but iOS · UAE is bleeding at the OTP step (−23%).",
    findings: [
      {
        tag: "WHAT",
        bg: "#e6f4f1",
        fg: "#1a6e64",
        text: "Express completion is 64.1% vs 52.3% for standard checkout — +11.8pp across 96k users in 14 days.",
      },
      {
        tag: "WHY",
        bg: "#fdeae4",
        fg: "#a03c22",
        text: "iOS · UAE collapses at otp_filled: 78% of its drop-offs fire is_fallback = 1, and median OTP fill takes 11.2s vs 2.1s globally.",
      },
      {
        tag: "CONTEXT",
        bg: "#e9eef2",
        fg: "#274754",
        text: 'Matches known issue "iOS WebKit OTP autofill" (base_context §known-issues, since v1.1): Safari suppresses autofill in cross-origin iframes.',
      },
      {
        tag: "ACT",
        bg: "#faf3dc",
        fg: "#8a6d1a",
        text: "Ship a native OTP sheet for iOS · UAE first — projected +2.1pp overall, ≈ ₹3.2Cr/yr GMV at current run-rate.",
      },
    ],
    chartTitle: "Express completion rate · last 14 days",
    columns: [
      { label: "Web", value: "68.2%", height: 116 },
      { label: "Android", value: "66.4%", height: 113 },
      { label: "iOS · rest", value: "63.1%", height: 107 },
      { label: "iOS · UAE", value: "41.3%", height: 70, hot: true },
    ],
    confidence: 0.87,
    confidenceNote: "3 queries · 2,046 rows to LLM · compute stayed in ClickHouse",
    sql: `SELECT platform, region,
       round(uniqMerge(completed_users) / uniqMerge(shown_users), 3) AS conv,
       round(avgMerge(otp_ms)) AS otp_fill_ms
FROM atlys.mv_express_checkout_daily
WHERE day >= today() - 14
GROUP BY platform, region
ORDER BY conv ASC
LIMIT 20`,
  },

  funnel: {
    key: "funnel",
    short: "Funnel drop-off review",
    traceId: "tr_an_22d8",
    queryMs: "380ms",
    steps: [
      {
        label: "Context retrieved",
        detail: "v{ctx} · funnel definition: 4 ordered steps on user_id, 30-day window",
      },
      { label: "SQL planned", detail: "windowFunnel over the 4 base event tables · 1 query" },
      {
        label: "Executed on ClickHouse",
        detail: "380ms · 2.5M events scanned server-side, 4 aggregate rows returned",
      },
      { label: "Insight composed", detail: "joined against known-issues log · confidence scored" },
    ],
    headline:
      "Document upload is the funnel’s biggest leak — 44% of applicants who start never finish uploading.",
    findings: [
      {
        tag: "WHAT",
        bg: "#e6f4f1",
        fg: "#1a6e64",
        text: "Of 511,900 started applications, only 288,700 complete document upload — a 223k-user loss, the largest absolute drop in the funnel.",
      },
      {
        tag: "WHY",
        bg: "#fdeae4",
        fg: "#a03c22",
        text: "Schengen destinations demand 2.3× more documents per application; mobile uploaders fail 31% more often than desktop.",
      },
      {
        tag: "CONTEXT",
        bg: "#e9eef2",
        fg: "#274754",
        text: "Known issue (base_context v1.0): HEIC → JPEG conversion times out on files over 8MB — 61% of mobile failures match its signature.",
      },
      {
        tag: "ACT",
        bg: "#faf3dc",
        fg: "#8a6d1a",
        text: "Async document checklist + client-side compression. Recovering half the mobile failures ≈ +18k purchases/yr.",
      },
    ],
    chartTitle: "Pre-purchase funnel · distinct users, in order, 90 days",
    funnel: [
      { label: "destination_card_clicked", value: "1,000,000", width: "100%" },
      { label: "application_started", value: "511,900 · 51.2%", width: "51%" },
      { label: "document_uploaded", value: "288,700 · 56.4% step", width: "29%" },
      { label: "purchase_completed", value: "186,600 · 64.6% step", width: "19%" },
    ],
    confidence: 0.91,
    confidenceNote: "windowFunnel over 2.5M events · 4 rows to LLM",
    sql: `SELECT countIf(step >= 1) AS clicked,  countIf(step >= 2) AS started,
       countIf(step >= 3) AS uploaded, countIf(step >= 4) AS purchased
FROM (
    SELECT user_id,
           windowFunnel(2592000)(timestamp,
               event = 'destination_card_clicked', event = 'application_started',
               event = 'document_uploaded',       event = 'purchase_completed') AS step
    FROM atlys.funnel_events           -- UNION view over the 4 base tables
    GROUP BY user_id
)`,
  },

  uploads: {
    key: "uploads",
    short: "Mobile upload failures",
    traceId: "tr_an_09c3",
    queryMs: "121ms",
    steps: [
      { label: "Context retrieved", detail: "v{ctx} · entity: document · known-issue log scanned" },
      { label: "SQL planned", detail: "2 queries · failure rate by platform × file format" },
      { label: "Executed on ClickHouse", detail: "121ms · 41k aggregate rows reduced to 8" },
      { label: "Insight composed", detail: "low web sample flagged → confidence capped" },
    ],
    headline: "Mobile upload failures are a file-format problem, not a network one.",
    findings: [
      {
        tag: "WHAT",
        bg: "#e6f4f1",
        fg: "#1a6e64",
        text: "HEIC uploads from iOS fail at 34% — 3.8× the JPEG failure rate on the same devices, same sessions.",
      },
      {
        tag: "WHY",
        bg: "#fdeae4",
        fg: "#a03c22",
        text: "Failures cluster on files > 8MB and retries double p95 upload latency, compounding the drop-off.",
      },
      {
        tag: "CONTEXT",
        bg: "#e9eef2",
        fg: "#274754",
        text: 'Base_context v1.0 already logs "HEIC → JPEG conversion times out > 8MB" — this quantifies it and ties it to funnel loss.',
      },
      {
        tag: "ACT",
        bg: "#faf3dc",
        fg: "#8a6d1a",
        text: "Convert + compress client-side before upload; kills the timeout class entirely for ~₹0 infra cost.",
      },
    ],
    chartTitle: "Upload failure rate · by platform and format",
    columns: [
      { label: "iOS · HEIC", value: "34%", height: 118, hot: true },
      { label: "iOS · JPEG", value: "9%", height: 32 },
      { label: "Android", value: "11%", height: 39 },
      { label: "Web", value: "6%", height: 22 },
    ],
    confidence: 0.78,
    confidenceNote: "web sample thin (n = 4.1k) — flagged, confidence capped",
    sql: `SELECT platform, attrs['format'] AS fmt,
       countIf(event_type = 'failed') / count() AS fail_rate,
       quantile(0.95)(attrs['size_mb']::Float32) AS p95_mb
FROM atlys.document_uploaded
WHERE timestamp >= now() - INTERVAL 30 DAY
GROUP BY platform, fmt
HAVING count() > 1000
ORDER BY fail_rate DESC`,
  },

  generic: {
    key: "generic",
    short: "New conversation",
    traceId: null,
    queryMs: "12ms",
    steps: [
      { label: "Context retrieved", detail: "v{ctx} · entities, metric formulas, known issues" },
      {
        label: "Schema listed",
        detail: "system.tables — base funnel + every agent-instrumented table",
      },
    ],
    headline: "Here is what I can query right now.",
    findings: [
      {
        tag: "TABLES",
        bg: "#e6f4f1",
        fg: "#1a6e64",
        text: "8 base funnel & engagement tables plus every table the Instrumentation Agent has shipped — all joined on user_id / application_id.",
      },
      {
        tag: "CONTEXT",
        bg: "#e9eef2",
        fg: "#274754",
        text: "Working from context v{ctx}: metric definitions, entity relationships and the known-issues log — refreshed automatically on every schema change.",
      },
      {
        tag: "TRY",
        bg: "#faf3dc",
        fg: "#8a6d1a",
        text: "Express Checkout performance since launch · where the funnel leaks · why mobile uploads fail.",
      },
    ],
    confidence: null,
    sql: null,
  },
}

export const STATIC_TRACES: Trace[] = [
  {
    id: "tr_an_09c3",
    name: 'analytics.ask — "Why do document uploads fail on mobile?"',
    agent: "analytics",
    tokens: "4,110",
    cost: "$0.049",
    duration: "6.9s",
    status: "ok",
    time: "13:55",
    meta: "context v1.3 · 2 queries · 8 rows to LLM · confidence 0.78 (capped: thin web sample)",
    human: "Someone asked why mobile uploads fail. The agent planned 2 queries, ClickHouse crunched 41k rows down to 8, and the answer was tied to a documented HEIC conversion bug.",
    spans: [
      { name: "ctx.read v1.3", kind: "tool", left: 0, width: 5 },
      { name: "sql.plan (LLM)", kind: "llm", left: 5, width: 28 },
      { name: "ch.query document_uploaded agg", kind: "db", left: 34, width: 12 },
      { name: "ch.query size distribution", kind: "db", left: 47, width: 9 },
      { name: "insight.compose (LLM)", kind: "llm", left: 58, width: 38 },
    ],
  },
  {
    id: "tr_an_22d8",
    name: 'analytics.ask — "Where do users drop off in the funnel?"',
    agent: "analytics",
    tokens: "3,988",
    cost: "$0.047",
    duration: "7.4s",
    status: "ok",
    time: "13:41",
    meta: "context v1.3 · windowFunnel over 2.5M events · 4 rows to LLM · confidence 0.91",
    human: "Someone asked where the funnel leaks. One funnel query over 2.5M events found document upload losing 44% of applicants — the agent explained why and what to do.",
    spans: [
      { name: "ctx.read v1.3", kind: "tool", left: 0, width: 5 },
      { name: "sql.plan (LLM)", kind: "llm", left: 5, width: 30 },
      { name: "ch.query windowFunnel", kind: "db", left: 36, width: 18 },
      { name: "insight.compose (LLM)", kind: "llm", left: 55, width: 40 },
    ],
  },
  {
    id: "tr_cx_31f0",
    name: "context.update — v1.2 → v1.3",
    agent: "context",
    tokens: "1,876",
    cost: "$0.022",
    duration: "1.9s",
    status: "flagged",
    time: "13:22",
    meta: 'trigger: whatsapp_alert_events created · stale claim "all notifications are email" superseded',
    human: "A new table appeared, so the Context Agent re-read the business docs, caught a claim that was no longer true, and rewrote that section before anyone relied on it.",
    spans: [
      { name: "diff.schema (system.tables)", kind: "db", left: 0, width: 20 },
      { name: "contradiction.scan (LLM)", kind: "llm", left: 20, width: 50 },
      { name: "context.write + version", kind: "tool", left: 70, width: 18 },
      { name: "notify analytics agent", kind: "tool", left: 88, width: 12 },
    ],
  },
  {
    id: "tr_wa_55aa",
    name: "instrumentation.run — whatsapp_status_alerts",
    agent: "instrumentation",
    tokens: "3,102",
    cost: "$0.041",
    duration: "11.2s + human",
    status: "human ✓",
    time: "13:21",
    meta: "context v1.2 in · human approval recorded · 2 statements executed · 96,882 events backfilled",
    human: "A feature spec came in. The agent studied the existing data, designed the WhatsApp events table, a human reviewed and approved it, and 96,882 events were loaded.",
    spans: [
      { name: "ctx.fetch v1.2", kind: "tool", left: 0, width: 3 },
      { name: "schema.inspect (system.columns)", kind: "db", left: 3, width: 7 },
      { name: "spec.parse + sampling", kind: "tool", left: 10, width: 6 },
      { name: "ddl.design (LLM)", kind: "llm", left: 16, width: 42 },
      { name: "ddl.dryrun (staging)", kind: "db", left: 58, width: 6 },
      { name: "human.approval — APPROVED", kind: "human", left: 64, width: 18 },
      { name: "ch.execute 2 stmts", kind: "db", left: 82, width: 8 },
      { name: "context.trigger", kind: "tool", left: 90, width: 4 },
    ],
  },
  {
    id: "tr_cx_8c44",
    name: "context.update — v1.0 → v1.1 (audit)",
    agent: "context",
    tokens: "2,410",
    cost: "$0.028",
    duration: "2.6s",
    status: "flagged",
    time: "12:39",
    meta: "proactive audit: conversion formula divided by sessions while the metric table used users — corrected",
    human: "Routine audit of the hand-written docs: the conversion formula disagreed with the actual data. The agent verified against ClickHouse and corrected the definition.",
    spans: [
      { name: "context.audit (LLM)", kind: "llm", left: 0, width: 62 },
      { name: "ch.verify formulas", kind: "db", left: 62, width: 22 },
      { name: "context.write + version", kind: "tool", left: 84, width: 16 },
    ],
  },
  {
    id: "tr_tp_9d12",
    name: "instrumentation.run — saved_traveller_profiles",
    agent: "instrumentation",
    tokens: "2,890",
    cost: "$0.038",
    duration: "10.1s + human",
    status: "human ✓",
    time: "12:58",
    meta: "context v1.1 in · MV rejected by the agent’s own cost check — query volume didn’t justify it",
    human: "The agent designed the traveller-profiles table, ran the numbers on a pre-aggregation view and decided it wasn’t worth the cost. A human approved the final design.",
    spans: [
      { name: "ctx.fetch v1.1", kind: "tool", left: 0, width: 4 },
      { name: "schema.inspect (system.columns)", kind: "db", left: 4, width: 8 },
      { name: "spec.parse + sampling", kind: "tool", left: 12, width: 6 },
      { name: "ddl.design (LLM)", kind: "llm", left: 18, width: 44 },
      { name: "mv.cost-check → skip", kind: "tool", left: 62, width: 6 },
      { name: "human.approval — APPROVED", kind: "human", left: 68, width: 16 },
      { name: "ch.execute 1 stmt", kind: "db", left: 84, width: 10 },
      { name: "context.trigger", kind: "tool", left: 94, width: 4 },
    ],
  },
]

export const STATIC_CHANGELOG: ChangelogEntry[] = [
  {
    id: "cl_1322",
    time: "13:22",
    icon: "ti-book-2",
    kind: "ctx",
    title: "context v1.3",
    desc: '+ alert_delivery metrics · stale claim "all notifications are email" superseded',
    traceId: "tr_cx_31f0",
    warn: true,
  },
  {
    id: "cl_1321",
    time: "13:21",
    icon: "ti-table",
    kind: "table",
    title: "whatsapp_alert_events + 1 MV created",
    desc: "Instrumentation Agent · human-approved · 96,882 events backfilled",
    traceId: "tr_wa_55aa",
  },
  {
    id: "cl_1259",
    time: "12:59",
    icon: "ti-book-2",
    kind: "ctx",
    title: "context v1.2",
    desc: "+ traveller_profile entity · doc_type enum documented",
    traceId: "tr_cx_44b8",
  },
  {
    id: "cl_1258",
    time: "12:58",
    icon: "ti-table",
    kind: "table",
    title: "traveller_profile_events created (MV skipped)",
    desc: "Agent’s own cost check rejected the MV — query volume didn’t justify it. Per-user ordering key.",
    traceId: "tr_tp_9d12",
  },
  {
    id: "cl_1239",
    time: "12:39",
    icon: "ti-alert-triangle",
    kind: "ctx",
    title: "context v1.1 — base context corrected",
    desc: "Audit found the hand-written conversion formula divided by sessions while the metric table used users. The provided context is treated with suspicion, as instructed.",
    traceId: "tr_cx_8c44",
    warn: true,
  },
  {
    id: "cl_1226",
    time: "12:26",
    icon: "ti-book-2",
    kind: "ctx",
    title: "context v1.0 ingested",
    desc: "base_context.md loaded as provided — known-imperfect, flagged for audit",
    traceId: null,
  },
  {
    id: "cl_1224",
    time: "12:24",
    icon: "ti-database",
    kind: "table",
    title: "8 base tables loaded",
    desc: "ddl.sql + Parquet load — 2.5M rows across the pre-purchase funnel and engagement events",
    traceId: null,
  },
]

export const SERIES: Record<"traces" | "cost" | "tokens", Series> = {
  traces: { data: [2, 1, 3, 4, 6, 3, 2, 5, 4, 3, 6, 8], unit: " traces" },
  cost: { data: [2, 4, 9, 11, 8, 5, 3, 6, 5, 4, 7, 12], unit: "¢" },
  tokens: { data: [3, 5, 9, 12, 8, 6, 4, 7, 6, 5, 8, 14], unit: "k tok" },
}

/** p95 query latency per hour, last 24h. Index 22 is the backfill spike. */
export const LATENCY = [
  34, 30, 38, 28, 24, 26, 22, 18, 16, 14, 18, 20, 24, 28, 34, 38, 44, 40, 36, 42, 52, 58, 96, 64,
]

export const INITIAL_STATUSES: Record<SpecId, SpecStatus> = {
  ec: "ready",
  wa: "done",
  tp: "done",
  ve: "ready",
  rf: "ready",
}

export const INITIAL_HISTORY: HistoryEntry[] = [
  { specId: "wa", time: "today 13:21", version: "v1.2 → v1.3", approvedBy: "R. Mehta" },
  { specId: "tp", time: "today 12:58", version: "v1.1 → v1.2", approvedBy: "R. Mehta" },
]

export const INITIAL_CONVERSATIONS: Conversation[] = [
  {
    id: 1,
    title: "Funnel drop-off review",
    time: "13:41",
    starred: true,
    messages: [
      {
        id: 1,
        role: "user",
        text: "Where do users drop off in the funnel?",
        stepsDone: 0,
        revealed: false,
        contextVersion: "1.3",
      },
      {
        id: 2,
        role: "agent",
        answerKey: "funnel",
        stepsDone: 99,
        revealed: true,
        contextVersion: "1.3",
      },
    ],
  },
  { id: 2, title: "New conversation", time: "now", starred: false, messages: [] },
]

export const INITIAL_DASHBOARDS: Dashboard[] = [
  { id: 1, name: "Funnel health", items: [{ key: "funnel" }, { key: "uploads" }] },
]

export const INITIAL_CONTEXT_VERSION = "1.3"
