/**
 * Shared transport for the real Clickwright backend (`backend/API.md`).
 *
 * Paths are relative — `vite.config.ts` proxies `/api/*` to the service, so the
 * same code works in dev and behind a reverse proxy.
 */

/** Errors are `{ error: string }` with a 4xx/5xx status. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  })
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

export function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) })
}

export function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" })
}

/* ── SSE over POST ─────────────────────────────────────────────────────── */

export interface SsePacket {
  /** the `event:` name — the backend never sends unnamed frames */
  event: string
  data: unknown
}

/**
 * `EventSource` can only issue GETs, and asking a question is a POST — so the
 * stream is read off the response body instead. Same wire format, minus the
 * automatic reconnect: a dropped chat stream cannot be resumed anyway (the
 * answer is not buffered server-side), and the finished answer is already
 * persisted, so a reload re-reads it from `GET /api/conversations/:id`.
 */
export async function streamPost(
  path: string,
  body: unknown,
  onPacket: (packet: SsePacket) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "")
    let message = `${response.status} ${response.statusText}`
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (parsed.error) message = String(parsed.error)
    } catch {
      /* not JSON — keep the status line */
    }
    throw new Error(message)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Frames are separated by a blank line; anything after the last one is a
    // partial frame and stays in the buffer until the rest of it arrives.
    const frames = buffer.split("\n\n")
    buffer = frames.pop() ?? ""
    for (const frame of frames) {
      const packet = parseFrame(frame)
      if (packet) onPacket(packet)
    }
  }
}

function parseFrame(frame: string): SsePacket | null {
  let event = ""
  const data: string[] = []
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue // keepalive comment
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).trim())
  }
  if (!event) return null
  try {
    return { event, data: data.length ? JSON.parse(data.join("\n")) : null }
  } catch {
    return null // truncated payload — the stream carries on
  }
}
