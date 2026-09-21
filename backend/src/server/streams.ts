/**
 * Registry of open SSE responses.
 *
 * SSE responses have no natural end, so a shutdown has to close them
 * explicitly — otherwise `tsx watch` restarts leave clients waiting on a dead
 * socket. Both streams register here: run events (`/api/runs/:id/events`) and
 * chat answers (`/api/conversations/:id/messages`).
 */

export interface ClosableStream {
  end: () => void;
}

const open = new Set<ClosableStream>();

/** Register a stream; the returned function deregisters it (idempotent). */
export function registerStream(stream: ClosableStream): () => void {
  open.add(stream);
  return () => {
    open.delete(stream);
  };
}

/** Close every open stream. Never throws — a socket already gone is fine. */
export function closeOpenStreams(): void {
  for (const stream of open) {
    try {
      stream.end();
    } catch {
      /* already gone */
    }
  }
  open.clear();
}

/** How many streams are open — exposed for diagnostics and tests. */
export function openStreamCount(): number {
  return open.size;
}
