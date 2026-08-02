/**
 * Instrumentation runs and the context store, as specified in `backend/API.md`.
 *
 * Chat and Changelog talk to the same backend through `src/api/chat.ts` and
 * `src/api/changelog.ts`.
 */

import { post, request } from "./http"

/* ── runs ──────────────────────────────────────────────────────────────── */

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"

export type Gate = "ddl" | "context"

export interface RunSummary {
  /** e.g. "run_msafuwue_a5688b" */
  id: string
  /** spec id, e.g. "02_group_family" */
  spec: string
  status: RunStatus
  /** set while `status === "awaiting_approval"` */
  pendingGate: Gate | null
  /** Langfuse deep link, set once the run starts */
  traceUrl: string | null
  createdAt: string
  /** server-side path — display only */
  specDir: string
}

export interface RunDetail extends RunSummary {
  /** full buffered event log — the same objects the SSE stream sends */
  events: RunEvent[]
}

export type RunEventType =
  | "step_start"
  | "step_end"
  | "step_error"
  | "status"
  | "approval_request"
  | "approval_result"
  | "log"

/** Every named SSE event the backend emits — `onmessage` never fires. */
export const RUN_EVENT_TYPES: RunEventType[] = [
  "step_start",
  "step_end",
  "step_error",
  "status",
  "approval_request",
  "approval_result",
  "log",
]

export interface RunEvent {
  /** 0-based, dense — the ordering and dedupe key */
  seq: number
  ts: string
  type: RunEventType
  /** step name | status value | gate name */
  name: string
  payload: Record<string, unknown>
}

/* ── gate proposals (payload.proposal of an approval_request) ───────────── */

/** Per-table design notes — each field is capped to one or two statements. */
export interface TableRationale {
  ordering_key: string
  partitioning: string
  types_codecs: string
  deviations?: string
}

export interface ProposedTable {
  name: string
  event: string
  purpose: string
  /** the full CREATE TABLE statement, executed byte-for-byte on approval */
  ddl: string
  /** absent on runs recorded before the agent emitted structured rationale */
  rationale?: TableRationale
}

export interface DdlProposal {
  /** markdown, one `##` section per table — the assembled per-table rationale */
  reasoning: string
  tables: ProposedTable[]
}

export interface ContextProposal {
  entries: {
    /** namespaced, e.g. "table:group_started" */
    entity: string
    /** full replacement text */
    definition_md: string
    change_note: string
  }[]
  /** contradictions with existing context — the "contradiction surfaced" chips */
  warnings?: string[]
}

export interface LoadedTable {
  name: string
  event: string
  purpose: string
  rowsInFile: number
  rowsLoaded: number
}

/* ── the rest of the surface ────────────────────────────────────────────── */

export interface Health {
  ok: boolean
  clickhouse: string
  database: string
  /** "claude-code-oauth" | "anthropic-api" */
  llmBackend: string
  model: string
}

export interface SpecOption {
  id: string
  /** pass straight to POST /api/runs */
  specDir: string
  events: number
  eventTypes: number
  /** disables the Use button — the spec is already live */
  alreadyInstrumented: boolean
}

/** One row of `GET /api/history` — survives backend restarts (from runs_log). */
export interface HistoryRun {
  run_id: string
  spec: string
  started: string
  finished: string
  last_status: string
  events: number
}

export interface ContextEntry {
  entity: string
  definition_md: string
  /** 1-based, per entity */
  version: number
  source_spec: string
  change_note: string
  updated_at: string
  /** only present in /history responses */
  run_id?: string
}

export interface ApprovalDecision {
  approved: boolean
  feedback?: string
  /** recorded in the Langfuse trace and runs_log — always sent */
  identity: string
}

export type CreateRunInput =
  | { specDir: string }
  | { name: string; specMd: string; ndjson: string }

export const backend = {
  health: () => request<Health>("/health"),

  /* instrumentation runs */
  listSpecs: () => request<SpecOption[]>("/specs"),
  listRuns: () => request<RunSummary[]>("/runs"),
  getRun: (id: string) => request<RunDetail>(`/runs/${encodeURIComponent(id)}`),
  createRun: (input: CreateRunInput) =>
    post<{ id: string; spec: string; status: RunStatus }>("/runs", input),
  /** Valid only while the run is `awaiting_approval`; 409 means the UI is stale. */
  approve: (id: string, decision: ApprovalDecision) =>
    post<{ ok: true }>(`/runs/${encodeURIComponent(id)}/approve`, decision),

  /* history — the truth across restarts */
  listHistory: () => request<HistoryRun[]>("/history"),
  getHistory: (runId: string) =>
    request<RunEvent[]>(`/history/${encodeURIComponent(runId)}`),

  /* context store */
  listContext: () => request<ContextEntry[]>("/context"),
  contextHistory: (entity: string) =>
    request<ContextEntry[]>(`/context/${encodeURIComponent(entity)}/history`),
}

/**
 * Subscribe to a run's event stream. The server replays every buffered event
 * before streaming live ones, so connecting late — or reconnecting — is safe;
 * callers dedupe by `seq`. Returns an unsubscribe function.
 */
export function openRunStream(
  runId: string,
  onEvent: (event: RunEvent) => void,
  onStateChange?: (state: "open" | "reconnecting") => void
): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`)

  const handle = (message: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(message.data) as RunEvent)
    } catch {
      /* a truncated frame is re-sent on the next replay — ignore it */
    }
  }

  for (const type of RUN_EVENT_TYPES) source.addEventListener(type, handle)
  source.addEventListener("open", () => onStateChange?.("open"))
  // EventSource reconnects on its own; a reconnect replays the whole buffer.
  source.addEventListener("error", () => onStateChange?.("reconnecting"))

  return () => {
    for (const type of RUN_EVENT_TYPES) source.removeEventListener(type, handle)
    source.close()
  }
}
