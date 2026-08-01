import { toast } from "sonner"

import { api } from "@/api/client"
import type { AgentKind, SpanKind, Trace } from "@/api/types"
import { ActivityChart } from "@/components/charts/activity-chart"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { StatusPill } from "@/components/ui-kit/chips"
import {
  FilterPill,
  FilterPills,
  Segmented,
  SegmentedIcon,
  SegmentedItem,
} from "@/components/ui-kit/controls"
import { Icon } from "@/components/ui-kit/icon"
import { Panel } from "@/components/ui-kit/panel"
import { cn } from "@/lib/utils"
import { useConsole, type ActivityMetric, type ChartView, type TraceFilter } from "@/state/console"
import { StatCards } from "./stat-cards"
import { UnavailableNote } from "./states"

const AGENT_STYLE: Record<AgentKind, { background: string; color: string }> = {
  instrumentation: { background: "#e6f4f1", color: "#1a6e64" },
  analytics: { background: "#fdeae4", color: "#a03c22" },
  context: { background: "#e9eef2", color: "#274754" },
}

const SPAN_COLOR: Record<SpanKind, string> = {
  llm: "#e76e50",
  db: "#2a9d90",
  tool: "#94a3b8",
  human: "#e8c468",
}

const LEGEND: { kind: SpanKind; label: string }[] = [
  { kind: "llm", label: "llm" },
  { kind: "db", label: "clickhouse" },
  { kind: "tool", label: "tool" },
  { kind: "human", label: "human" },
]

const FILTERS: { id: TraceFilter; label: string }[] = [
  { id: "all", label: "All agents" },
  { id: "instrumentation", label: "Instrumentation" },
  { id: "analytics", label: "Analytics" },
  { id: "context", label: "Context" },
]

const ROW_GRID = "grid grid-cols-[2.2fr_.8fr_.6fr_.6fr_.65fr_.7fr]"

export function TracesTab() {
  const {
    server,
    traceFilter,
    setTraceFilter,
    openTrace,
    toggleTrace,
    activityMetric,
    setActivityMetric,
    activityView,
    setActivityView,
  } = useConsole()

  const series = api.getSeries(activityMetric)
  const visible = server.traces.filter(
    (trace) => traceFilter === "all" || trace.agent === traceFilter
  )

  const stats = [
    {
      key: "Traces",
      value: String(server.traces.length),
      detail: "since hack start · 3 agents",
    },
    { key: "LLM spend", value: "$0.31", detail: "claude-sonnet-4-5 · all agents" },
    { key: "Median trace", value: "7.2s", detail: "excluding human wait time" },
    {
      key: "Human approvals",
      value: String(server.history.length),
      detail: "recorded inside traces",
    },
  ]

  return (
    <>
      {/* The other two tabs read the real backend; this one does not yet, and
          unlabelled fake numbers on an observability screen are a trap. */}
      <UnavailableNote>
        <strong>Sample data.</strong> This tab is still served by the in-memory
        mock — the traces, costs and spans below are illustrative. Database
        health and Changelog read the live backend.
      </UnavailableNote>

      <StatCards stats={stats} />

      <Panel className="px-[18px] py-4">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] font-semibold">Agent activity</span>
          <span className="text-[11px] text-zinc-400">since hack start · per 15 min</span>
          <div className="flex-1" />
          <Segmented
            value={activityMetric}
            onValueChange={(value) => setActivityMetric(value as ActivityMetric)}
          >
            <SegmentedItem value="traces">Traces</SegmentedItem>
            <SegmentedItem value="cost">Cost</SegmentedItem>
            <SegmentedItem value="tokens">Tokens</SegmentedItem>
          </Segmented>
          <Segmented
            value={activityView}
            onValueChange={(value) => setActivityView(value as ChartView)}
          >
            <SegmentedIcon value="bars" aria-label="Bar chart">
              <Icon name="ti-chart-bar" size={14} />
            </SegmentedIcon>
            <SegmentedIcon value="line" aria-label="Line chart">
              <Icon name="ti-chart-line" size={14} />
            </SegmentedIcon>
          </Segmented>
        </div>
        <ActivityChart data={series.data} unit={series.unit} view={activityView} />
        <div className="mt-2 flex justify-between font-mono text-[10px] text-zinc-400">
          <span>12:00</span>
          <span>12:45</span>
          <span>13:30</span>
          <span>14:15</span>
          <span>now</span>
        </div>
      </Panel>

      <div className="flex items-center gap-2">
        <FilterPills
          value={traceFilter}
          onValueChange={(value) => setTraceFilter(value as TraceFilter)}
        >
          {FILTERS.map((filter) => (
            <FilterPill key={filter.id} value={filter.id}>
              {filter.label}
            </FilterPill>
          ))}
        </FilterPills>
        <div className="flex-1" />
        <span className="inline-flex gap-2.5 text-[11px] text-zinc-400">
          {LEGEND.map((item) => (
            <span key={item.kind}>
              <span
                className="inline-block size-2 rounded-sm"
                style={{ background: SPAN_COLOR[item.kind] }}
              />{" "}
              {item.label}
            </span>
          ))}
        </span>
      </div>

      <Panel className="overflow-hidden">
        <div
          className={cn(
            ROW_GRID,
            "border-b border-zinc-100 bg-zinc-50 px-4 py-[9px] text-[10.5px] font-[650] tracking-[.05em] text-zinc-400"
          )}
        >
          <span>TRACE</span>
          <span>AGENT</span>
          <span>TOKENS</span>
          <span>COST</span>
          <span>DURATION</span>
          <span>STATUS</span>
        </div>
        {visible.map((trace) => (
          <TraceRow
            key={trace.id}
            trace={trace}
            open={openTrace === trace.id}
            onToggle={() => toggleTrace(trace.id)}
          />
        ))}
      </Panel>

      <div className="text-center text-[11px] text-zinc-400">
        self-hosted Langfuse — running ClickHouse under the hood · every artifact in this app
        links back to a trace
      </div>
    </>
  )
}

