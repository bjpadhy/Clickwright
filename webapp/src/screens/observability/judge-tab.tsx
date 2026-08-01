import * as React from "react"

import {
  formatClock,
  traceIdFromUrl,
  type JudgeFinding,
  type Verdict,
} from "@/api/observability"
import { Button } from "@/components/ui/button"
import { StatusPill, TraceChip } from "@/components/ui-kit/chips"
import { FilterPill, FilterPills } from "@/components/ui-kit/controls"
import { Icon } from "@/components/ui-kit/icon"
import { Panel, PanelBody, PanelHeader } from "@/components/ui-kit/panel"
import { StatCards } from "./stat-cards"
import { EmptyNote, LoadError, UnavailableNote } from "./states"
import { useJudgements } from "./use-observe"

const VERDICT_STYLE: Record<Verdict, { background: string; color: string }> = {
  pass: { background: "#f0fdf4", color: "#166534" },
  warn: { background: "#fffbeb", color: "#9a3412" },
  fail: { background: "#fef2f2", color: "#dc2626" },
}

const SEVERITY_COLOR: Record<JudgeFinding["severity"], string> = {
  info: "#71717a",
  warn: "#d97706",
  fail: "#dc2626",
}

type JudgeFilter = "all" | Verdict

const FILTERS: { id: JudgeFilter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "fail", label: "Failed" },
  { id: "warn", label: "Warnings" },
  { id: "pass", label: "Passed" },
]

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function Axis({
  label,
  axis,
}: {
  label: string
  axis: { verdict: Verdict; score: number; reason: string }
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-[550] text-zinc-500">{label}</span>
        <StatusPill style={VERDICT_STYLE[axis.verdict]}>{axis.verdict}</StatusPill>
        <span className="font-mono text-[10.5px] text-zinc-400">{pct(axis.score)}</span>
      </div>
      <div className="mt-1 text-[11.5px] leading-[1.5] text-zinc-600">{axis.reason}</div>
    </div>
  )
}

export function JudgeTab() {
  const { data, error, loading, reload } = useJudgements(true)
  const [filter, setFilter] = React.useState<JudgeFilter>("all")
  const [open, setOpen] = React.useState<string | null>(null)

  const all = data ?? []
  const rows = all.filter((j) => filter === "all" || j.overall === filter)

  const stats = [
    { key: "Answers judged", value: String(all.length), detail: "one entry per question" },
    {
      key: "Relevance pass",
      value: all.length ? pct(all.filter((j) => j.relevance.verdict === "pass").length / all.length) : "—",
      detail: "did the data answer the question",
    },
    {
      key: "SQL pass",
      value: all.length ? pct(all.filter((j) => j.sql.verdict === "pass").length / all.length) : "—",
      detail: "was the query correct",
    },
    {
      key: "Needs attention",
      value: String(all.filter((j) => j.overall !== "pass").length),
      detail: "failed or warned",
    },
  ]

  return (
    <>
      <StatCards stats={stats} />

      {error ? <LoadError message={error} onRetry={reload} /> : null}

      <UnavailableNote>
        Every chat answer is graded after it is sent by a second agent running on a
        stronger model — it never changes the answer. Convention checks (data
        hygiene, currency, denominators) are decided by code, so they hold whatever
        the grader concludes.
      </UnavailableNote>

      <div className="flex items-center gap-2">
        <FilterPills value={filter} onValueChange={(v) => setFilter(v as JudgeFilter)}>
          {FILTERS.map((f) => (
            <FilterPill key={f.id} value={f.id}>
              {f.label}
            </FilterPill>
          ))}
        </FilterPills>
        <div className="flex-1" />
        <Button
          variant="outline"
          onClick={reload}
          className="h-7 gap-1.5 border-zinc-200 bg-transparent px-2.5 text-[11px] text-zinc-900 hover:border-zinc-900 hover:bg-transparent"
        >
          <Icon name="ti-refresh" size={13} />
          Refresh
        </Button>
      </div>

      {loading && !data ? (
        <Panel>
          <EmptyNote>Loading judgements…</EmptyNote>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyNote>
            {all.length > 0
              ? "No answers match this filter."
              : "No answers graded yet — ask a question in Chat and its judgement appears here a moment after the answer."}
          </EmptyNote>
        </Panel>
      ) : (
        rows.map((j) => {
          const id = `${j.convId}:${j.seq}`
          const expanded = open === id
          return (
            <Panel key={id} className="min-w-0">
              <PanelHeader className="gap-2.5">
                <StatusPill className="shrink-0" style={VERDICT_STYLE[j.overall]}>
                  {j.overall}
                </StatusPill>
                <span
                  className="min-w-0 flex-1 truncate text-[13px] font-semibold"
                  title={j.question}
                >
                  {j.question}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-zinc-400" title={j.judgedAt}>
                  {formatClock(j.judgedAt)}
                </span>
                <Button
                  variant="outline"
                  onClick={() => setOpen(expanded ? null : id)}
                  className="h-7 shrink-0 gap-1 border-zinc-200 bg-transparent px-2 text-[11px] text-zinc-700 hover:border-zinc-900 hover:bg-transparent"
                >
                  <Icon name={expanded ? "ti-chevron-up" : "ti-chevron-down"} size={13} />
                  {expanded ? "Hide" : "Detail"}
                </Button>
              </PanelHeader>

              <PanelBody className="flex flex-col gap-3">
                <div className="flex gap-5">
                  <Axis label="Relevance" axis={j.relevance} />
                  <Axis label="SQL correctness" axis={j.sql} />
                </div>

                {j.findings.length > 0 ? (
                  <div className="flex flex-col gap-1 border-t border-zinc-100 pt-2.5">
                    {j.findings.map((f, i) => (
                      <div key={i} className="flex gap-2 text-[11.5px] leading-[1.5]">
                        <span
                          className="shrink-0 font-mono text-[10px] font-bold tracking-[.04em] uppercase"
                          style={{ color: SEVERITY_COLOR[f.severity] }}
                        >
                          {f.kind}
                        </span>
                        <span className="min-w-0 flex-1 text-zinc-600">
                          {f.task ? <span className="text-zinc-400">{f.task}: </span> : null}
                          {f.text}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {expanded ? (
                  <div className="flex flex-col gap-2.5 border-t border-zinc-100 pt-2.5">
                    {j.queries.map((q) => (
                      <div key={q.task} className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[11.5px] font-[550]">{q.title}</span>
                          <span className="font-mono text-[10.5px] text-zinc-400">
                            {q.rowCount} rows
                          </span>
                        </div>
                        <pre className="scroll-x mt-1 rounded-md bg-zinc-50 p-2.5 font-mono text-[10.5px] leading-[1.5] text-zinc-700">
                          {q.sql}
                        </pre>
                      </div>
                    ))}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10.5px] text-zinc-400">
                        judged by {j.model}
                      </span>
                      {j.answerTraceUrl ? (
                        <TraceChip
                          traceId={`answer ${traceIdFromUrl(j.answerTraceUrl)}`}
                          onClick={() => window.open(j.answerTraceUrl!, "_blank", "noopener")}
                          className="bg-white px-[9px] py-[2.5px] text-[10.5px]"
                        />
                      ) : null}
                      {j.judgeTraceUrl ? (
                        <TraceChip
                          traceId={`judge ${traceIdFromUrl(j.judgeTraceUrl)}`}
                          onClick={() => window.open(j.judgeTraceUrl!, "_blank", "noopener")}
                          className="bg-white px-[9px] py-[2.5px] text-[10.5px]"
                        />
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </PanelBody>
            </Panel>
          )
        })
      )}
    </>
  )
}
