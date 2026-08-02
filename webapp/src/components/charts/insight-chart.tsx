import { Bar, BarChart, Cell, LabelList, Line, LineChart, XAxis, YAxis } from "recharts"

import type { InsightChart as InsightChartData, ValueFormat } from "@/api/chat"
import { ChartContainer, type ChartConfig } from "@/components/ui/chart"

const config = {
  value: { label: "Value", color: "var(--color-teal)" },
} satisfies ChartConfig

const MONO = "'Geist Mono', ui-monospace, monospace"

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
 * The chart an insight card carries. `kind` and the series come from the agent;
 * the bar heights are the real values, so the proportions are the data's.
 */
export function InsightChart({
  chart,
  scale = 1,
}: {
  chart: InsightChartData
  /** dashboards and previews render the same chart smaller */
  scale?: number
}) {
  const data = chart.series.map((point) => ({
    label: point.label,
    value: point.value,
    display: formatValue(point.value, chart.valueFormat),
  }))
  const values = data.map((point) => point.value)
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  // The weakest bar is the one an operator acts on — mark it, but only when
  // there is a spread worth pointing at.
  const lowest = values.length > 2 && max > 0 && min < max * 0.75 ? Math.min(...values) : null

  // When there are many bars with long labels, rotate them to avoid overlap.
  const needsRotation = data.length > 5 || data.some((d) => d.label.length > 12)
  const xAxisHeight = needsRotation ? 70 : 22
  const chartHeight = Math.round((150 + (needsRotation ? 50 : 0)) * scale)

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
