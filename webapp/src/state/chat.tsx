/**
 * Chat screen state, backed by the real Clickwright backend.
 *
 * The backend owns every durable fact: conversations, titles, stars and the
 * finished insight for each turn all live in ClickHouse (`backend/API.md`
 * § Chat). This provider holds only what a reload is allowed to lose — the
 * answer currently streaming, and the step log of answers watched this session.
 *
 * A new conversation is a DRAFT until its first question: `activeId === null`
 * renders the empty state and the row is created on send, so opening the screen
 * never litters the table with empty conversations.
 */

import * as React from "react"
import { toast } from "sonner"

import {
  askQuestion,
  chat,
  type ChatEvent,
  type ChatMessage,
  type ConversationSummary,
  type Suggestion,
} from "@/api/chat"
import { useConsole } from "@/state/console"

/** The live turn: a question on screen whose answer does not exist yet. */
export interface PendingTurn {
  convId: string
  question: string
  startedAt: number
  events: ChatEvent[]
  traceUrl: string | null
  error: string | null
}

interface ChatValue {
  conversations: ConversationSummary[]
  /** `null` = an unsaved new conversation */
  activeId: string | null
  active: ConversationSummary | null
  messages: ChatMessage[]
  loadingMessages: boolean

  /** the in-flight turn — may belong to a conversation you have navigated away from */
  pending: PendingTurn | null
  streaming: boolean
  /** Stop waiting on the in-flight turn. The agent keeps going server-side and
   *  the answer is still persisted — this detaches the UI, it does not undo. */
  cancel: () => void

  suggestions: Suggestion[]
  /** "44 entities · max v2" — what the agent will plan against */
  contextSummary: string
  offline: string | null

  input: string
  setInput: (value: string) => void
  send: (question?: string) => void
  select: (id: string) => void
  newConversation: () => void
  toggleStar: (id: string) => void
  /** Irreversible. Refuses while that conversation's answer is still streaming. */
  remove: (id: string) => void
  /** jump to Chat from another screen and ask in a fresh conversation */
  askAbout: (question: string) => void

  /** step logs of answers watched this session, keyed `<convId>#<messageIndex>` */
  stepLog: Record<string, ChatEvent[]>
}

const ChatContext = React.createContext<ChatValue | null>(null)

/**
 * How long the client waits for an answer before it stops listening.
 *
 * Generously above the worst measured question so a slow-but-working answer is
 * never cut off. The point is that a stream killed by a proxy, a sleeping
 * laptop or a backend restart cannot leave the composer disabled forever with
 * a spinner that will never resolve — the turn is persisted server-side, so
 * reopening the conversation picks up whatever landed.
 */
