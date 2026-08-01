import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui-kit/icon"
import { cn } from "@/lib/utils"
import { useConsole } from "@/state/console"
import { useInstrumentation } from "@/state/instrumentation"

/**
 * "New spec" / "History" switch in the Instrumentation header. Deliberately two
 * buttons rather than a toggle group: tapping "New spec" while already on it
 * detaches from the run on screen, which a toggle group would swallow as a
 * no-op. The run itself keeps going — it lives on the server.
 */
export function InstrumentationTabs() {
  const { instrTab, setInstrTab } = useConsole()
  const { history, newRun, refreshHistory } = useInstrumentation()

  const tabs = [
    { id: "run", icon: "ti-file-plus", label: "New spec", count: "" },
    { id: "hist", icon: "ti-history", label: "History", count: String(history.length) },
  ] as const

  return (
    <div className="inline-flex gap-2">
      {tabs.map((tab) => {
        const active = instrTab === tab.id
        return (
          <Button
            key={tab.id}
            variant="outline"
            aria-pressed={active}
            onClick={() => {
              if (tab.id === "run") newRun()
              else refreshHistory()
              setInstrTab(tab.id)
            }}
            className={cn(
              "h-[33px] gap-1.5 rounded-lg px-[13px] text-[12.5px] font-[550] hover:border-zinc-900",
              active
                ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-900 hover:text-white"
                : "border-zinc-200 bg-white text-zinc-700 hover:bg-white hover:text-zinc-700"
            )}
          >
            <Icon name={tab.icon} size={15} />
            {tab.label}
            {tab.count ? (
              <span className="font-mono text-[11px] opacity-75">{tab.count}</span>
            ) : null}
          </Button>
        )
      })}
    </div>
  )
}
