/**
 * Chat — the Analytics Agent as a conversation, against the real backend
 * (`backend/API.md` § Chat).
 *
 * Conversations and every finished answer live in ClickHouse, so reopening a
 * conversation re-renders its insight cards with no recompute. Only the answer
 * currently being written streams.
 */

import type { ContextEntry } from "./instrumentation"
import { del, post, request, streamPost } from "./http"

/* ── the insight ───────────────────────────────────────────────────────── */

/**
 * How to render a number. Derived in code from the source query's column names
 * and value ranges — never asked of the model — so the same rate reads the same
 * way across answers. Values themselves are left exactly as the SQL produced
 * them, which is what keeps every number traceable to a result set.
 */
export type ValueFormat =
  | "fraction"
  | "percent"
  | "percentage_points"
  | "count"
  | "ms"
  | "seconds"
  | "currency"
  | "number"

export interface InsightChart {
  kind: "bar" | "line"
  series: { label: string; value: number }[]
  /** id of the task whose query produced the series */
  sourceTask: string
  valueFormat?: ValueFormat
}

export interface InsightTable {
  columns: string[]
  rows: (string | number)[][]
  sourceTask: string
  /** parallel to `columns`; `"text"` for non-numeric ones */
  columnFormats?: (ValueFormat | "text")[]
}

export interface InsightSql {
  task: string
  title: string
  query: string
  /** rows this query returned */
  rowCount: number
  /** rows the analysis covered — larger than `rowCount` when the result was too
   * big to fetch and was profiled in ClickHouse instead. Absent for small results. */
  totalRows?: number
}

/** The visual, and the basis it was computed on. */
export interface InsightEvidence {
  /** what the visual shows, including population/ordering/window */
  title: string
  chart: InsightChart | null
  segmentTable: InsightTable | null
}

/**
 * An answer, in the order a PM reads it.
 *
 * The sections are separate keys rather than a tagged list of findings so that
 * none of them can be skipped: an answer that never says WHY cannot satisfy the
 * schema. Everything but `headline` and `confidence` is prose written by the
 * narrator, and every number in it has been checked against a SQL result set.
 */
export interface Insight {
  /** one sentence, carrying the key number */
  headline: string
  /** the effect, in numbers: how big, over what population, where */
  whatsHappening: string
  /** the mechanism behind it — never the measurement restated */
  whyItHappens: string
  evidence: InsightEvidence
  /** retrieved knowledge bearing on the answer; `""` when nothing applies */
  groundedInContext: string
  /** the decision this implies, and what it should move */
  recommendedAction: string
  /** Computed in code from measured precision, gate flags and an independent
   * verification query — never the model's opinion. `score` is the same
   * judgement on a 0–1 scale, for the meter. */
  confidence: { value: "high" | "medium" | "low"; score: number; note: string }
  /** e.g. "44 entities · max v2" */
  contextVersion: string
  sql: InsightSql[]
  /** true ⇒ served from `insight_cache`, no LLM ran */
  cached?: boolean
}

/* ── conversations ─────────────────────────────────────────────────────── */

export interface ChatMessage {
  role: "user" | "agent"
  ts: string
  /** role = user */
  text?: string
  /** role = agent — null when that turn failed */
  insight?: Insight | null
  /** role = agent */
  traceUrl?: string
}

export interface ConversationSummary {
  id: string
  title: string
  /** ClickHouse UInt8 */
  starred: number
  /** "YYYY-MM-DD HH:MM:SS.mmm", UTC */
  updatedAt: string
  /** the latest user question */
  preview: string
  /** turn count, user + agent */
  messages: number
}

export interface Suggestion {
  spec: string
  question: string
}

/* ── the answer stream ─────────────────────────────────────────────────── */

export type ChatEventKind = "step_start" | "step_end" | "step_error" | "log"

/** One agent step (or progress tick), stamped on arrival — the chat stream is
 * live-only, so unlike run events these carry no server `seq`/`ts`. */
export interface ChatEvent {
  kind: ChatEventKind
  name: string
  payload: Record<string, unknown>
  at: number
}

export interface AskHandlers {
  onStart?: (start: { traceUrl: string; convId: string }) => void
  onEvent?: (event: ChatEvent) => void
  onInsight?: (insight: Insight, traceUrl: string) => void
  onFailed?: (error: string) => void
}

const STEP_KINDS = new Set<string>(["step_start", "step_end", "step_error", "log"])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/**
 * Ask a question and stream the answer. Resolves when the stream closes — the
 * backend always sends `done`, success or failure. Reject the returned promise
 * only for transport failures; an agent failure arrives as `onFailed`.
 */
export async function askQuestion(
  convId: string,
  question: string,
  handlers: AskHandlers,
  signal?: AbortSignal
): Promise<void> {
  await streamPost(
    `/conversations/${encodeURIComponent(convId)}/messages`,
    { question },
    ({ event, data }) => {
      const body = record(data)
      if (event === "start") {
        handlers.onStart?.({
          traceUrl: String(body["traceUrl"] ?? ""),
          convId: String(body["convId"] ?? convId),
        })
      } else if (STEP_KINDS.has(event)) {
        handlers.onEvent?.({
          kind: event as ChatEventKind,
          name: String(body["name"] ?? ""),
          payload: record(body["payload"]),
          at: Date.now(),
        })
      } else if (event === "insight") {
        handlers.onInsight?.(body["insight"] as Insight, String(body["traceUrl"] ?? ""))
      } else if (event === "failed") {
        handlers.onFailed?.(String(body["error"] ?? "the answer could not be produced"))
      }
      // `done` needs no handler — streamPost resolves when the body closes.
    },
    signal
  )
}

/* ── endpoints ─────────────────────────────────────────────────────────── */

export const chat = {
  listConversations: () => request<ConversationSummary[]>("/conversations"),

  createConversation: (title?: string) =>
    post<{ id: string }>("/conversations", title ? { title } : {}).then((r) => r.id),

  getConversation: (id: string) =>
    request<{ id: string; messages: ChatMessage[] }>(
      `/conversations/${encodeURIComponent(id)}`
    ),

  setStarred: (id: string, starred: boolean) =>
    post<{ ok: true }>(`/conversations/${encodeURIComponent(id)}/star`, { starred }),

  /** Irreversible: the conversation is hidden and its turns are removed. */
  deleteConversation: (id: string) =>
    del<{ ok: true }>(`/conversations/${encodeURIComponent(id)}`),

  /** Chips on the empty state — the PM questions from instrumented specs. */
  suggestions: () => request<Suggestion[]>("/suggestions"),

  /**
   * The badge under the composer. Derived the same way the agent derives it, so
   * the footer and the card on an answer agree.
   */
  contextSummary: async (): Promise<string> => {
    const entries = await request<ContextEntry[]>("/context")
    if (entries.length === 0) return ""
    const maxVersion = Math.max(...entries.map((entry) => entry.version))
    return `${entries.length} entities · max v${maxVersion}`
  }
}
