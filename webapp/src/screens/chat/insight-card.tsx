import * as React from "react"

import type { ConfidenceSignal, Insight } from "@/api/chat"
import { formatValue, InsightChart } from "@/components/charts/insight-chart"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CodeSurface } from "@/components/ui-kit/code"
import { Segmented, SegmentedItem } from "@/components/ui-kit/controls"
import { Icon } from "@/components/ui-kit/icon"
import { Panel } from "@/components/ui-kit/panel"
import { capsuleButton } from "@/components/ui-kit/styles"
import { cn } from "@/lib/utils"

type ConfidenceLevel = Insight["confidence"]["value"]

/** The meter fill tracks the level, so colour and number never disagree. */
const CONFIDENCE_FILL: Record<ConfidenceLevel, string> = {
  high: "bg-teal",
  medium: "bg-sand",
  low: "bg-coral",
}

/** The level word as a chip, in the same tints the section labels use. */
const CONFIDENCE_CHIP: Record<ConfidenceLevel, string> = {
  high: "bg-[#e6f4f1] text-[#1a6e64]",
  medium: "bg-[#faf1d6] text-[#7a5a0a]",
  low: "bg-[#fdeae4] text-[#a03c22]",
}

/**
 * One answer, in the order a PM reads it: the headline, what is happening, why it
 * happens, the evidence, what was already known, and what to do.
 *
 * Each section is a distinct key on the insight rather than an entry in a list,
 * so the card can label them — a reader always finds the mechanism in the same
 * place, and an answer that omits one cannot render as if it were complete.
 *
 * `print` renders the same card for the PDF export: no controls, and anything
 * behind a toggle is laid out in full, because paper has no interactions.
 */
