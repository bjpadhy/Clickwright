import { ErrorBoundary } from "@/components/error-boundary"
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
      {/* Per-screen, so one screen throwing keeps the nav rail and lets the
          reader switch away — the root boundary in main.tsx replaced the whole
          app, including the way out of it. Keyed by screen so moving between
          them clears a previous screen's error. */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ErrorBoundary resetKey={`${nav}:${instrTab}`}>
          {nav === "instr" &&
            (instrTab === "run" ? <InstrumentationRun /> : <InstrumentationHistory />)}
          {nav === "log" && <Changelog />}
          {nav === "chat" && <Chat />}
        </ErrorBoundary>
      </main>
    </div>
  )
}
