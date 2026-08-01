/**
 * The Observability screen's half of the real backend (`backend/API.md`).
 *
 * Kept separate from `instrumentation.ts` only because the two screens grew
 * independently; both talk to the same server through the `/api/*` proxy.
 *
 * The backend returns RAW numbers (bytes, milliseconds, row counts) and lets the
 * UI decide how to render them — the formatters at the bottom of this file are
 * that decision, in one place.
 */

/* ── database health ───────────────────────────────────────────────────── */

/** Who ran a query, from the `log_comment` stamped at execution time. `null`
 *  means it was not run by Clickwright — a console session, or ClickHouse
 *  Cloud's own internals. Never guess an agent for these. */
export type QueryAgent =
  | "instrumentation"
  | "context"
  | "analytics"
  | "optimizer"
  | "observe"
  | "server"
  | "script"

export type TableOrigin = "base" | "agent" | "internal"

export interface HealthStats {
  queries24h: number
  p95LatencyMs: number
  rowsRead24h: number
  tablesLive: number
  baseTables: number
  agentTables: number
}

export interface LatencyBucket {
  /** epoch seconds at the start of the hour */
  hourTs: number
  hour: string
  p95Ms: number
  queries: number
  /** p95 ≥ max(2 × median busy hour, 100ms) */
  isSpike: boolean
  /** e.g. "instrumentation insert (412,900 rows)" */
  spikeCause: string | null
}

export interface StorageRowDto {
  table: string
  bytes: number
  rows: number
  parts: number
  origin: TableOrigin
}

export interface PartsHealth {
  activeParts: number
  activeMerges: number
  failedMerges24h: number
  healthy: boolean
  /** false ⇒ failedMerges24h is unknown, not zero */
  partLogAvailable: boolean
}

export interface SlowQuery {
  shape: string
  maxMs: number
  runs: number
  rows: number
  agent: QueryAgent | null
}

export interface RecentQuery {
  queryId: string
  at: string
  query: string
  ms: number
  rows: number
  agent: QueryAgent | null
  step: string | null
  runId: string | null
}

export interface DatabaseHealth {
  windowHours: number
  /** false ⇒ every query-derived number below is meaningless. Say so; do not
   *  render 0 as if it were a measurement. */
  queryLogAvailable: boolean
  /** true = unioned across ClickHouse Cloud replicas */
  queryLogClustered: boolean
  stats: HealthStats | null
  /** always exactly 24 buckets, dense, oldest first */
  latencyP95ByHour: LatencyBucket[]
  storageByTable: StorageRowDto[]
  storageTotalBytes: number
  partsHealth: PartsHealth | null
  slowestQueries: SlowQuery[]
  recentQueries: RecentQuery[]
}

/* ── changelog ─────────────────────────────────────────────────────────── */

export interface ChangelogEntryDto {
  id: string
  /** "YYYY-MM-DD HH:MM:SS.mmm" */
  at: string
  kind: "table" | "context"
  title: string
  description: string
  /** an existing definition was superseded */
  warn: boolean
  traceUrl: string | null
  runId: string | null
  spec: string | null
  /** "v1.3" — context entries only */
  contextVersion: string | null
  entities: string[]
  tables: { name: string; rows: number }[]
}

/* ── optimization advisor ──────────────────────────────────────────────── */

export interface Suggestion {
  id: string
  severity: "HIGH" | "MED" | "GOOD"
  action: string
  why: string
  targetTable: string | null
  /** false ⇒ no permitted DDL statement can express this; hide the draft button */
  actionable: boolean
  scannedAt: string
}

export interface ScanResult {
  status: "never_run" | "scanning" | "ready" | "failed"
  scannedAt: string | null
  traceUrl: string | null
  /** HIGH → MED → GOOD */
  suggestions: Suggestion[]
  error?: string
}

/* ── answer judge ──────────────────────────────────────────────────────── */

export type Verdict = "pass" | "warn" | "fail"

export interface JudgeFinding {
  kind: "hygiene" | "denominator" | "currency" | "join" | "citation" | "coverage"
  severity: "info" | "warn" | "fail"
  text: string
  task: string | null
}

export interface Judgement {
  convId: string
  seq: number
  question: string
  askedAt: string
  judgedAt: string
  overall: Verdict
  /** Did the data returned actually answer the question? */
  relevance: { verdict: Verdict; score: number; reason: string }
  /** Was the query the agent wrote correct? */
  sql: { verdict: Verdict; score: number; reason: string }
  /** Decided by code, not the model — see judge.ts */
  findings: JudgeFinding[]
  queries: { task: string; title: string; sql: string; rowCount: number }[]
  /** The judge runs on a stronger model than the agent it grades. */
  model: string
  answerTraceUrl: string | null
  judgeTraceUrl: string | null
}

/* ── transport ─────────────────────────────────────────────────────────── */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init)
  const text = await response.text()
  const body = text ? (JSON.parse(text) as unknown) : null

  if (!response.ok) {
    const error =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `${response.status} ${response.statusText}`
    throw new Error(error)
  }
  return body as T
}

export const observe = {
  health: () => request<DatabaseHealth>("/observe/clickhouse"),

  changelog: (kind?: "table" | "context") =>
    request<ChangelogEntryDto[]>(
      `/observe/changelog${kind ? `?kind=${kind}` : ""}`
    ),

  /** Plain href — let the browser download it rather than buffering in JS. */
  changelogExportUrl: "/api/observe/changelog/export",

  judgements: (verdict?: Verdict) =>
    request<Judgement[]>(`/observe/judgements${verdict ? `?verdict=${verdict}` : ""}`),

  suggestions: () => request<ScanResult>("/observe/suggestions"),

  /** 202 and returns immediately; a scan takes 2–3 minutes. Poll `suggestions`
   *  until `status !== "scanning"`. 409 if one is already running. */
  startScan: () =>
    request<{ status: "scanning" }>("/observe/suggestions/scan", {
      method: "POST",
    }),

  /** "Ask agent to draft it" — enqueues a gated optimization run. */
  draft: (suggestionId: string) =>
    request<{ id: string; spec: string; kind: string; status: string }>(
      `/observe/suggestions/${encodeURIComponent(suggestionId)}/draft`,
      { method: "POST" }
    ),
}

/* ── formatters ────────────────────────────────────────────────────────── */

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`
  return `${bytes} B`
}

/** 48,214,392 → "48.2M". Used for row counts, where exactness is noise. */
export function formatCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatExact(n: number): string {
  return n.toLocaleString("en-US")
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** "2026-08-01 15:29:39.228" → "15:29". The changelog groups by day already. */
export function formatClock(at: string): string {
  return at.slice(11, 16) || at
}

/** Langfuse deep links end in the trace id; the chip shows the id, the click
 *  opens the URL. */
export function traceIdFromUrl(url: string): string {
  const id = url.split("/").filter(Boolean).pop() ?? url
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}
