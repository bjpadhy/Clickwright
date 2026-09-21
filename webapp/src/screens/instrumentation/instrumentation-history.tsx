import * as React from "react"

import { ErrorBoundary, ErrorPanel } from "@/components/error-boundary"
import { Spinner } from "@/components/ui-kit/icon"
import { Screen, ScreenHeader } from "@/components/ui-kit/panel"
import { InstrumentationTabs } from "./instrumentation-tabs"

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
 * slow connection. Only the BODY is split: the header and the tabs are part of
 * this module, so they stay on screen — and clickable — while it loads.
 */
const load = () => import("./instrumentation-history-screen")

/**
 * `React.lazy` remembers a rejected `import()` and re-throws it on every later
 * render, so the retry the error boundary offers has to be handed a new one.
 */
const attempts = new Map<number, React.ComponentType>()
function bodyFor(attempt: number): React.ComponentType {
  let body = attempts.get(attempt)
  if (!body) {
    body = React.lazy(() =>
      load().then((m) => ({ default: m.InstrumentationHistoryScreen }))
    )
    attempts.set(attempt, body)
  }
  return body
}

const idle: (run: () => void) => void =
  typeof window !== "undefined" && "requestIdleCallback" in window
    ? (run) => window.requestIdleCallback(run)
    : (run) => window.setTimeout(run, 1500)

idle(() => {
  // Prefetch only; a failure here is retried by the lazy import below, but an
  // uncaught rejection would surface as `unhandledrejection` when offline.
  void load().catch(() => {})
})

export function InstrumentationHistory() {
  const [attempt, setAttempt] = React.useState(0)
  const Body = bodyFor(attempt)

  return (
    <Screen label="Instrumentation history">
      <ScreenHeader
        title="Instrumentation"
        subtitle="Every run, with its full decision record — replayed from runs_log"
      >
        <InstrumentationTabs />
      </ScreenHeader>

      <ErrorBoundary
        resetKey={attempt}
        fallback={(props) => (
          <ErrorPanel {...props} reset={() => setAttempt((n) => n + 1)} />
        )}
      >
        <React.Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-zinc-400">
              <Spinner size={18} />
            </div>
          }
        >
          <Body />
        </React.Suspense>
      </ErrorBoundary>
    </Screen>
  )
}
