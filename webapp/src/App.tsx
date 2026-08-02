import { NavRail } from "@/components/nav-rail"
import { Changelog } from "@/screens/changelog/changelog"
import { Chat } from "@/screens/chat/chat"
import { InstrumentationHistory } from "@/screens/instrumentation/instrumentation-history"
import { InstrumentationRun } from "@/screens/instrumentation/instrumentation-run"
import { useConsole } from "@/state/console"

export default function App() {
  const { nav, instrTab } = useConsole()

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50 text-sm text-zinc-950">
      <NavRail />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {nav === "instr" &&
          (instrTab === "run" ? <InstrumentationRun /> : <InstrumentationHistory />)}
        {nav === "log" && <Changelog />}
        {nav === "chat" && <Chat />}
      </main>
    </div>
  )
}
