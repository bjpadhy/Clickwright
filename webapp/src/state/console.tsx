/**
 * Client-side console state: which screen is open, which filters are set, what
 * is typed into a form. Everything that would survive a page reload on a real
 * deployment lives on the server, not here.
 *
 * Dashboards and Observability are still served by the in-memory mock in
 * `src/mock`. Instrumentation and Chat are not — they run against the real
 * backend and own their state in `src/state/instrumentation.tsx` and
 * `src/state/chat.tsx`.
 */

import * as React from "react"
import { toast } from "sonner"

import { api } from "@/api/client"
import type { AgentKind, ServerState } from "@/api/types"

export type NavId = "chat" | "instr" | "obs" | "dash"
export type InstrTab = "run" | "hist"
export type ObsTab = "traces" | "stack" | "log" | "judge"
export type TraceFilter = "all" | AgentKind
/** Mirrors the agents that can appear in system.query_log's log_comment. */
export type QueryFilter = "all" | "analytics" | "instrumentation" | "context"
export type LogFilter = "all" | "table" | "ctx"
export type ActivityMetric = "traces" | "cost" | "tokens"
export type ChartView = "bars" | "line"

const subscribe = (listener: () => void) => api.subscribe(listener)
const getSnapshot = () => api.getState()

export function useServerState(): ServerState {
  // Third arg = server snapshot. The mock store is plain in-memory state with no
  // client-only reads, so the same getter is correct on both sides.
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

interface ConsoleContextValue {
  server: ServerState

  nav: NavId
  goto: (nav: NavId) => void

  /* instrumentation — which of its two screens is showing */
  instrTab: InstrTab
  setInstrTab: (tab: InstrTab) => void

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
}

const ConsoleContext = React.createContext<ConsoleContextValue | null>(null)

export function ConsoleProvider({ children }: { children: React.ReactNode }) {
  const server = useServerState()

  const [nav, setNav] = React.useState<NavId>("chat")
  const [instrTab, setInstrTab] = React.useState<InstrTab>("run")

  // Database health is the real one; Agent activity is still mock, so it is a
  // poor thing to land on.
  const [obsTab, setObsTab] = React.useState<ObsTab>("stack")
  const [traceFilter, setTraceFilter] = React.useState<TraceFilter>("all")
  const [openTrace, setOpenTrace] = React.useState<string | null>(null)
  const [activityMetric, setActivityMetric] = React.useState<ActivityMetric>("traces")
  const [activityView, setActivityView] = React.useState<ChartView>("bars")
  const [latencyView, setLatencyView] = React.useState<ChartView>("bars")
  const [queryFilter, setQueryFilter] = React.useState<QueryFilter>("all")
  const [logFilter, setLogFilter] = React.useState<LogFilter>("all")

  const [activeDashboard, setActiveDashboard] = React.useState(1)

  /* server-pushed toasts */
  React.useEffect(() => api.onNotice(({ message }) => toast.success(message)), [])

  const refreshDashboards = React.useCallback(() => {
    setNav("dash")
    void api.refreshDashboards()
  }, [])

  const goto = React.useCallback(
    (next: NavId) => {
      if (next === "dash") return refreshDashboards()
      setNav(next)
    },
    [refreshDashboards]
  )

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

  const value: ConsoleContextValue = {
    server,
    nav,
    goto,
    instrTab,
    setInstrTab,
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
  }

  return <ConsoleContext value={value}>{children}</ConsoleContext>
}

export function useConsole() {
  const value = React.use(ConsoleContext)
  if (!value) throw new Error("useConsole must be used inside <ConsoleProvider>")
  return value
}
