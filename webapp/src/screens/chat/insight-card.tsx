import * as React from "react"

import type { FindingTag, Insight } from "@/api/chat"
import { formatValue, InsightChart } from "@/components/charts/insight-chart"
import { Button } from "@/components/ui/button"
import { CodeSurface } from "@/components/ui-kit/code"
import { StatusPill } from "@/components/ui-kit/chips"
import { Segmented, SegmentedItem } from "@/components/ui-kit/controls"
import { Icon } from "@/components/ui-kit/icon"
import { Panel } from "@/components/ui-kit/panel"
import { capsuleButton } from "@/components/ui-kit/styles"
import { cn } from "@/lib/utils"
import { useChat } from "@/state/chat"

/** The four tags the narrator may emit — no others reach the UI. */
const TAG_STYLE: Record<FindingTag, { label: string; bg: string; fg: string }> = {
  driver: { label: "DRIVER", bg: "#e6f4f1", fg: "#1a6e64" },
  segment: { label: "SEGMENT", bg: "#e9eef2", fg: "#274754" },
  caveat: { label: "CAVEAT", bg: "#faf3dc", fg: "#8a6d1a" },
  known_issue: { label: "KNOWN ISSUE", bg: "#fdeae4", fg: "#a03c22" },
}

const CONFIDENCE_STYLE: Record<Insight["confidence"]["value"], string> = {
  high: "border-teal/30 bg-teal/10 text-teal",
  medium: "border-sand/40 bg-sand/15 text-[#8a6d1a]",
  low: "border-coral/30 bg-coral/10 text-[#a03c22]",
}

