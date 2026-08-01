/**
 * Instrumentation screen state, backed by the real Clickwright backend.
 *
 * The backend owns the pipeline; this provider only mirrors it. Live progress
 * arrives over SSE (`/api/runs/:id/events`), which replays the whole buffer on
 * connect — so a page reload during a 5-minute run rejoins it mid-flight rather
 * than losing it.
 */

import * as React from "react"
import { toast } from "sonner"

import {
  backend,
  openRunStream,
  type CreateRunInput,
  type Health,
  type HistoryRun,
  type RunEvent,
  type RunStatus,
  type RunSummary,
  type SpecOption,
} from "@/api/instrumentation"
import { buildRunModel, type RunModel } from "@/screens/instrumentation/run-model"

const IDENTITY_KEY = "clickwright.identity"

/** Free-text, recorded in the Langfuse trace and `runs_log` for every decision. */
function storedIdentity(): string {
  if (typeof window === "undefined") return ""
  return window.localStorage.getItem(IDENTITY_KEY) ?? ""
}

interface InstrumentationValue {
  /* backend facts */
  health: Health | null
  specs: SpecOption[]
  runs: RunSummary[]
  history: HistoryRun[]
  offline: string | null

  /* the run on screen — `runId` is set before the summary lands */
  runId: string | null
  run: RunSummary | null
  model: RunModel
  /** derived status — events win over the list snapshot */
  status: RunStatus | null
  /** how many runs are ahead of this one in the FIFO queue */
  queuedBehind: number
  streaming: boolean
  /** true while a run is mid-flight, including waiting on a human */
  busy: boolean

  /* starting and switching runs */
  starting: boolean
  /** POSTs the spec (or upload) and attaches the stream to the new run */
  startRun: (input: CreateRunInput) => void
  /** back to the spec form — the run itself keeps going on the server */
  newRun: () => void
  openRun: (runId: string) => void

  /* the gates */
  identity: string
  setIdentity: (value: string) => void
  changeRequestOpen: boolean
  setChangeRequestOpen: (open: boolean) => void
  feedback: string
  setFeedback: (value: string) => void
  deciding: boolean
  approve: () => void
  requestChanges: () => void

  /* history */
  refreshHistory: () => void
  selectedRunId: string | null
  selectRunId: (runId: string | null) => void
}

const InstrumentationContext = React.createContext<InstrumentationValue | null>(null)

