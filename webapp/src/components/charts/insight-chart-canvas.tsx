import * as React from "react"
import { Bar, BarChart, Cell, LabelList, Line, LineChart, XAxis, YAxis } from "recharts"

import type { InsightChart as InsightChartData } from "@/api/chat"
import { ChartContainer, type ChartConfig } from "@/components/ui/chart"
import { chartLayout, formatValue } from "./insight-chart"

const config = {
  value: { label: "Value", color: "var(--color-teal)" },
} satisfies ChartConfig

const MONO = "'Geist Mono', ui-monospace, monospace"

/**
 * The chart an insight card carries. `kind` and the series come from the agent;
 * the bar heights are the real values, so the proportions are the data's.
 *
 * Memoised, and so is everything derived from the series. A conversation holds
 * one of these per answer, and every step event of the NEXT answer used to
 * re-run the whole derivation and hand Recharts a brand-new `data` array —
 * which it treats as new data and re-lays-out the chart. The insight it draws
 * is immutable once written, so an identical `chart` prop is a no-op.
 */
export function InsightChartCanvas({
  chart,
  scale = 1,
}: {
  chart: InsightChartData
  /** dashboards and previews render the same chart smaller */
  scale?: number
}) {
  const { data, min, max, lowest, needsRotation } = React.useMemo(() => {
    const rows = chart.series.map((point) => ({
      label: point.label,
      value: point.value,
      display: formatValue(point.value, chart.valueFormat),
    }))
    const values = rows.map((point) => point.value)
    const high = Math.max(...values, 0)
    const low = Math.min(...values, 0)
    return {
      data: rows,
      min: low,
      max: high,
      // The weakest bar is the one an operator acts on — mark it, but only when
      // there is a spread worth pointing at.
      lowest:
        values.length > 2 && high > 0 && low < high * 0.75 ? Math.min(...values) : null,
      // When there are many bars with long labels, rotate them to avoid overlap.
      needsRotation: rows.length > 5 || rows.some((d) => d.label.length > 12),
    }
  }, [chart])

  const xAxisHeight = needsRotation ? 70 : 22
  const chartHeight = chartLayout(chart, scale).height

  const xTickProps = needsRotation
    ? { fontSize: 9.5, fill: "var(--color-zinc-500)", textAnchor: "end" as const, angle: -35 }
    : { fontSize: 10.5, fill: "var(--color-zinc-500)" }

  return (
    <ChartContainer
      config={config}
      className="aspect-auto w-full"
      style={{ height: chartHeight }}
    >
      {chart.kind === "line" ? (
        <LineChart data={data} margin={{ top: 20, left: 4, right: 8, bottom: needsRotation ? 10 : 0 }}>
          <YAxis hide domain={[min < 0 ? min * 1.1 : 0, max * 1.15]} />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tickMargin={6}
            height={xAxisHeight}
            interval="preserveStartEnd"
            tick={xTickProps}
          />
          <Line
            dataKey="value"
            type="monotone"
            stroke="var(--color-teal)"
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={{ r: 2.5, strokeWidth: 0, fill: "var(--color-teal)" }}
          >
            <LabelList
              dataKey="display"
              position="top"
              offset={8}
              fontSize={10.5}
              fontFamily={MONO}
              fontWeight={650}
              fill="var(--color-zinc-700)"
            />
          </Line>
        </LineChart>
      ) : (
        <BarChart data={data} margin={{ top: 20, bottom: needsRotation ? 10 : 0 }} barCategoryGap="26%">
          <YAxis hide domain={[min < 0 ? min * 1.1 : 0, max * 1.15]} />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tickMargin={6}
            height={xAxisHeight}
            interval={0}
            tick={xTickProps}
          />
          <Bar
            dataKey="value"
            radius={[6, 6, 2, 2]}
            maxBarSize={Math.round(54 * scale)}
            isAnimationActive={false}
          >
            {data.map((point, index) => (
              <Cell
                key={`${point.label}-${index}`}
                fill={
                  lowest !== null && point.value === lowest
                    ? "var(--color-coral)"
                    : "var(--color-teal)"
                }
              />
            ))}
            <LabelList
              dataKey="display"
              position="top"
              offset={6}
              fontSize={11}
              fontFamily={MONO}
              fontWeight={650}
              fill="var(--color-zinc-700)"
            />
          </Bar>
        </BarChart>
      )}
    </ChartContainer>
  )
}
