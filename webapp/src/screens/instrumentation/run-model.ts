/**
 * `RunEvent[]` → everything the Instrumentation screens render.
 *
 * The live run (SSE) and the history report (`GET /api/history/:runId`) receive
 * the exact same event objects, so both screens derive their view from this one
 * function — a finished run replays identically to a live one.
 *
 * Two rules from `backend/API.md` drive the shape:
 *   1. `*_attempt_N` steps collapse into a single stepper node; a `step_error`
 *      on attempt N followed by attempt N+1 is the self-healing retry, and the
 *      error text is shown, not swallowed.
 *   2. A gate can be re-proposed any number of times after a rejection — only
 *      the latest `approval_request` is live, and it dies on `approval_result`.
 */

import type {
  ContextProposal,
  DdlProposal,
  Gate,
  LoadedTable,
  RunEvent,
  RunStatus,
} from "@/api/instrumentation"

/** The five nodes of the pipeline stepper. */
export type PhaseId = "parse" | "design" | "approval" | "execute" | "context"

export type PhaseState = "idle" | "active" | "waiting" | "done" | "error"

export const PHASES: { id: PhaseId; label: string }[] = [
  { id: "parse", label: "Parse spec" },
  { id: "design", label: "Design schema" },
  { id: "approval", label: "Human approval" },
  { id: "execute", label: "Execute DDL" },
  { id: "context", label: "Context update" },
]

/** Backend step name (attempt suffix stripped) → the phase it belongs to. */
const STEP_PHASE: Record<string, PhaseId> = {
  profile: "parse",
  context_load: "parse",
  schema_reconciliation: "parse",
  ddl_generation: "design",
  dry_run: "design",
  approval: "approval",
  ddl_execution: "execute",
  update_generation: "context",
  update_approval: "context",
}

const STEP_LABEL: Record<string, string> = {
  profile: "Profile the event sample",
  context_load: "Load business context",
  schema_reconciliation: "Reconcile context against live schema",
  ddl_generation: "Design tables (LLM)",
  dry_run: "Dry-run every statement on ClickHouse",
  approval: "Human approval — DDL",
  ddl_execution: "Execute DDL + load rows",
  update_generation: "Draft context update (LLM)",
  update_approval: "Human approval — context",
}

/** Wrappers spanning a whole phase — their children carry the detail. */
const WRAPPERS = new Set(["instrumentation", "context_update"])

/**
 * `ddl_table_<event>` steps are the per-event generations that fan out inside
 * one `ddl_generation` attempt — one LLM call per table, all in flight at once.
 * They nest under their parent instead of sitting beside it, or a five-event
 * spec renders six identical spinners stacked in the timeline.
 */
const FANOUT_PREFIX = "ddl_table_"
const FANOUT_PARENT = "ddl_generation"

const GATE_PHASE: Record<Gate, PhaseId> = { ddl: "approval", context: "context" }

export interface Attempt {
  /** `null` for steps that run exactly once (profile, context_load, …) */
  attempt: number | null
  status: "running" | "done" | "error"
  startedAt: string
  endedAt: string | null
  ms: number | null
  /** one-line summary of `step_end` output, when we know how to read it */
  summary: string | null
  /** verbatim failure that fed the next attempt */
  error: string | null
}

export interface StepGroup {
  /** step name with the attempt suffix stripped */
  key: string
  label: string
  phase: PhaseId
  attempts: Attempt[]
  status: "running" | "done" | "error"
  /** parallel sub-steps (the per-event DDL generations) */
  children: StepGroup[]
}

export interface ExecLine {
  ts: string
  kind: string
  text: string
  ok: boolean
  ms: number | null
}

export interface Approval {
  gate: Gate
  approved: boolean
  feedback: string
  identity: string
  ts: string
}

export interface RunResult {
  tables: LoadedTable[]
  contextEntries: { entity: string; version: number }[]
  contextWarnings: string[]
}

