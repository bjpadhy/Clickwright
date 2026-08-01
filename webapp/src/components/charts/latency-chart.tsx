import { Area, AreaChart, Bar, BarChart, Cell, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type { ChartView } from "@/state/console"

const config = {
  value: { label: "p95", color: "var(--color-teal)" },
} satisfies ChartConfig

/** The one hour that spikes is the express_checkout backfill. */
const SPIKE_INDEX = 22

export function LatencyChart({ data, view }: { data: number[]; view: ChartView }) {
  const points = data.map((value, index) => ({ hour: index, value }))
  const max = Math.max(...data)
  const format = (value: number) => `p95 ${Number(value) * 4}ms`

  return (
    <ChartContainer config={config} className="mt-4 aspect-auto h-[108px] w-full">
      {view === "bars" ? (
        <BarChart data={points} margin={{ top: 4 }} barCategoryGap="10%">
          <XAxis dataKey="hour" hide />
          <YAxis hide domain={[0, max * 1.05]} />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideLabel formatter={(v) => format(Number(v))} />}
          />
          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
            {points.map((point) => (
              <Cell
                key={point.hour}
                fill={point.hour === SPIKE_INDEX ? "var(--color-coral)" : "var(--color-teal)"}
              />
            ))}
          </Bar>
        </BarChart>
      ) : (
        <AreaChart data={points} margin={{ top: 4 }}>
          <XAxis dataKey="hour" hide />
          <YAxis hide domain={[0, max * 1.15]} />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideLabel formatter={(v) => format(Number(v))} />}
          />
          <Area
            dataKey="value"
            type="linear"
            stroke="var(--color-teal)"
            strokeWidth={1}
            strokeLinejoin="round"
            fill="rgba(42,157,144,.12)"
            dot={false}
            activeDot={{ r: 2.5, strokeWidth: 0, fill: "var(--color-teal)" }}
          />
        </AreaChart>
      )}
    </ChartContainer>
  )
}
