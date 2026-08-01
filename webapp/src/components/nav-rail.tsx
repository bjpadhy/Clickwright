import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Icon } from "@/components/ui-kit/icon"
import { cn } from "@/lib/utils"
import { useConsole, type NavId } from "@/state/console"
import { useInstrumentation } from "@/state/instrumentation"

const NAV_ITEMS: {
  id: NavId
  icon: string
  label: string
  short: string
  /** Shown but not reachable yet — still served by the mock. */
  disabled?: boolean
}[] = [
  { id: "chat", icon: "ti-message-circle", label: "Chat", short: "Chat" },
  { id: "instr", icon: "ti-wand", label: "Instrumentation", short: "Instrument" },
  // Database health and Changelog read the real /api/observe/* endpoints.
  // Agent activity is still mock — see the note in traces-tab.tsx.
  { id: "obs", icon: "ti-activity", label: "Observability", short: "Observe" },
  {
    id: "dash",
    icon: "ti-layout-dashboard",
    label: "Dashboards — coming soon",
    short: "Boards",
    disabled: true,
  },
]

export function NavRail() {
  const { nav, goto } = useConsole()
  const { model } = useInstrumentation()

  return (
    <aside className="flex w-[70px] shrink-0 flex-col items-center gap-[5px] border-r border-zinc-200 bg-white pt-3.5 pb-4">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="mb-3.5 flex size-[34px] items-center justify-center rounded-[10px] bg-zinc-900">
            <Icon name="ti-bolt" size={19} className="text-white" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">SpecLoop — spec → insight · Atlys</TooltipContent>
      </Tooltip>

      {NAV_ITEMS.map((item) => {
        const active = nav === item.id
        // A gate is waiting on a human in Instrumentation while you're elsewhere.
        const needsAttention =
          item.id === "instr" && model.pendingGate !== null && !active

        return (
          <Tooltip key={item.id}>
            {/* `asChild` on a disabled button swallows pointer events, so the
                tooltip needs its own wrapper to stay hoverable. */}
            <TooltipTrigger asChild>
              <span className={cn(item.disabled && "cursor-not-allowed")}>
              <Button
                variant="ghost"
                disabled={item.disabled}
                aria-current={active ? "page" : undefined}
                aria-disabled={item.disabled || undefined}
                onClick={() => {
                  if (!item.disabled) goto(item.id)
                }}
                className={cn(
                  "relative h-auto w-14 flex-col gap-1 rounded-[11px] px-0 pt-[9px] pb-2",
                  item.disabled
                    ? "pointer-events-none bg-transparent text-zinc-300 opacity-60"
                    : "hover:bg-zinc-100",
                  active && !item.disabled
                    ? "bg-zinc-100 text-zinc-950"
                    : item.disabled
                      ? ""
                      : "bg-transparent text-zinc-600"
                )}
              >
                <Icon name={item.icon} size={20} />
                <span className="text-[9px] font-[650] tracking-[.02em]">
                  {item.short}
                </span>
                {needsAttention ? (
                  <span className="absolute top-1.5 right-2.5 size-2 animate-pulse-dot rounded-full border-2 border-white bg-amber-600" />
                ) : null}
              </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        )
      })}
    </aside>
  )
}