function InsightCardImpl({
  insight,
  traceUrl,
  print = false,
}: {
  insight: Insight
  traceUrl?: string
  print?: boolean
}) {
  const [sqlOpen, setSqlOpen] = React.useState(false)
  const [view, setView] = React.useState<"chart" | "table">("chart")

  const { evidence, confidence } = insight
  // Optional on the wire: cards stored before the breakdown existed have none.
  const signals = confidence.signals ?? []
  const verification = insight.verification ?? null
  const droppedTasks = insight.droppedTasks ?? []
  const chart = evidence?.chart ?? null
  const segmentTable = evidence?.segmentTable ?? null
  // On screen one of the two is behind a toggle; on paper both are shown.
  const showToggle = !!chart && !!segmentTable && !print
  const showTable = !!segmentTable && (!chart || print || view === "table")
  const showChart = !!chart && (print || !showTable)
  const queries = insight.sql.filter((entry) => entry.query)

  return (
    // A whole card must be allowed to break across pages in the PDF — holding one
    // together pushes it to the next page and leaves the current one blank.
    <Panel className={cn("px-[18px] py-4", !print && "animate-fade-up-lg")}>
      <div className="text-[15px] leading-[1.4] font-[650] tracking-[-.005em]">
        {insight.headline}
      </div>

      <div className="print-stack mt-3.5 flex flex-col gap-2.5">
        <Section label="WHAT'S HAPPENING" tone="teal" text={insight.whatsHappening} />
        <Section label="WHY IT HAPPENS" tone="coral" text={insight.whyItHappens} />
      </div>

      {chart || segmentTable ? (
        <div className="print-block mt-[13px] rounded-[10px] border border-zinc-100 px-3.5 py-[13px]">
          <div className="mb-2.5 flex items-center gap-2">
            <span className="shrink-0 rounded-[5px] border border-zinc-200 px-[7px] py-[2.5px] text-[9.5px] font-bold tracking-[.06em] text-zinc-500">
              EVIDENCE
            </span>
            <span className="min-w-0 flex-1 text-[11.5px] font-semibold text-zinc-500">
              {evidence?.title || "Supporting cut"}
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

          {showChart && chart ? <InsightChart chart={chart} /> : null}

          {showTable && segmentTable ? (
            <div
              className={cn(
                "overflow-x-auto rounded-lg border border-zinc-100",
                showChart && "mt-3"
              )}
            >
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
          ) : null}
        </div>
      ) : null}

      {/* Empty whenever nothing retrieved genuinely bears on the answer — an
          invented connection to a known issue is worse than none. */}
      {insight.groundedInContext ? (
        <div className="print-block mt-[13px] flex gap-[9px] rounded-[9px] bg-zinc-50 px-3 py-2.5">
          <Icon name="ti-book-2" size={14} className="mt-[3px] shrink-0 text-zinc-500" />
          <div className="text-[12.5px] leading-[1.6] text-zinc-700">
            <span className="font-[650] text-zinc-900">Grounded in context — </span>
            {insight.groundedInContext}
          </div>
        </div>
      ) : null}

      {insight.recommendedAction ? (
        <div className="print-block mt-[13px] flex gap-[11px] rounded-[10px] bg-zinc-900 px-3.5 py-3">
          <Icon name="ti-bulb" size={15} className="mt-px shrink-0 text-sand" />
          <div className="min-w-0">
            <div className="text-[9.5px] font-bold tracking-[.07em] text-zinc-400">
              RECOMMENDED ACTION
            </div>
            <div className="mt-[5px] text-[12.5px] leading-[1.6] text-white">
              {insight.recommendedAction}
            </div>
          </div>
        </div>
      ) : null}

      <div className="print-block mt-[13px] flex flex-wrap items-center gap-[9px]">
        <span className="text-[11px] text-zinc-500">Confidence</span>
        <span
          className={cn(
            "rounded-full px-[7px] py-[2px] text-[9.5px] font-bold tracking-[.06em] uppercase",
            CONFIDENCE_CHIP[confidence.value]
          )}
        >
          {confidence.value}
        </span>
        <ConfidenceMeter
          value={confidence.value}
          score={confidence.score}
          signals={print ? [] : signals}
        />
        {verification && verification.agreed === null ? (
          <span
            title={verification.note}
            className="rounded-full border border-dashed border-zinc-300 px-[7px] py-[2px] text-[10px] text-zinc-500"
          >
            not independently verified
          </span>
        ) : null}
        <span className="min-w-0 flex-1 text-[11px] text-zinc-400">{confidence.note}</span>
      </div>

      {/* Paper has no hover, so the breakdown behind the tooltip is laid out in full. */}
      {print && signals.length > 0 ? (
        <ul className="print-block mt-1.5 flex flex-col gap-[3px] pl-[76px]">
          {signals.map((signal) => (
            <li key={signal.name} className="text-[10.5px] leading-[1.5] text-zinc-500">
              <SignalLine signal={signal} />
            </li>
          ))}
        </ul>
      ) : null}

      {/* The auditor's best argument that the figure is wrong — shown even when
          the numbers agreed; coral when it says the definition was not followed. */}
      {verification?.concern ? (
        <div
          className={cn(
            "print-block mt-2 text-[11.5px] leading-[1.55]",
            verification.definitionOk === false ? "text-coral" : "text-zinc-600"
          )}
        >
          <span className="font-[650]">Auditor's concern — </span>
          {verification.concern}
        </div>
      ) : null}

      {droppedTasks.length > 0 ? (
        <div className="print-block mt-1.5 text-[11px] leading-[1.55] text-zinc-400">
          {droppedTasks.length} planned task{droppedTasks.length === 1 ? "" : "s"} returned no
          data: {droppedTasks.join("; ")}
        </div>
      ) : null}

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
        {traceUrl && !print ? (
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
        {queries.length > 0 && !print ? (
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
      </div>

      {(sqlOpen || print) && queries.length > 0 ? (
        <CodeSurface className="print-stack mt-2.5 flex flex-col gap-3 overflow-x-auto rounded-[9px] px-3.5 py-3">
          {queries.map((entry) => (
            <div key={entry.task}>
              <div className="mb-1 font-mono text-[10px] tracking-[.04em] text-zinc-500 uppercase">
                {entry.title} ·{" "}
                {entry.totalRows !== undefined && entry.totalRows > entry.rowCount
                  ? // The fetched rows are a sample; saying "1000 rows" would understate
                    // an answer computed over every one of them.
                    `${entry.rowCount.toLocaleString()} of ${entry.totalRows.toLocaleString()} rows analysed`
                  : `${entry.rowCount} row${entry.rowCount === 1 ? "" : "s"}`}
              </div>
              <div
                className={cn(
                  "font-mono text-[11px] leading-[1.7] text-zinc-300",
                  // paper cannot scroll sideways, so long queries wrap instead
                  print ? "break-words whitespace-pre-wrap" : "whitespace-pre"
                )}
              >
                {entry.query}
              </div>
            </div>
          ))}
        </CodeSurface>
      ) : null}
    </Panel>
  )
}

/**
 * Memoised: a streaming answer pushes an SSE step event several times a second,
 * and without this every card in the thread — and every chart under it — re-renders
 * on each one. Props are stable (the parent holds insights in state), so a shallow
 * compare is enough.
 */
export const InsightCard = React.memo(InsightCardImpl)

/** A labelled paragraph — the tag carries the section, the text carries the claim. */
function Section({
  label,
  tone,
  text,
}: {
  label: string
  tone: "teal" | "coral"
  text: string
}) {
  if (!text) return null
  return (
    <div className="flex items-baseline gap-[9px]">
      <span
        className={cn(
          "-translate-y-px shrink-0 rounded-[5px] px-[7px] py-[3px] text-[9.5px] font-bold tracking-[.06em]",
          tone === "teal" ? "bg-[#e6f4f1] text-[#1a6e64]" : "bg-[#fdeae4] text-[#a03c22]"
        )}
      >
        {label}
      </span>
      <span className="text-[12.5px] leading-[1.6] text-zinc-700">{text}</span>
    </div>
  )
}

/** `+0.05` / `−0.12` / `±0.00` — the sign is the whole point of a waterfall. */
function formatDelta(delta: number): string {
  if (delta === 0) return "±0.00"
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)}`
}

/** One signal as `name · ±delta · detail`, the way API.md documents it. */
function SignalLine({ signal }: { signal: ConfidenceSignal }) {
  return (
    <>
      <span className="font-mono">{signal.name}</span>
      <span className="mx-1 opacity-60">·</span>
      <span
        className={cn(
          "font-mono font-[650]",
          signal.delta < 0 ? "text-coral" : signal.delta > 0 ? "text-teal" : ""
        )}
      >
        {formatDelta(signal.delta)}
      </span>
      <span className="mx-1 opacity-60">·</span>
      {signal.detail}
    </>
  )
}

/**
 * Confidence as a bar plus the score, so two "medium" answers can be told apart.
 * Hovering shows the signals whose deltas sum to the score — the breakdown that
 * lets a PM see which refinement of the question would raise it.
 */
function ConfidenceMeter({
  value,
  score,
  signals,
}: {
  value: ConfidenceLevel
  score: number
  signals: ConfidenceSignal[]
}) {
  // Cards are stored as JSON and replayed forever; one written before `score`
  // existed has `undefined` here, and `undefined.toFixed(2)` threw during
  // render — which, before the per-screen boundaries, took the whole app down
  // to a fallback that had no way back to a different conversation.
  const safeScore = Number.isFinite(score) ? score : 0
  const pct = Math.round(Math.min(1, Math.max(0, safeScore)) * 100)
  const meter = (
    <span className="flex items-center gap-2" title={signals.length ? undefined : `${value} confidence`}>
      <span className="h-[6px] w-[92px] overflow-hidden rounded-full bg-zinc-200">
        <span
          className={cn("block h-full rounded-full", CONFIDENCE_FILL[value])}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="font-mono text-[11.5px] font-[650] text-zinc-900">
        {safeScore.toFixed(2)}
      </span>
    </span>
  )
  if (signals.length === 0) return meter
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{meter}</span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="flex max-w-sm flex-col items-start gap-1 px-3 py-2 text-[11px] leading-[1.5]"
      >
        <span className="text-[9.5px] font-bold tracking-[.06em] opacity-60">
          HOW THE SCORE WAS BUILT · 1 + Σ = {safeScore.toFixed(2)}
        </span>
        {signals.map((signal) => (
          <span key={signal.name} className="block">
            <SignalLine signal={signal} />
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}