function TraceRow({
  trace,
  open,
  onToggle,
}: {
  trace: Trace
  open: boolean
  onToggle: () => void
}) {
  const agent = AGENT_STYLE[trace.agent]
  const flagged = trace.status === "flagged"

  return (
    <Collapsible open={open} onOpenChange={onToggle}>
      <CollapsibleTrigger
        className={cn(
          ROW_GRID,
          "w-full cursor-pointer items-center border-b border-zinc-100 px-4 py-[11px] text-left hover:bg-zinc-50",
          open ? "bg-zinc-50" : "bg-white"
        )}
      >
        <div className="flex min-w-0 items-center gap-2 pr-2.5">
          <Icon
            name={open ? "ti-chevron-down" : "ti-chevron-right"}
            size={13}
            className="shrink-0 text-zinc-400"
          />
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-[550]">{trace.name}</div>
            <div className="mt-px font-mono text-[10.5px] text-zinc-400">
              {trace.id} · {trace.time}
            </div>
          </div>
        </div>
        <span>
          <StatusPill style={agent}>{trace.agent}</StatusPill>
        </span>
        <span className="font-mono text-[11.5px] text-zinc-600">{trace.tokens}</span>
        <span className="font-mono text-[11.5px] text-zinc-600">{trace.cost}</span>
        <span className="font-mono text-[11.5px] text-zinc-600">{trace.duration}</span>
        <span>
          <StatusPill
            className={cn(
              flagged ? "bg-orange-50 text-orange-800" : "bg-green-50 text-green-800"
            )}
          >
            {trace.status}
          </StatusPill>
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent className="border-b border-zinc-100 bg-zinc-50 px-4 pt-3.5 pb-4">
        <div className="mb-3 flex gap-[9px] rounded-lg border border-zinc-100 bg-white px-3 py-[9px] text-[12px] leading-[1.55] text-zinc-700">
          <Icon
            name="ti-align-left"
            size={13}
            className="translate-y-0.5 text-zinc-400"
          />
          <span>
            <b>In plain terms:</b> {trace.human}
          </span>
        </div>
        {trace.spans.map((span) => (
          <div key={span.name} className="flex items-center gap-2.5 py-[3px]">
            <span className="w-[230px] shrink-0 truncate text-right font-mono text-[11px] text-zinc-600">
              {span.name}
            </span>
            <div className="relative h-4 flex-1 rounded-[4px] bg-zinc-100">
              <div
                className="absolute top-0.5 bottom-0.5 rounded-[3px]"
                style={{
                  left: `${span.left}%`,
                  width: `${span.width}%`,
                  background: SPAN_COLOR[span.kind],
                }}
              />
            </div>
            <span className="w-[52px] font-mono text-[10.5px] text-zinc-400">
              {span.kind === "human" ? "wait" : `${(span.width / 10).toFixed(1)}s`}
            </span>
          </div>
        ))}
        <div className="mt-3 flex items-center gap-2.5">
          <div className="flex flex-1 items-center gap-1.5 text-[11px] text-zinc-500">
            <Icon name="ti-info-circle" size={13} className="shrink-0" />
            {trace.meta} · model: claude-sonnet-4-5
          </div>
          <Button
            variant="outline"
            onClick={() =>
              toast.success(
                `Opening ${trace.id} in Langfuse — self-hosted, running on ClickHouse`
              )
            }
            className="h-[30px] shrink-0 gap-1.5 rounded-lg border-zinc-200 bg-white px-3 text-[11.5px] font-[550] text-zinc-900 hover:border-zinc-900 hover:bg-white hover:text-zinc-900"
          >
            Open full trace in Langfuse
            <Icon name="ti-external-link" size={13} />
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
