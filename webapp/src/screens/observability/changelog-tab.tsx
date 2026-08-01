import { TraceChip } from "@/components/ui-kit/chips"
import { FilterPill, FilterPills } from "@/components/ui-kit/controls"
import { Icon } from "@/components/ui-kit/icon"
import { Panel } from "@/components/ui-kit/panel"
import {
  formatClock,
  traceIdFromUrl,
  type ChangelogEntryDto,
} from "@/api/observability"
import { useConsole, type LogFilter } from "@/state/console"
import { useChangelog } from "./use-observe"
import { EmptyNote, LoadError } from "./states"

const FILTERS: { id: LogFilter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "table", label: "Schema changes" },
  { id: "ctx", label: "Context versions" },
]

/** The backend says "context"; the UI's filter chips have always said "ctx". */
function uiKind(entry: ChangelogEntryDto): "table" | "ctx" {
  return entry.kind === "context" ? "ctx" : "table"
}

/** Presentation, so it lives here rather than in the API payload. */
function iconFor(entry: ChangelogEntryDto): string {
  if (entry.warn) return "ti-alert-triangle"
  return entry.kind === "context" ? "ti-book-2" : "ti-table"
}

export function ChangelogTab() {
  const { logFilter, setLogFilter } = useConsole()
  const { data, error, loading, reload } = useChangelog(true)

  const entries = (data ?? []).filter(
    (entry) => logFilter === "all" || uiKind(entry) === logFilter
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

      {error ? <LoadError message={error} onRetry={reload} /> : null}

      <Panel className="px-5 py-[18px]">
        {loading && !data ? (
          <EmptyNote>Loading changelog…</EmptyNote>
        ) : entries.length === 0 ? (
          <EmptyNote>
            {data && data.length > 0
              ? "No entries match this filter."
              : "Nothing recorded yet — run a spec and its schema and context changes appear here."}
          </EmptyNote>
        ) : (
          <div className="flex flex-col">
            {entries.map((entry, index) => {
              const kind = uiKind(entry)
              return (
                <div key={entry.id} className="flex gap-3.5">
                  <div className="flex flex-col items-center">
                    <div
                      className="flex size-7 shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: entry.warn
                          ? "#fffbeb"
                          : kind === "ctx"
                            ? "#e9eef2"
                            : "#e6f4f1",
                      }}
                    >
                      <Icon
                        name={iconFor(entry)}
                        size={14}
                        style={{
                          color: entry.warn
                            ? "#d97706"
                            : kind === "ctx"
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
                      <span
                        className="font-mono text-[10.5px] text-zinc-400"
                        title={entry.at}
                      >
                        {formatClock(entry.at)}
                      </span>
                      <span className="text-[13px] font-semibold">{entry.title}</span>
                      {entry.spec ? (
                        <span className="rounded-full bg-zinc-100 px-[7px] py-0.5 font-mono text-[10px] text-zinc-500">
                          {entry.spec}
                        </span>
                      ) : null}
                      {entry.warn ? (
                        <span className="rounded-full border border-orange-200 bg-orange-50 px-[7px] py-0.5 text-[10px] font-semibold text-orange-800">
                          contradiction surfaced
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-[3px] text-[12px] leading-[1.55] text-zinc-500">
                      {entry.description}
                    </div>
                    {entry.traceUrl ? (
                      // The Agent-activity tab is still mock data and cannot
                      // resolve a real Langfuse id, so open the trace directly.
                      <TraceChip
                        traceId={traceIdFromUrl(entry.traceUrl)}
                        onClick={() =>
                          window.open(entry.traceUrl!, "_blank", "noopener")
                        }
                        className="mt-1.5 bg-white px-[9px] py-[2.5px] text-[10.5px]"
                      />
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Panel>
    </>
  )
}
