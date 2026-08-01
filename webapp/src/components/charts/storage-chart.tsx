import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts"

import { ChartContainer, type ChartConfig } from "@/components/ui/chart"
import { makeCategoryTick } from "./axis-tick"

const config = {
  value: { label: "Size", color: "var(--color-teal)" },
} satisfies ChartConfig

const LABEL_WIDTH = 168
const VALUE_WIDTH = 52
const ROW_PITCH = 18

export interface StorageRow {
  table: string
  megabytes: number
  agentCreated: boolean
}

function formatSize(megabytes: number) {
  return megabytes >= 1000 ? `${(megabytes / 1000).toFixed(1)} GB` : `${megabytes} MB`
}

/** Storage per table, teal where the Instrumentation Agent created the table. */
export function StorageChart({ rows }: { rows: StorageRow[] }) {
  const max = Math.max(...rows.map((row) => row.megabytes))
  const data = rows.map((row) => ({
    label: row.table,
    value: Math.round((row.megabytes / max) * 100),
    display: formatSize(row.megabytes),
    agentCreated: row.agentCreated,
  }))
  const values = new Map(data.map((row) => [row.label, row.display]))

  return (
    <ChartContainer
      config={config}
      className="mt-4 aspect-auto w-full"
      style={{ height: data.length * ROW_PITCH }}
    >
      <BarChart data={data} layout="vertical" margin={{ top: 0, bottom: 0 }}>
        <XAxis type="number" hide domain={[0, 100]} />
        <YAxis
          yAxisId="label"
          type="category"
          dataKey="label"
          width={LABEL_WIDTH}
          axisLine={false}
          tickLine={false}
          tickMargin={10}
          interval={0}
          tick={makeCategoryTick({
            anchor: "end",
            fontSize: 10.5,
            fill: "var(--color-zinc-600)",
          })}
        />
        <YAxis
          yAxisId="value"
          orientation="right"
          type="category"
          dataKey="label"
          width={VALUE_WIDTH}
          axisLine={false}
          tickLine={false}
          tickMargin={0}
          interval={0}
          tick={makeCategoryTick({
            text: (label) => values.get(label) ?? "",
            anchor: "end",
            // a few px shy of the column edge so the last glyph never clips
            dx: VALUE_WIDTH - 6,
            fontSize: 10.5,
            fill: "var(--color-zinc-400)",
          })}
        />
        <Bar
          yAxisId="label"
          dataKey="value"
          barSize={12}
          radius={3}
          isAnimationActive={false}
          background={{ fill: "var(--color-zinc-100)", radius: 3 }}
        >
          {data.map((row) => (
            <Cell
              key={row.label}
              fill={row.agentCreated ? "var(--color-teal)" : "var(--color-zinc-300)"}
            />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
