/**
 * In-memory stand-in for the parts of the backend that are not live yet: Chat,
 * Dashboards and Observability.
 *
 * Instrumentation is NOT here any more — it runs against the real service (see
 * `src/api/instrumentation.ts`). What remains of a "run" in this file is the
 * static history and spec-status seed Observability draws its charts from.
 */

import type {
  Answer,
  AnswerKey,
  ApiConfig,
  Notice,
  Series,
  ServerState,
  SpecLoopApi,
  Trace,
} from "@/api/types"
import {
  ANSWERS,
  INITIAL_CONTEXT_VERSION,
  INITIAL_CONVERSATIONS,
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

export class MockSpecLoopServer implements SpecLoopApi {
  readonly config: ApiConfig

  private state: ServerState
  private listeners = new Set<() => void>()
  private noticeListeners = new Set<(notice: Notice) => void>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private nextConversationId: number
  private nextDashboardId: number
  private nextMessageId = 10
  /** analytics answers only get logged to the trace list once, like the original */
  private loggedAnswers = new Set<AnswerKey>()

  constructor(config: ApiConfig) {
    this.config = config
    this.state = {
      contextVersion: INITIAL_CONTEXT_VERSION,
      specStatuses: clone(INITIAL_STATUSES),
      history: clone(INITIAL_HISTORY),
      traces: clone(STATIC_TRACES),
      changelog: clone(STATIC_CHANGELOG),
      conversations: clone(INITIAL_CONVERSATIONS),
      dashboards: clone(INITIAL_DASHBOARDS),
      dashboardsRefreshing: false,
      dashboardsStamp: "14:41",
    }
    this.nextConversationId =
      Math.max(0, ...this.state.conversations.map((c) => c.id)) + 1
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

  matchAnswer(question: string): AnswerKey {
    if (/express|checkout|otp/i.test(question)) return "express"
    if (/funnel|drop|leak|convers/i.test(question)) return "funnel"
    if (/upload|document|mobile|fail|heic/i.test(question)) return "uploads"
    return "generic"
  }

  getSeries(metric: "traces" | "cost" | "tokens"): Series {
    return SERIES[metric]
  }

  getLatencySeries(): number[] {
    return LATENCY
  }

  /* ── chat ────────────────────────────────────────────────────────────── */

  async ask(conversationId: number, question: string) {
    const text = question.trim()
    if (!text) return

    const key = this.matchAnswer(text)
    const answer = ANSWERS[key]
    const messageId = this.nextMessageId
    this.nextMessageId += 2
    const contextVersion = this.state.contextVersion

    this.commit({
      conversations: this.state.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              time: "now",
              title: c.title === "New conversation" ? answer.short : c.title,
              messages: [
                ...c.messages,
                {
                  id: messageId,
                  role: "user" as const,
                  text,
                  stepsDone: 0,
                  revealed: false,
                  contextVersion,
                },
                {
                  id: messageId + 1,
                  role: "agent" as const,
                  answerKey: key,
                  stepsDone: 0,
                  revealed: false,
                  contextVersion,
                },
              ],
            }
          : c
      ),
    })

    const stepCount = answer.steps.length
    let i = 0
    const tick = () => {
      i++
      const done = i >= stepCount
      this.commit({
        conversations: this.state.conversations.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId + 1 ? { ...m, stepsDone: i, revealed: done } : m
                ),
              }
            : c
        ),
      })
      if (done) {
        this.logAnswerTrace(key)
        return
      }
      this.after(tick, 720 * this.pace)
    }
    this.after(tick, 700 * this.pace)
  }

  private logAnswerTrace(key: AnswerKey) {
    const answer = ANSWERS[key]
    if (!answer.traceId || this.loggedAnswers.has(key)) return
    this.loggedAnswers.add(key)
    const contextVersion = this.state.contextVersion
    const trace: Trace = {
      id: answer.traceId,
      name: `analytics.ask — "${answer.short}"`,
      agent: "analytics",
      tokens: "5,102",
      cost: "$0.061",
      duration: "8.7s",
      status: "ok",
      time: "now",
      meta: `context v${contextVersion} · aggregates computed in ClickHouse · confidence ${
        answer.confidence ?? "—"
      }`,
      human: "A question was asked in plain English. The agent wrote the SQL, ClickHouse did the heavy computation, and the answer came back with sources and a confidence score.",
      spans: [
        { name: `ctx.read v${contextVersion}`, kind: "tool", left: 0, width: 4 },
        { name: "sql.plan (LLM)", kind: "llm", left: 4, width: 26 },
        { name: "ch.query aggregates", kind: "db", left: 30, width: 16 },
        { name: "anomaly.scan (MADs)", kind: "tool", left: 46, width: 12 },
        { name: "insight.compose (LLM)", kind: "llm", left: 58, width: 38 },
      ],
    }
    this.commit({ traces: [trace, ...this.state.traces] })
  }

  async createConversation() {
    const id = this.nextConversationId++
    this.commit({
      conversations: [
        ...this.state.conversations,
        { id, title: "New conversation", time: "now", starred: false, messages: [] },
      ],
    })
    return id
  }

  async openConversation() {
    const empty = this.state.conversations.find((c) => c.messages.length === 0)
    if (empty) return empty.id
    return this.createConversation()
  }

  async toggleStar(conversationId: number) {
    this.commit({
      conversations: this.state.conversations.map((c) =>
        c.id === conversationId ? { ...c, starred: !c.starred } : c
      ),
    })
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
