import { Icon, Spinner } from "@/components/ui-kit/icon"
import {
  PHASES,
  phaseDuration,
  type PhaseId,
  type PhaseState,
  type StepGroup,
} from "./run-model"

const MARKER: Record<PhaseState, { background: string; borderColor: string; color: string }> = {
  done: { background: "#2a9d90", borderColor: "#2a9d90", color: "#fff" },
  active: { background: "#18181b", borderColor: "#18181b", color: "#fff" },
  // Blocked on a person, so it pulses amber instead of spinning.
  waiting: { background: "#d97706", borderColor: "#d97706", color: "#fff" },
  error: { background: "#dc2626", borderColor: "#dc2626", color: "#fff" },
  idle: { background: "#fff", borderColor: "#e4e4e7", color: "#a1a1aa" },
}

export function PipelineSteps({
  phases,
  steps,
}: {
  phases: Record<PhaseId, PhaseState>
  steps: StepGroup[]
}) {
  return (
    <div className="flex items-center border-t border-zinc-100 pt-4">
      {PHASES.map((phase, index) => {
        const state = phases[phase.id]
        const marker = MARKER[state]
        const duration = phaseDuration(steps, phase.id)

        return (
          <div
            key={phase.id}
            className="flex items-center"
            style={{ flex: index < PHASES.length - 1 ? 1 : 0 }}
          >
            <div className="flex min-w-[74px] flex-col items-center gap-[5px]">
              <div
                className="flex size-[27px] items-center justify-center rounded-full border-[1.5px]"
                style={{
                  ...marker,
                  animation: state === "waiting" ? "pulse-soft 1.4s infinite" : undefined,
                }}
              >
                {state === "done" ? <Icon name="ti-check" size={14} /> : null}
                {state === "active" ? <Spinner size={14} /> : null}
                {state === "error" ? <Icon name="ti-x" size={14} /> : null}
                {state === "idle" || state === "waiting" ? (
                  <span className="text-[11px] font-semibold">{index + 1}</span>
                ) : null}
              </div>
              <span
                className="text-[11px] whitespace-nowrap"
                style={{
                  fontWeight: state === "idle" ? 450 : 600,
                  color: state === "idle" ? "#a1a1aa" : "#09090b",
                }}
              >
                {phase.label}
              </span>
              <span className="h-[11px] font-mono text-[9.5px] text-zinc-400">
                {state === "waiting" ? "waiting…" : duration}
              </span>
            </div>
            {index < PHASES.length - 1 ? (
              <div
                className="mx-1.5 mb-[26px] h-0.5 flex-1 rounded-sm"
                style={{
                  background: phases[PHASES[index + 1]!.id] === "idle" ? "#e4e4e7" : "#2a9d90",
                }}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
