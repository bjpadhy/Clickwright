import { api } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MonoChip } from "@/components/ui-kit/chips"
import { Icon } from "@/components/ui-kit/icon"
import { Panel, PanelBody, PanelHeader } from "@/components/ui-kit/panel"
import { solidButton } from "@/components/ui-kit/styles"
import { cn } from "@/lib/utils"
import { useConsole } from "@/state/console"

const PLACEHOLDER =
  "Paste the feature spec here — the PM brief as written. The agent reads base_context, every live schema and 90 days of query patterns before designing anything."

export function SpecInput() {
  const {
    server,
    pendingSpec,
    specInput,
    onSpecInput,
    loadSample,
    clearPending,
    runPipeline,
    busy,
  } = useConsole()

  const samples = api.listSpecs().filter((spec) => server.specStatuses[spec.id] !== "done")
  const preview = pendingSpec ? api.getSpecPreview(pendingSpec) : null
  const ready = !!pendingSpec || specInput.trim().length > 0

  return (
    <Panel>
      <PanelHeader className="px-[18px] py-[13px]">
        <Icon name="ti-file-plus" size={16} className="text-zinc-600" />
        <span className="text-[13.5px] font-semibold">New feature spec</span>
        <div className="flex-1" />
        <span className="text-[11px] text-zinc-400">
          markdown brief + raw NDJSON sample · no table design
        </span>
      </PanelHeader>

      <PanelBody className="px-[18px] py-4">
        {preview ? (
          <div className="rounded-[10px] border border-zinc-200 bg-zinc-50 px-[15px] py-[13px]">
            <div className="flex items-center gap-2">
              <MonoChip icon="ti-file-text">specs/{preview.file}</MonoChip>
              <span className="text-[11px] text-zinc-400">{preview.events}</span>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="icon"
                title="Clear spec"
                onClick={clearPending}
                className="size-6 rounded-[7px] text-zinc-500 hover:bg-zinc-100"
              >
                <Icon name="ti-x" size={14} />
              </Button>
            </div>
            <div className="mt-2.5 text-[12.5px] leading-[1.6] text-zinc-700">
              {preview.brief}
            </div>
            {preview.ndjson.length > 0 ? (
              <div className="mt-2.5 overflow-x-auto rounded-lg border border-zinc-100 bg-white px-3 py-[9px]">
                {preview.ndjson.map((line) => (
                  <div
                    key={line}
                    className="font-mono text-[10.5px] leading-[1.7] whitespace-pre text-zinc-600"
                  >
                    {line}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <Textarea
              value={specInput}
              onChange={(event) => onSpecInput(event.target.value)}
              placeholder={PLACEHOLDER}
              className="field-sizing-fixed h-[118px] min-h-0 resize-y rounded-[10px] border-[1.5px] border-dashed border-zinc-300 bg-zinc-50 px-3.5 py-3 text-[12.5px] leading-[1.6] text-zinc-950 md:text-[12.5px]"
            />
            <div className="mt-3.5 flex flex-col gap-[7px]">
              <div className="text-[11px] font-[650] tracking-[.06em] text-zinc-400">
                OR START FROM A SAMPLE SPEC
              </div>
              {samples.map((spec) => (
                <Button
                  key={spec.id}
                  variant="outline"
                  onClick={() => loadSample(spec.id)}
                  className="h-auto justify-start gap-[11px] rounded-[10px] border-zinc-200 bg-white px-[13px] py-2.5 font-normal hover:border-zinc-900 hover:bg-white"
                >
                  <Icon name="ti-file-text" size={16} className="text-teal" />
                  <div className="min-w-0 flex-1 text-left">
                    <div className="text-[12.5px] font-semibold">{spec.name}</div>
                    <div className="mt-px font-mono text-[10.5px] text-zinc-400">
                      specs/{spec.file} · {spec.events}
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1 text-[11px] font-[550] text-zinc-600">
                    Use
                    <Icon name="ti-arrow-right" size={13} />
                  </span>
                </Button>
              ))}
            </div>
          </>
        )}

        <div className="mt-3.5 flex items-center gap-3">
          <Button
            onClick={runPipeline}
            className={cn(solidButton, (busy || !ready) && "opacity-45")}
          >
            <Icon name="ti-sparkles" size={15} />
            Run Instrumentation Agent
          </Button>
          <span className="text-[11.5px] text-zinc-500">
            reads base_context v{server.contextVersion} + all live schemas + 90d of query
            patterns first
          </span>
        </div>
      </PanelBody>
    </Panel>
  )
}