const TURN_TIMEOUT_MS = 5 * 60_000

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { goto } = useConsole()

  const [conversations, setConversations] = React.useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [loadingMessages, setLoadingMessages] = React.useState(false)
  const [pending, setPending] = React.useState<PendingTurn | null>(null)
  const [stepLog, setStepLog] = React.useState<Record<string, ChatEvent[]>>({})
  const [suggestions, setSuggestions] = React.useState<Suggestion[]>([])
  const [contextSummary, setContextSummary] = React.useState("")
  const [offline, setOffline] = React.useState<string | null>(null)
  const [input, setInput] = React.useState("")

  // An answer takes a minute; the conversation on screen — and its message
  // list — can change under it, so the stream reads both through refs.
  const activeIdRef = React.useRef<string | null>(null)
  activeIdRef.current = activeId
  const messagesRef = React.useRef<ChatMessage[]>([])
  messagesRef.current = messages
  /** Set while a turn is in flight, so `cancel()` can reach into it. */
  const abortTurnRef = React.useRef<((reason: "user" | "timeout") => void) | null>(null)

  const active = React.useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  )

  const refreshConversations = React.useCallback(async () => {
    const list = await chat.listConversations()
    setConversations(list)
    return list
  }, [])

  /* ── first load ──────────────────────────────────────────────────────── */

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await refreshConversations()
        if (cancelled) return
        setOffline(null)
      } catch (error) {
        if (!cancelled) setOffline(message(error))
      }
    })()
    // Chips and the context badge are nice-to-have — they never block the screen.
    void chat
      .suggestions()
      .then((list) => !cancelled && setSuggestions(list))
      .catch(() => {})
    void chat
      .contextSummary()
      .then((summary) => !cancelled && setContextSummary(summary))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [refreshConversations])

  /* ── the open conversation's history ─────────────────────────────────── */

  React.useEffect(() => {
    if (!activeId) {
      setMessages([])
      return
    }
    let cancelled = false
    setLoadingMessages(true)
    void chat
      .getConversation(activeId)
      .then((conversation) => {
        if (cancelled) return
        setMessages(conversation.messages)
        setOffline(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // Gone rather than unreachable — deleted in another tab, or the id
        // outlived a database reset. Drop to the draft state instead of
        // accusing the backend of being down.
        if (message(error) === "unknown conversation") {
          setActiveId(null)
          setMessages([])
          void refreshConversations().catch(() => {})
          return
        }
        setOffline(message(error))
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeId, refreshConversations])

  /* ── asking ──────────────────────────────────────────────────────────── */

  const streaming = pending !== null

  /**
   * One question, one traced answer. `target` is the conversation to ask in;
   * `null` creates one first, which is how both a draft conversation and the
   * "Ask about it" handoff from Instrumentation start.
   */
  const ask = React.useCallback(
    (question: string, target: string | null) => {
      const text = question.trim()
      if (!text) return

      void (async () => {
        let convId = target
        try {
          if (!convId) {
            convId = await chat.createConversation()
            setActiveId(convId)
            setMessages([])
            await refreshConversations().catch(() => {})
          }
        } catch (error) {
          toast.error(message(error))
          return
        }

        // Owned by this turn, not by React state: `onInsight` needs the whole
        // log synchronously, and state updates are not readable in-flight.
        const events: ChatEvent[] = []
        const outcome: { error: string | null } = { error: null }

        // An answer emits step events in bursts — several within a frame while
        // three SQL tasks run. Appending to the array above is free; publishing
        // is what costs, because every publish re-renders the thread. So the
        // publish is coalesced to at most one per frame.
        let flushHandle: number | null = null
        const publishEvents = () => {
          flushHandle = null
          setPending((p) => (p?.convId === convId ? { ...p, events: events.slice() } : p))
        }

        // Two ways to stop waiting: the reader asks, or nothing arrives for
        // five minutes. Either way the server-side turn continues and its
        // answer is persisted; only this client detaches.
        const controller = new AbortController()
        let stopped: "user" | "timeout" | null = null
        const abort = (reason: "user" | "timeout") => {
          if (stopped) return
          stopped = reason
          controller.abort()
        }
        abortTurnRef.current = abort
        const timeout = window.setTimeout(() => abort("timeout"), TURN_TIMEOUT_MS)

        setPending({
          convId,
          question: text,
          startedAt: Date.now(),
          events,
          traceUrl: null,
          error: null,
        })

        try {
          await askQuestion(convId, text, {
            onStart: ({ traceUrl }) =>
              setPending((p) => (p?.convId === convId ? { ...p, traceUrl } : p)),
            onEvent: (event) => {
              events.push(event)
              if (flushHandle === null) flushHandle = window.requestAnimationFrame(publishEvents)
            },
            onInsight: (insight, traceUrl) => {
              // The answer is persisted either way; only merge it into the view
              // if that conversation is still the one on screen.
              if (activeIdRef.current !== convId) return
              // Both turns are written BEFORE the backend sends `insight`, so
              // re-reading the conversation is authoritative — and avoids the
              // duplicate question a local append would produce if the history
              // was refetched mid-stream (navigate away and back).
              void chat
                .getConversation(convId)
                .then(({ messages: history }) => {
                  if (activeIdRef.current !== convId) return
                  setMessages(history)
                  // Keyed against the agent turn it explains. A reload drops it
                  // — chat step events are not stored server-side.
                  // A copy: `events` keeps being appended to by this turn's
                  // stream, and state that mutates behind React's back renders
                  // stale — or changes with no re-render at all.
                  setStepLog((log) => ({
                    ...log,
                    [`${convId}#${history.length - 1}`]: events.slice(),
                  }))
                })
                .catch(() => {
                  // Re-read failed; fall back to what this turn already holds.
                  if (activeIdRef.current !== convId) return
                  const index = messagesRef.current.length + 1
                  setMessages((current) => [
                    ...current,
                    { role: "user", ts: new Date().toISOString(), text },
                    { role: "agent", ts: new Date().toISOString(), insight, traceUrl },
                  ])
                  setStepLog((log) => ({ ...log, [`${convId}#${index}`]: events.slice() }))
                })
            },
            onFailed: (error) => {
              outcome.error = error
              setPending((p) => (p?.convId === convId ? { ...p, error } : p))
            },
          }, controller.signal)
        } catch (error) {
          outcome.error =
            stopped === "timeout"
              ? "No answer after 5 minutes. The agent may still be working — reopen this conversation to pick it up."
              : stopped === "user"
                ? "Stopped listening. The answer may still land — reopen this conversation to check."
                : message(error)
          setPending((p) => (p?.convId === convId ? { ...p, error: outcome.error } : p))
        } finally {
          window.clearTimeout(timeout)
          if (flushHandle !== null) window.cancelAnimationFrame(flushHandle)
          if (abortTurnRef.current === abort) abortTurnRef.current = null
        }

        // `done` has fired — the backend always sends it, success or failure.
        setPending(null)
        if (outcome.error) {
          // Stopping on purpose is not an error worth a red toast.
          if (stopped === "user") toast(outcome.error)
          else toast.error(outcome.error)
          // The question was persisted before the agent ran, so re-read it back
          // into view rather than dropping it with the failed turn.
          if (activeIdRef.current === convId)
            void chat
              .getConversation(convId)
              .then(({ messages: history }) => {
                if (activeIdRef.current === convId) setMessages(history)
              })
              .catch(() => {})
        }
        void refreshConversations().catch(() => {})
      })()
    },
    [refreshConversations]
  )

  const send = React.useCallback(
    (question?: string) => {
      const text = (question ?? input).trim()
      if (!text || streaming) return
      setInput("")
      ask(text, activeId)
    },
    [ask, activeId, input, streaming]
  )

  const select = React.useCallback((id: string) => setActiveId(id), [])

  const newConversation = React.useCallback(() => {
    setActiveId(null)
    setMessages([])
    setInput("")
  }, [])

  const toggleStar = React.useCallback(
    (id: string) => {
      const current = conversations.find((c) => c.id === id)
      if (!current) return
      const starred = current.starred ? 0 : 1
      // Optimistic: starring writes a new ReplacingMergeTree version, and the
      // row must not flicker back while the FINAL read catches up.
      setConversations((list) => list.map((c) => (c.id === id ? { ...c, starred } : c)))
      void chat.setStarred(id, starred === 1).catch((error: unknown) => {
        toast.error(message(error))
        setConversations((list) =>
          list.map((c) => (c.id === id ? { ...c, starred: current.starred } : c))
        )
      })
    },
    [conversations]
  )

  const remove = React.useCallback(
    (id: string) => {
      if (pending?.convId === id) {
        toast("That answer is still being written — wait for it to land")
        return
      }
      if (!conversations.some((c) => c.id === id)) return
      const survivors = conversations.filter((c) => c.id !== id)

      // Optimistic: the row disappears on click. A failure re-reads the truth.
      setConversations(survivors)
      setStepLog((log) =>
        Object.fromEntries(Object.entries(log).filter(([key]) => !key.startsWith(`${id}#`)))
      )
      if (activeIdRef.current === id) {
        // Fall through to the next conversation down, then the one above it,
        // then the draft empty state — walking the order the SIDEBAR renders
        // (starred pinned on top), not the raw server order.
        const visible = [
          ...conversations.filter((c) => c.starred),
          ...conversations.filter((c) => !c.starred),
        ]
        const at = visible.findIndex((c) => c.id === id)
        const next = visible.slice(at + 1).find(Boolean) ?? visible[at - 1] ?? null
        setActiveId(next?.id ?? null)
        setMessages([])
      }

      void chat.deleteConversation(id).catch((error: unknown) => {
        toast.error(message(error))
        void refreshConversations().catch(() => {})
      })
    },
    [conversations, pending, refreshConversations]
  )

  const cancel = React.useCallback(() => {
    abortTurnRef.current?.("user")
  }, [])

  const askAbout = React.useCallback(
    (question: string) => {
      goto("chat")
      if (streaming) {
        toast("An answer is still being written — try again when it lands")
        return
      }
      setActiveId(null)
      setMessages([])
      ask(question, null)
    },
    [ask, goto, streaming]
  )


  // Memoised: a new object here re-renders every consumer — including every
  // InsightCard and Recharts chart in the thread — on each of the ~100 step
  // events an answer emits.
  const value = React.useMemo<ChatValue>(
    () => ({
      conversations,
      activeId,
      active,
      messages,
      loadingMessages,
      pending,
      streaming,
      cancel,
      suggestions,
      contextSummary,
      offline,
      input,
      setInput,
      send,
      select,
      newConversation,
      toggleStar,
      remove,
      askAbout,
      stepLog,
    }),
    [
      conversations,
      activeId,
      active,
      messages,
      loadingMessages,
      pending,
      streaming,
      cancel,
      suggestions,
      contextSummary,
      offline,
      input,
      send,
      select,
      newConversation,
      toggleStar,
      remove,
      askAbout,
      stepLog,
    ]
  )

  return <ChatContext value={value}>{children}</ChatContext>
}

export function useChat() {
  const value = React.use(ChatContext)
  if (!value) throw new Error("useChat must be used inside <ChatProvider>")
  return value
}
