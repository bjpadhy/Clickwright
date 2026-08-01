import { api } from "@/api/client"
import { Button } from "@/components/ui/button"
import { MonoChip, StatusPill, TraceChip } from "@/components/ui-kit/chips"
import { DdlBlock } from "@/components/ui-kit/code"
import { Icon } from "@/components/ui-kit/icon"
import { Panel, PanelBody, PanelHeader, Screen, ScreenHeader } from "@/components/ui-kit/panel"
import { cn } from "@/lib/utils"
import { useConsole } from "@/state/console"
import { InstrumentationTabs } from "./instrumentation-tabs"
import {
  AgentLogList,
  ContradictionCallout,
  DiffTable,
  MvNote,
  RationaleItem,
} from "./parts"

export function InstrumentationHistory() {
  const { server, selectedHistory, setSelectedHistory, showTrace } = useConsole()

  const entry =
    server.history.find((item) => item.specId === selectedHistory) ?? server.history[0]
  const record = entry ? api.getRunRecord(entry.specId) : null
  const spec = entry ? api.getSpecPreview(entry.specId) : null

  const stats = record
    ? [
        { key: "TABLE", value: record.table },
        { key: "MATERIALIZED VIEW", value: record.mvShort },
        { key: "BACKFILL", value: record.backfill },
        { key: "CONTEXT", value: entry!.version },
        { key: "LLM COST", value: `${record.trace.cost} · ${record.trace.tokens} tok` },
        { key: "PIPELINE TIME", value: record.trace.duration },
      ]
    : []

  return (
    <Screen label="Instrumentation history">
      <ScreenHeader
        title="Instrumentation"
        subtitle="Every instrumented spec, with its full decision record"
      >
        <InstrumentationTabs />
      </ScreenHeader>

      <div className="flex min-h-0 flex-1">
        <div className="scroll-y w-[280px] shrink-0 border-r border-zinc-200 bg-white p-3">
          <div className="flex flex-col gap-[7px]">
            {server.history.map((item) => {
              const itemRecord = api.getRunRecord(item.specId)
              const itemSpec = api.getSpecPreview(item.specId)
              const selected = selectedHistory === item.specId
              return (
                <Button
                  key={`${item.specId}-${item.time}`}
                  variant="outline"
                  onClick={() => setSelectedHistory(item.specId)}
                  className={cn(
                    "h-auto flex-col items-stretch gap-0 rounded-[10px] bg-white px-3 py-[11px] font-normal hover:border-zinc-400 hover:bg-white",
                    selected
                      ? "border-zinc-900 shadow-[0_0_0_1px_#18181b]"
                      : "border-zinc-200"
                  )}
                >
                  <div className="flex items-center gap-[7px]">
                    <span className="flex-1 text-left text-[13px] font-semibold">
                      {itemSpec.name}
                    </span>
                    <StatusPill className="border-green-200 bg-green-50 px-[7px] py-0.5 text-[10px] text-green-800">
                      Live
                    </StatusPill>
                  </div>
                  <div className="mt-1 text-left font-mono text-[10.5px] text-zinc-500">
                    {itemRecord.table}
                  </div>
                  <div className="mt-[7px] flex items-center gap-1.5">
                    <span className="font-mono text-[10px] text-zinc-400">{item.time}</span>
                    <span className="rounded-full bg-indigo-50 px-[7px] py-[1.5px] text-[10px] text-indigo-800">
                      context {item.version}
                    </span>
                  </div>
                </Button>
              )
            })}
          </div>
        </div>

        <div className="scroll-y min-w-0 flex-1 px-6 pt-5 pb-12">
          {entry && record && spec ? (
            <div className="flex max-w-[880px] flex-col gap-[14px]">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-[17px] font-[650] tracking-[-.01em]">{spec.name}</span>
                <MonoChip icon="ti-file-text">specs/{spec.file}</MonoChip>
                <div className="flex-1" />
                <span className="text-[11.5px] text-zinc-500">
                  {entry.time} · approved by <b>{entry.approvedBy}</b>
                </span>
              </div>

              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200">
                {stats.map((stat) => (
                  <div key={stat.key} className="bg-white px-4 py-3">
                    <div className="text-[10px] font-[650] tracking-[.06em] text-zinc-400">
                      {stat.key}
                    </div>
                    <div className="mt-[3px] font-mono text-[12.5px] leading-[1.45] text-zinc-900">
                      {stat.value}
                    </div>
                  </div>
                ))}
              </div>

              <Panel>
                <PanelHeader>
                  <Icon name="ti-terminal-2" size={15} className="text-zinc-600" />
                  <span className="text-[13px] font-semibold">Executed DDL</span>
                  <div className="flex-1" />
                  <TraceChip
                    traceId={record.trace.id}
                    onClick={() => showTrace(record.trace.id)}
                  />
                </PanelHeader>
                <PanelBody className="px-4 py-3.5">
                  <DdlBlock ddl={record.ddl} className="max-h-[400px]" />
                </PanelBody>
              </Panel>

              <Panel>
                <PanelHeader>
                  <Icon name="ti-bulb" size={15} className="text-zinc-600" />
                  <span className="text-[13px] font-semibold">Design rationale</span>
                </PanelHeader>
                <div className="grid grid-cols-2 gap-3.5 px-4 py-3.5">
                  {record.rationale.map((item) => (
                    <RationaleItem key={item.title} item={item} />
                  ))}
                </div>
                <MvNote mv={record.mv} className="mx-4 mb-3.5" />
              </Panel>

              <Panel>
                <PanelHeader>
                  <Icon name="ti-wand" size={15} className="text-zinc-600" />
                  <span className="text-[13px] font-semibold">Agent reasoning</span>
                  <span className="rounded-md bg-zinc-100 px-[7px] py-0.5 font-mono text-[10.5px] text-zinc-500">
                    claude-sonnet-4-5
                  </span>
                </PanelHeader>
                <PanelBody className="flex flex-col gap-2">
                  <AgentLogList lines={record.log} />
                </PanelBody>
              </Panel>

              <Panel>
                <PanelHeader>
                  <Icon name="ti-book-2" size={15} className="text-zinc-600" />
                  <span className="text-[13px] font-semibold">
                    Context update — {entry.version}
                  </span>
                  <div className="flex-1" />
                  <TraceChip
                    traceId={record.contextTrace.id}
                    onClick={() => showTrace(record.contextTrace.id)}
                  />
                </PanelHeader>
                <PanelBody className="px-4 py-3.5">
                  <DiffTable diff={record.diff} />
                  {record.warn ? <ContradictionCallout text={record.warn} /> : null}
                </PanelBody>
              </Panel>
            </div>
          ) : null}
        </div>
      </div>
    </Screen>
  )
}