export function InstrumentationProvider({ children }: { children: React.ReactNode }) {
  const [health, setHealth] = React.useState<Health | null>(null)
  const [specs, setSpecs] = React.useState<SpecOption[]>([])
  const [runs, setRuns] = React.useState<RunSummary[]>([])
  const [history, setHistory] = React.useState<HistoryRun[]>([])
  const [offline, setOffline] = React.useState<string | null>(null)

  const [runId, setRunId] = React.useState<string | null>(null)
  const [events, setEvents] = React.useState<RunEvent[]>([])
  const [streaming, setStreaming] = React.useState(false)

  const [starting, setStarting] = React.useState(false)

  const [identity, setIdentityState] = React.useState(storedIdentity)
  const [changeRequestOpen, setChangeRequestOpen] = React.useState(false)
  const [feedback, setFeedback] = React.useState("")
  const [deciding, setDeciding] = React.useState(false)

  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)

  const model = React.useMemo(() => buildRunModel(events), [events])
  const run = React.useMemo(
    () => runs.find((item) => item.id === runId) ?? null,
    [runs, runId]
  )
  const status = model.status ?? run?.status ?? null
  const busy =
    status === "queued" || status === "running" || status === "awaiting_approval"

  const refreshRuns = React.useCallback(async () => {
    const list = await backend.listRuns()
    setRuns(list)
    return list
  }, [])

  const refreshHistory = React.useCallback(() => {
    void backend
      .listHistory()
      .then(setHistory)
      .catch((error: unknown) => setOffline(String(error)))
  }, [])

  /* ── first load: health, sample specs, and any run already in flight ──── */

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [healthResult, specList, runList] = await Promise.all([
          backend.health(),
          backend.listSpecs(),
          refreshRuns(),
        ])
        if (cancelled) return
        setHealth(healthResult)
        setSpecs(specList)
        setOffline(null)
        // Rejoin whatever the backend is working on — SSE replays it in full.
        const live = runList.find(
          (item) =>
            item.status === "queued" ||
            item.status === "running" ||
            item.status === "awaiting_approval"
        )
        if (live) setRunId(live.id)
      } catch (error) {
        if (!cancelled) setOffline(error instanceof Error ? error.message : String(error))
      }
    })()
    refreshHistory()
    return () => {
      cancelled = true
    }
  }, [refreshHistory, refreshRuns])

  /* ── the live stream ─────────────────────────────────────────────────── */

  React.useEffect(() => {
    if (!runId) {
      setEvents([])
      setStreaming(false)
      return
    }
    setEvents([])
    setStreaming(true)
    return openRunStream(
      runId,
      (event) =>
        // Reconnects replay the whole buffer; `seq` is dense and authoritative.
        setEvents((current) => {
          if (current.some((item) => item.seq === event.seq)) return current
          return [...current, event].sort((a, b) => a.seq - b.seq)
        }),
      (state) => setStreaming(state === "open")
    )
  }, [runId])

  /* Queue depth only changes server-side, and only matters while queued. */
  React.useEffect(() => {
    if (status !== "queued") return
    const timer = window.setInterval(() => void refreshRuns().catch(() => {}), 4000)
    return () => window.clearInterval(timer)
  }, [status, refreshRuns])

  const queuedBehind = React.useMemo(() => {
    if (status !== "queued" || !run) return 0
    return runs.filter(
      (item) =>
        item.id !== run.id &&
        item.createdAt < run.createdAt &&
        (item.status === "queued" ||
          item.status === "running" ||
          item.status === "awaiting_approval")
    ).length
  }, [runs, run, status])

  /* A finished run refreshes the lists it just changed. */
  const settled = status === "succeeded" || status === "failed"
  React.useEffect(() => {
    if (!settled) return
    void refreshRuns().catch(() => {})
    void backend.listSpecs().then(setSpecs).catch(() => {})
    refreshHistory()
  }, [settled, refreshHistory, refreshRuns])

  // Announce a finish we actually watched happen — not one we replayed into.
  const previousStatus = React.useRef<RunStatus | null>(null)
  React.useEffect(() => {
    const was = previousStatus.current
    previousStatus.current = status
    if (status === "succeeded" && (was === "running" || was === "awaiting_approval"))
      toast.success("Schema live on ClickHouse · context updated")
  }, [status])

  /* ── actions ─────────────────────────────────────────────────────────── */

  const setIdentity = React.useCallback((value: string) => {
    setIdentityState(value)
    window.localStorage.setItem(IDENTITY_KEY, value)
  }, [])

  const startRun = React.useCallback(
    (input: CreateRunInput) => {
      if (starting) return
      setStarting(true)
      void backend
        .createRun(input)
        .then(async (created) => {
          setChangeRequestOpen(false)
          setFeedback("")
          // Fetch the summary first so the run header has a spec name to show.
          await refreshRuns().catch(() => {})
          setRunId(created.id)
          if (created.status === "queued") toast("Queued behind the active run")
        })
        .catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : String(error))
        )
        .finally(() => setStarting(false))
    },
    [starting, refreshRuns]
  )

  const newRun = React.useCallback(() => {
    setRunId(null)
    setChangeRequestOpen(false)
    setFeedback("")
  }, [])

  const openRun = React.useCallback((id: string) => setRunId(id), [])

  const decide = React.useCallback(
    (approved: boolean, note: string) => {
      if (!runId || deciding) return
      setDeciding(true)
      void backend
        .approve(runId, {
          approved,
          identity: identity.trim() || "unnamed reviewer",
          ...(approved ? {} : { feedback: note }),
        })
        .then(() => {
          setChangeRequestOpen(false)
          setFeedback("")
        })
        .catch((error: unknown) => {
          // 409 = the gate moved on without us; the stream already has the truth.
          toast.error(error instanceof Error ? error.message : String(error))
        })
        .finally(() => setDeciding(false))
    },
    [runId, deciding, identity]
  )

  const approve = React.useCallback(() => decide(true, ""), [decide])

  const requestChanges = React.useCallback(() => {
    const note = feedback.trim()
    if (!note) {
      toast("Describe what the agent should change")
      return
    }
    decide(false, note)
  }, [decide, feedback])

  const value: InstrumentationValue = {
    health,
    specs,
    runs,
    history,
    offline,
    runId,
    run,
    model,
    status,
    queuedBehind,
    streaming,
    busy,
    starting,
    startRun,
    newRun,
    openRun,
    identity,
    setIdentity,
    changeRequestOpen,
    setChangeRequestOpen,
    feedback,
    setFeedback,
    deciding,
    approve,
    requestChanges,
    refreshHistory,
    selectedRunId,
    selectRunId: setSelectedRunId,
  }

  return (
    <InstrumentationContext value={value}>{children}</InstrumentationContext>
  )
}

export function useInstrumentation() {
  const value = React.use(InstrumentationContext)
  if (!value)
    throw new Error("useInstrumentation must be used inside <InstrumentationProvider>")
  return value
}
