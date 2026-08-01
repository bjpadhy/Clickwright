/**
 * Domain contract for the still-mocked half of the console: Chat, Dashboards
 * and Observability. `SpecLoopApi` is implemented in `src/mock/server.ts`.
 *
 * Instrumentation is not part of this contract — it runs against the real
 * backend through `src/api/instrumentation.ts`.
 */

/** Sample features Observability's storage and table charts are drawn around. */
export type SpecId = "ec" | "ve" | "rf" | "wa" | "tp"

export type AgentKind = "instrumentation" | "analytics" | "context"

export type SpanKind = "llm" | "db" | "tool" | "human"

export type AnswerKey = "express" | "funnel" | "uploads" | "generic"

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

/* ── Analytics answers ─────────────────────────────────────────────────── */

export interface AnswerStep {
  label: string
  /** `{ctx}` is interpolated with the context version the answer ran against */
  detail: string
}

export interface Finding {
  tag: string
  bg: string
  fg: string
  text: string
}

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

export interface Answer {
  key: AnswerKey
  short: string
  traceId: string | null
  steps: AnswerStep[]
  headline: string
  findings: Finding[]
  chartTitle?: string
  funnel?: FunnelRow[]
  columns?: ColumnPoint[]
  confidence: number | null
  confidenceNote?: string
  sql: string | null
  /** query wall time shown on a saved dashboard tile */
  queryMs: string
}

/* ── Chat ──────────────────────────────────────────────────────────────── */

export interface ChatMessage {
  id: number
  role: "user" | "agent"
  /** user messages only */
  text?: string
  /** agent messages only */
  answerKey?: AnswerKey
  /** how many plan steps have completed */
  stepsDone: number
  revealed: boolean
  contextVersion: string
}

export interface Conversation {
  id: number
  title: string
  time: string
  starred: boolean
  messages: ChatMessage[]
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
  conversations: Conversation[]
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
  matchAnswer(question: string): AnswerKey
  getSeries(metric: "traces" | "cost" | "tokens"): Series
  getLatencySeries(): number[]

  /* chat */
  ask(conversationId: number, question: string): Promise<void>
  createConversation(): Promise<number>
  /** returns the id of an empty conversation, creating one if needed */
  openConversation(): Promise<number>
  toggleStar(conversationId: number): Promise<void>

  /* dashboards */
  refreshDashboards(): Promise<void>
  createDashboard(): Promise<number>
  /** returns the id of the board the insight landed on */
  pinToDashboard(dashboardId: number | null, key: AnswerKey): Promise<number>
  removeFromDashboard(dashboardId: number, index: number): Promise<void>
}
