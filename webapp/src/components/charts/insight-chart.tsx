import * as React from "react"

import type { InsightChart as InsightChartData, ValueFormat } from "@/api/chat"

/**
 * Render a number the way the backend says it should be read.
 *
 * Values arrive exactly as the SQL produced them — that is what keeps every
 * number traceable to a result set — so the unit lives in a separate,
 * code-derived `ValueFormat` rather than in the value itself.
 */
export function formatValue(value: number, format: ValueFormat | "text" | undefined): string {
  if (!Number.isFinite(value)) return String(value)
  switch (format) {
    case "fraction":
      return `${(value * 100).toFixed(1)}%`
    case "percent":
      return `${round(value)}%`
    case "percentage_points":
      return `${value > 0 ? "+" : ""}${round(value)}pp`
    case "ms":
      return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${round(value)}ms`
    case "seconds":
      return `${round(value)}s`
    case "currency":
      return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    case "count":
      return Math.round(value).toLocaleString()
    default:
      return round(value)
  }
}

function round(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString()
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/**
 * Geometry, shared by the chart and by the placeholder held for it while the
 * charting library loads — so nothing on the page moves when it arrives.
 *
 * Many bars, or long labels, means rotated tick labels and a taller axis.
 */
export function chartLayout(
  chart: InsightChartData,
  scale = 1
): { needsRotation: boolean; height: number } {
  const needsRotation =
    chart.series.length > 5 || chart.series.some((point) => point.label.length > 12)
  return { needsRotation, height: Math.round((150 + (needsRotation ? 50 : 0)) * scale) }
}

/**
 * Recharts is ~300 KB — a third of the bundle — and it is needed only once an
 * answer with a chart is on screen. It is fetched as its own chunk, starting
 * the moment this module is evaluated, so it is in cache long before the first
 * answer arrives (and long before the PDF export, which can only run after a
 * conversation has rendered).
 */
const loadCanvas = () => import("./insight-chart-canvas")
const Canvas = React.lazy(() =>
  loadCanvas().then((module) => ({ default: module.InsightChartCanvas }))
)
void loadCanvas()

export interface InsightChartProps {
  chart: InsightChartData
  /** dashboards and previews render the same chart smaller */
  scale?: number
}

/**
 * The chart an insight card carries. `kind` and the series come from the
 * agent; the bar heights are the real values, so the proportions are the
 * data's.
 *
 * Memoised: a conversation holds one chart per answer, and every step event of
 * the NEXT answer used to re-render all of them — handing Recharts a brand-new
 * data array each time, which it treats as new data and re-lays-out. A
 * finished insight is immutable, so an identical `chart` prop is a no-op.
 */
export const InsightChart = React.memo(function InsightChart({
  chart,
  scale = 1,
}: InsightChartProps) {
  return (
    <React.Suspense
      fallback={<div aria-hidden style={{ height: chartLayout(chart, scale).height }} />}
    >
      <Canvas chart={chart} scale={scale} />
    </React.Suspense>
  )
})
