/**
 * Client-side console state: which screen is open, and which tab within it.
 * Everything that would survive a page reload on a real deployment lives on the
 * server, not here.
 *
 * Every screen now runs against the real backend — Chat and Instrumentation own
 * their own state in `src/state/chat.tsx` and `src/state/instrumentation.tsx`,
 * and Changelog fetches on mount. So this holds navigation and nothing else.
 */

import * as React from "react"

export type NavId = "chat" | "instr" | "log"
export type InstrTab = "run" | "hist"

interface ConsoleContextValue {
  nav: NavId
  goto: (nav: NavId) => void

  /* instrumentation — which of its two screens is showing */
  instrTab: InstrTab
  setInstrTab: (tab: InstrTab) => void
}

const ConsoleContext = React.createContext<ConsoleContextValue | null>(null)

export function ConsoleProvider({ children }: { children: React.ReactNode }) {
  const [nav, setNav] = React.useState<NavId>("chat")
  const [instrTab, setInstrTab] = React.useState<InstrTab>("run")

  const goto = React.useCallback((next: NavId) => setNav(next), [])

  const value: ConsoleContextValue = { nav, goto, instrTab, setInstrTab }

  return <ConsoleContext value={value}>{children}</ConsoleContext>
}

export function useConsole() {
  const value = React.use(ConsoleContext)
  if (!value) throw new Error("useConsole must be used inside <ConsoleProvider>")
  return value
}
