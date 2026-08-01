/**
 * Every run's full decision record, read from `runs_log` rather than memory —
 * so it survives a backend restart. The stored events are identical to the SSE
 * ones, which is why this screen reuses the live screen's derivation and parts.
 */

import * as React from "react"

import { backend, type RunEvent } from "@/api/instrumentation"
import { Button } from "@/components/ui/button"
import { MonoChip, StatusPill } from "@/components/ui-kit/chips"
import { Icon, Spinner } from "@/components/ui-kit/icon"
import { Panel, PanelBody, PanelHeader, Screen, ScreenHeader } from "@/components/ui-kit/panel"
import { cn } from "@/lib/utils"
import { useInstrumentation } from "@/state/instrumentation"
import { InstrumentationTabs } from "./instrumentation-tabs"
import {
  BackendUnreachable,
  ContextProposalBody,
  LoadedTablesTable,
  ProposedTables,
  StepTimeline,
  TraceLink,
} from "./parts"
import { buildRunModel, formatMs } from "./run-model"

const STATUS_STYLE: Record<string, string> = {
  succeeded: "border-green-200 bg-green-50 text-green-800",
  failed: "border-red-200 bg-red-50 text-red-800",
  awaiting_approval: "border-amber-200 bg-amber-50 text-amber-800",
  running: "border-zinc-300 bg-zinc-100 text-zinc-700",
  queued: "border-zinc-200 bg-zinc-50 text-zinc-600",
}

