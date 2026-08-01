import type { RunStage } from "@/api/types"
import { Icon, Spinner } from "@/components/ui-kit/icon"

const STEPS = [
  "Parse spec",
  "Design schema",
  "Human approval",
  "Execute DDL",
  "Context update",
]

/** Step 3 blocks on a person, so it pulses amber instead of spinning. */
const APPROVAL_STEP = 3

type StepState = "idle" | "active" | "done"

const MARKER: Record<
  "done" | "running" | "waiting" | "idle",
  { background: string; borderColor: string; color: string }
> = {
  done: { background: "#2a9d90", borderColor: "#2a9d90", color: "#fff" },
  running: { background: "#18181b", borderColor: "#18181b", color: "#fff" },
  waiting: { background: "#d97706", borderColor: "#d97706", color: "#fff" },
  idle: { background: "#fff", borderColor: "#e4e4e7", color: "#a1a1aa" },
}

export function PipelineSteps({
  stage,
  durations = [],
}: {
  stage: RunStage
  durations?: string[]
}) {
  return (
    <div className="flex items-center border-t border-zinc-100 pt-4">
      {STEPS.map((label, index) => {
        const step = index + 1
        const state: StepState =
          stage >= 6 || stage > step ? "done" : stage === step ? "active" : "idle"

        const isApproval = step === APPROVAL_STEP
        const done = state === "done"
        const running = state === "active" && !isApproval
        const waiting = state === "active" && isApproval
        const marker = done
          ? MARKER.done
          : running
            ? MARKER.running
            : waiting
              ? MARKER.waiting
              : MARKER.idle

        return (
          <div
            key={label}
            className="flex items-center"
            style={{ flex: index < STEPS.length - 1 ? 1 : 0 }}
          >
            <div className="flex min-w-[74px] flex-col items-center gap-[5px]">
              <div
                className="flex size-[27px] items-center justify-center rounded-full border-[1.5px]"
                style={{
                  ...marker,
                  animation: waiting ? "pulse-soft 1.4s infinite" : undefined,
                }}
              >
                {done ? <Icon name="ti-check" size={14} /> : null}
                {running ? <Spinner size={14} /> : null}
                {!done && !running ? (
                  <span className="text-[11px] font-semibold">{step}</span>
                ) : null}
              </div>
              <span
                className="text-[11px] whitespace-nowrap"
                style={{
                  fontWeight: state === "idle" ? 450 : 600,
                  color: state === "idle" ? "#a1a1aa" : "#09090b",
                }}
              >
                {label}
              </span>
              <span className="h-[11px] font-mono text-[9.5px] text-zinc-400">
                {done ? (durations[index] ?? "") : waiting ? "waiting…" : ""}
              </span>
            </div>
            {index < STEPS.length - 1 ? (
              <div
                className="mx-1.5 mb-[26px] h-0.5 flex-1 rounded-sm"
                style={{ background: stage > step ? "#2a9d90" : "#e4e4e7" }}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
