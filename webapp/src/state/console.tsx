/**
 * Client-side console state: which screen is open, which filters are set, what
 * is typed into a form. Everything that would survive a page reload on a real
 * deployment lives on the server (`src/api`), not here.
 */

import * as React from "react"
import { toast } from "sonner"

import { api } from "@/api/client"
import type { AgentKind, AnswerKey, ServerState, SpecId } from "@/api/types"

export type NavId = "chat" | "instr" | "obs" | "dash"
export type InstrTab = "run" | "hist"
export type ObsTab = "traces" | "stack" | "log"
export type TraceFilter = "all" | AgentKind
export type QueryFilter = "all" | "analytics" | "instrumentation"
export type LogFilter = "all" | "table" | "ctx"
export type ActivityMetric = "traces" | "cost" | "tokens"
export type ChartView = "bars" | "line"

const subscribe = (listener: () => void) => api.subscribe(listener)
const getSnapshot = () => api.getState()

export function useServerState(): ServerState {
  return React.useSyncExternalStore(subscribe, getSnapshot)
}

interface ConsoleContextValue {
  server: ServerState

  nav: NavId
  goto: (nav: NavId) => void

  /* instrumentation */
  instrTab: InstrTab
  setInstrTab: (tab: InstrTab) => void
  selectedHistory: SpecId
  setSelectedHistory: (id: SpecId) => void
  pendingSpec: SpecId | null
  specInput: string
  onSpecInput: (value: string) => void
  loadSample: (id: SpecId) => void
  clearPending: () => void
  runPipeline: () => void
  approve: () => void
  changeRequestOpen: boolean
  openChangeRequest: () => void
  changeText: string
  setChangeText: (value: string) => void
  submitChangeRequest: () => void
  viewReport: () => void
  askAboutFeature: () => void
  /** true while a run is mid-flight (stage 1–5) */
  busy: boolean
  /** 0 when nothing is running */
  stage: number

  /* observability */
  obsTab: ObsTab
  setObsTab: (tab: ObsTab) => void
  traceFilter: TraceFilter
  setTraceFilter: (filter: TraceFilter) => void
  openTrace: string | null
  toggleTrace: (id: string) => void
  showTrace: (id: string) => void
  activityMetric: ActivityMetric
  setActivityMetric: (metric: ActivityMetric) => void
  activityView: ChartView
  setActivityView: (view: ChartView) => void
  latencyView: ChartView
  setLatencyView: (view: ChartView) => void
  queryFilter: QueryFilter
  setQueryFilter: (filter: QueryFilter) => void
  logFilter: LogFilter
  setLogFilter: (filter: LogFilter) => void

  /* dashboards */
  activeDashboard: number
  selectDashboard: (id: number) => void
  refreshDashboards: () => void
  createDashboard: () => void
  removeFromDashboard: (dashboardId: number, index: number) => void

  /* chat */
  activeConversation: number
  setActiveConversation: (id: number) => void
  chatInput: string
  setChatInput: (value: string) => void
  send: (question?: string) => void
  newConversation: () => void
  toggleStar: (id: number) => void
  pinToDashboard: (key: AnswerKey) => void
  sqlOpen: Record<number, boolean>
  toggleSql: (messageId: number) => void
  chartMode: Record<number, "chart" | "table">
  setChartMode: (messageId: number, mode: "chart" | "table") => void
}

const ConsoleContext = React.createContext<ConsoleContextValue | null>(null)

