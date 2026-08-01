/**
 * `ChatEvent[]` → the live progress panel shown while an answer is being
 * written.
 *
 * A fresh answer takes 40–70s with long silences inside single LLM calls, so
 * the panel's job is to stay honest about what is happening: which step is
 * running, how many attempts it has taken, and how long the in-flight model
 * call has been going (`log` ticks arrive every 3s).
 *
 * Two shapes from `backend/API.md` drive it:
 *   1. `*_attempt_N` steps collapse into one node — attempt 2 of `narrate`
 *      means the citation check rejected a number, which is worth showing.
 *   2. `task_<id>` steps run CONCURRENTLY and their `sql_attempt_N` children
 *      interleave. The child's own name carries no task, so attribution comes
 *      from `payload.input.task` (the task title) matching the parent's.
 */

import type { ChatEvent } from "@/api/chat"

export type ChatStepStatus = "running" | "done" | "error"

export interface ChatStep {
  /** step name with any `_attempt_N` suffix stripped */
  key: string
  label: string
  status: ChatStepStatus
  /** >1 means the step was retried — the self-healing loop, not a bug */
  attempts: number
  startedAt: number
  /** wall time once finished */
  ms: number | null
  /** one-line summary of the step's output, when we know how to read it */
  detail: string | null
  /** verbatim failure that fed the retry */
  error: string | null
  /** why the PREVIOUS attempt failed, when the step is on attempt > 1 */
  retryNote: string | null
  children: ChatStep[]
}

export interface InFlightCall {
  call: string
  label: string
  /** client clock, so the UI can tick between the 3s server ticks */
  startedAt: number
}

export interface ChatProgress {
  steps: ChatStep[]
  /** model calls in flight right now, for "writing SQL… 14s" */
  inFlight: InFlightCall[]
  /** true once `cache_lookup` returned an answer — the run ends there */
  cacheHit: boolean
}

const WRAPPER = "analytics"
const TASK_PREFIX = "task_"
const SQL_PREFIX = "sql_attempt_"

const STEP_LABEL: Record<string, string> = {
  context_load: "Load business context",
  cache_lookup: "Check the answer cache",
  plan: "Plan the analysis (LLM)",
  sanity_gate: "Sanity-check the results",
  context_lookup: "Look for known issues",
  narrate: "Compose the insight (LLM)",
  quality_gate: "Quality gate",
  narrate_revision: "Revise the narration",
}

/** `sql_<task>` / `plan` / `narrate` — the `call` on an llm progress tick. */
const CALL_LABEL: Record<string, string> = {
  plan: "planning the analysis",
  narrate: "writing the insight",
  quality: "reviewing the answer",
  context_lookup: "retrieving known issues",
}

function callLabel(call: string): string {
  if (call.startsWith("sql_")) return `writing SQL · ${call.slice(4)}`
  return CALL_LABEL[call] ?? call.replace(/_/g, " ")
}

function splitStep(name: string): { key: string; attempt: number | null } {
  const match = /^(.*)_attempt_(\d+)$/.exec(name)
  return match ? { key: match[1]!, attempt: Number(match[2]) } : { key: name, attempt: null }
}

