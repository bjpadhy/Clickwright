import * as React from "react"

import type { SpecOption } from "@/api/instrumentation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { MonoChip, StatusPill } from "@/components/ui-kit/chips"
import { Icon, Spinner } from "@/components/ui-kit/icon"
import { Panel, PanelBody, PanelHeader } from "@/components/ui-kit/panel"
import { outlineButtonSm, solidButton } from "@/components/ui-kit/styles"
import { cn } from "@/lib/utils"
import { useInstrumentation } from "@/state/instrumentation"
import { BackendUnreachable } from "./parts"

const SPEC_PLACEHOLDER =
  "Paste spec.md — the PM brief as written. The agent reads the context store, every live schema and the raw event sample before designing anything."

const NDJSON_PLACEHOLDER =
  'Paste events.ndjson — one JSON event per line, e.g. {"event":"checkout_started","id":"…","timestamp":"…"}'

/** `express checkout v2` → the spec id the backend will derive. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, "_")
}

export function SpecInput() {
  const { specs, health, offline, startRun, starting, runs, openRun } =
    useInstrumentation()

  // The draft lives here: the backend only ever sees a finished submission.
  const [sample, setSample] = React.useState<SpecOption | null>(null)
  const [name, setName] = React.useState("")
  const [specMd, setSpecMd] = React.useState("")
  const [ndjson, setNdjson] = React.useState("")

  const uploadReady = !!(name.trim() && specMd.trim() && ndjson.trim())
  const ready = !!sample || uploadReady
  /** The user has started supplying their own spec — samples no longer apply. */
  const composing = !!(specMd.trim() || ndjson.trim())
  const ndjsonLines = ndjson.trim() ? ndjson.trim().split("\n").length : 0
  const recent = runs.slice(0, 4)

  const run = () => {
    if (sample) startRun({ specDir: sample.specDir })
    else if (uploadReady) startRun({ name: slug(name), specMd, ndjson })
  }

  const readInto = (setter: (value: string) => void) => (file: File | undefined) => {
    if (!file) return
    void file.text().then(setter)
  }

  return (
    <div className="flex flex-col gap-[14px]">
      {offline ? <BackendUnreachable error={offline} /> : null}

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
          {sample ? (
            <div className="rounded-[10px] border border-zinc-200 bg-zinc-50 px-[15px] py-[13px]">
              <div className="flex items-center gap-2">
                <MonoChip icon="ti-file-text">{sample.specDir}</MonoChip>
                <span className="text-[11px] text-zinc-400">
                  {sample.events.toLocaleString()} events · {sample.eventTypes} event types
                </span>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="icon"
                  title="Clear spec"
                  onClick={() => setSample(null)}
                  className="size-6 rounded-[7px] text-zinc-500 hover:bg-zinc-100"
                >
                  <Icon name="ti-x" size={14} />
                </Button>
              </div>
              <div className="mt-2.5 text-[12.5px] leading-[1.6] text-zinc-700">
                The agent will read <span className="font-mono text-[11.5px]">spec.md</span> and
                profile every event type in{" "}
                <span className="font-mono text-[11.5px]">events.ndjson</span> on the server,
                then propose one table per event type for your approval.
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2.5">
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Feature name — becomes the spec id, e.g. express_checkout_v2"
                  className="h-[36px] rounded-[10px] border-zinc-200 px-3 text-[12.5px] md:text-[12.5px]"
                />
                <FileField
                  label="spec.md"
                  accept=".md,.markdown,text/markdown"
                  onFile={readInto(setSpecMd)}
                  filled={specMd.trim().length > 0}
                >
                  <Textarea
                    value={specMd}
                    onChange={(event) => setSpecMd(event.target.value)}
                    placeholder={SPEC_PLACEHOLDER}
                    className="field-sizing-fixed h-[104px] min-h-0 resize-y rounded-[10px] border-[1.5px] border-dashed border-zinc-300 bg-zinc-50 px-3.5 py-3 text-[12.5px] leading-[1.6] text-zinc-950 md:text-[12.5px]"
                  />
                </FileField>
                <FileField
                  label="events.ndjson"
                  accept=".ndjson,.jsonl,.json,text/plain"
                  onFile={readInto(setNdjson)}
                  filled={ndjsonLines > 0}
                  note={ndjsonLines ? `${ndjsonLines.toLocaleString()} lines` : undefined}
                >
                  <Textarea
                    value={ndjson}
                    onChange={(event) => setNdjson(event.target.value)}
                    placeholder={NDJSON_PLACEHOLDER}
                    className="field-sizing-fixed h-[84px] min-h-0 resize-y rounded-[10px] border-[1.5px] border-dashed border-zinc-300 bg-zinc-50 px-3.5 py-3 font-mono text-[11px] leading-[1.6] text-zinc-950 md:text-[11px]"
                  />
                </FileField>
              </div>

              {/* Once there's a spec or event data in the form, the samples are
                  no longer an "or" — they'd discard what was just entered. */}
              <div
                className={cn(
                  "mt-3.5 flex-col gap-[7px]",
                  composing ? "hidden" : "flex"
                )}
              >
                <div className="text-[11px] font-[650] tracking-[.06em] text-zinc-400">
                  OR START FROM A SAMPLE SPEC
                </div>
                {specs.length === 0 && !offline ? (
                  <div className="flex items-center gap-2 text-[12px] text-zinc-400">
                    <Spinner size={13} />
                    loading specs from the server…
                  </div>
                ) : null}
                {specs.map((spec) => (
                  <Button
                    key={spec.id}
                    variant="outline"
                    disabled={spec.alreadyInstrumented}
                    onClick={() => setSample(spec)}
                    className="h-auto justify-start gap-[11px] rounded-[10px] border-zinc-200 bg-white px-[13px] py-2.5 font-normal hover:border-zinc-900 hover:bg-white disabled:opacity-50"
                  >
                    <Icon name="ti-file-text" size={16} className="text-teal" />
                    <div className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-2">
                        <span className="text-[12.5px] font-semibold">{spec.id}</span>
                        {spec.alreadyInstrumented ? (
                          <StatusPill className="border-green-200 bg-green-50 text-green-800">
                            already instrumented
                          </StatusPill>
                        ) : null}
                      </div>
                      <div className="mt-px font-mono text-[10.5px] text-zinc-400">
                        {spec.specDir} · {spec.events.toLocaleString()} events ·{" "}
                        {spec.eventTypes} event types
                      </div>
                    </div>
                    {spec.alreadyInstrumented ? null : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-[550] text-zinc-600">
                        Use
                        <Icon name="ti-arrow-right" size={13} />
                      </span>
                    )}
                  </Button>
                ))}
              </div>
            </>
          )}

          <div className="mt-3.5 flex items-center gap-3">
            <Button
              onClick={run}
              disabled={!ready || starting}
              className={cn(solidButton, (!ready || starting) && "opacity-45")}
            >
              {starting ? <Spinner size={15} /> : <Icon name="ti-sparkles" size={15} />}
              Run Instrumentation Agent
            </Button>
            <span className="text-[11.5px] text-zinc-500">
              {health
                ? `${health.model} · ClickHouse ${health.clickhouse} · ${health.database}`
                : "reads the context store + every live schema before designing"}
            </span>
          </div>
        </PanelBody>
      </Panel>

      {recent.length > 0 ? (
        <Panel>
          <PanelHeader>
            <Icon name="ti-list-details" size={15} className="text-zinc-600" />
            <span className="text-[13px] font-semibold">This session's runs</span>
            <span className="text-[11px] text-zinc-400">
              queued FIFO · one run at a time
            </span>
          </PanelHeader>
          <PanelBody className="flex flex-col gap-1.5 px-3 py-2.5">
            {recent.map((item) => (
              <Button
                key={item.id}
                variant="outline"
                onClick={() => openRun(item.id)}
                className={`${outlineButtonSm} h-auto justify-start gap-2.5 py-2 font-normal`}
              >
                <span className="text-[12.5px] font-semibold">{item.spec}</span>
                <span className="font-mono text-[10.5px] text-zinc-400">{item.id}</span>
                <div className="flex-1" />
                <span className="text-[11px] text-zinc-500">{item.status}</span>
                <Icon name="ti-arrow-right" size={13} className="text-zinc-400" />
              </Button>
            ))}
          </PanelBody>
        </Panel>
      ) : null}
    </div>
  )
}

/** Textarea plus a "load from file" affordance — 50 MB of NDJSON isn't pasteable. */
function FileField({
  label,
  accept,
  note,
  filled,
  onFile,
  children,
}: {
  label: string
  accept: string
  note?: string
  filled: boolean
  onFile: (file: File | undefined) => void
  children: React.ReactNode
}) {
  const input = React.useRef<HTMLInputElement>(null)

  return (
    <div>
      <div className="flex items-center gap-2 pb-1.5">
        <span className="font-mono text-[11px] text-zinc-500">{label}</span>
        {filled ? (
          <Icon name="ti-circle-check" size={13} className="text-green-600" />
        ) : null}
        {note ? <span className="text-[11px] text-zinc-400">{note}</span> : null}
        <div className="flex-1" />
        <Button
          variant="ghost"
          onClick={() => input.current?.click()}
          className="h-auto gap-1.5 px-1.5 py-0.5 text-[11px] font-[550] text-zinc-600 hover:bg-zinc-100"
        >
          <Icon name="ti-upload" size={13} />
          Load file
        </Button>
        <input
          ref={input}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(event) => onFile(event.target.files?.[0])}
        />
      </div>
      {children}
    </div>
  )
}