export function InstrumentationHistory() {
  const { history, offline, selectedRunId, selectRunId } = useInstrumentation()

  const activeRunId = selectedRunId ?? history[0]?.run_id ?? null
  const entry = history.find((item) => item.run_id === activeRunId) ?? null

  const [events, setEvents] = React.useState<RunEvent[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!activeRunId) return
    let cancelled = false
    setEvents(null)
    setError(null)
    void backend
      .getHistory(activeRunId)
      .then((result) => {
        // `seq` is the ordering key; never trust arrival order for a replay.
        if (!cancelled) setEvents([...result].sort((a, b) => a.seq - b.seq))
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [activeRunId])

  const model = React.useMemo(() => buildRunModel(events ?? []), [events])

  const duration =
    events && events.length > 1
      ? formatMs(Date.parse(events.at(-1)!.ts) - Date.parse(events[0]!.ts))
      : ""
  const rows = model.result?.tables.reduce((sum, table) => sum + table.rowsLoaded, 0) ?? 0
  const ddlAttempts = model.steps.find((step) => step.key === "ddl_generation")?.attempts.length

  const stats = entry
    ? [
        { key: "SPEC", value: entry.spec },
        { key: "STATUS", value: entry.last_status || "—" },
        {
          key: "TABLES",
          value: model.result?.tables.map((table) => table.name).join(", ") || "—",
        },
        { key: "ROWS LOADED", value: rows ? rows.toLocaleString() : "—" },
        { key: "PIPELINE TIME", value: duration || "—" },
        {
          key: "CONTEXT ENTRIES",
          value: String(model.result?.contextEntries.length ?? 0),
        },
        {
          key: "DDL ATTEMPTS",
          value: ddlAttempts ? String(ddlAttempts) : "—",
        },
        { key: "EVENTS LOGGED", value: String(entry.events) },
      ]
    : []

  return (
    <Screen label="Instrumentation history">
      <ScreenHeader
        title="Instrumentation"
        subtitle="Every run, with its full decision record — replayed from runs_log"
      >
        <InstrumentationTabs />
      </ScreenHeader>

      <div className="flex min-h-0 flex-1">
        <div className="scroll-y w-[280px] shrink-0 border-r border-zinc-200 bg-white p-3">
          {history.length === 0 ? (
            <div className="px-1 py-2 text-[12px] leading-[1.6] text-zinc-400">
              No runs recorded yet. Instrument a spec and it lands here — permanently.
            </div>
          ) : null}
          <div className="flex flex-col gap-[7px]">
            {history.map((item) => {
              const selected = activeRunId === item.run_id
              return (
                <Button
                  key={item.run_id}
                  variant="outline"
                  onClick={() => selectRunId(item.run_id)}
                  className={cn(
                    "h-auto flex-col items-stretch gap-0 rounded-[10px] bg-white px-3 py-[11px] font-normal hover:border-zinc-400 hover:bg-white",
                    selected ? "border-zinc-900 shadow-[0_0_0_1px_#18181b]" : "border-zinc-200"
                  )}
                >
                  <div className="flex items-center gap-[7px]">
                    <span className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold">
                      {item.spec}
                    </span>
                    <StatusPill
                      className={
                        STATUS_STYLE[item.last_status] ??
                        "border-zinc-200 bg-zinc-50 text-zinc-600"
                      }
                    >
                      {item.last_status || "—"}
                    </StatusPill>
                  </div>
                  <div className="mt-1 truncate text-left font-mono text-[10.5px] text-zinc-500">
                    {item.run_id}
                  </div>
                  <div className="mt-[7px] flex items-center gap-1.5">
                    <span className="font-mono text-[10px] text-zinc-400">
                      {item.started.slice(0, 19)}
                    </span>
                    <span className="rounded-full bg-indigo-50 px-[7px] py-[1.5px] text-[10px] text-indigo-800">
                      {item.events} events
                    </span>
                  </div>
                </Button>
              )
            })}
          </div>
        </div>

        <div className="scroll-y min-w-0 flex-1 px-6 pt-5 pb-12">
          {offline ? (
            <div className="max-w-[880px]">
              <BackendUnreachable error={offline} />
            </div>
          ) : null}

          {entry && !events && !error ? (
            <div className="flex items-center gap-2 text-[12.5px] text-zinc-400">
              <Spinner size={14} />
              loading the decision record…
            </div>
          ) : null}

          {error ? (
            <div className="text-[12.5px] text-red-700">Could not load this run: {error}</div>
          ) : null}

          {entry && events ? (
            <div className="flex max-w-[880px] flex-col gap-[14px]">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-[17px] font-[650] tracking-[-.01em]">{entry.spec}</span>
                <MonoChip icon="ti-hash">{entry.run_id}</MonoChip>
                <div className="flex-1" />
                {model.traceUrl ? <TraceLink url={model.traceUrl} /> : null}
                <span className="text-[11.5px] text-zinc-500">
                  {entry.started.slice(0, 19)}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200">
                {stats.map((stat) => (
                  <div key={stat.key} className="bg-white px-4 py-3">
                    <div className="text-[10px] font-[650] tracking-[.06em] text-zinc-400">
                      {stat.key}
                    </div>
                    <div className="mt-[3px] font-mono text-[12.5px] leading-[1.45] break-words text-zinc-900">
                      {stat.value}
                    </div>
                  </div>
                ))}
              </div>

              {model.error ? (
                <Panel className="border-red-200 bg-red-50">
                  <PanelBody className="flex gap-[11px] px-4 py-3.5">
                    <Icon
                      name="ti-alert-triangle"
                      size={19}
                      className="translate-y-px text-red-600"
                    />
                    <div className="min-w-0">
                      <div className="text-[13px] font-[650] text-red-900">Run failed</div>
                      <div className="mt-1.5 font-mono text-[11.5px] leading-[1.6] break-words whitespace-pre-wrap text-red-800">
                        {model.error}
                      </div>
                    </div>
                  </PanelBody>
                </Panel>
              ) : null}

              {model.result?.tables.length ? (
                <Panel>
                  <PanelHeader>
                    <Icon name="ti-database" size={15} className="text-zinc-600" />
                    <span className="text-[13px] font-semibold">Tables loaded</span>
                  </PanelHeader>
                  <PanelBody className="px-4 py-3.5">
                    <LoadedTablesTable tables={model.result.tables} />
                  </PanelBody>
                </Panel>
              ) : null}

              {model.ddlProposal ? (
                <>
                  <Panel>
                    <PanelHeader>
                      <Icon name="ti-terminal-2" size={15} className="text-zinc-600" />
                      <span className="text-[13px] font-semibold">
                        {model.result ? "Executed DDL" : "Last proposed DDL"}
                      </span>
                      <div className="flex-1" />
                      {model.proposals.ddl > 1 ? (
                        <StatusPill className="border-orange-200 bg-orange-50 text-orange-800">
                          {model.proposals.ddl} proposals reviewed
                        </StatusPill>
                      ) : null}
                    </PanelHeader>
                    <PanelBody className="px-4 py-3.5">
                      <ProposedTables proposal={model.ddlProposal} />
                    </PanelBody>
                  </Panel>
                </>
              ) : null}

              <Panel>
                <PanelHeader>
                  <Icon name="ti-wand" size={15} className="text-zinc-600" />
                  <span className="text-[13px] font-semibold">Agent pipeline</span>
                  <span className="text-[11px] text-zinc-400">
                    every attempt, including the ones that failed
                  </span>
                </PanelHeader>
                <PanelBody className="flex flex-col gap-2">
                  <StepTimeline steps={model.steps} />
                </PanelBody>
              </Panel>

              {model.approvals.length > 0 ? (
                <Panel>
                  <PanelHeader>
                    <Icon name="ti-gavel" size={15} className="text-zinc-600" />
                    <span className="text-[13px] font-semibold">Decisions</span>
                  </PanelHeader>
                  <PanelBody className="flex flex-col gap-1.5 px-4 py-3">
                    {model.approvals.map((approval, index) => (
                      <div key={index} className="flex flex-wrap items-baseline gap-2">
                        <Icon
                          name={approval.approved ? "ti-check" : "ti-pencil"}
                          size={13}
                          className={approval.approved ? "text-green-600" : "text-amber-600"}
                        />
                        <span className="font-mono text-[11px] text-zinc-500">
                          {approval.gate}
                        </span>
                        <span className="text-[12.5px] text-zinc-700">
                          {approval.approved ? "approved" : "changes requested"}
                          {approval.feedback ? ` — "${approval.feedback}"` : ""}
                        </span>
                      </div>
                    ))}
                  </PanelBody>
                </Panel>
              ) : null}

              {model.contextProposal ? (
                <Panel>
                  <PanelHeader>
                    <Icon name="ti-book-2" size={15} className="text-zinc-600" />
                    <span className="text-[13px] font-semibold">Context update</span>
                    <div className="flex-1" />
                    {model.result?.contextEntries.length ? (
                      <span className="font-mono text-[11px] text-zinc-500">
                        {model.result.contextEntries
                          .map((item) => `${item.entity} v${item.version}`)
                          .join(" · ")}
                      </span>
                    ) : null}
                  </PanelHeader>
                  <PanelBody className="px-4 py-3.5">
                    {/* Warnings live inside the proposal body — the run's
                        `contextWarnings` are the same list, so rendering both
                        surfaced every contradiction twice. */}
                    <ContextProposalBody proposal={model.contextProposal} />
                  </PanelBody>
                </Panel>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Screen>
  )
}