export function stepLabel(key: string): string {
  if (key.startsWith(TASK_PREFIX)) return key.slice(TASK_PREFIX.length).replace(/_/g, " ")
  return STEP_LABEL[key] ?? key.replace(/_/g, " ")
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A short, honest one-liner per step — never invents a number it can't read. */
function summarize(key: string, output: unknown): string | null {
  const out = record(output)

  if (key.startsWith(TASK_PREFIX) || key === "sql") {
    if (!out) return null
    const rows = Array.isArray(out["rows"]) ? out["rows"].length : null
    if (typeof out["dropped"] === "string") return `dropped — ${out["dropped"]}`
    return rows === null ? null : `${rows} aggregate row${rows === 1 ? "" : "s"}`
  }

  switch (key) {
    case "context_load": {
      const version = out?.["contextVersion"]
      const live = out?.["liveTables"]
      const tables = Array.isArray(live) ? `${live.length} live tables` : ""
      return [typeof version === "string" ? version : "", tables].filter(Boolean).join(" · ") || null
    }
    case "cache_lookup":
      return out ? "hit — answered from cache" : "miss"
    case "plan": {
      const tasks = Array.isArray(out?.["tasks"]) ? (out["tasks"] as unknown[]).length : null
      return tasks === null ? null : `${tasks} task${tasks === 1 ? "" : "s"}`
    }
    case "sanity_gate": {
      const notes = Array.isArray(out?.["notes"]) ? (out["notes"] as unknown[]).length : null
      if (notes === null) return null
      return notes === 0 ? "clean" : `${notes} result${notes === 1 ? "" : "s"} dropped or flagged`
    }
    case "context_lookup": {
      const entries = Array.isArray(out?.["entries"]) ? (out["entries"] as unknown[]).length : null
      return entries === null ? null : `${entries} entr${entries === 1 ? "y" : "ies"} retrieved`
    }
    case "narrate":
    case "narrate_revision": {
      const confidence = record(out?.["confidence"])?.["value"]
      return typeof confidence === "string" ? `confidence ${confidence}` : null
    }
    case "quality_gate": {
      const verdict = out?.["verdict"]
      return typeof verdict === "string" ? verdict : null
    }
    default:
      return null
  }
}

/**
 * The task title a `sql_attempt_N` carries — its only link to a parent, since
 * the step name itself is just the attempt number and tasks run concurrently.
 * `step_start` carries it as `input.task`, `step_end` as `output.title`;
 * `step_error` carries neither, which is why a failed attempt is read off the
 * NEXT attempt's `input.feedback` instead of the error frame.
 */
function taskTitleOf(payload: Record<string, unknown>, field: "input" | "output"): string | null {
  const inner = record(payload[field])
  const title = inner?.["task"] ?? inner?.["title"]
  return typeof title === "string" ? title : null
}

export function buildChatProgress(events: ChatEvent[]): ChatProgress {
  const steps = new Map<string, ChatStep>()
  /** task title → `task_<id>` key, so an interleaved SQL child finds its parent */
  const taskByTitle = new Map<string, string>()
  /** the SQL child currently open per task, so its end closes the right one */
  const openSql = new Map<string, ChatStep>()
  const inFlight = new Map<string, InFlightCall>()
  let cacheHit = false

  const open = (key: string, attempt: number | null, at: number): ChatStep => {
    const existing = steps.get(key)
    if (existing) {
      // A later attempt supersedes the earlier one in place: the attempt count
      // and the kept failure text carry the retry story without stacking rows.
      existing.retryNote = existing.error
      existing.attempts = attempt ?? existing.attempts + 1
      existing.status = "running"
      existing.startedAt = at
      existing.ms = null
      existing.detail = null
      existing.error = null
      return existing
    }
    const step: ChatStep = {
      key,
      label: stepLabel(key),
      status: "running",
      attempts: attempt ?? 1,
      startedAt: at,
      ms: null,
      detail: null,
      error: null,
      retryNote: null,
      children: [],
    }
    steps.set(key, step)
    return step
  }

  for (const event of events) {
    if (event.name === WRAPPER) continue

    if (event.kind === "log") {
      const call = String(event.payload["call"] ?? "")
      if (!call) continue
      if (event.name === "llm_done") {
        inFlight.delete(call)
      } else if (!inFlight.has(call)) {
        // `llm_progress` carries the server's elapsed time; anchoring the client
        // clock to it keeps a stream joined mid-call honest.
        const elapsed = Number(event.payload["elapsedMs"] ?? 0)
        inFlight.set(call, {
          call,
          label: callLabel(call),
          startedAt: event.at - (Number.isFinite(elapsed) ? elapsed : 0),
        })
      }
      continue
    }

    // ── the per-task SQL children ──
    if (event.name.startsWith(SQL_PREFIX)) {
      // A `step_error` here identifies no task, so it is skipped: the failure
      // text reappears verbatim as the next attempt's `input.feedback`, and a
      // task that never recovers is settled when its parent closes.
      if (event.kind === "step_error") continue

      const attempt = Number(event.name.slice(SQL_PREFIX.length))
      const isStart = event.kind === "step_start"
      const title = taskTitleOf(event.payload, isStart ? "input" : "output") ?? ""
      const parentKey = taskByTitle.get(title)
      const parent = parentKey ? steps.get(parentKey) : undefined
      if (!parent) continue // parent not seen yet — the panel shows the task alone

      if (isStart) {
        const feedback = record(event.payload["input"])?.["feedback"]
        const child: ChatStep = {
          key: "sql",
          label: "Write + run SQL",
          status: "running",
          attempts: attempt,
          startedAt: event.at,
          ms: null,
          detail: null,
          error: null,
          retryNote: typeof feedback === "string" && feedback ? feedback : null,
          children: [],
        }
        parent.children = [child]
        openSql.set(parent.key, child)
      } else {
        const child = openSql.get(parent.key)
        if (!child) continue
        child.ms = event.at - child.startedAt
        child.status = "done"
        child.detail = summarize("sql", event.payload["output"])
      }
      continue
    }

    const { key, attempt } = splitStep(event.name)

    if (event.kind === "step_start") {
      const step = open(key, attempt, event.at)
      if (key.startsWith(TASK_PREFIX)) {
        const title = taskTitleOf(event.payload, "input")
        if (title) taskByTitle.set(title, key)
        step.label = title ?? step.label
      }
      continue
    }

    const step = steps.get(key)
    if (!step) continue
    step.ms = event.at - step.startedAt
    if (event.kind === "step_end") {
      step.status = "done"
      step.detail = summarize(key, event.payload["output"])
      if (key === "cache_lookup" && record(event.payload["output"])) cacheHit = true
    } else {
      step.status = "error"
      step.error = String(event.payload["error"] ?? "unknown error")
    }

    // A task closing settles the SQL attempt underneath it. The last attempt of
    // a task that gave up errors out with no `step_end` of its own, so without
    // this its child would spin under a finished parent.
    if (key.startsWith(TASK_PREFIX)) {
      const child = openSql.get(key)
      if (child?.status === "running") {
        child.ms = event.at - child.startedAt
        const dropped = record(event.payload["output"])?.["dropped"]
        child.status = typeof dropped === "string" || event.kind === "step_error" ? "error" : "done"
        child.error =
          typeof dropped === "string" ? dropped : (child.error ?? step.error ?? null)
      }
    }
  }

  return { steps: [...steps.values()], inFlight: [...inFlight.values()], cacheHit }
}

/** `1.4s` / `2m 07s` — a step's duration is the proof it did real work. */
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return ""
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`
}
