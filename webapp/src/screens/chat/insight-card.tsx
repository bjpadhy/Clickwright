import type { Answer, ChatMessage } from "@/api/types"
import { InsightColumns } from "@/components/charts/insight-columns"
import { InsightFunnel } from "@/components/charts/insight-funnel"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { TraceChip } from "@/components/ui-kit/chips"
import { CodeSurface } from "@/components/ui-kit/code"
import { Segmented, SegmentedItem } from "@/components/ui-kit/controls"
import { Icon } from "@/components/ui-kit/icon"
import { Panel } from "@/components/ui-kit/panel"
import { capsuleButton } from "@/components/ui-kit/styles"
import { cn } from "@/lib/utils"
import { useConsole } from "@/state/console"

/** The insight itself: headline, tagged findings, chart, confidence, sources. */
export function InsightCard({
  answer,
  message,
}: {
  answer: Answer
  message: ChatMessage
}) {
  const { chartMode, setChartMode, sqlOpen, toggleSql, showTrace, pinToDashboard } =
    useConsole()

  const ctx = message.contextVersion
  const withCtx = (text: string) => text.replace("{ctx}", ctx)

  const hasChart = !!(answer.funnel || answer.columns)
  const mode = chartMode[message.id] ?? "chart"
  const showTable = mode === "table"
  const tableRows = answer.funnel
    ? answer.funnel.map((row) => ({ label: row.label, value: row.value }))
    : (answer.columns ?? []).map((column) => ({
        label: column.label,
        value: column.value,
      }))

  const confidence = answer.confidence
  const sqlIsOpen = !!sqlOpen[message.id]

  return (
    <Panel className="animate-fade-up-lg px-[18px] py-4">
      <div className="text-[15px] leading-[1.4] font-[650] tracking-[-.005em]">
        {withCtx(answer.headline)}
      </div>

      <div className="mt-3 flex flex-col gap-[9px]">
        {answer.findings.map((finding) => (
          <div key={finding.tag} className="flex items-baseline gap-[9px]">
            <span
              className="-translate-y-px shrink-0 rounded-[5px] px-[7px] py-[2.5px] text-[9.5px] font-bold tracking-[.06em]"
              style={{ background: finding.bg, color: finding.fg }}
            >
              {finding.tag}
            </span>
            <span className="text-[12.5px] leading-[1.6] text-zinc-700">
              {withCtx(finding.text)}
            </span>
          </div>
        ))}
      </div>

      {hasChart ? (
        <div className="mt-[13px] rounded-[10px] border border-zinc-100 px-3.5 py-[13px]">
          <div className="mb-2.5 flex items-center gap-2">
            <span className="flex-1 text-[11.5px] font-semibold text-zinc-500">
              {answer.chartTitle}
            </span>
            <Segmented
              value={mode}
              onValueChange={(value) =>
                setChartMode(message.id, value as "chart" | "table")
              }
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
          </div>

          {showTable ? (
            <div className="overflow-hidden rounded-lg border border-zinc-100">
              <div className="flex bg-zinc-50 px-3 py-1.5 text-[10px] font-[650] tracking-[.05em] text-zinc-400">
                <span className="flex-1">SEGMENT</span>
                <span>VALUE</span>
              </div>
              {tableRows.map((row) => (
                <div
                  key={row.label}
                  className="flex border-t border-zinc-100 px-3 py-1.5 font-mono text-[11.5px]"
                >
                  <span className="flex-1 text-zinc-700">{row.label}</span>
                  <span className="font-semibold text-zinc-950">{row.value}</span>
                </div>
              ))}
            </div>
          ) : answer.funnel ? (
            <InsightFunnel rows={answer.funnel} />
          ) : answer.columns ? (
            <InsightColumns columns={answer.columns} />
          ) : null}
        </div>
      ) : null}

      {confidence != null ? (
        <div className="mt-[13px] flex items-center gap-[9px]">
          <span className="text-[11px] text-zinc-500">Confidence</span>
          <Progress
            value={confidence * 100}
            className={cn(
              "h-1.5 w-[110px] rounded-full bg-zinc-100",
              confidence >= 0.85
                ? "[&_[data-slot=progress-indicator]]:bg-teal"
                : "[&_[data-slot=progress-indicator]]:bg-sand"
            )}
          />
          <span className="font-mono text-[12px] font-[650]">
            {confidence.toFixed(2)}
          </span>
          <span className="text-[11px] text-zinc-400">{answer.confidenceNote}</span>
        </div>
      ) : null}

      <div className="mt-3.5 flex flex-wrap items-center gap-[7px] border-t border-zinc-100 pt-3">
        <span className="inline-flex items-center gap-[5px] rounded-full border border-zinc-200 px-[9px] py-[3px] text-[10.5px] text-zinc-600">
          <Icon name="ti-book-2" size={12} />
          context v{ctx}
        </span>
        {answer.traceId ? (
          <TraceChip
            traceId={answer.traceId}
            onClick={() => showTrace(answer.traceId!)}
            className="text-[10.5px]"
          />
        ) : null}
        {answer.sql ? (
          <Button
            variant="outline"
            onClick={() => toggleSql(message.id)}
            className={capsuleButton}
          >
            <Icon name="ti-code" size={12} />
            SQL
            <Icon name={sqlIsOpen ? "ti-chevron-up" : "ti-chevron-down"} size={11} />
          </Button>
        ) : null}
        {hasChart ? (
          <Button
            variant="outline"
            onClick={() => pinToDashboard(answer.key)}
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

      {answer.sql && sqlIsOpen ? (
        <CodeSurface className="mt-2.5 overflow-x-auto rounded-[9px] px-3.5 py-3">
          <div className="font-mono text-[11px] leading-[1.7] whitespace-pre text-zinc-300">
            {answer.sql}
          </div>
        </CodeSurface>
      ) : null}
    </Panel>
  )
}
