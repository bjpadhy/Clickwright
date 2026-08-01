/**
 * In-memory stand-in for the SpecLoop backend.
 *
 * It owns everything a server would own — the context version, spec statuses,
 * run history, traces, changelog, conversations and dashboards — and streams
 * agent progress by mutating state on a timer and notifying subscribers. The
 * UI never schedules pipeline choreography itself; it subscribes and renders.
 *
 * Swapping in the real backend means writing another `SpecLoopApi`, not
 * touching a component.
 */

import type {
  Answer,
  AnswerKey,
  ApiConfig,
  ChangelogEntry,
  Notice,
  RunRecord,
  Series,
  ServerState,
  Spec,
  SpecId,
  SpecLoopApi,
  SpecPreview,
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
  RUNNABLE_SPECS,
  RUNS,
  SERIES,
  SPECS,
  STATIC_CHANGELOG,
  STATIC_TRACES,
} from "./fixtures"

const SPEED_MULTIPLIER: Record<ApiConfig["speed"], number> = {
  instant: 0.05,
  fast: 0.45,
  realistic: 1,
}

const HUMAN_REVIEWER = "R. Mehta"
const AUTO_REVIEWER = "auto (demo policy)"

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
  private nextRunSeq = 1
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
      run: null,
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

  listSpecs(): Spec[] {
    return RUNNABLE_SPECS.map((id) => SPECS[id])
  }

  getSpecPreview(id: SpecId): SpecPreview {
    return { ...SPECS[id], brief: RUNS[id].brief, ndjson: RUNS[id].ndjson }
  }

  getRunRecord(id: SpecId): RunRecord {
    return RUNS[id]
  }

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

  /* ── instrumentation ─────────────────────────────────────────────────── */

  async startRun(specId: SpecId) {
    const current = this.state.run
    if (current && current.stage > 0 && current.stage < 6) return

    const record = RUNS[specId]
    const runId = `run_${specId}_${this.nextRunSeq++}`
    this.commit({
      run: {
        runId,
        specId,
        stage: 1,
        logCount: 1,
        execCount: 0,
        revised: false,
        versionFrom: "",
        versionTo: "",
        approvedBy: "",
      },
    })

    const total = record.log.length
    let i = 1
    const tick = () => {
      if (this.state.run?.runId !== runId) return
      i++
      if (i >= total) {
        this.patchRun(runId, { logCount: total, stage: 3 })
        if (this.config.autoApprove) {
          this.after(() => {
            if (this.state.run?.runId === runId && this.state.run.stage === 3) {
              void this.approveRun()
            }
          }, 1100 * this.pace)
        }
        return
      }
      this.patchRun(runId, { logCount: i, stage: i >= 3 ? 2 : 1 })
      this.after(tick, 640 * this.pace)
    }
    this.after(tick, 700 * this.pace)
  }

  async approveRun() {
    const run = this.state.run
    if (!run || run.stage !== 3) return
    const record = RUNS[run.specId]
    const runId = run.runId
    const total = record.exec.length + 1

    this.patchRun(runId, { stage: 4, execCount: 1 })

    let i = 1
    const tick = () => {
      if (this.state.run?.runId !== runId) return
      i++
      if (i > total) {
        this.patchRun(runId, { stage: 5 })
        this.after(() => this.finishRun(runId), 1700 * this.pace)
        return
      }
      this.patchRun(runId, { execCount: i })
      this.after(tick, 480 * this.pace)
    }
    this.after(tick, 480 * this.pace)
  }

  async requestChanges(_note: string) {
    const run = this.state.run
    if (!run || run.stage !== 3) return
    const runId = run.runId
    this.patchRun(runId, { revised: true, stage: 2 })
    this.after(() => {
      if (this.state.run?.runId === runId) this.patchRun(runId, { stage: 3 })
    }, 1500 * this.pace)
  }

  async resetRun() {
    this.commit({ run: null })
  }

  private patchRun(runId: string, patch: Partial<ServerState["run"] & object>) {
    const run = this.state.run
    if (!run || run.runId !== runId) return
    this.commit({ run: { ...run, ...patch } })
  }

  private finishRun(runId: string) {
    const run = this.state.run
    if (!run || run.runId !== runId) return

    const record = RUNS[run.specId]
    const versionFrom = this.state.contextVersion
    const versionTo = (parseFloat(versionFrom) + 0.1).toFixed(1)
    const approvedBy = this.config.autoApprove ? AUTO_REVIEWER : HUMAN_REVIEWER

    this.commit({
      specStatuses: { ...this.state.specStatuses, [run.specId]: "done" },
      run: { ...run, stage: 6, versionFrom, versionTo, approvedBy },
      contextVersion: versionTo,
      history: [
        {
          specId: run.specId,
          time: "just now",
          version: `v${versionFrom} → v${versionTo}`,
          approvedBy,
        },
        ...this.state.history,
      ],
      traces: [
        this.buildContextTrace(record, versionFrom, versionTo),
        this.buildRunTrace(record, versionFrom),
        ...this.state.traces,
      ],
      changelog: [
        {
          id: `cl_${runId}_ctx`,
          time: "now",
          icon: "ti-book-2",
          kind: "ctx",
          title: `context v${versionTo}`,
          desc: record.changelogContext ?? "",
          traceId: record.contextTrace.id,
          warn: !!record.warn,
        },
        {
          id: `cl_${runId}_tbl`,
          time: "now",
          icon: "ti-table",
          kind: "table",
          title: record.changelogTable ?? "",
          desc: `Instrumentation Agent · approved by ${approvedBy} · ${record.backfill}`,
          traceId: record.trace.id,
        },
        ...this.state.changelog,
      ] satisfies ChangelogEntry[],
    })

    this.notify(
      `Schema live on ClickHouse · context v${versionTo} pushed to Analytics Agent`
    )
  }

  private buildRunTrace(record: RunRecord, versionFrom: string): Trace {
    const auto = this.config.autoApprove
    return {
      id: record.trace.id,
      name: `instrumentation.run — ${record.table.replace("atlys.", "").replace("_events", "")}`,
      agent: "instrumentation",
      tokens: record.trace.tokens,
      cost: record.trace.cost,
      duration: record.trace.duration,
      status: auto ? "auto ✓" : "human ✓",
      time: "now",
      meta: `context v${versionFrom} in · approval recorded in-trace · ${record.backfill}`,
      human: `A feature spec came in. The agent studied the existing data, designed the schema, ${
        auto ? "demo policy auto-approved it" : "a human reviewed and approved it"
      }, and the tables went live with data.`,
      spans: [
        { name: `ctx.fetch v${versionFrom}`, kind: "tool", left: 0, width: 3 },
        { name: "schema.inspect (system.columns)", kind: "db", left: 3, width: 7 },
        { name: "spec.parse + sampling", kind: "tool", left: 10, width: 6 },
        { name: "ddl.design (LLM)", kind: "llm", left: 16, width: 42 },
        { name: "ddl.dryrun (staging)", kind: "db", left: 58, width: 6 },
        { name: "human.approval — APPROVED", kind: "human", left: 64, width: 18 },
        { name: "ch.execute 2 stmts", kind: "db", left: 82, width: 8 },
        { name: "context.trigger", kind: "tool", left: 90, width: 4 },
      ],
    }
  }

  private buildContextTrace(
    record: RunRecord,
    versionFrom: string,
    versionTo: string
  ): Trace {
    return {
      id: record.contextTrace.id,
      name: `context.update — v${versionFrom} → v${versionTo}`,
      agent: "context",
      tokens: record.contextTrace.tokens,
      cost: record.contextTrace.cost,
      duration: record.contextTrace.duration,
      status: record.warn ? "flagged" : "ok",
      time: "now",
      meta: record.changelogContext ?? "",
      human: `The schema just changed, so the Context Agent updated the business docs on its own${
        record.warn ? " — and flagged a contradiction for humans to see." : "."
      }`,
      spans: [
        { name: "diff.schema (system.tables)", kind: "db", left: 0, width: 18 },
        { name: "contradiction.scan (LLM)", kind: "llm", left: 18, width: 52 },
        { name: "context.write + version", kind: "tool", left: 70, width: 18 },
        { name: "notify analytics agent", kind: "tool", left: 88, width: 12 },
      ],
    }
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
