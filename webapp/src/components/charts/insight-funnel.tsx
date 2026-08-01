import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts"

import type { FunnelRow } from "@/api/types"
import { ChartContainer, type ChartConfig } from "@/components/ui/chart"
import { makeCategoryTick } from "./axis-tick"

const config = {
  value: { label: "Users", color: "var(--color-teal)" },
} satisfies ChartConfig

/**
 * Label and value columns are sized to fit the longest step name and value at
 * each font size — SVG text can't ellipsize, so it must not overflow.
 */
const SIZES = {
  lg: { labelWidth: 178, valueWidth: 148, barSize: 24, pitch: 30, fontSize: 11 },
  sm: { labelWidth: 162, valueWidth: 136, barSize: 20, pitch: 25, fontSize: 10 },
} as const

/**
 * Ordered funnel steps as horizontal bars. A second, right-oriented category
 * axis carries the value column so labels, bars and values stay on one
 * baseline no matter how short the bar is.
 */
export function InsightFunnel({
  rows,
  size = "lg",
}: {
  rows: FunnelRow[]
  size?: keyof typeof SIZES
}) {
  const { labelWidth, valueWidth, barSize, pitch, fontSize } = SIZES[size]
  const data = rows.map((row) => ({
    label: row.label,
    value: parseFloat(row.width),
    display: row.value,
  }))
  const values = new Map(data.map((row) => [row.label, row.display]))

  return (
    <ChartContainer
      config={config}
      className="aspect-auto w-full"
      style={{ height: data.length * pitch }}
    >
      <BarChart data={data} layout="vertical" margin={{ top: 0, bottom: 0 }}>
        <XAxis type="number" hide domain={[0, 100]} />
        <YAxis
          yAxisId="label"
          type="category"
          dataKey="label"
          width={labelWidth}
          axisLine={false}
          tickLine={false}
          tickMargin={9}
          interval={0}
          tick={makeCategoryTick({
            anchor: "end",
            fontSize,
            fill: "var(--color-zinc-600)",
          })}
        />
        <YAxis
          yAxisId="value"
          orientation="right"
          type="category"
          dataKey="label"
          width={valueWidth}
          axisLine={false}
          tickLine={false}
          tickMargin={9}
          interval={0}
          tick={makeCategoryTick({
            text: (label) => values.get(label) ?? "",
            anchor: "start",
            fontSize,
            fill: "var(--color-zinc-700)",
          })}
        />
        <Bar
          yAxisId="label"
          dataKey="value"
          barSize={barSize}
          radius={5}
          isAnimationActive={false}
          background={{ fill: "var(--color-zinc-50)", radius: 5 }}
        >
          {data.map((row, index) => (
            <Cell
              key={row.label}
              fill={index === 0 ? "var(--color-navy)" : "var(--color-teal)"}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
