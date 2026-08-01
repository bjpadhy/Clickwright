import { TraceChip } from "@/components/ui-kit/chips"
import { FilterPill, FilterPills } from "@/components/ui-kit/controls"
import { Icon } from "@/components/ui-kit/icon"
import { Panel } from "@/components/ui-kit/panel"
import { useConsole, type LogFilter } from "@/state/console"

const FILTERS: { id: LogFilter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "table", label: "Schema changes" },
  { id: "ctx", label: "Context versions" },
]

export function ChangelogTab() {
  const { server, logFilter, setLogFilter, showTrace } = useConsole()

  const entries = server.changelog.filter(
    (entry) => logFilter === "all" || entry.kind === logFilter
  )

  return (
    <>
      <div className="flex items-center gap-2">
        <FilterPills
          value={logFilter}
          onValueChange={(value) => setLogFilter(value as LogFilter)}
        >
          {FILTERS.map((filter) => (
            <FilterPill key={filter.id} value={filter.id}>
              {filter.label}
            </FilterPill>
          ))}
        </FilterPills>
        <div className="flex-1" />
        <span className="text-[11px] text-zinc-400">
          schema changes and context versions, one stream
        </span>
      </div>

      <Panel className="px-5 py-[18px]">
        <div className="flex flex-col">
          {entries.map((entry, index) => (
            <div key={entry.id} className="flex gap-3.5">
              <div className="flex flex-col items-center">
                <div
                  className="flex size-7 shrink-0 items-center justify-center rounded-full"
                  style={{
                    background: entry.warn
                      ? "#fffbeb"
                      : entry.kind === "ctx"
                        ? "#e9eef2"
                        : "#e6f4f1",
                  }}
                >
                  <Icon
                    name={entry.icon}
                    size={14}
                    style={{
                      color: entry.warn
                        ? "#d97706"
                        : entry.kind === "ctx"
                          ? "#274754"
                          : "#1a6e64",
                    }}
                  />
                </div>
                {index < entries.length - 1 ? (
                  <div className="my-1 w-0.5 flex-1 bg-zinc-100" />
                ) : null}
              </div>
              <div className="min-w-0 flex-1 pb-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10.5px] text-zinc-400">
                    {entry.time}
                  </span>
                  <span className="text-[13px] font-semibold">{entry.title}</span>
                  {entry.warn ? (
                    <span className="rounded-full border border-orange-200 bg-orange-50 px-[7px] py-0.5 text-[10px] font-semibold text-orange-800">
                      contradiction surfaced
                    </span>
                  ) : null}
                </div>
                <div className="mt-[3px] text-[12px] leading-[1.55] text-zinc-500">
                  {entry.desc}
                </div>
                {entry.traceId ? (
                  <TraceChip
                    traceId={entry.traceId}
                    onClick={() => showTrace(entry.traceId!)}
                    className="mt-1.5 bg-white px-[9px] py-[2.5px] text-[10.5px]"
                  />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </>
  )
}
