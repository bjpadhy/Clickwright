import * as React from "react"

import { Spinner } from "@/components/ui-kit/icon"

/**
 * The Instrumentation screens, code-split.
 *
 * Chat is the screen the app opens on, and it never renders any of this — the
 * run stepper, the DDL review cards, the spec form, the history report. Those
 * modules are pulled in the first time someone opens Instrumentation instead
 * of being parsed on every cold load of the chat screen.
 *
 * The chunk is also prefetched once the browser goes idle, so switching tabs
 * is instant in practice and the fallback below is only ever seen on a cold,
 * slow connection.
 */
const load = () => import("./instrumentation-history-screen")

const Lazy = React.lazy(() => load().then((m) => ({ default: m.InstrumentationHistoryScreen })))

const idle: (run: () => void) => void =
  typeof window !== "undefined" && "requestIdleCallback" in window
    ? (run) => window.requestIdleCallback(run)
    : (run) => window.setTimeout(run, 1500)

idle(() => {
  void load()
})

export function InstrumentationHistory() {
  return (
    <React.Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-zinc-400">
          <Spinner size={18} />
        </div>
      }
    >
      <Lazy />
    </React.Suspense>
  )
}
