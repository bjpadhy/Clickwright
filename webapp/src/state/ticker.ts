/**
 * One clock for the whole app.
 *
 * Several places count seconds while work is in flight: the run header, every
 * running step row, every in-flight LLM call. Each used to own a
 * `setInterval(…, 1000)` and its own `useState`, so a run with eight live rows
 * ran eight timers that each re-rendered their own subtree on a different
 * phase of the second — visibly ragged, and the cost scaled with the number of
 * things being watched.
 *
 * This is a single interval shared by every subscriber, started on the first
 * subscription and stopped on the last, so an idle screen has no timer at all.
 * Subscribers read the same timestamp, so every elapsed counter on screen
 * advances on the same tick.
 */

import * as React from "react"

const listeners = new Set<() => void>()
let timer: number | null = null
let nowMs = Date.now()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === null) {
    timer = window.setInterval(() => {
      nowMs = Date.now()
      for (const notify of listeners) notify()
    }, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }
}

// Must return a cached value, never a fresh Date.now(): React compares
// snapshots by identity and a new value every call would re-render forever.
const snapshot = () => nowMs

const NEVER = () => () => {}

/**
 * Current time in ms, re-rendering once a second while `active`.
 *
 * When inactive the component does not subscribe and does not re-render; the
 * value it reads is the last shared tick, which is only ever used for counters
 * that are already finished (those render their recorded duration instead).
 */
export function useTick(active: boolean): number {
  const subscribeWhileActive = React.useCallback(
    (listener: () => void) => (active ? subscribe(listener) : NEVER()),
    [active]
  )
  return React.useSyncExternalStore(subscribeWhileActive, snapshot, snapshot)
}
