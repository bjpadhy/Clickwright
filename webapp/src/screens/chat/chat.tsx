import * as React from "react"

import type { ChatEvent, ChatMessage } from "@/api/chat"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Icon, Spinner } from "@/components/ui-kit/icon"
import { Panel } from "@/components/ui-kit/panel"
import { capsuleButton } from "@/components/ui-kit/styles"
import { useChat } from "@/state/chat"
import { AgentSteps } from "./agent-steps"
import { ConversationList } from "./conversation-list"
import { ConversationPdf } from "./conversation-pdf"
import { InsightCard } from "./insight-card"

/** Shown when no spec has been instrumented yet, so `/api/suggestions` is empty. */
const FALLBACK_SUGGESTIONS = [
  "Where do users drop off in the funnel?",
  "Which segment converts worst, and why?",
]

const CHIP_ICONS = ["ti-bolt", "ti-filter", "ti-users", "ti-chart-arrows-vertical"]

export function Chat() {
  const {
    activeId,
    active,
    messages,
    loadingMessages,
    pending,
    streaming,
    suggestions,
    contextSummary,
    offline,
    input,
    setInput,
    send,
    stepLog,
  } = useChat()

  // Mounted only while an export is in flight — it renders the whole
  // conversation off-screen and opens the print dialog.
  const [exporting, setExporting] = React.useState(false)

  const threadRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const el = threadRef.current
      if (el) el.scrollTop = el.scrollHeight
    }, 80)
    return () => window.clearTimeout(timer)
  }, [messages, pending?.events.length])

  // Only the conversation on screen shows its own in-flight turn; an answer you
  // navigated away from keeps streaming and lands in its own conversation.
  const liveTurn = pending && pending.convId === activeId ? pending : null
  // The backend persists the question as soon as the stream opens, so leaving
  // this conversation and coming back mid-answer brings it into `messages` —
  // render the bubble once, not twice.
  const last = messages.at(-1)
  const questionAlreadyShown =
    !!liveTurn && last?.role === "user" && last.text === liveTurn.question
  const chips = suggestions.length
    ? suggestions.slice(0, 4).map((s) => s.question)
    : FALLBACK_SUGGESTIONS
  const empty = messages.length === 0 && !liveTurn && !loadingMessages

  return (
    <section aria-label="AI Conversation" className="flex h-full min-h-0">
      <ConversationList />

      <div className="flex min-w-0 flex-1 flex-col bg-zinc-50">
        <header className="flex shrink-0 items-center gap-2.5 border-b border-zinc-200 bg-white px-[22px] py-3">
          <span className="text-[13.5px] font-[650]">
            {active?.title ?? "New conversation"}
          </span>
          <div className="flex-1" />
          {offline ? (
            <span className="inline-flex items-center gap-[5px] text-[11px] text-[#a03c22]">
              <Icon name="ti-plug-connected-x" size={13} />
              backend unreachable — {offline}
            </span>
          ) : null}
          {messages.length > 0 ? (
            <Button
              variant="outline"
              // Exporting mid-answer would print a turn that is still being
              // written, so the button waits for the stream to finish.
              disabled={exporting || streaming || loadingMessages}
              onClick={() => setExporting(true)}
              title="Export this conversation as a PDF"
              className={capsuleButton}
            >
              {exporting ? <Spinner size={12} /> : <Icon name="ti-file-type-pdf" size={13} />}
              {exporting ? "Preparing…" : "Export PDF"}
            </Button>
          ) : null}
        </header>

        <div ref={threadRef} className="scroll-y flex-1 p-[22px]">
          <div className="mx-auto flex max-w-[760px] flex-col gap-[18px]">
            {empty ? (
              <div className="flex flex-col items-center px-5 pt-[60px] pb-[30px] text-center">
                <div className="flex size-11 items-center justify-center rounded-full bg-teal">
                  <Icon name="ti-sparkles" size={21} className="text-white" />
                </div>
                <div className="mt-3.5 text-[16px] font-[650]">Ask the Analytics Agent</div>
                <div className="mt-[5px] max-w-[440px] text-[12.5px] leading-[1.6] text-zinc-500">
                  Natural language in → context-grounded SQL on ClickHouse → an insight that
                  carries the <i>why</i>. Aggregation happens in the database; the LLM never
                  fetches raw rows.
                </div>
                <div className="mt-5 flex w-full max-w-[460px] flex-col gap-2">
                  {chips.map((question, index) => (
                    <Button
                      key={question}
                      variant="outline"
                      disabled={streaming}
                      onClick={() => send(question)}
                      className="h-auto justify-start gap-[9px] rounded-[10px] border-zinc-200 bg-white px-3.5 py-2.5 text-left text-[12.5px] font-normal text-zinc-700 hover:border-zinc-400 hover:bg-white hover:text-zinc-700"
                    >
                      <Icon
                        name={CHIP_ICONS[index % CHIP_ICONS.length]!}
                        size={15}
                        className="shrink-0 text-teal"
                      />
                      <span className="min-w-0 flex-1 whitespace-normal">{question}</span>
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {loadingMessages ? (
              <div className="flex items-center justify-center gap-[9px] py-10 text-zinc-500">
                <Spinner size={14} />
                <span className="text-[12px]">loading the conversation…</span>
              </div>
            ) : null}

            {messages.map((message, index) =>
              message.role === "user" ? (
                <UserBubble key={`${index}-${message.ts}`} text={message.text ?? ""} />
              ) : (
                <AgentTurn
                  key={`${index}-${message.ts}`}
                  message={message}
                  events={stepLog[`${activeId}#${index}`]}
                />
              )
            )}

            {liveTurn ? (
              <>
                {questionAlreadyShown ? null : <UserBubble text={liveTurn.question} />}
                <div className="flex gap-[11px]">
                  <AgentAvatar />
                  <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                    <AgentSteps
                      events={liveTurn.events}
                      running={!liveTurn.error}
                      startedAt={liveTurn.startedAt}
                    />
                    {liveTurn.error ? (
                      <Panel className="border-[#f3c6b8] bg-[#fdeae4] px-3.5 py-[11px]">
                        <div className="text-[12.5px] leading-[1.6] text-[#a03c22]">
                          {liveTurn.error}
                        </div>
                      </Panel>
                    ) : null}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="shrink-0 px-[22px] pt-3 pb-[18px]">
          <div className="mx-auto max-w-[760px]">
            <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white py-1.5 pr-1.5 pl-[15px] shadow-[0_1px_2px_rgba(0,0,0,.04)]">
              <Input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !streaming) send()
                }}
                placeholder={
                  streaming ? "Writing the answer…" : "Ask about the funnel, a feature, a segment…"
                }
                className="h-auto flex-1 border-none bg-transparent p-0 text-[13.5px] shadow-none focus-visible:border-none focus-visible:ring-0 md:text-[13.5px]"
              />
              <Button
                onClick={() => send()}
                disabled={streaming || !input.trim()}
                title="Send"
                className="size-[34px] shrink-0 rounded-[9px] bg-zinc-900 p-0 text-white hover:bg-zinc-800"
              >
                {streaming ? <Spinner size={15} /> : <Icon name="ti-send" size={15} />}
              </Button>
            </div>
            <div className="mt-2 text-center text-[10.5px] text-zinc-400">
              {contextSummary ? `Plans SQL from context · ${contextSummary}` : "Plans SQL from the context store"}{" "}
              · aggregates in ClickHouse · read-only · every answer traced in Langfuse
            </div>
          </div>
        </div>
      </div>

      {exporting ? (
        <ConversationPdf
          title={active?.title ?? "Conversation"}
          messages={messages}
          contextSummary={contextSummary}
          onDone={() => setExporting(false)}
        />
      ) : null}
    </section>
  )
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[70%] rounded-[14px_14px_4px_14px] bg-zinc-900 px-[15px] py-2.5 text-[13.5px] leading-[1.5] text-white">
        {text}
      </div>
    </div>
  )
}

function AgentAvatar() {
  return (
    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-teal">
      <Icon name="ti-sparkles" size={14} className="text-white" />
    </div>
  )
}

function AgentTurn({ message, events }: { message: ChatMessage; events?: ChatEvent[] }) {
  return (
    <div className="flex gap-[11px]">
      <AgentAvatar />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {message.insight ? (
          <InsightCard insight={message.insight} traceUrl={message.traceUrl} />
        ) : (
          <Panel className="px-3.5 py-[11px]">
            <div className="text-[12.5px] text-zinc-500">
              This answer could not be produced. Ask again — the failure is in the trace.
            </div>
          </Panel>
        )}
        {events?.length ? (
          <AgentSteps events={events} running={false} startedAt={events[0]!.at} collapsible />
        ) : null}
      </div>
    </div>
  )
}
