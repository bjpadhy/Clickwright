import { api } from "@/api/client"
import type { Conversation } from "@/api/types"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui-kit/icon"
import { iconButton } from "@/components/ui-kit/styles"
import { cn } from "@/lib/utils"
import { useConsole } from "@/state/console"

function preview(conversation: Conversation) {
  const last = conversation.messages.at(-1)
  if (!last) return "Ask anything about the data"
  if (last.role === "user") return last.text ?? ""
  return api.getAnswer(last.answerKey!).headline
}

export function ConversationList() {
  const {
    server,
    activeConversation,
    setActiveConversation,
    newConversation,
    toggleStar,
  } = useConsole()

  // Newest first, starred pinned to the top.
  const newestFirst = [...server.conversations].reverse()
  const starred = newestFirst.filter((c) => c.starred)
  const recent = newestFirst.filter((c) => !c.starred)
  const ordered = [...starred, ...recent]

  return (
    <div className="flex w-[248px] shrink-0 flex-col border-r border-zinc-200 bg-white">
      <div className="flex items-center justify-between px-3.5 pt-[13px] pb-2.5">
        <span className="text-[13px] font-[650]">Conversations</span>
        <Button
          variant="outline"
          size="icon"
          title="New conversation"
          onClick={newConversation}
          className={iconButton}
        >
          <Icon name="ti-plus" size={14} />
        </Button>
      </div>
      <div className="scroll-y flex flex-1 flex-col gap-0.5 px-2">
        {ordered.map((conversation, index) => {
          const groupLabel =
            starred.length && index === 0
              ? "STARRED"
              : starred.length && index === starred.length
                ? "RECENT"
                : ""

          return (
            <div key={conversation.id}>
              {groupLabel ? (
                <div className="px-2.5 pt-2 pb-1 text-[9.5px] font-[650] tracking-[.07em] text-zinc-400">
                  {groupLabel}
                </div>
              ) : null}
              <div className="relative">
                <Button
                  variant="ghost"
                  onClick={() => setActiveConversation(conversation.id)}
                  className={cn(
                    "h-auto w-full flex-col items-stretch gap-0 rounded-lg py-2 pr-[29px] pl-2.5 font-normal hover:bg-zinc-100",
                    conversation.id === activeConversation
                      ? "bg-zinc-100"
                      : "bg-transparent"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="flex-1 truncate text-left text-[12.5px] font-[550]">
                      {conversation.title}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-zinc-400">
                      {conversation.time}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-left text-[11px] text-zinc-400">
                    {preview(conversation)}
                  </div>
                </Button>
                {/* Sits outside the row button — nesting buttons is invalid HTML. */}
                <Button
                  variant="ghost"
                  size="icon"
                  title="Star conversation"
                  aria-pressed={conversation.starred}
                  onClick={() => toggleStar(conversation.id)}
                  className="absolute top-[7px] right-2 size-[18px] rounded-sm hover:bg-transparent"
                >
                  <Icon
                    name={conversation.starred ? "ti-star-filled" : "ti-star"}
                    size={13}
                    className={conversation.starred ? "text-sand" : "text-zinc-300"}
                  />
                </Button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
