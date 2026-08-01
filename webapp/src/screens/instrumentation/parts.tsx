import * as React from "react"

import type {
  ContextProposal,
  DdlProposal,
  LoadedTable,
  RunStatus,
} from "@/api/instrumentation"
import { MonoChip, StatusPill } from "@/components/ui-kit/chips"
import { CodeSurface, DdlBlock } from "@/components/ui-kit/code"
import { Icon, Spinner } from "@/components/ui-kit/icon"
import { Markdown } from "@/components/ui-kit/markdown"
import { Panel, PanelBody, PanelHeader } from "@/components/ui-kit/panel"
import { cn } from "@/lib/utils"
import { formatMs, type ExecLine, type StepGroup } from "./run-model"

const STATUS_STYLE: Record<RunStatus, { label: string; className: string }> = {
  queued: { label: "queued", className: "border-zinc-200 bg-zinc-50 text-zinc-600" },
  running: { label: "running", className: "border-zinc-300 bg-zinc-100 text-zinc-800" },
  awaiting_approval: {
    label: "awaiting approval",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  succeeded: { label: "succeeded", className: "border-green-200 bg-green-50 text-green-800" },
  failed: { label: "failed", className: "border-red-200 bg-red-50 text-red-800" },
}

export function RunStatusPill({ status }: { status: RunStatus }) {
  const style = STATUS_STYLE[status]
  return <StatusPill className={style.className}>{style.label}</StatusPill>
}

/** Wall time since the run started — generation steps go minutes without events. */
export function useElapsed(startedAt: string | null, running: boolean): string {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  if (!startedAt) return ""
  return formatMs(Math.max(0, now - Date.parse(startedAt)))
}

/** Opens the Langfuse trace — the full, unclipped artifact for every step. */
export function TraceLink({ url, className }: { url: string; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title="Open the Langfuse trace"
      className={cn(
        "inline-flex shrink-0 items-center gap-[5px] rounded-full border border-zinc-200 px-[9px] py-[3px] font-mono text-[11px] text-zinc-600 hover:border-zinc-400",
        className
      )}
    >
      <Icon name="ti-route" size={12} />
      trace
      <Icon name="ti-external-link" size={11} className="text-zinc-400" />
    </a>
  )
}

/**
 * The agent's reasoning trail: one row per step, with every attempt underneath.
 * A failed attempt followed by another one is the self-healing retry — the error
 * text is the evidence, so it is rendered verbatim rather than collapsed away.
 */
export function StepTimeline({ steps }: { steps: StepGroup[] }) {
  if (steps.length === 0)
    return (
      <div className="flex items-center gap-[9px] text-zinc-400">
        <Spinner size={14} />
        <span className="text-[12.5px]">waiting for the first step…</span>
      </div>
    )

  return (
    <div className="flex flex-col gap-2.5">
      {steps.map((step) => (
        <div key={step.key} className="flex gap-[9px]">
          <StepMarker status={step.status} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-[12.5px] leading-[1.45] font-[550] text-zinc-800">
                {step.label}
              </span>
              {step.attempts.length > 1 ? (
                <StatusPill className="border-orange-200 bg-orange-50 text-orange-800">
                  {step.attempts.length} attempts
                </StatusPill>
              ) : null}
            </div>
            {step.attempts.map((attempt, index) => (
              <div key={index} className="mt-[3px] flex flex-wrap items-baseline gap-x-2">
                {step.attempts.length > 1 ? (
                  <span className="font-mono text-[10.5px] text-zinc-400">
                    #{attempt.attempt ?? index + 1}
                  </span>
                ) : null}
                {attempt.summary ? (
                  <span className="text-[11.5px] leading-[1.5] text-zinc-500">
                    {attempt.summary}
                  </span>
                ) : null}
                {attempt.status === "running" ? (
                  <span className="inline-flex items-center gap-1.5 text-[11.5px] text-zinc-400">
                    <Spinner size={12} />
                    working…
                  </span>
                ) : null}
                {attempt.ms !== null ? (
                  <span className="font-mono text-[10.5px] text-zinc-400">
                    {formatMs(attempt.ms)}
                  </span>
                ) : null}
                {attempt.error ? (
                  <div className="mt-1 w-full rounded-[7px] border border-red-100 bg-red-50/70 px-2.5 py-1.5">
                    <div className="flex items-center gap-1.5 text-[10.5px] font-[650] tracking-[.05em] text-red-700">
                      <Icon name="ti-refresh-alert" size={12} />
                      FED BACK TO THE AGENT
                    </div>
                    <div className="mt-[3px] font-mono text-[11px] leading-[1.55] break-words whitespace-pre-wrap text-red-900">
                      {attempt.error}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function StepMarker({ status }: { status: StepGroup["status"] }) {
  if (status === "running")
    return <Spinner size={14} className="translate-y-[3px] text-zinc-500" />
  return (
    <Icon
      name={status === "error" ? "ti-alert-triangle" : "ti-check"}
      size={14}
      className={cn(
        "translate-y-[3px]",
        status === "error" ? "text-red-600" : "text-green-600"
      )}
    />
  )
}

/** The DDL a human is being asked to sign off on, byte-for-byte. */
export function DdlProposalPanel({
  proposal,
  revision,
  children,
}: {
  proposal: DdlProposal
  /** >1 once a reviewer has sent a proposal back */
  revision: number
  children?: React.ReactNode
}) {
  return (
    <Panel className="animate-fade-up">
      <PanelHeader>
        <Icon name="ti-terminal-2" size={15} className="text-zinc-600" />
        <span className="text-[13px] font-semibold">Proposed schema</span>
        <StatusPill className="gap-1 border-green-200 bg-green-50 text-green-800">
          <Icon name="ti-check" size={11} />
          dry-run passed
        </StatusPill>
        {revision > 1 ? (
          <StatusPill className="border-orange-200 bg-orange-50 text-orange-800">
            rev {revision} — reviewer note applied
          </StatusPill>
        ) : null}
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-zinc-400">
          {proposal.tables.length} statement{proposal.tables.length === 1 ? "" : "s"}
        </span>
      </PanelHeader>
      <div className="flex items-start gap-3.5 px-4 py-3.5">
        <div className="flex min-w-0 flex-[1.55] flex-col gap-3">
          {proposal.tables.map((table) => (
            <div key={table.name} className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 pb-1.5">
                <MonoChip icon="ti-table" className="border-transparent bg-zinc-100">
                  {table.name}
                </MonoChip>
                <span className="truncate text-[11.5px] text-zinc-500">
                  {table.event} · {table.purpose}
                </span>
              </div>
              <DdlBlock ddl={table.ddl} className="max-h-[340px]" />
            </div>
          ))}
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <div className="text-[10.5px] font-[650] tracking-[.07em] text-zinc-400">
            DESIGN RATIONALE
          </div>
          <Markdown text={proposal.reasoning} />
        </div>
      </div>
      {children}
    </Panel>
  )
}

/** Per-statement execution progress, straight from the `log` events. */
export function ExecutionLog({
  lines,
  running,
}: {
  lines: ExecLine[]
  running: boolean
}) {
  return (
    <Panel className="animate-fade-up">
      <PanelHeader>
        <Icon name="ti-database" size={15} className="text-zinc-600" />
        <span className="text-[13px] font-semibold">Executing on ClickHouse</span>
        {running ? <Spinner size={14} className="text-zinc-500" /> : null}
      </PanelHeader>
      <CodeSurface className="rounded-b-xl px-4 py-3">
        {lines.length === 0 ? (
          <div className="font-mono text-[11.5px] text-zinc-500">
            running statements…
          </div>
        ) : null}
        {lines.map((line, index) => (
          <div key={index} className="flex animate-fade-up-xs items-baseline gap-[9px]">
            <span
              className={cn(
                "font-mono text-[11.5px]",
                line.ok ? "text-green-500" : "text-red-400"
              )}
            >
              {line.ok ? "✓" : "✗"}
            </span>
            <span className="flex-1 font-mono text-[11.5px] leading-[1.8] text-zinc-300">
              {line.text}
            </span>
            <span className="font-mono text-[11px] text-gray-500">
              {formatMs(line.ms)}
            </span>
          </div>
        ))}
      </CodeSurface>
    </Panel>
  )
}

/** The context entries the agent wants to write, and what it flagged. */
export function ContextProposalBody({ proposal }: { proposal: ContextProposal }) {
  return (
    <div className="flex flex-col gap-2.5">
      {proposal.warnings?.length ? (
        <div className="flex flex-col gap-2">
          {proposal.warnings.map((warning) => (
            <ContradictionCallout key={warning} text={warning} />
          ))}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-[9px] border border-zinc-100">
        {proposal.entries.map((entry) => (
          <details key={entry.entity} className="group border-b border-zinc-100 last:border-b-0">
            <summary className="flex cursor-pointer list-none items-center gap-2 bg-green-50/40 px-3 py-2">
              <span className="font-mono text-[11.5px] font-bold text-green-700">+</span>
              <span className="font-mono text-[11.5px] text-zinc-800">{entry.entity}</span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-500">
                {entry.change_note}
              </span>
              <Icon
                name="ti-chevron-down"
                size={13}
                className="text-zinc-400 group-open:rotate-180"
              />
            </summary>
            <div className="border-t border-zinc-100 px-3 py-2.5">
              <Markdown text={entry.definition_md} />
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

export function ContradictionCallout({ text }: { text: string }) {
  return (
    <div className="flex gap-2.5 rounded-[9px] border border-amber-200 bg-amber-50 px-3 py-2.5">
      <Icon name="ti-alert-triangle" size={15} className="translate-y-px text-amber-600" />
      <div className="text-[12px] leading-[1.55] text-amber-900">
        <b>Contradiction surfaced.</b> {text}
      </div>
    </div>
  )
}

/** What actually landed: table, source event, and file-vs-table row counts. */
export function LoadedTablesTable({ tables }: { tables: LoadedTable[] }) {
  return (
    <div className="overflow-hidden rounded-[9px] border border-zinc-100">
      {tables.map((table) => (
        <div
          key={table.name}
          className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-zinc-100 px-3 py-2 last:border-b-0"
        >
          <span className="font-mono text-[11.5px] text-zinc-900">{table.name}</span>
          <span className="font-mono text-[10.5px] text-zinc-400">{table.event}</span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-500">
            {table.purpose}
          </span>
          <span
            className={cn(
              "font-mono text-[11px]",
              table.rowsLoaded === table.rowsInFile ? "text-green-700" : "text-amber-700"
            )}
          >
            {table.rowsLoaded.toLocaleString()} / {table.rowsInFile.toLocaleString()} rows
          </span>
        </div>
      ))}
    </div>
  )
}

/** Shared empty/error surface for "the backend isn't there". */
export function BackendUnreachable({ error }: { error: string }) {
  return (
    <Panel className="border-red-200 bg-red-50">
      <PanelBody className="flex gap-[11px] px-4 py-3.5">
        <Icon name="ti-plug-connected-x" size={19} className="translate-y-px text-red-600" />
        <div>
          <div className="text-[13px] font-[650] text-red-900">Backend unreachable</div>
          <div className="mt-[3px] text-[12.5px] leading-[1.55] text-red-800">
            Start it with <span className="font-mono text-[11.5px]">cd backend &amp;&amp; npm run serve</span>{" "}
            — it serves this screen on <span className="font-mono text-[11.5px]">:8787</span>.
          </div>
          <div className="mt-1.5 font-mono text-[11px] break-words text-red-700">{error}</div>
        </div>
      </PanelBody>
    </Panel>
  )
}
