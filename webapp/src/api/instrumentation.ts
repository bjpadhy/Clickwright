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

/**
 * The three human gates. "optimization" gates an advisor-suggested schema
 * change and its proposal is an `OptimizationProposal`, NOT a `DdlProposal` —
 * anything reading `payload.proposal` has to branch on the gate name. It was
 * missing here, so an optimization run's proposal was cast to the DDL shape
 * and the approval panel rendered against fields that do not exist on it.
 */
export type Gate = "ddl" | "context" | "optimization"

/** A spec run instruments a feature; an optimization run applies an advisor
 *  suggestion. Same queue, same gates, same stream. */
export type RunKind = "spec" | "optimization"

export interface RunSummary {
  /** e.g. "run_msafuwue_a5688b" */
  id: string
  /** spec id, e.g. "02_group_family", or "optimize:<table>" */
  spec: string
  kind: RunKind
  status: RunStatus
  /** set while `status === "awaiting_approval"` */
  pendingGate: Gate | null
  /** Langfuse deep link, set once the run starts */
  traceUrl: string | null
  createdAt: string
  /** server-side path — display only. Empty for optimization runs. */
  specDir: string
  /** set only when `kind === "optimization"` */
  suggestionId: string | null
  /** when execution began — null while queued */
  startedAt: string | null
  finishedAt: string | null
  /** end-to-end ms, gates included — null until the run is over */
  durationMs: number | null
  /** most recent step name, used to attribute progress ticks to a phase */
  currentStep?: string
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

/**
 * The "optimization" gate's proposal: DDL the advisor drafted for one
 * suggestion, not a table design. Statements execute byte-for-byte on approval.
 */
export interface OptimizationProposal {
  reasoning: string
  statements: string[]
  /** what the operator should see change, in plain terms */
  expectedEffect: string
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
  /** "gemini" | "anthropic" | "anthropic-oauth" — absent on older backends */
  llmProvider?: string
  /** free-form: "gemini-openai-compatible" | "anthropic-api" | "claude-code-oauth" */
  llmBackend: string
  model: string
  /** only sent for the OpenAI-compatible (Gemini) backend */
  llmBaseUrl?: string
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
  /** end-to-end ms as the backend measured it, gates included */
  durationMs?: number
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
  onStateChange?: (state: "open" | "reconnecting" | "closed") => void
): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`)
  let closed = false

  const close = () => {
    if (closed) return
    closed = true
    for (const type of RUN_EVENT_TYPES) source.removeEventListener(type, handle)
    source.close()
  }

  const handle = (message: MessageEvent<string>) => {
    let event: RunEvent
    try {
      event = JSON.parse(message.data) as RunEvent
    } catch {
      /* a truncated frame is re-sent on the next replay — ignore it */
      return
    }
    onEvent(event)
    // A finished run emits nothing further, and the server ends the response
    // at this same event. Closing here is what keeps EventSource's automatic
    // reconnect from re-opening the stream, replaying the whole buffer and
    // being closed again, forever.
    if (event.type === "status" && (event.name === "succeeded" || event.name === "failed")) {
      close()
      onStateChange?.("closed")
    }
  }

  for (const type of RUN_EVENT_TYPES) source.addEventListener(type, handle)
  source.addEventListener("open", () => onStateChange?.("open"))
  // EventSource reconnects on its own; a reconnect replays the whole buffer.
  source.addEventListener("error", () => {
    if (!closed) onStateChange?.("reconnecting")
  })

  return close
}
