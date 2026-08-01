import type { AgentLogLine, DiffLine, LogTone, MaterializedView, Rationale } from "@/api/types"
import { Icon } from "@/components/ui-kit/icon"
import { cn } from "@/lib/utils"

const TONE_COLOR: Record<LogTone, string> = {
  info: "#71717a",
  warn: "#d97706",
  ok: "#16a34a",
}

/** The agent's reasoning trail — streamed during a run, static in the report. */
export function AgentLogList({
  lines,
  animate = false,
}: {
  lines: AgentLogLine[]
  animate?: boolean
}) {
  return (
    <>
      {lines.map((line, index) => (
        <div
          key={`${index}-${line.text}`}
          className={cn("flex items-baseline gap-[9px]", animate && "animate-fade-up-sm")}
        >
          <Icon
            name={line.icon}
            size={14}
            className="translate-y-0.5"
            style={{ color: TONE_COLOR[line.tone] }}
          />
          <span className="text-[12.5px] leading-[1.55] text-zinc-700">{line.text}</span>
        </div>
      ))}
    </>
  )
}

export function RationaleItem({ item }: { item: Rationale }) {
  return (
    <div className="flex gap-[9px]">
      <Icon name={item.icon} size={15} className="translate-y-px text-teal" />
      <div>
        <div className="text-[12px] font-semibold">{item.title}</div>
        <div className="mt-px text-[11.5px] leading-[1.5] text-zinc-500">{item.text}</div>
      </div>
    </div>
  )
}

export function MvNote({ mv, className }: { mv: MaterializedView; className?: string }) {
  return (
    <div
      className={cn("rounded-[9px] border border-zinc-200 bg-zinc-50 px-3 py-2.5", className)}
    >
      <div className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-900">
        <Icon name="ti-stack-2" size={13} className="text-coral" />
        {mv.name}
      </div>
      <div className="mt-1 text-[11.5px] leading-[1.5] text-zinc-500">{mv.note}</div>
    </div>
  )
}

/** `+` additions and `~` revisions the Context Agent wrote into base_context. */
export function DiffTable({ diff }: { diff: DiffLine[] }) {
  return (
    <div className="overflow-hidden rounded-[9px] border border-zinc-100">
      {diff.map((line) => (
        <div
          key={line.text}
          className="flex gap-2.5 border-b border-zinc-100 px-3 py-1.5"
          style={{ background: line.sign === "+" ? "#f7fdf9" : "#fffdf5" }}
        >
          <span
            className="w-3 font-mono text-[11.5px] font-bold"
            style={{ color: line.sign === "+" ? "#16a34a" : "#d97706" }}
          >
            {line.sign}
          </span>
          <span className="font-mono text-[11.5px] leading-[1.55] text-zinc-700">
            {line.text}
          </span>
        </div>
      ))}
    </div>
  )
}

export function ContradictionCallout({ text }: { text: string }) {
  return (
    <div className="mt-2.5 flex gap-2.5 rounded-[9px] border border-amber-200 bg-amber-50 px-3 py-2.5">
      <Icon name="ti-alert-triangle" size={15} className="translate-y-px text-amber-600" />
      <div className="text-[12px] leading-[1.55] text-amber-900">
        <b>Contradiction surfaced.</b> {text}
      </div>
    </div>
  )
}

/** A reviewer note bumps the TTL and rewrites the comment that justified it. */
export function applyRevision(ddl: string) {
  return ddl
    .replace("INTERVAL 18 MONTH", "INTERVAL 24 MONTH")
    .replace("per base_context §data-retention", "reviewer: finance audit retention")
}
