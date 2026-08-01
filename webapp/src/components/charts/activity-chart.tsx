import { Area, AreaChart, Bar, BarChart, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type { ChartView } from "@/state/console"

const config = {
  value: { label: "Activity", color: "var(--color-teal)" },
} satisfies ChartConfig

/** 15-minute buckets of agent activity since the hack started. */
export function ActivityChart({
  data,
  unit,
  view,
}: {
  data: number[]
  unit: string
  view: ChartView
}) {
  const points = data.map((value, index) => ({ bucket: index, value }))
  const max = Math.max(...data)
  const format = (value: number) => `${value}${unit}`

  return (
    <ChartContainer config={config} className="mt-4 aspect-auto h-[120px] w-full">
      {view === "bars" ? (
        <BarChart data={points} margin={{ top: 4 }} barCategoryGap="6%">
          <XAxis dataKey="bucket" hide />
          <YAxis hide domain={[0, max * 1.07]} />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideLabel formatter={(v) => format(Number(v))} />}
          />
          <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} />
        </BarChart>
      ) : (
        <AreaChart data={points} margin={{ top: 4 }}>
          <XAxis dataKey="bucket" hide />
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