export function ConsoleProvider({ children }: { children: React.ReactNode }) {
  const server = useServerState()

  const [nav, setNav] = React.useState<NavId>("chat")
  const [instrTab, setInstrTab] = React.useState<InstrTab>("run")
  const [selectedHistory, setSelectedHistory] = React.useState<SpecId>("wa")
  const [pendingSpec, setPendingSpec] = React.useState<SpecId | null>(null)
  const [specInput, setSpecInput] = React.useState("")
  const [changeRequestOpen, setChangeRequestOpen] = React.useState(false)
  const [changeText, setChangeText] = React.useState("")

  const [obsTab, setObsTab] = React.useState<ObsTab>("traces")
  const [traceFilter, setTraceFilter] = React.useState<TraceFilter>("all")
  const [openTrace, setOpenTrace] = React.useState<string | null>(null)
  const [activityMetric, setActivityMetric] = React.useState<ActivityMetric>("traces")
  const [activityView, setActivityView] = React.useState<ChartView>("bars")
  const [latencyView, setLatencyView] = React.useState<ChartView>("bars")
  const [queryFilter, setQueryFilter] = React.useState<QueryFilter>("all")
  const [logFilter, setLogFilter] = React.useState<LogFilter>("all")

  const [activeDashboard, setActiveDashboard] = React.useState(1)
  const [activeConversation, setActiveConversation] = React.useState(2)
  const [chatInput, setChatInput] = React.useState("")
  const [sqlOpen, setSqlOpen] = React.useState<Record<number, boolean>>({})
  const [chartMode, setChartMode] = React.useState<Record<number, "chart" | "table">>({})

  const run = server.run
  const stage = run?.stage ?? 0
  const busy = stage > 0 && stage < 6

  /* server-pushed toasts */
  React.useEffect(() => api.onNotice(({ message }) => toast.success(message)), [])

  const refreshDashboards = React.useCallback(() => {
    setNav("dash")
    void api.refreshDashboards()
  }, [])

  const openChat = React.useCallback(() => {
    void api.openConversation().then((id) => {
      setNav("chat")
      setActiveConversation(id)
    })
  }, [])

  const goto = React.useCallback(
    (next: NavId) => {
      if (next === "chat") return openChat()
      if (next === "dash") return refreshDashboards()
      setNav(next)
    },
    [openChat, refreshDashboards]
  )

  /* ── instrumentation ───────────────────────────────────────────────── */

  const loadSample = React.useCallback((id: SpecId) => {
    setPendingSpec(id)
    setSpecInput("")
  }, [])

  // A pasted brief is only matched to a known spec when the run starts, so the
  // textarea stays editable while you type.
  const onSpecInput = React.useCallback((value: string) => setSpecInput(value), [])

  const clearPending = React.useCallback(() => {
    setPendingSpec(null)
    setSpecInput("")
  }, [])

  const runPipeline = React.useCallback(() => {
    const specId = pendingSpec ?? (specInput.trim() ? "ec" : null)
    if (!specId) {
      toast("Paste a spec or pick a sample first")
      return
    }
    if (busy) return
    setPendingSpec(specId)
    setChangeRequestOpen(false)
    void api.startRun(specId)
  }, [busy, pendingSpec, specInput])

  const approve = React.useCallback(() => {
    setChangeRequestOpen(false)
    void api.approveRun()
  }, [])

  const submitChangeRequest = React.useCallback(() => {
    const note = changeText
    setChangeRequestOpen(false)
    setChangeText("")
    void api.requestChanges(note)
  }, [changeText])

  const goNewSpec = React.useCallback(() => {
    setInstrTab("run")
    if (busy) return
    setPendingSpec(null)
    setSpecInput("")
    setChangeRequestOpen(false)
    void api.resetRun()
  }, [busy])

  const viewReport = React.useCallback(() => {
    if (run) setSelectedHistory(run.specId)
    setNav("instr")
    setInstrTab("hist")
  }, [run])

  const askAboutFeature = React.useCallback(() => {
    void api.createConversation().then((id) => {
      setNav("chat")
      setActiveConversation(id)
      window.setTimeout(
        () => void api.ask(id, "How is Express Checkout performing since launch?"),
        350
      )
    })
  }, [])

  /* ── observability ─────────────────────────────────────────────────── */

  const toggleTrace = React.useCallback((id: string) => {
    setOpenTrace((current) => (current === id ? null : id))
  }, [])

  const showTrace = React.useCallback((id: string) => {
    setNav("obs")
    setObsTab("traces")
    setTraceFilter("all")
    setOpenTrace(id)
  }, [])

  /* ── dashboards ────────────────────────────────────────────────────── */

  const selectDashboard = React.useCallback(
    (id: number) => {
      setActiveDashboard(id)
      refreshDashboards()
    },
    [refreshDashboards]
  )

  const createDashboard = React.useCallback(() => {
    void api.createDashboard().then(setActiveDashboard)
  }, [])

  const removeFromDashboard = React.useCallback(
    (dashboardId: number, index: number) => {
      void api.removeFromDashboard(dashboardId, index)
    },
    []
  )

  const pinToDashboard = React.useCallback(
    (key: AnswerKey) => {
      void api.pinToDashboard(activeDashboard, key).then(setActiveDashboard)
    },
    [activeDashboard]
  )

  /* ── chat ──────────────────────────────────────────────────────────── */

  const send = React.useCallback(
    (question?: string) => {
      const text = (question ?? chatInput).trim()
      if (!text) return
      setChatInput("")
      void api.ask(activeConversation, text)
    },
    [activeConversation, chatInput]
  )

  const newConversation = React.useCallback(() => {
    void api.createConversation().then(setActiveConversation)
  }, [])

  const toggleStar = React.useCallback((id: number) => {
    void api.toggleStar(id)
  }, [])

  const toggleSql = React.useCallback((messageId: number) => {
    setSqlOpen((current) => ({ ...current, [messageId]: !current[messageId] }))
  }, [])

  const setChartModeFor = React.useCallback(
    (messageId: number, mode: "chart" | "table") => {
      setChartMode((current) => ({ ...current, [messageId]: mode }))
    },
    []
  )

  const value: ConsoleContextValue = {
    server,
    nav,
    goto,
    instrTab,
    setInstrTab: (tab) => (tab === "run" ? goNewSpec() : setInstrTab(tab)),
    selectedHistory,
    setSelectedHistory,
    pendingSpec,
    specInput,
    onSpecInput,
    loadSample,
    clearPending,
    runPipeline,
    approve,
    changeRequestOpen,
    openChangeRequest: () => setChangeRequestOpen(true),
    changeText,
    setChangeText,
    submitChangeRequest,
    viewReport,
    askAboutFeature,
    busy,
    stage,
    obsTab,
    setObsTab,
    traceFilter,
    setTraceFilter,
    openTrace,
    toggleTrace,
    showTrace,
    activityMetric,
    setActivityMetric,
    activityView,
    setActivityView,
    latencyView,
    setLatencyView,
    queryFilter,
    setQueryFilter,
    logFilter,
    setLogFilter,
    activeDashboard,
    selectDashboard,
    refreshDashboards,
    createDashboard,
    removeFromDashboard,
    activeConversation,
    setActiveConversation,
    chatInput,
    setChatInput,
    send,
    newConversation,
    toggleStar,
    pinToDashboard,
    sqlOpen,
    toggleSql,
    chartMode,
    setChartMode: setChartModeFor,
  }

  return <ConsoleContext value={value}>{children}</ConsoleContext>
}

export function useConsole() {
  const value = React.use(ConsoleContext)
  if (!value) throw new Error("useConsole must be used inside <ConsoleProvider>")
  return value
}
