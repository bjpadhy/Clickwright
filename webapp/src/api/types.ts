/**
 * Domain contract for the SpecLoop Console.
 *
 * Everything the UI renders comes through `SpecLoopApi`. The prototype ships a
 * fully in-memory implementation (`src/mock/server.ts`); a real HTTP/SSE client
 * only has to satisfy this same interface.
 */

export type SpecId = "ec" | "ve" | "rf" | "wa" | "tp"

export type AgentKind = "instrumentation" | "analytics" | "context"

export type SpanKind = "llm" | "db" | "tool" | "human"

export type AnswerKey = "express" | "funnel" | "uploads" | "generic"

export type LogTone = "info" | "warn" | "ok"

/** 0 idle · 1 parse · 2 design · 3 approval · 4 execute · 5 context · 6 done */
export type RunStage = 0 | 1 | 2 | 3 | 4 | 5 | 6

export type SpecStatus = "ready" | "done"

export type SimulationSpeed = "instant" | "fast" | "realistic"

/* ── Specs ─────────────────────────────────────────────────────────────── */

export interface Spec {
  id: SpecId
  /** file name under `specs/` */
  file: string
  name: string
  /** e.g. "6 event types · 412,908 sampled events" */
  events: string
}

export interface SpecPreview extends Spec {
  brief: string
  /** raw NDJSON sample lines shown before the run starts */
  ndjson: string[]
}

/* ── Instrumentation run ───────────────────────────────────────────────── */

export interface AgentLogLine {
  icon: string
  text: string
  tone: LogTone
}

export interface Rationale {
  icon: string
  title: string
  text: string
}

export interface MaterializedView {
  name: string
  note: string
}

export interface DiffLine {
  sign: "+" | "~"
  text: string
}

export interface TraceCost {
  id: string
  tokens: string
  cost: string
  duration: string
}

/** The full decision record an instrumentation run produces for one spec. */
export interface RunRecord {
  specId: SpecId
  brief: string
  ndjson: string[]
  log: AgentLogLine[]
  /** appended when a reviewer sends the spec back for changes */
  revisionLog?: AgentLogLine
  ddl: string
  rationale: Rationale[]
  mv: MaterializedView
  exec: string[]
  diff: DiffLine[]
  /** contradiction/gap the Context Agent surfaced — empty when clean */
  warn: string
  trace: TraceCost
  contextTrace: TraceCost
  table: string
  mvShort: string
  backfill: string
  /** per-pipeline-step durations, index-aligned with the 5 steps */
  durations?: string[]
  changelogTable?: string
  changelogContext?: string
}

export interface RunState {
  runId: string
  specId: SpecId
  stage: RunStage
  /** how many agent log lines have streamed in */
  logCount: number
  /** how many execution lines have streamed in */
  execCount: number
  revised: boolean
  versionFrom: string
  versionTo: string
  approvedBy: string
}

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
  run: RunState | null
}

export interface ApiConfig {
  speed: SimulationSpeed
  /** skip the human approval gate (recorded as `auto` in the trace) */
  autoApprove: boolean
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
  listSpecs(): Spec[]
  getSpecPreview(id: SpecId): SpecPreview
  getRunRecord(id: SpecId): RunRecord
  getAnswer(key: AnswerKey): Answer
  matchAnswer(question: string): AnswerKey
  getSeries(metric: "traces" | "cost" | "tokens"): Series
  getLatencySeries(): number[]

  /* instrumentation */
  startRun(specId: SpecId): Promise<void>
  approveRun(): Promise<void>
  requestChanges(note: string): Promise<void>
  resetRun(): Promise<void>

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
