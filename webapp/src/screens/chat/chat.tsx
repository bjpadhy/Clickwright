import * as React from "react"

import { api } from "@/api/client"
import type { ChatMessage } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Icon, Spinner } from "@/components/ui-kit/icon"
import { Panel } from "@/components/ui-kit/panel"
import { useConsole } from "@/state/console"
import { ConversationList } from "./conversation-list"
import { InsightCard } from "./insight-card"

const SUGGESTIONS = [
  { question: "How is Express Checkout performing since launch?", icon: "ti-bolt" },
  { question: "Where do users drop off in the funnel?", icon: "ti-filter" },
  { question: "Why do document uploads fail on mobile?", icon: "ti-file-upload" },
]

export function Chat() {
  const { server, activeConversation, chatInput, setChatInput, send } = useConsole()

  const conversation =
    server.conversations.find((c) => c.id === activeConversation) ?? server.conversations[0]

  const threadRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const el = threadRef.current
      if (el) el.scrollTop = el.scrollHeight
    }, 80)
    return () => window.clearTimeout(timer)
  }, [conversation?.messages])

  if (!conversation) return null

  return (
    <section aria-label="AI Conversation" className="flex h-full min-h-0">
      <ConversationList />

      <div className="flex min-w-0 flex-1 flex-col bg-zinc-50">
        <header className="flex shrink-0 items-center gap-2.5 border-b border-zinc-200 bg-white px-[22px] py-3">
          <span className="text-[13.5px] font-[650]">{conversation.title}</span>
          <div className="flex-1" />
        </header>

        <div ref={threadRef} className="scroll-y flex-1 p-[22px]">
          <div className="mx-auto flex max-w-[760px] flex-col gap-[18px]">
            {conversation.messages.length === 0 ? (
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
                  {SUGGESTIONS.map((suggestion) => (
                    <Button
                      key={suggestion.question}
                      variant="outline"
                      onClick={() => send(suggestion.question)}
                      className="h-auto justify-start gap-[9px] rounded-[10px] border-zinc-200 bg-white px-3.5 py-2.5 text-left text-[12.5px] font-normal text-zinc-700 hover:border-zinc-400 hover:bg-white hover:text-zinc-700"
                    >
                      <Icon name={suggestion.icon} size={15} className="text-teal" />
                      {suggestion.question}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {conversation.messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[70%] rounded-[14px_14px_4px_14px] bg-zinc-900 px-[15px] py-2.5 text-[13.5px] leading-[1.5] text-white">
                    {message.text}
                  </div>
                </div>
              ) : (
                <AgentMessage key={message.id} message={message} />
              )
            )}
          </div>
        </div>

        <div className="shrink-0 px-[22px] pt-3 pb-[18px]">
          <div className="mx-auto max-w-[760px]">
            <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white py-1.5 pr-1.5 pl-[15px] shadow-[0_1px_2px_rgba(0,0,0,.04)]">
              <Input
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") send()
                }}
                placeholder="Ask about the funnel, a feature, a segment…"
                className="h-auto flex-1 border-none bg-transparent p-0 text-[13.5px] shadow-none focus-visible:border-none focus-visible:ring-0 md:text-[13.5px]"
              />
              <Button
                onClick={() => send()}
                title="Send"
                className="size-[34px] shrink-0 rounded-[9px] bg-zinc-900 p-0 text-white hover:bg-zinc-800"
              >
                <Icon name="ti-send" size={15} />
              </Button>
            </div>
            <div className="mt-2 text-center text-[10.5px] text-zinc-400">
              Plans SQL from context v{server.contextVersion} · aggregates in ClickHouse ·
              every answer traced in Langfuse
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function AgentMessage({ message }: { message: ChatMessage }) {
  const answer = api.getAnswer(message.answerKey!)

  return (
    <div className="flex gap-[11px]">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-teal">
        <Icon name="ti-sparkles" size={14} className="text-white" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <Panel className="flex flex-col gap-[7px] rounded-[11px] px-3.5 py-[11px]">
          {answer.steps.map((step, index) => {
            const done = message.stepsDone > index
            const active = message.stepsDone === index
            return (
              <div key={step.label} className="flex items-baseline gap-[9px]">
                {done ? (
                  <Icon name="ti-check" size={13} className="translate-y-px text-teal" />
                ) : active ? (
                  <Spinner size={13} className="translate-y-px text-zinc-500" />
                ) : (
                  <Icon
                    name="ti-circle"
                    size={11}
                    className="translate-y-px text-zinc-300"
                  />
                )}
                <div className="min-w-0">
                  <span
                    className="text-[12px] font-[560]"
                    style={{ color: done || active ? "#09090b" : "#a1a1aa" }}
                  >
                    {step.label}
                  </span>
                  <span className="ml-[7px] font-mono text-[11px] text-zinc-400">
                    {done || active
                      ? step.detail.replace("{ctx}", message.contextVersion)
                      : ""}
                  </span>
                </div>
              </div>
            )
          })}
        </Panel>
        {message.revealed ? <InsightCard answer={answer} message={message} /> : null}
      </div>
    </div>
  )
}
