import * as React from "react"

import type { ChatEvent } from "@/api/chat"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Icon, Spinner } from "@/components/ui-kit/icon"
import { Panel } from "@/components/ui-kit/panel"
import { cn } from "@/lib/utils"
import { buildChatProgress, formatMs, type ChatStep } from "./chat-model"

/** Re-renders once a second while `active`, so elapsed timers actually move. */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function StepRow({ step, now, depth = 0 }: { step: ChatStep; now: number; depth?: number }) {
  const running = step.status === "running"
  const elapsed = running ? now - step.startedAt : step.ms

  return (
    <>
      <div className="flex items-baseline gap-[9px]" style={{ paddingLeft: depth * 19 }}>
        {step.status === "done" ? (
          <Icon name="ti-check" size={13} className="translate-y-px text-teal" />
        ) : step.status === "error" ? (
          <Icon name="ti-alert-triangle" size={12} className="translate-y-px text-coral" />
        ) : (
          <Spinner size={13} className="translate-y-px text-zinc-500" />
        )}
        <div className="min-w-0 flex-1">
          <span
            className={cn(
              "text-[12px] font-[560]",
              step.status === "error" ? "text-[#a03c22]" : "text-zinc-950"
            )}
          >
            {step.label}
          </span>
          {step.attempts > 1 ? (
            <span className="ml-[6px] rounded-[4px] bg-orange-50 px-[5px] py-px text-[9.5px] font-semibold text-orange-800">
              attempt {step.attempts}
            </span>
          ) : null}
          <span className="ml-[7px] font-mono text-[11px] text-zinc-400">
            {step.detail ?? ""}
          </span>
        </div>
        <span className="shrink-0 font-mono text-[10.5px] text-zinc-400">
          {formatMs(elapsed)}
        </span>
      </div>

      {/* The retry loop is the feature — show the failure that caused it. */}
      {step.error || step.retryNote ? (
        <div
          className="font-mono text-[10.5px] leading-[1.55] break-words text-[#a03c22]"
          style={{ paddingLeft: depth * 19 + 22 }}
        >
          {step.error ?? step.retryNote}
        </div>
      ) : null}

      {step.children.map((child) => (
        <StepRow key={`${step.key}-${child.key}`} step={child} now={now} depth={depth + 1} />
      ))}
    </>
  )
}

/**
 * "How I got this" — the agent's steps for one answer.
 *
 * Live during the answer, then kept for the rest of the session behind a
 * disclosure. It is not persisted: the backend stores the finished insight, not
 * the per-step events, so reopening an old conversation shows the card alone.
 */
export function AgentSteps({
  events,
  running,
  startedAt,
  collapsible = false,
}: {
  events: ChatEvent[]
  running: boolean
  startedAt: number
  collapsible?: boolean
}) {
  const now = useNow(running)
  const progress = React.useMemo(() => buildChatProgress(events), [events])
  const [open, setOpen] = React.useState(false)

  const body = (
    <div className="flex flex-col gap-[7px] px-3.5 py-[11px]">
      {progress.steps.length === 0 ? (
        <div className="flex items-baseline gap-[9px]">
          <Spinner size={13} className="translate-y-px text-zinc-500" />
          <span className="text-[12px] font-[560]">Starting the Analytics Agent…</span>
        </div>
      ) : (
        progress.steps.map((step) => <StepRow key={step.key} step={step} now={now} />)
      )}

      {running && progress.inFlight.length > 0 ? (
        <div className="mt-0.5 flex flex-col gap-1 border-t border-zinc-100 pt-2">
          {progress.inFlight.map((call) => (
            <div key={call.call} className="flex items-baseline gap-[7px]">
              <Icon name="ti-sparkles" size={11} className="translate-y-px text-zinc-400" />
              <span className="flex-1 text-[11px] text-zinc-500">{call.label}…</span>
              <span className="font-mono text-[10.5px] text-zinc-400">
                {formatMs(now - call.startedAt)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )

  if (!collapsible) return <Panel className="rounded-[11px]">{body}</Panel>

  const total = formatMs(
    progress.steps.reduce((max, step) => Math.max(max, step.startedAt + (step.ms ?? 0)), 0) -
      startedAt
  )

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-[6px] text-[11px] text-zinc-500 hover:text-zinc-900">
        <Icon name={open ? "ti-chevron-up" : "ti-chevron-down"} size={12} />
        How I got this
        <span className="font-mono text-[10.5px] text-zinc-400">
          {progress.steps.length} steps{total ? ` · ${total}` : ""}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Panel className="mt-1.5 rounded-[11px]">{body}</Panel>
      </CollapsibleContent>
    </Collapsible>
  )
}
