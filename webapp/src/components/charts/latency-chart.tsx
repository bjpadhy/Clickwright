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

export interface LatencyPoint {
  /** ISO timestamp at the start of the hour */
  hour: string
  p95Ms: number
  queries: number
  /** measured, not fixed — the backend flags a bucket whose p95 is at least
   *  double the median busy hour */
  isSpike: boolean
}

/** p95 per hour over the last 24h; the coral bar is whichever hour spiked. */
export function LatencyChart({
  data,
  view,
}: {
  data: LatencyPoint[]
  view: ChartView
}) {
  const points = data.map((point, index) => ({
    index,
    value: point.p95Ms,
    // The backend sends UTC; a tooltip reading 18:00 for the user's 23:30 is
    // worse than no label at all.
    label: new Date(point.hour).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
  }))
  // An all-quiet window would otherwise hand recharts a zero-height domain.
  const max = Math.max(...points.map((point) => point.value), 1)
  const format = (value: number) => `p95 ${Math.round(Number(value))}ms`

  return (
    <ChartContainer config={config} className="mt-4 aspect-auto h-[108px] w-full">
      {view === "bars" ? (
        <BarChart data={points} margin={{ top: 4 }} barCategoryGap="10%">
          <XAxis dataKey="index" hide />
          <YAxis hide domain={[0, max * 1.05]} />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent labelKey="label" formatter={(v) => format(Number(v))} />
            }
          />
          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
            {points.map((point, index) => (
              <Cell
                key={point.index}
                fill={
                  data[index]?.isSpike ? "var(--color-coral)" : "var(--color-teal)"
                }
              />
            ))}
          </Bar>
        </BarChart>
      ) : (
        <AreaChart data={points} margin={{ top: 4 }}>
          <XAxis dataKey="index" hide />
          <YAxis hide domain={[0, max * 1.15]} />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent labelKey="label" formatter={(v) => format(Number(v))} />
            }
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
