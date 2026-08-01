import * as React from "react"

import type { ConversationSummary } from "@/api/chat"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui-kit/icon"
import { iconButton } from "@/components/ui-kit/styles"
import { cn } from "@/lib/utils"
import { useChat } from "@/state/chat"

/**
 * ClickHouse hands back "YYYY-MM-DD HH:MM:SS.mmm" in UTC with no zone marker,
 * which `Date.parse` would read as local time — hence the explicit `Z`.
 */
function parseServerTime(value: string): number {
  return Date.parse(`${value.replace(" ", "T")}Z`)
}

function relativeTime(value: string): string {
  const at = parseServerTime(value)
  if (!Number.isFinite(at)) return ""
  const seconds = Math.max(0, (Date.now() - at) / 1000)
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function ConversationList() {
  const { conversations, activeId, select, newConversation, toggleStar, remove, streaming } =
    useChat()

  // Deleting is irreversible, so the trash icon arms an inline confirm rather
  // than acting on the first click. Only one row can be armed at a time.
  const [confirming, setConfirming] = React.useState<string | null>(null)

  // The backend already returns newest first; starred are pinned above the rest.
  const starred = conversations.filter((c) => c.starred)
  const recent = conversations.filter((c) => !c.starred)
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
      <div className="scroll-y flex flex-1 flex-col gap-0.5 px-2 pb-2">
        {activeId === null ? (
          <Row
            conversation={{
              id: "",
              title: "New conversation",
              starred: 0,
              updatedAt: "",
              preview: "Ask anything about the data",
              messages: 0,
            }}
            active
            draft
            onSelect={() => {}}
            onStar={() => {}}
            onDelete={() => {}}
          />
        ) : null}

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
              {confirming === conversation.id ? (
                <DeleteConfirm
                  title={conversation.title}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => {
                    setConfirming(null)
                    remove(conversation.id)
                  }}
                />
              ) : (
                <Row
                  conversation={conversation}
                  active={conversation.id === activeId}
                  onSelect={() => !streaming && select(conversation.id)}
                  onStar={() => toggleStar(conversation.id)}
                  onDelete={() => setConfirming(conversation.id)}
                />
              )}
            </div>
          )
        })}

        {conversations.length === 0 && activeId !== null ? (
          <div className="px-2.5 py-3 text-[11px] leading-[1.6] text-zinc-400">
            No conversations yet — ask a question to start one.
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Row({
  conversation,
  active,
  draft = false,
  onSelect,
  onStar,
  onDelete,
}: {
  conversation: ConversationSummary
  active: boolean
  draft?: boolean
  onSelect: () => void
  onStar: () => void
  onDelete: () => void
}) {
  return (
    <div className="group relative">
      <Button
        variant="ghost"
        onClick={onSelect}
        className={cn(
          "h-auto w-full flex-col items-stretch gap-0 rounded-lg py-2 pr-[52px] pl-2.5 font-normal hover:bg-zinc-100",
          active ? "bg-zinc-100" : "bg-transparent"
        )}
      >
        <div className="flex items-center gap-1.5">
          <span className="flex-1 truncate text-left text-[12.5px] font-[550]">
            {conversation.title}
          </span>
        </div>
        <div className="mt-0.5 truncate text-left text-[11px] text-zinc-400">
          {conversation.preview || "Ask anything about the data"}
        </div>
      </Button>

      {/* Sits outside the row button — nesting buttons is invalid HTML. */}
      <div className="absolute top-[6px] right-2 flex items-center gap-0.5">
        {draft ? (
          <span className="font-mono text-[10px] text-zinc-400">draft</span>
        ) : (
          <>
            {/* The timestamp yields to the actions on hover — the row is only
                248px wide and both cannot sit there at once. */}
            <span className="font-mono text-[10px] text-zinc-400 group-hover:hidden">
              {relativeTime(conversation.updatedAt)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              title="Star conversation"
              aria-pressed={conversation.starred === 1}
              onClick={onStar}
              className={cn(
                "size-[18px] rounded-sm hover:bg-transparent",
                conversation.starred ? "" : "hidden group-hover:inline-flex"
              )}
            >
              <Icon
                name={conversation.starred ? "ti-star-filled" : "ti-star"}
                size={13}
                className={conversation.starred ? "text-sand" : "text-zinc-400"}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Delete conversation"
              onClick={onDelete}
              className="hidden size-[18px] rounded-sm text-zinc-400 hover:bg-transparent hover:text-coral group-hover:inline-flex"
            >
              <Icon name="ti-trash" size={13} />
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/** Replaces the row in place — no modal, and no chance of hitting the wrong one. */
function DeleteConfirm({
  title,
  onCancel,
  onConfirm,
}: {
  title: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="rounded-lg border border-coral/40 bg-coral/5 px-2.5 py-2">
      <div className="truncate text-[11px] text-zinc-600">
        Delete “<span className="font-[550] text-zinc-900">{title}</span>”?
      </div>
      <div className="mt-0.5 text-[10.5px] text-zinc-500">
        Its questions and answers are removed for good.
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <Button
          variant="ghost"
          onClick={onConfirm}
          className="h-[22px] rounded-md bg-coral px-2 text-[11px] font-[550] text-white hover:bg-coral/90 hover:text-white"
        >
          Delete
        </Button>
        <Button
          variant="ghost"
          onClick={onCancel}
          className="h-[22px] rounded-md px-2 text-[11px] font-normal text-zinc-600 hover:bg-white"
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
