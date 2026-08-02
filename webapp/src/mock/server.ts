/**
 * In-memory stand-in for the parts of the backend that are not live yet:
 * Dashboards and Observability.
 *
 * Instrumentation and Chat are NOT here any more — they run against the real
 * service (see `src/api/instrumentation.ts` and `src/api/chat.ts`). What remains
 * of a "run" in this file is the static history and spec-status seed
 * Observability draws its charts from.
 */

import type {
  Answer,
  AnswerKey,
  ApiConfig,
  Notice,
  Series,
  ServerState,
  ClickwrightApi,
} from "@/api/types"
import {
  ANSWERS,
  INITIAL_CONTEXT_VERSION,
  INITIAL_DASHBOARDS,
  INITIAL_HISTORY,
  INITIAL_STATUSES,
  LATENCY,
  SERIES,
  STATIC_CHANGELOG,
  STATIC_TRACES,
} from "./fixtures"

const SPEED_MULTIPLIER: Record<ApiConfig["speed"], number> = {
  instant: 0.05,
  fast: 0.45,
  realistic: 1,
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class MockClickwrightServer implements ClickwrightApi {
  readonly config: ApiConfig

  private state: ServerState
  private listeners = new Set<() => void>()
  private noticeListeners = new Set<(notice: Notice) => void>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private nextDashboardId: number

  constructor(config: ApiConfig) {
    this.config = config
    this.state = {
      contextVersion: INITIAL_CONTEXT_VERSION,
      specStatuses: clone(INITIAL_STATUSES),
      history: clone(INITIAL_HISTORY),
      traces: clone(STATIC_TRACES),
      changelog: clone(STATIC_CHANGELOG),
      dashboards: clone(INITIAL_DASHBOARDS),
      dashboardsRefreshing: false,
      dashboardsStamp: "14:41",
    }
    this.nextDashboardId = Math.max(0, ...this.state.dashboards.map((d) => d.id)) + 1
  }

  /* ── store ───────────────────────────────────────────────────────────── */

  getState(): ServerState {
    return this.state
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onNotice(listener: (notice: Notice) => void) {
    this.noticeListeners.add(listener)
    return () => {
      this.noticeListeners.delete(listener)
    }
  }

  /** Cancels every in-flight simulation. Call from a top-level unmount. */
  dispose() {
    this.timers.forEach(clearTimeout)
    this.timers.clear()
  }

  private commit(patch: Partial<ServerState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((l) => l())
  }

  private notify(message: string) {
    this.noticeListeners.forEach((l) => l({ message }))
  }

  private get pace() {
    return SPEED_MULTIPLIER[this.config.speed] ?? SPEED_MULTIPLIER.fast
  }

  private after(fn: () => void, ms: number) {
    const id = setTimeout(() => {
      this.timers.delete(id)
      fn()
    }, Math.max(30, ms))
    this.timers.add(id)
    return id
  }

  /* ── catalogue ───────────────────────────────────────────────────────── */

  getAnswer(key: AnswerKey): Answer {
    return ANSWERS[key]
  }

  getSeries(metric: "traces" | "cost" | "tokens"): Series {
    return SERIES[metric]
  }

  getLatencySeries(): number[] {
    return LATENCY
  }

  /* ── dashboards ──────────────────────────────────────────────────────── */

  async refreshDashboards() {
    this.commit({ dashboardsRefreshing: true })
    this.after(
      () => this.commit({ dashboardsRefreshing: false, dashboardsStamp: "just now" }),
      1000 * this.pace
    )
  }

  async createDashboard() {
    const id = this.nextDashboardId++
    this.commit({
      dashboards: [...this.state.dashboards, { id, name: `Dashboard ${id}`, items: [] }],
    })
    return id
  }

  async pinToDashboard(dashboardId: number | null, key: AnswerKey) {
    let dashboards = [...this.state.dashboards]
    let activeId = dashboardId

    if (!dashboards.length) {
      const id = this.nextDashboardId++
      dashboards.push({ id, name: "My dashboard", items: [] })
      activeId = id
    }

    const target = dashboards.find((d) => d.id === activeId) ?? dashboards[0]
    const already = target.items.some((item) => item.key === key)
    if (!already) {
      dashboards = dashboards.map((d) =>
        d.id === target.id ? { ...d, items: [...d.items, { key }] } : d
      )
    }

    this.commit({ dashboards })
    this.notify(
      already
        ? `Already saved on "${target.name}"`
        : `Saved to "${target.name}" — open Dashboards to view`
    )
    return target.id
  }

  async removeFromDashboard(dashboardId: number, index: number) {
    this.commit({
      dashboards: this.state.dashboards.map((d) =>
        d.id === dashboardId
          ? { ...d, items: d.items.filter((_, i) => i !== index) }
          : d
      ),
    })
  }
}
