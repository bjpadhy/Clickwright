/**
 * Data loading for the Changelog screen — fetch on mount, refresh on demand.
 *
 * Deliberately plain useState/useEffect rather than a provider: unlike
 * Instrumentation, nothing here is long-lived or shared across screens.
 */

import * as React from "react"

import { changelog, type ChangelogEntryDto } from "@/api/changelog"

export interface Loadable<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useChangelog(): Loadable<ChangelogEntryDto[]> {
  const [data, setData] = React.useState<ChangelogEntryDto[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [nonce, setNonce] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    void changelog
      .list()
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
  }, [nonce])

  const reload = React.useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading, reload }
}
