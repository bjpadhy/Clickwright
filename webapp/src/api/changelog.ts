/**
 * The Changelog screen's half of the real backend (`backend/API.md`).
 *
 * The backend returns raw values and lets the UI decide how to render them —
 * the formatters at the bottom of this file are that decision, in one place.
 */

export interface ChangelogEntryDto {
  id: string
  /** "YYYY-MM-DD HH:MM:SS.mmm" */
  at: string
  kind: "table" | "context"
  title: string
  description: string
  /** an existing definition was superseded */
  warn: boolean
  traceUrl: string | null
  runId: string | null
  spec: string | null
  /** "v1.3" — context entries only */
  contextVersion: string | null
  entities: string[]
  tables: { name: string; rows: number }[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init)
  const text = await response.text()
  const body = text ? (JSON.parse(text) as unknown) : null

  if (!response.ok) {
    const error =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `${response.status} ${response.statusText}`
    throw new Error(error)
  }
  return body as T
}

export const changelog = {
  list: (kind?: "table" | "context") =>
    request<ChangelogEntryDto[]>(
      `/observe/changelog${kind ? `?kind=${kind}` : ""}`
    ),

  /** Plain href — let the browser download it rather than buffering in JS. */
  exportUrl: "/api/observe/changelog/export",
}

/** "2026-08-01 15:29:39.228" → "15:29". The changelog groups by day already. */
export function formatClock(at: string): string {
  return at.slice(11, 16) || at
}

/** Langfuse deep links end in the trace id; the chip shows the id, the click
 *  opens the URL. */
export function traceIdFromUrl(url: string): string {
  const id = url.split("/").filter(Boolean).pop() ?? url
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}
