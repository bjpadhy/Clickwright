/**
 * Domain contract for the still-mocked half of the console: Dashboards and
 * Observability. `SpecLoopApi` is implemented in `src/mock/server.ts`.
 *
 * Instrumentation and Chat are not part of this contract — they run against the
 * real backend through `src/api/instrumentation.ts` and `src/api/chat.ts`.
 */

/** Sample features Observability's storage and table charts are drawn around. */
export type SpecId = "ec" | "ve" | "rf" | "wa" | "tp"

export type AgentKind = "instrumentation" | "analytics" | "context"

export type SpanKind = "llm" | "db" | "tool" | "human"

export type AnswerKey = "express" | "funnel" | "uploads"

export type SpecStatus = "ready" | "done"

export type SimulationSpeed = "instant" | "fast" | "realistic"

/* ── Observability ─────────────────────────────────────────────────────── */

export interface Span {
  name: string
  kind: SpanKind
  /** percent offset along the trace timeline */
  left: number
  /** percent width */
  width: number
}

export interface Trace {
  id: string
  name: string
  agent: AgentKind
  tokens: string
  cost: string
  duration: string
  /** "ok" | "flagged" | "human ✓" | "auto ✓" */
  status: string
  time: string
  meta: string
  /** plain-English restatement shown when a trace row is expanded */
  human: string
  spans: Span[]
}

export interface ChangelogEntry {
  id: string
  time: string
  icon: string
  kind: "ctx" | "table"
  title: string
  desc: string
  traceId: string | null
  warn?: boolean
}

/** Static seed for Observability's counters — real run history lives in `runs_log`. */
export interface HistoryEntry {
  specId: SpecId
  time: string
  /** "v1.2 → v1.3" */
  version: string
  approvedBy: string
}

export interface Series {
  data: number[]
  unit: string
}

/* ── Saved visualizations ──────────────────────────────────────────────── */

export interface ColumnPoint {
  label: string
  value: string
  /** bar height in px, straight from the design */
  height: number
  hot?: boolean
}

export interface FunnelRow {
  label: string
  value: string
  width: string
}

/** A saved visualization's rendered form on a mock dashboard tile. */
export interface Answer {
  key: AnswerKey
  short: string
  headline: string
  chartTitle?: string
  funnel?: FunnelRow[]
  columns?: ColumnPoint[]
  /** query wall time shown on a saved dashboard tile */
  queryMs: string
}

/* ── Dashboards ────────────────────────────────────────────────────────── */

export interface DashboardItem {
  key: AnswerKey
}

export interface Dashboard {
  id: number
  name: string
  items: DashboardItem[]
}

/* ── Server state ──────────────────────────────────────────────────────── */

export interface ServerState {
  contextVersion: string
  specStatuses: Record<SpecId, SpecStatus>
  history: HistoryEntry[]
  /** newest first */
  traces: Trace[]
  /** newest first */
  changelog: ChangelogEntry[]
  dashboards: Dashboard[]
  dashboardsRefreshing: boolean
  dashboardsStamp: string
}

export interface ApiConfig {
  speed: SimulationSpeed
}

/** Fired by the server so the shell can surface a toast. */
export type Notice = { message: string }

export interface SpecLoopApi {
  readonly config: ApiConfig

  /* reactive store — read with useSyncExternalStore */
  getState(): ServerState
  subscribe(listener: () => void): () => void
  onNotice(listener: (notice: Notice) => void): () => void

  /* static catalogue */
  getAnswer(key: AnswerKey): Answer
  getSeries(metric: "traces" | "cost" | "tokens"): Series
  getLatencySeries(): number[]

  /* dashboards */
  refreshDashboards(): Promise<void>
  createDashboard(): Promise<number>
  /** returns the id of the board the insight landed on */
  pinToDashboard(dashboardId: number | null, key: AnswerKey): Promise<number>
  removeFromDashboard(dashboardId: number, index: number): Promise<void>
}
