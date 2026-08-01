/**
 * Data loading for the Observability screen.
 *
 * Deliberately plain useState/useEffect rather than a provider: unlike
 * Instrumentation, nothing here is long-lived or shared across screens — it is
 * fetch on mount, refresh on demand, and one polling loop for advisor scans.
 */

import * as React from "react"

import {
  observe,
  type ChangelogEntryDto,
  type DatabaseHealth,
  type ScanResult,
} from "@/api/observability"

export interface Loadable<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function useLoadable<T>(fetcher: () => Promise<T>, enabled: boolean): Loadable<T> {
  const [data, setData] = React.useState<T | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [nonce, setNonce] = React.useState(0)

  // Keep the latest fetcher without making it a dependency — callers pass
  // inline arrow functions, which would otherwise refetch on every render.
  const ref = React.useRef(fetcher)
  ref.current = fetcher

  React.useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setLoading(true)
    void ref
      .current()
      .then((result) => {
        if (cancelled) return
        setData(result)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(message(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, nonce])

  const reload = React.useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading, reload }
}

/** `enabled` defers the request until its tab is actually opened — the health
 *  payload runs half a dozen system-table queries and should not fire while the
 *  user is reading traces. */
export function useDatabaseHealth(enabled: boolean): Loadable<DatabaseHealth> {
  return useLoadable(() => observe.health(), enabled)
}

export function useChangelog(enabled: boolean): Loadable<ChangelogEntryDto[]> {
  return useLoadable(() => observe.changelog(), enabled)
}

const SCAN_POLL_MS = 5_000

export interface SuggestionsState extends Loadable<ScanResult> {
  scanning: boolean
  startScan: () => void
  scanError: string | null
}

/**
 * Advisor suggestions, plus the scan lifecycle. A scan is one LLM call over
 * measured evidence and takes 2–3 minutes, so the POST returns immediately and
 * we poll until the status settles.
 */
export function useSuggestions(enabled: boolean): SuggestionsState {
  const base = useLoadable(() => observe.suggestions(), enabled)
  const [scanError, setScanError] = React.useState<string | null>(null)
  const { reload } = base
  const scanning = base.data?.status === "scanning"

  React.useEffect(() => {
    if (!scanning) return
    const timer = setInterval(reload, SCAN_POLL_MS)
    return () => clearInterval(timer)
  }, [scanning, reload])

  const startScan = React.useCallback(() => {
    setScanError(null)
    void observe
      .startScan()
      .then(() => reload())
      .catch((cause: unknown) => setScanError(message(cause)))
  }, [reload])

  return { ...base, scanning, startScan, scanError }
}