/** Headline, tagged findings, chart or segment table, confidence, sources. */
export function InsightCard({ insight, traceUrl }: { insight: Insight; traceUrl?: string }) {
  const { saveToDashboard } = useChat()
  const [sqlOpen, setSqlOpen] = React.useState(false)
  const [view, setView] = React.useState<"chart" | "table">("chart")

  const { chart, segmentTable } = insight
  const showToggle = !!chart && !!segmentTable
  const showTable = !!segmentTable && (!chart || view === "table")
  const queries = insight.sql.filter((entry) => entry.query)

  return (
    <Panel className="animate-fade-up-lg px-[18px] py-4">
      <div className="text-[15px] leading-[1.4] font-[650] tracking-[-.005em]">
        {insight.headline}
      </div>

      <div className="mt-3 flex flex-col gap-[9px]">
        {insight.findings.map((finding, index) => {
          const style = TAG_STYLE[finding.tag]
          return (
            <div key={`${finding.tag}-${index}`} className="flex items-baseline gap-[9px]">
              <span
                className="-translate-y-px shrink-0 rounded-[5px] px-[7px] py-[2.5px] text-[9.5px] font-bold tracking-[.06em]"
                style={{ background: style.bg, color: style.fg }}
              >
                {style.label}
              </span>
              <span className="text-[12.5px] leading-[1.6] text-zinc-700">{finding.text}</span>
            </div>
          )
        })}
      </div>

      {chart || segmentTable ? (
        <div className="mt-[13px] rounded-[10px] border border-zinc-100 px-3.5 py-[13px]">
          <div className="mb-2.5 flex items-center gap-2">
            <span className="flex-1 text-[11.5px] font-semibold text-zinc-500">
              {chart?.title ?? "Segments"}
            </span>
            {showToggle ? (
              <Segmented
                value={view}
                onValueChange={(value) => value && setView(value as "chart" | "table")}
                className="rounded-[7px] p-0.5"
              >
                <SegmentedItem
                  value="chart"
                  aria-label="Chart view"
                  className="h-[22px] w-[26px] rounded-[5px] p-0 data-[state=on]:shadow-none"
                >
                  <Icon name="ti-chart-bar" size={13} />
                </SegmentedItem>
                <SegmentedItem
                  value="table"
                  aria-label="Table view"
                  className="h-[22px] w-[26px] rounded-[5px] p-0 data-[state=on]:shadow-none"
                >
                  <Icon name="ti-table" size={13} />
                </SegmentedItem>
              </Segmented>
            ) : null}
          </div>

          {showTable && segmentTable ? (
            <div className="overflow-x-auto rounded-lg border border-zinc-100">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-zinc-50">
                    {segmentTable.columns.map((column) => (
                      <th
                        key={column}
                        className="px-3 py-1.5 text-left text-[10px] font-[650] tracking-[.05em] whitespace-nowrap text-zinc-400 uppercase"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {segmentTable.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-zinc-100">
                      {row.map((cell, cellIndex) => {
                        const format = segmentTable.columnFormats?.[cellIndex]
                        const numeric = typeof cell === "number" && format !== "text"
                        return (
                          <td
                            key={cellIndex}
                            className={cn(
                              "px-3 py-1.5 font-mono text-[11.5px] whitespace-nowrap",
                              numeric ? "font-semibold text-zinc-950" : "text-zinc-700"
                            )}
                          >
                            {numeric ? formatValue(cell, format) : String(cell)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : chart ? (
            <InsightChart chart={chart} />
          ) : null}
        </div>
      ) : null}

      <div className="mt-[13px] flex flex-wrap items-center gap-[9px]">
        <span className="text-[11px] text-zinc-500">Confidence</span>
        <StatusPill className={cn("border", CONFIDENCE_STYLE[insight.confidence.value])}>
          {insight.confidence.value}
        </StatusPill>
        <span className="min-w-0 flex-1 text-[11px] text-zinc-400">
          {insight.confidence.note}
        </span>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-[7px] border-t border-zinc-100 pt-3">
        <span className="inline-flex items-center gap-[5px] rounded-full border border-zinc-200 px-[9px] py-[3px] text-[10.5px] text-zinc-600">
          <Icon name="ti-book-2" size={12} />
          context {insight.contextVersion}
        </span>
        {insight.cached ? (
          <span
            title="Same question, unchanged context — replayed from insight_cache, no model call"
            className="inline-flex items-center gap-[5px] rounded-full border border-zinc-200 px-[9px] py-[3px] text-[10.5px] text-zinc-600"
          >
            <Icon name="ti-bolt" size={12} />
            cached
          </span>
        ) : null}
        {traceUrl ? (
          <a
            href={traceUrl}
            target="_blank"
            rel="noreferrer"
            title="Open the Langfuse trace"
            className="inline-flex items-center gap-[5px] rounded-full border border-zinc-200 px-[9px] py-[3px] font-mono text-[10.5px] text-zinc-600 hover:border-zinc-400"
          >
            <Icon name="ti-route" size={12} />
            trace
          </a>
        ) : null}
        {queries.length > 0 ? (
          <Button
            variant="outline"
            onClick={() => setSqlOpen((open) => !open)}
            className={capsuleButton}
          >
            <Icon name="ti-code" size={12} />
            SQL · {queries.length}
            <Icon name={sqlOpen ? "ti-chevron-up" : "ti-chevron-down"} size={11} />
          </Button>
        ) : null}
        {chart && queries.length > 0 ? (
          <Button
            variant="outline"
            onClick={() => saveToDashboard(insight, chart.sourceTask)}
            className={cn(
              capsuleButton,
              "font-[550] text-zinc-900 hover:border-zinc-900 hover:text-zinc-900"
            )}
          >
            <Icon name="ti-layout-dashboard" size={12} />
            Save to dashboard
          </Button>
        ) : null}
      </div>

      {sqlOpen && queries.length > 0 ? (
        <CodeSurface className="mt-2.5 flex flex-col gap-3 overflow-x-auto rounded-[9px] px-3.5 py-3">
          {queries.map((entry) => (
            <div key={entry.task}>
              <div className="mb-1 font-mono text-[10px] tracking-[.04em] text-zinc-500 uppercase">
                {entry.title} · {entry.rowCount} row{entry.rowCount === 1 ? "" : "s"}
              </div>
              <div className="font-mono text-[11px] leading-[1.7] whitespace-pre text-zinc-300">
                {entry.query}
              </div>
            </div>
          ))}
        </CodeSurface>
      ) : null}
    </Panel>
  )
}
