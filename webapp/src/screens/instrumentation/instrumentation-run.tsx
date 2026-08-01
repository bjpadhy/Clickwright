import * as React from "react"

import { api } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MonoChip, StatusPill, TraceChip } from "@/components/ui-kit/chips"
import { CodeSurface, DdlBlock } from "@/components/ui-kit/code"
import { Icon, Spinner } from "@/components/ui-kit/icon"
import { Panel, PanelBody, PanelHeader, Screen, ScreenHeader } from "@/components/ui-kit/panel"
import {
  outlineButtonMd,
  outlineButtonSm,
  solidButtonMd,
  solidButtonSm,
} from "@/components/ui-kit/styles"
import { useConsole } from "@/state/console"
import { InstrumentationTabs } from "./instrumentation-tabs"
import {
  AgentLogList,
  ContradictionCallout,
  DiffTable,
  MvNote,
  RationaleItem,
  applyRevision,
} from "./parts"
import { PipelineSteps } from "./pipeline-steps"
import { SpecInput } from "./spec-input"

export function InstrumentationRun() {
  const {
    server,
    stage,
    pendingSpec,
    showTrace,
    approve,
    changeRequestOpen,
    openChangeRequest,
    changeText,
    setChangeText,
    submitChangeRequest,
    viewReport,
    askAboutFeature,
  } = useConsole()

  const run = server.run
  const specId = run?.specId ?? pendingSpec
  const record = specId ? api.getRunRecord(specId) : null
  const spec = specId ? api.getSpecPreview(specId) : null

  const scrollRef = React.useRef<HTMLDivElement>(null)
  // Each new pipeline card should land in view the way it does in the prototype.
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }, 80)
    return () => window.clearTimeout(timer)
  }, [stage, run?.logCount, run?.execCount])

  const logLines = record ? record.log.slice(0, run?.logCount ?? 0) : []
  if (record?.revisionLog && run?.revised && stage >= 3) logLines.push(record.revisionLog)

  const execLines =
    record && run && stage >= 4
      ? [
          api.config.autoApprove
            ? "Approval: AUTO (demo policy) — recorded in Langfuse trace"
            : "Approval: human reviewer — APPROVED · identity recorded in Langfuse trace",
          ...record.exec,
        ].slice(0, stage === 4 ? run.execCount : undefined)
      : []

  return (
    <Screen label="Instrumentation">
      <ScreenHeader
        title="Instrumentation"
        subtitle="Feature spec in → human-approved schema live on ClickHouse"
      >
        <InstrumentationTabs />
      </ScreenHeader>

      <div ref={scrollRef} className="scroll-y flex-1 px-6 pt-[22px] pb-12">
        <div className="mx-auto flex max-w-[860px] flex-col gap-[14px]">
          {stage === 0 ? <SpecInput /> : null}

          {stage > 0 && run && record && spec ? (
            <>
              <Panel className="px-5 pt-4 pb-3">
                <div className="flex items-center gap-2 pb-3.5">
                  <MonoChip icon="ti-file-text" className="border-transparent bg-zinc-100">
                    specs/{spec.file}
                  </MonoChip>
                  <span className="flex-1 truncate text-[12px] text-zinc-500">
                    {spec.name} · {spec.events}
                  </span>
                  <TraceChip
                    traceId={record.trace.id}
                    onClick={() => showTrace(record.trace.id)}
                  />
                </div>
                <PipelineSteps stage={run.stage} durations={record.durations} />
              </Panel>

              <Panel>
                <PanelHeader>
                  <Icon name="ti-wand" size={15} className="text-zinc-600" />
                  <span className="text-[13px] font-semibold">Instrumentation Agent</span>
                  <span className="rounded-md bg-zinc-100 px-[7px] py-0.5 font-mono text-[10.5px] text-zinc-500">
                    claude-sonnet-4-5
                  </span>
                </PanelHeader>
                <PanelBody className="flex flex-col gap-2">
                  <AgentLogList lines={logLines} animate />
                  {stage > 0 && stage < 3 ? (
                    <div className="flex items-center gap-[9px] text-zinc-400">
                      <Spinner size={14} />
                      <span className="text-[12.5px]">thinking…</span>
                    </div>
                  ) : null}
                </PanelBody>
              </Panel>

              {stage >= 3 ? (
                <Panel className="animate-fade-up">
                  <PanelHeader>
                    <Icon name="ti-terminal-2" size={15} className="text-zinc-600" />
                    <span className="text-[13px] font-semibold">Proposed schema</span>
                    <StatusPill className="gap-1 border-green-200 bg-green-50 text-green-800">
                      <Icon name="ti-check" size={11} />
                      dry-run passed
                    </StatusPill>
                    {run.revised ? (
                      <StatusPill className="border-orange-200 bg-orange-50 text-orange-800">
                        rev 2 — reviewer note applied
                      </StatusPill>
                    ) : null}
                  </PanelHeader>
                  <div className="flex items-start gap-3.5 px-4 py-3.5">
                    <div className="min-w-0 flex-[1.55]">
                      <DdlBlock
                        ddl={run.revised ? applyRevision(record.ddl) : record.ddl}
                        className="max-h-[430px]"
                      />
                    </div>
                    <div className="flex flex-1 flex-col gap-3">
                      <div className="text-[10.5px] font-[650] tracking-[.07em] text-zinc-400">
                        DESIGN RATIONALE
                      </div>
                      {record.rationale.map((item) => (
                        <RationaleItem key={item.title} item={item} />
                      ))}
                      <MvNote mv={record.mv} />
                    </div>
                  </div>
                </Panel>
              ) : null}

              {stage === 3 ? (
                <Panel className="animate-fade-up border-amber-200 bg-amber-50 px-4 py-3.5">
                  <div className="flex gap-[11px]">
                    <Icon
                      name="ti-shield-check"
                      size={19}
                      className="translate-y-px text-amber-600"
                    />
                    <div className="flex-1">
                      <div className="text-[13.5px] font-[650] text-amber-900">
                        Human approval required
                      </div>
                      <div className="mt-[3px] text-[12.5px] leading-[1.55] text-amber-800">
                        The agent will execute <b>2 statements</b> on{" "}
                        <span className="font-mono text-[11.5px]">
                          atlys @ ClickHouse Cloud
                        </span>
                        . Your decision and identity are written into the Langfuse trace.
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button onClick={approve} className={solidButtonMd}>
                          <Icon name="ti-check" size={14} />
                          Approve &amp; execute
                        </Button>
                        <Button
                          variant="outline"
                          onClick={openChangeRequest}
                          className={outlineButtonMd}
                        >
                          <Icon name="ti-pencil" size={14} />
                          Request changes
                        </Button>
                      </div>
                      {changeRequestOpen ? (
                        <div className="mt-2.5 flex gap-2">
                          <Input
                            autoFocus
                            value={changeText}
                            onChange={(event) => setChangeText(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") submitChangeRequest()
                            }}
                            placeholder="e.g. finance audit needs 24-month retention"
                            className="h-[34px] flex-1 rounded-lg border-amber-200 bg-white px-3 text-[12.5px] md:text-[12.5px]"
                          />
                          <Button
                            onClick={submitChangeRequest}
                            className="h-[34px] rounded-lg bg-amber-600 px-3.5 text-[12.5px] font-[550] text-white hover:bg-amber-600/90"
                          >
                            Send to agent
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </Panel>
              ) : null}

              {stage >= 4 ? (
                <Panel className="animate-fade-up">
                  <PanelHeader>
                    <Icon name="ti-database" size={15} className="text-zinc-600" />
                    <span className="text-[13px] font-semibold">Executing on ClickHouse</span>
                    {stage === 4 ? <Spinner size={14} className="text-zinc-500" /> : null}
                  </PanelHeader>
                  <CodeSurface className="rounded-b-xl px-4 py-3">
                    {execLines.map((line) => (
                      <div
                        key={line}
                        className="flex animate-fade-up-xs items-baseline gap-[9px]"
                      >
                        <span className="font-mono text-[11.5px] text-green-500">✓</span>
                        <span className="font-mono text-[11.5px] leading-[1.8] text-zinc-300">
                          {line}
                        </span>
                      </div>
                    ))}
                  </CodeSurface>
                </Panel>
              ) : null}

              {stage >= 5 ? (
                <Panel className="animate-fade-up">
                  <PanelHeader>
                    <Icon name="ti-book-2" size={15} className="text-zinc-600" />
                    <span className="text-[13px] font-semibold">Context Agent</span>
                    <StatusPill className="border-indigo-200 bg-indigo-50 text-indigo-800">
                      auto-triggered by schema change
                    </StatusPill>
                    <div className="flex-1" />
                    <TraceChip
                      traceId={record.contextTrace.id}
                      onClick={() => showTrace(record.contextTrace.id)}
                    />
                  </PanelHeader>
                  {stage === 5 ? (
                    <div className="flex items-center gap-[9px] p-4 text-zinc-500">
                      <Spinner size={14} />
                      <span className="text-[12.5px]">
                        Diffing base_context v{server.contextVersion} against the new table
                        landscape · scanning for contradictions…
                      </span>
                    </div>
                  ) : (
                    <div className="px-4 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className="rounded-[7px] bg-zinc-100 px-[9px] py-[3px] font-mono text-[11.5px] text-zinc-500">
                          base_context v{run.versionFrom}
                        </span>
                        <Icon name="ti-arrow-right" size={13} className="text-zinc-400" />
                        <span className="rounded-[7px] border border-green-200 bg-green-50 px-[9px] py-[3px] font-mono text-[11.5px] text-green-800">
                          v{run.versionTo}
                        </span>
                        <span className="text-[11px] text-zinc-500">
                          pushed to Analytics Agent — no stale snapshots
                        </span>
                      </div>
                      <div className="mt-3">
                        <DiffTable diff={record.diff} />
                      </div>
                      {record.warn ? <ContradictionCallout text={record.warn} /> : null}
                    </div>
                  )}
                </Panel>
              ) : null}

              {stage >= 6 ? (
                <Panel className="animate-fade-up flex-row flex-wrap items-center gap-[11px] border-green-200 bg-green-50 px-4 py-[13px]">
                  <Icon name="ti-circle-check" size={19} className="text-green-600" />
                  <div className="min-w-[220px] flex-1">
                    <div className="text-[13px] font-semibold text-green-900">
                      Live on ClickHouse — {record.table}
                    </div>
                    <div className="mt-px text-[11.5px] text-green-800">
                      {record.backfill} · context v{server.contextVersion} pushed to the
                      Analytics Agent
                    </div>
                  </div>
                  <Button onClick={viewReport} className={solidButtonSm}>
                    View detailed report
                  </Button>
                  <Button
                    variant="outline"
                    onClick={askAboutFeature}
                    className={`${outlineButtonSm} border-green-200 hover:border-green-200 hover:bg-zinc-50`}
                  >
                    <Icon name="ti-message-circle" size={14} />
                    Ask about it
                  </Button>
                </Panel>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </Screen>
  )
}
