/**
 * Seed data for the screens still served by the mock — Dashboards and
 * Observability. Instrumentation and Chat were cut over to the real backend, so
 * nothing here describes a run or an answer any more; `history`, `specStatuses`
 * and `ANSWERS` survive only as the static shape those two screens draw from.
 *
 * When they land on the real backend too, this file goes away — nothing outside
 * `src/mock` imports it.
 */

import type {
  Answer,
  AnswerKey,
  ChangelogEntry,
  Dashboard,
  HistoryEntry,
  Series,
  SpecId,
  SpecStatus,
  Trace,
} from "@/api/types"

export const ANSWERS: Record<AnswerKey, Answer> = {
  express: {
    key: "express",
    short: "Express Checkout impact",
    queryMs: "94ms",
    headline:
      "Express Checkout lifts overall conversion +11.8pp — but iOS · UAE is bleeding at the OTP step (−23%).",
    chartTitle: "Express completion rate · last 14 days",
    columns: [
      { label: "Web", value: "68.2%", height: 116 },
      { label: "Android", value: "66.4%", height: 113 },
      { label: "iOS · rest", value: "63.1%", height: 107 },
      { label: "iOS · UAE", value: "41.3%", height: 70, hot: true },
    ],
  },

  funnel: {
    key: "funnel",
    short: "Funnel drop-off review",
    queryMs: "380ms",
    headline:
      "Document upload is the funnel’s biggest leak — 44% of applicants who start never finish uploading.",
    chartTitle: "Pre-purchase funnel · distinct users, in order, 90 days",
    funnel: [
      { label: "destination_card_clicked", value: "1,000,000", width: "100%" },
      { label: "application_started", value: "511,900 · 51.2%", width: "51%" },
      { label: "document_uploaded", value: "288,700 · 56.4% step", width: "29%" },
      { label: "purchase_completed", value: "186,600 · 64.6% step", width: "19%" },
    ],
  },

  uploads: {
    key: "uploads",
    short: "Mobile upload failures",
    queryMs: "121ms",
    headline: "Mobile upload failures are a file-format problem, not a network one.",
    chartTitle: "Upload failure rate · by platform and format",
    columns: [
      { label: "iOS · HEIC", value: "34%", height: 118, hot: true },
      { label: "iOS · JPEG", value: "9%", height: 32 },
      { label: "Android", value: "11%", height: 39 },
      { label: "Web", value: "6%", height: 22 },
    ],
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

/** Observability only — which sample features its storage/table charts assume. */
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

export const INITIAL_DASHBOARDS: Dashboard[] = [
  { id: 1, name: "Funnel health", items: [{ key: "funnel" }, { key: "uploads" }] },
]

export const INITIAL_CONTEXT_VERSION = "1.3"
