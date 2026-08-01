import { Panel } from "@/components/ui-kit/panel"

export interface Stat {
  key: string
  value: string
  detail: string
}

export function StatCards({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid grid-cols-4 gap-3">
      {stats.map((stat) => (
        <Panel key={stat.key} className="px-4 py-3.5">
          <div className="text-[11px] font-[550] text-zinc-500">{stat.key}</div>
          <div className="mt-1 font-mono text-[22px] font-[650] tracking-[-.02em]">
            {stat.value}
          </div>
          <div className="mt-[3px] text-[10.5px] text-zinc-400">{stat.detail}</div>
        </Panel>
      ))}
    </div>
  )
}
