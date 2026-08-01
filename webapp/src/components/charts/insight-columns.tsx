import { Bar, BarChart, Cell, LabelList, XAxis, YAxis } from "recharts"

import type { ColumnPoint } from "@/api/types"
import { ChartContainer, type ChartConfig } from "@/components/ui/chart"

const config = {
  value: { label: "Value", color: "var(--color-teal)" },
} satisfies ChartConfig

const MONO = "'Geist Mono', ui-monospace, monospace"

/**
 * The labelled column chart an insight card carries. Bar values are the px
 * heights from the design, so the chart plots at 1:1 and the relative
 * proportions survive the move to Recharts.
 */
export function InsightColumns({
  columns,
  scale = 1,
  maxBarSize = 54,
}: {
  columns: ColumnPoint[]
  /** dashboards render the same chart at 72% */
  scale?: number
  maxBarSize?: number
}) {
  const data = columns.map((column) => ({
    label: column.label,
    value: Math.round(column.height * scale),
    display: column.value,
    hot: column.hot,
  }))
  const max = Math.max(...data.map((d) => d.value))

  return (
    <ChartContainer
      config={config}
      className="aspect-auto w-full"
      style={{ height: max + 46 }}
    >
      <BarChart data={data} margin={{ top: 18 }} barCategoryGap="26%">
        <YAxis hide domain={[0, max]} />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tickMargin={6}
          height={22}
          interval={0}
          tick={{ fontSize: 10.5, fill: "var(--color-zinc-500)" }}
        />
        <Bar dataKey="value" radius={[6, 6, 2, 2]} maxBarSize={maxBarSize} isAnimationActive={false}>
          {data.map((point) => (
            <Cell
              key={point.label}
              fill={point.hot ? "var(--color-coral)" : "var(--color-teal)"}
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
    </ChartContainer>
  )
}