export interface RunModel {
  /** last `status` event — `null` until the run leaves the queue */
  status: RunStatus | null
  traceUrl: string | null
  /** the gate a human is blocking on right now */
  pendingGate: Gate | null
  /** latest DDL proposal — survives after the gate closes, for the report */
  ddlProposal: DdlProposal | null
  contextProposal: ContextProposal | null
  /** decisions taken, oldest first */
  approvals: Approval[]
  steps: StepGroup[]
  phases: Record<PhaseId, PhaseState>
  /** per-statement execution progress from `log` events */
  execLog: ExecLine[]
  result: RunResult | null
  error: string | null
  startedAt: string | null
  endedAt: string | null
  /** how many proposals each gate has seen — >1 means a reviewer sent one back */
  proposals: { ddl: number; context: number }
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function splitStep(name: string): { key: string; attempt: number | null } {
  const match = /^(.*)_attempt_(\d+)$/.exec(name)
  return match
    ? { key: match[1]!, attempt: Number(match[2]) }
    : { key: name, attempt: null }
}

export function stepLabel(key: string): string {
  if (key.startsWith(FANOUT_PREFIX)) return key.slice(FANOUT_PREFIX.length)
  return STEP_LABEL[key] ?? key.replace(/_/g, " ")
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function count(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null
}

/** A short, honest one-liner per step — never invents numbers it can't read. */
function summarize(key: string, output: unknown): string | null {
  const out = record(output)

  if (key.startsWith(FANOUT_PREFIX)) {
    const name = out?.["name"]
    return typeof name === "string" ? `→ ${name}` : null
  }

  switch (key) {
    case "profile": {
      const fields = count(out?.["newFields"])
      return fields === null ? null : `${fields} field(s) outside the envelope`
    }
    case "context_load": {
      const summary = record(out?.["summary"])
      if (!summary) return null
      const updated = count(summary["updatedEntries"]) ?? 0
      return `${String(summary["entities"] ?? "?")} context entries · ${updated} previously updated`
    }
    case "schema_reconciliation": {
      if (!out) return null
      const live = count(out["liveTables"]) ?? 0
      const stale = count(out["documentedNotLive"]) ?? 0
      const undocumented = count(out["liveNotDocumented"]) ?? 0
      const drift = [
        stale ? `${stale} documented but missing` : "",
        undocumented ? `${undocumented} live but undocumented` : "",
      ].filter(Boolean)
      return `${live} live tables${drift.length ? ` · ${drift.join(" · ")}` : " · no drift"}`
    }
    case "ddl_generation": {
      const tables = count(out?.["tables"])
      return tables === null ? null : `${tables} table(s) proposed`
    }
    case "dry_run": {
      const passed = out?.["passed"]
      return typeof passed === "number" ? `${passed} statement(s) parsed` : null
    }
    case "ddl_execution": {
      if (!Array.isArray(output)) return null
      const tables = output as LoadedTable[]
      const rows = tables.reduce((sum, table) => sum + (table.rowsLoaded ?? 0), 0)
      return `${tables.length} table(s) live · ${rows.toLocaleString()} rows loaded`
    }
    case "update_generation": {
      const entries = count(out?.["entries"])
      return entries === null ? null : `${entries} context entr(y/ies) drafted`
    }
    case "approval":
    case "update_approval": {
      if (!out) return null
      return out["approved"] === true
        ? "approved"
        : `changes requested${out["feedback"] ? ` — "${String(out["feedback"])}"` : ""}`
    }
    default:
      return null
  }
}

/* ── the derivation ────────────────────────────────────────────────────── */

export function buildRunModel(events: RunEvent[]): RunModel {
  const groups = new Map<string, StepGroup>()
  const approvals: Approval[] = []
  const execLog: ExecLine[] = []

  let status: RunStatus | null = null
  let traceUrl: string | null = null
  let pendingGate: Gate | null = null
  let ddlProposal: DdlProposal | null = null
  let contextProposal: ContextProposal | null = null
  let result: RunResult | null = null
  let error: string | null = null
  let endedAt: string | null = null
  const proposals = { ddl: 0, context: 0 }

  for (const event of events) {
    const { key, attempt } = splitStep(event.name)

    switch (event.type) {
      case "step_start": {
        if (WRAPPERS.has(event.name)) break
        const group = groups.get(key) ?? {
          key,
          label: stepLabel(key),
          phase: key.startsWith(FANOUT_PREFIX)
            ? ("design" as PhaseId)
            : (STEP_PHASE[key] ?? "parse"),
          attempts: [],
          status: "running" as const,
          children: [],
        }
        group.attempts.push({
          attempt,
          status: "running",
          startedAt: event.ts,
          endedAt: null,
          ms: null,
          summary: null,
          error: null,
        })
        group.status = "running"
        groups.set(key, group)
        break
      }

      case "step_end":
      case "step_error": {
        if (WRAPPERS.has(event.name)) break
        const group = groups.get(key)
        // Close the oldest attempt still open, not simply the last one: when a
        // fan-out attempt fails, `Promise.all` rejects immediately but its
        // siblings keep running, so the next attempt's step_start can arrive
        // before the previous attempt's step_end. Closing `.at(-1)` there would
        // strand an attempt as "running" for the rest of the run.
        const current = group?.attempts.find((a) => a.status === "running")
        if (!group || !current) break
        current.endedAt = event.ts
        current.ms = Date.parse(event.ts) - Date.parse(current.startedAt)
        if (event.type === "step_end") {
          current.status = "done"
          current.summary = summarize(key, event.payload["output"])
        } else {
          current.status = "error"
          current.error = String(event.payload["error"] ?? "unknown error")
        }
        // The group reflects its newest attempt, which may not be this one.
        group.status = group.attempts.at(-1)!.status
        break
      }

      case "approval_request": {
        const gate = event.name as Gate
        const proposal = event.payload["proposal"]
        if (gate === "ddl") {
          ddlProposal = proposal as DdlProposal
          proposals.ddl++
        } else {
          contextProposal = proposal as ContextProposal
          proposals.context++
        }
        pendingGate = gate
        break
      }

      case "approval_result": {
        approvals.push({
          gate: event.name as Gate,
          approved: event.payload["approved"] === true,
          feedback: String(event.payload["feedback"] ?? ""),
          identity: String(event.payload["identity"] ?? ""),
          ts: event.ts,
        })
        pendingGate = null
        break
      }

      case "log": {
        const p = event.payload
        const ms = typeof p["ms"] === "number" ? p["ms"] : null
        const text =
          event.name === "data_load"
            ? `${String(p["table"] ?? "")} ← ${Number(p["rows"] ?? 0).toLocaleString()} rows`
            : String(p["statement"] ?? event.name)
        execLog.push({ ts: event.ts, kind: event.name, text, ok: p["ok"] !== false, ms })
        break
      }

      case "status": {
        status = event.name as RunStatus
        if (typeof event.payload["traceUrl"] === "string")
          traceUrl = event.payload["traceUrl"]
        if (status === "awaiting_approval") {
          pendingGate = (event.payload["gate"] as Gate | undefined) ?? pendingGate
        } else if (status === "running") {
          pendingGate = null
        } else if (status === "succeeded") {
          endedAt = event.ts
          result = {
            tables: (event.payload["tables"] as LoadedTable[] | undefined) ?? [],
            contextEntries:
              (event.payload["contextEntries"] as RunResult["contextEntries"]) ?? [],
            contextWarnings: (event.payload["contextWarnings"] as string[]) ?? [],
          }
        } else if (status === "failed") {
          endedAt = event.ts
          error = String(event.payload["error"] ?? "run failed")
        }
        break
      }
    }
  }

  // A terminal run has no live steps. A fan-out sibling whose step_end was
  // dropped (or never emitted, because a failed attempt abandoned it) would
  // otherwise spin forever under a finished pipeline — so settle the orphans
  // against the run's own outcome rather than leaving a lying spinner.
  if (status === "succeeded" || status === "failed") {
    const settled = status === "succeeded" ? "done" : "error"
    for (const group of groups.values()) {
      for (const attempt of group.attempts) {
        if (attempt.status === "running") attempt.status = settled
      }
      group.status = group.attempts.at(-1)?.status ?? group.status
    }
  }

  // Fan-out generations belong inside the attempt that spawned them.
  const all = [...groups.values()]
  const steps = all.filter((step) => !step.key.startsWith(FANOUT_PREFIX))
  const fanout = all.filter((step) => step.key.startsWith(FANOUT_PREFIX))
  const parent = steps.find((step) => step.key === FANOUT_PARENT)
  if (parent) parent.children = fanout
  else steps.push(...fanout) // parent missing (partial replay) — don't hide them

  return {
    status,
    traceUrl,
    pendingGate,
    ddlProposal,
    contextProposal,
    approvals,
    steps,
    phases: derivePhases(steps, status, pendingGate),
    execLog,
    result,
    error,
    startedAt: events[0]?.ts ?? null,
    endedAt,
    proposals,
  }
}

/**
 * A rejected gate sends the agent back to the previous phase, so "furthest
 * phase reached" would lie. The active phase is the one with the newest
 * activity — walking backwards is exactly what the reviewer just caused.
 */
function derivePhases(
  steps: StepGroup[],
  status: RunStatus | null,
  pendingGate: Gate | null
): Record<PhaseId, PhaseState> {
  const phases = Object.fromEntries(
    PHASES.map((phase) => [phase.id, "idle" as PhaseState])
  ) as Record<PhaseId, PhaseState>

  if (status === "succeeded") {
    for (const phase of PHASES) phases[phase.id] = "done"
    return phases
  }

  const order = PHASES.map((phase) => phase.id)
  const running = new Set(
    steps.filter((step) => step.status === "running").map((step) => step.phase)
  )
  const touched = new Set(steps.map((step) => step.phase))
  const active = running.size
    ? Math.max(...[...running].map((phase) => order.indexOf(phase)))
    : Math.max(-1, ...[...touched].map((phase) => order.indexOf(phase)))

  const waitingPhase = pendingGate ? GATE_PHASE[pendingGate] : null

  order.forEach((phase, index) => {
    if (index < active) phases[phase] = "done"
    else if (index > active) phases[phase] = "idle"
    else if (phase === waitingPhase) phases[phase] = "waiting"
    else if (status === "failed") phases[phase] = "error"
    else phases[phase] = running.size ? "active" : "done"
  })

  return phases
}

/** `1.4s` / `2m 07s` — durations are the only proof a step did real work. */
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return ""
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`
}

/** Total wall time of a phase, summing every attempt of every step in it. */
export function phaseDuration(steps: StepGroup[], phase: PhaseId): string {
  const total = steps
    .filter((step) => step.phase === phase)
    .flatMap((step) => step.attempts)
    .reduce((sum, attempt) => sum + (attempt.ms ?? 0), 0)
  return total > 0 ? formatMs(total) : ""
}
