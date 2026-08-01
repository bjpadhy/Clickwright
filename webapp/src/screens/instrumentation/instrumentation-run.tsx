import * as React from "react"

import type { Gate } from "@/api/instrumentation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { MonoChip, StatusPill } from "@/components/ui-kit/chips"
import { Icon, Spinner } from "@/components/ui-kit/icon"
import { Panel, PanelBody, PanelHeader, Screen, ScreenHeader } from "@/components/ui-kit/panel"
import {
  outlineButtonMd,
  outlineButtonSm,
  solidButtonMd,
  solidButtonSm,
} from "@/components/ui-kit/styles"
import { useChat } from "@/state/chat"
import { useConsole } from "@/state/console"
import { useInstrumentation } from "@/state/instrumentation"
import { InstrumentationTabs } from "./instrumentation-tabs"
import {
  BackendUnreachable,
  ContextProposalBody,
  ContradictionCallout,
  DdlProposalPanel,
  ExecutionLog,
  LoadedTablesTable,
  RunStatusPill,
  StepTimeline,
  TraceLink,
  useElapsed,
} from "./parts"
import { PipelineSteps } from "./pipeline-steps"
import { SpecInput } from "./spec-input"

export function InstrumentationRun() {
  const { setInstrTab } = useConsole()
  const { askAbout } = useChat()
  const {
    runId,
    run,
    model,
    status,
    busy,
    streaming,
    queuedBehind,
    health,
    offline,
    selectRunId,
  } = useInstrumentation()

  const elapsed = useElapsed(model.startedAt, busy)

  const scrollRef = React.useRef<HTMLDivElement>(null)
  // Each new card should land in view as the pipeline advances. Nested steps
  // count too — a fan-out generation is most of what arrives during design.
  const lastSeq =
    model.steps.reduce((n, step) => n + 1 + step.children.length, 0) + model.execLog.length
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }, 80)
    return () => window.clearTimeout(timer)
  }, [lastSeq, status])

  const viewReport = () => {
    if (runId) selectRunId(runId)
    setInstrTab("hist")
  }

  /** Hand the Analytics Agent the feature this run just made queryable. */
  const askAboutFeature = () => {
    const feature = (run?.spec ?? "").replace(/^\d+[_-]/, "").replace(/_/g, " ").trim()
    askAbout(
      feature
        ? `How is ${feature} performing since launch?`
        : "What can I learn from the tables that were just created?"
    )
  }

  const ddlDecided = model.approvals.some((approval) => approval.gate === "ddl")
  const executing = model.phases.execute === "active"
  const showExecution = model.execLog.length > 0 || executing

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
          {!runId ? <SpecInput /> : null}

          {runId ? (
            <>
              {offline ? <BackendUnreachable error={offline} /> : null}

              <Panel className="px-5 pt-4 pb-3">
                <div className="flex flex-wrap items-center gap-2 pb-3.5">
                  <MonoChip icon="ti-file-text" className="border-transparent bg-zinc-100">
                    {run?.spec ?? runId}
                  </MonoChip>
                  {status ? <RunStatusPill status={status} /> : null}
                  <span className="font-mono text-[11px] text-zinc-400">{runId}</span>
                  <div className="flex-1" />
                  {busy && elapsed ? (
                    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
                      <Icon name="ti-clock" size={12} />
                      {elapsed}
                    </span>
                  ) : null}
                  {model.traceUrl ? <TraceLink url={model.traceUrl} /> : null}
                </div>
                <PipelineSteps phases={model.phases} steps={model.steps} />
              </Panel>

              {status === "queued" ? (
                <Panel className="animate-fade-up flex-row items-center gap-[11px] px-4 py-3.5">
                  <Spinner size={16} className="text-zinc-500" />
                  <div className="text-[12.5px] text-zinc-700">
                    Waiting behind{" "}
                    <b>
                      {queuedBehind} run{queuedBehind === 1 ? "" : "s"}
                    </b>{" "}
                    — runs execute one at a time so every schema change is an atomic
                    read-modify-write.
                  </div>
                </Panel>
              ) : null}

              <Panel>
                <PanelHeader>
                  <Icon name="ti-wand" size={15} className="text-zinc-600" />
                  <span className="text-[13px] font-semibold">Agent pipeline</span>
                  {health ? (
                    <span className="rounded-md bg-zinc-100 px-[7px] py-0.5 font-mono text-[10.5px] text-zinc-500">
                      {health.model}
                    </span>
                  ) : null}
                  <div className="flex-1" />
                  {busy ? (
                    <span className="text-[11px] text-zinc-400">
                      {streaming ? "live" : "reconnecting…"}
                    </span>
                  ) : null}
                </PanelHeader>
                <PanelBody className="flex flex-col gap-2">
                  <StepTimeline steps={model.steps} />
                  {/* A hint, not a progress indicator — the running step already
                      spins, so this one stays still. */}
                  {busy && !model.pendingGate ? (
                    <div className="flex items-center gap-[9px] pt-1 text-zinc-400">
                      <Icon name="ti-clock-pause" size={14} />
                      <span className="text-[12.5px]">
                        generation steps take 1–3 minutes with no intermediate output
                      </span>
                    </div>
                  ) : null}
                </PanelBody>
              </Panel>

              {model.ddlProposal ? (
                <DdlProposalPanel
                  proposal={model.ddlProposal}
                  revision={model.proposals.ddl}
                >
                  {model.pendingGate === "ddl" ? (
                    <ApprovalGate
                      gate="ddl"
                      title="Human approval required"
                      detail={
                        <>
                          The agent will execute{" "}
                          <b>
                            {model.ddlProposal.tables.length} statement
                            {model.ddlProposal.tables.length === 1 ? "" : "s"}
                          </b>{" "}
                          on{" "}
                          <span className="font-mono text-[11.5px]">
                            {health?.database ?? "ClickHouse"}
                          </span>
                          . Approving executes the DDL byte-for-byte; requesting changes
                          sends your note to the agent, which regenerates.
                        </>
                      }
                    />
                  ) : null}
                </DdlProposalPanel>
              ) : null}

              {ddlDecided && !model.pendingGate && model.approvals.length > 0 ? (
                <ApprovalTrail />
              ) : null}

              {showExecution ? (
                <ExecutionLog lines={model.execLog} running={executing} />
              ) : null}

              {model.contextProposal ? (
                <Panel className="animate-fade-up">
                  <PanelHeader>
                    <Icon name="ti-book-2" size={15} className="text-zinc-600" />
                    <span className="text-[13px] font-semibold">Context update</span>
                    <StatusPill className="border-indigo-200 bg-indigo-50 text-indigo-800">
                      auto-triggered by schema change
                    </StatusPill>
                    {model.proposals.context > 1 ? (
                      <StatusPill className="border-orange-200 bg-orange-50 text-orange-800">
                        rev {model.proposals.context}
                      </StatusPill>
                    ) : null}
                  </PanelHeader>
                  <PanelBody className="px-4 py-3.5">
                    <ContextProposalBody proposal={model.contextProposal} />
                  </PanelBody>
                  {model.pendingGate === "context" ? (
                    <ApprovalGate
                      gate="context"
                      title="Approve the context update"
                      detail={
                        <>
                          These entries become what every agent reads next.{" "}
                          <b>
                            {model.contextProposal.entries.length} entr
                            {model.contextProposal.entries.length === 1 ? "y" : "ies"}
                          </b>{" "}
                          will be written as a new version — nothing is overwritten.
                        </>
                      }
                    />
                  ) : null}
                </Panel>
              ) : null}

              {model.phases.context === "active" && !model.contextProposal ? (
                <Panel className="animate-fade-up flex-row items-center gap-[9px] px-4 py-3.5">
                  <Spinner size={14} className="text-zinc-500" />
                  <span className="text-[12.5px] text-zinc-500">
                    Diffing the context store against the new table landscape · scanning for
                    contradictions…
                  </span>
                </Panel>
              ) : null}

              {model.result ? (
                <Panel className="animate-fade-up border-green-200 bg-green-50">
                  <PanelBody className="flex flex-col gap-3 px-4 py-[13px]">
                    <div className="flex flex-wrap items-center gap-[11px]">
                      <Icon name="ti-circle-check" size={19} className="text-green-600" />
                      <div className="min-w-[220px] flex-1">
                        <div className="text-[13px] font-semibold text-green-900">
                          Live on ClickHouse —{" "}
                          {model.result.tables.map((table) => table.name).join(", ") ||
                            "no tables reported"}
                        </div>
                        <div className="mt-px text-[11.5px] text-green-800">
                          {model.result.contextEntries.length} context entr
                          {model.result.contextEntries.length === 1 ? "y" : "ies"} written ·
                          every agent reads the new version on its next run
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
                    </div>
                    <div className="rounded-[9px] bg-white">
                      <LoadedTablesTable tables={model.result.tables} />
                    </div>
                    {model.result.contextEntries.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {model.result.contextEntries.map((entry) => (
                          <MonoChip key={entry.entity} className="border-green-200">
                            {entry.entity} v{entry.version}
                          </MonoChip>
                        ))}
                      </div>
                    ) : null}
                    {/* Normally the context panel above already shows these —
                        only surface them here if that panel isn't rendered. */}
                    {!model.contextProposal
                      ? model.result.contextWarnings.map((warning) => (
                          <ContradictionCallout key={warning} text={warning} />
                        ))
                      : null}
                  </PanelBody>
                </Panel>
              ) : null}

              {model.error ? (
                <Panel className="animate-fade-up border-red-200 bg-red-50">
                  <PanelBody className="flex gap-[11px] px-4 py-3.5">
                    <Icon
                      name="ti-alert-triangle"
                      size={19}
                      className="translate-y-px text-red-600"
                    />
                    <div className="min-w-0">
                      <div className="text-[13px] font-[650] text-red-900">
                        Run failed — retries exhausted
                      </div>
                      <div className="mt-1.5 font-mono text-[11.5px] leading-[1.6] break-words whitespace-pre-wrap text-red-800">
                        {model.error}
                      </div>
                    </div>
                  </PanelBody>
                </Panel>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </Screen>
  )
}

/**
 * Both gates go through the same endpoint — the server knows which one is
 * pending — so they share one panel. The moment an `approval_result` arrives the
 * panel disappears, which is what keeps a stale UI from double-deciding.
 */
function ApprovalGate({
  gate,
  title,
  detail,
}: {
  gate: Gate
  title: string
  detail: React.ReactNode
}) {
  const {
    identity,
    setIdentity,
    changeRequestOpen,
    setChangeRequestOpen,
    feedback,
    setFeedback,
    deciding,
    approve,
    requestChanges,
  } = useInstrumentation()

  return (
    <div className="animate-fade-up m-4 mt-0 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5">
      <div className="flex gap-[11px]">
        <Icon name="ti-shield-check" size={19} className="translate-y-px text-amber-600" />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-[650] text-amber-900">{title}</div>
          <div className="mt-[3px] text-[12.5px] leading-[1.55] text-amber-800">
            {detail} Your decision and identity are written into the Langfuse trace.
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={approve} disabled={deciding} className={solidButtonMd}>
              {deciding ? <Spinner size={14} /> : <Icon name="ti-check" size={14} />}
              {gate === "ddl" ? "Approve & execute" : "Approve & write"}
            </Button>
            <Button
              variant="outline"
              disabled={deciding}
              onClick={() => setChangeRequestOpen(!changeRequestOpen)}
              className={outlineButtonMd}
            >
              <Icon name="ti-pencil" size={14} />
              Request changes
            </Button>
            <Input
              value={identity}
              onChange={(event) => setIdentity(event.target.value)}
              placeholder="your name or handle"
              title="Recorded against this decision in Langfuse and runs_log"
              className="h-[34px] w-[190px] rounded-lg border-amber-200 bg-white px-3 text-[12.5px] md:text-[12.5px]"
            />
          </div>

          {changeRequestOpen ? (
            <div className="mt-2.5 flex flex-col gap-2">
              <Textarea
                autoFocus
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={
                  gate === "ddl"
                    ? "e.g. partition by day, not month — finance audit needs 24-month retention"
                    : "e.g. the metric definition should exclude guest sessions"
                }
                className="field-sizing-fixed h-[64px] min-h-0 resize-y rounded-lg border-amber-200 bg-white px-3 py-2 text-[12.5px] leading-[1.55] md:text-[12.5px]"
              />
              <div className="flex items-center gap-2">
                <Button
                  onClick={requestChanges}
                  disabled={deciding}
                  className="h-[34px] rounded-lg bg-amber-600 px-3.5 text-[12.5px] font-[550] text-white hover:bg-amber-600/90"
                >
                  Send to agent
                </Button>
                <span className="text-[11px] text-amber-800">
                  goes to the LLM verbatim — it regenerates and comes back to this gate
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** Who decided what, once a gate has closed. */
function ApprovalTrail() {
  const { model } = useInstrumentation()

  return (
    <Panel className="animate-fade-up">
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
            <span className="font-mono text-[11px] text-zinc-500">{approval.gate}</span>
            <span className="text-[12.5px] text-zinc-700">
              {approval.approved ? "approved" : "changes requested"}
              {approval.feedback ? ` — "${approval.feedback}"` : ""}
            </span>
          </div>
        ))}
      </PanelBody>
    </Panel>
  )
}
