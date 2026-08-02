/**
 * Changelog — every schema change and context update, one stream.
 *
 * Its own screen rather than a tab: it is the record of what the agents did to
 * the warehouse, which is read on its own terms and not while inspecting a
 * trace.
 */
import * as React from "react"

import { changelog as api, formatClock, traceIdFromUrl, type ChangelogEntryDto } from "@/api/changelog"
import { Button } from "@/components/ui/button"
import { TraceChip } from "@/components/ui-kit/chips"
import { FilterPill, FilterPills } from "@/components/ui-kit/controls"
import { Icon } from "@/components/ui-kit/icon"
import { Panel, Screen, ScreenHeader } from "@/components/ui-kit/panel"
import { solidButtonSm } from "@/components/ui-kit/styles"
import { useChangelog } from "./use-changelog"

type LogFilter = "all" | "table" | "ctx"

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

export function Changelog() {
  const [filter, setFilter] = React.useState<LogFilter>("all")
  const { data, error, loading, reload } = useChangelog()

  const entries = (data ?? []).filter(
    (entry) => filter === "all" || uiKind(entry) === filter
  )

  return (
    <Screen label="Changelog">
      <ScreenHeader
        title="Changelog"
        subtitle="Every schema change and context update, in plain terms"
      >
        {/* A real download from the backend, not a toast — the changelog is a
            submission artifact. */}
        <Button asChild className={solidButtonSm}>
          <a href={api.exportUrl} download>
            <Icon name="ti-download" size={14} />
            Export changelog
          </a>
        </Button>
      </ScreenHeader>

      <div className="scroll-y flex-1 px-6 pt-[18px] pb-10">
        <div className="mx-auto flex max-w-[1040px] flex-col gap-[14px]">
          <div className="flex items-center gap-2">
            <FilterPills
              value={filter}
              onValueChange={(value) => setFilter(value as LogFilter)}
            >
              {FILTERS.map((item) => (
                <FilterPill key={item.id} value={item.id}>
                  {item.label}
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
        </div>
      </div>
    </Screen>
  )
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3">
      <Icon name="ti-plug-connected-x" size={16} className="shrink-0 text-orange-700" />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold text-orange-900">
          Could not reach the backend
        </div>
        <div className="mt-0.5 font-mono text-[11px] break-words text-orange-800">
          {message}
        </div>
      </div>
      <Button
        variant="outline"
        onClick={onRetry}
        className="h-7 shrink-0 gap-1.5 border-orange-300 bg-white px-2.5 text-[11.5px] text-orange-900 hover:bg-orange-100"
      >
        <Icon name="ti-refresh" size={13} />
        Retry
      </Button>
    </div>
  )
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <div className="py-8 text-center text-[12px] text-zinc-400">{children}</div>
}
