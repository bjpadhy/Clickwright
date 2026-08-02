/**
 * PDF export — a visual duplicate of a whole conversation.
 *
 * The document is built from the SAME components the screen uses (`InsightCard`,
 * `InsightChart`), rendered into a portal at a fixed page width, and handed to
 * the browser's print pipeline. Two consequences are the reason for doing it
 * this way rather than drawing a PDF by hand:
 *
 *   - it cannot drift from the UI. Anything added to an insight card shows up in
 *     the export with no second implementation to keep in step.
 *   - text and charts stay vectors, so the PDF is selectable, searchable and
 *     sharp at any zoom. A canvas-rasterising exporter would also choke on the
 *     `oklch()` colours Tailwind v4 emits.
 *
 * Interactions do not survive onto paper, so the card's `print` mode lays out
 * what a toggle would otherwise hide: chart AND table together, SQL expanded.
 */
import * as React from "react"
import { createPortal } from "react-dom"

import type { ChatMessage } from "@/api/chat"
import { InsightCard } from "./insight-card"

/** Chrome needs a frame or two after mount to lay out and paint the charts. */
const PAINT_DELAY_MS = 350

function formatStamp(ts: string): string {
  // ClickHouse hands back "YYYY-MM-DD HH:MM:SS.mmm" in UTC, which `Date` will
  // read as local time unless it is told otherwise.
  const parsed = new Date(ts.replace(" ", "T") + (ts.endsWith("Z") ? "" : "Z"))
  if (Number.isNaN(parsed.getTime())) return ts
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

export interface ConversationPdfProps {
  title: string
  messages: ChatMessage[]
  contextSummary?: string
  /** Called once the print dialog has been dismissed, however it ended. */
  onDone: () => void
}

/**
 * Renders the conversation off-screen, waits for charts to paint, then opens the
 * print dialog. Mount this only while an export is in flight.
 */
export function ConversationPdf({
  title,
  messages,
  contextSummary,
  onDone,
}: ConversationPdfProps) {
  const doneRef = React.useRef(onDone)
  doneRef.current = onDone

  React.useEffect(() => {
    let cancelled = false
    // `afterprint` is the only signal that covers both "saved" and "cancelled";
    // there is deliberately no way to tell those apart, so the caller is simply
    // told the export finished.
    const finish = () => {
      if (cancelled) return
      cancelled = true
      doneRef.current()
    }
    window.addEventListener("afterprint", finish)

    const timer = window.setTimeout(() => {
      if (cancelled) return
      window.print()
      // Safari fires no `afterprint` at all, so release the export regardless.
      window.setTimeout(finish, 800)
    }, PAINT_DELAY_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.removeEventListener("afterprint", finish)
    }
  }, [])

  const answered = messages.filter((m) => m.role === "agent" && m.insight).length

  return createPortal(
    <div id="print-root" className="bg-white font-sans text-zinc-900">
      <header className="print-block mb-4 border-b border-zinc-200 pb-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-bold tracking-[.08em] text-teal">CLICKWRIGHT</span>
          <span className="text-[10px] tracking-[.04em] text-zinc-400">ANALYTICS CONVERSATION</span>
        </div>
        <h1 className="mt-1.5 text-[19px] leading-[1.25] font-[650] tracking-[-.01em]">{title}</h1>
        <div className="mt-1.5 text-[10.5px] text-zinc-500">
          {answered} answer{answered === 1 ? "" : "s"}
          {contextSummary ? ` · ${contextSummary}` : ""} · exported{" "}
          {new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </div>
      </header>

      {/* Block flow, not flex: a flex column that spans a page boundary makes
          Chrome push whole children to the next page and leave the rest of the
          current one blank. `space-y` is margins on block siblings, which
          paginates the way running text does. */}
      <div className="space-y-4">
        {messages.map((message, index) =>
          message.role === "user" ? (
            // A question is short, so it is kept whole — and `print-keep-next`
            // stops it being stranded at the foot of a page without its answer.
            <div key={`${index}-${message.ts}`} className="print-block print-keep-next">
              <div className="mb-1 text-[9.5px] font-bold tracking-[.06em] text-zinc-400">
                QUESTION · {formatStamp(message.ts)}
              </div>
              {/* The screen bubble is right-aligned and dark; on paper that wastes
                  a third of the width and a lot of toner, so the question keeps
                  its emphasis through weight and a rule instead. */}
              <div className="border-l-[3px] border-zinc-900 py-0.5 pl-3 text-[13.5px] leading-[1.5] font-[600]">
                {message.text}
              </div>
            </div>
          ) : (
            // The answer itself may run over a page boundary — see the Panel in
            // insight-card. Only its label is pinned to what follows.
            <div key={`${index}-${message.ts}`}>
              <div className="print-keep-next mb-1 text-[9.5px] font-bold tracking-[.06em] text-teal">
                ANSWER · {formatStamp(message.ts)}
              </div>
              {message.insight ? (
                <InsightCard insight={message.insight} print />
              ) : (
                <div className="rounded-[10px] border border-zinc-200 px-3.5 py-2.5 text-[12.5px] text-zinc-500">
                  This answer could not be produced.
                </div>
              )}
            </div>
          )
        )}
      </div>

      <footer className="mt-6 border-t border-zinc-200 pt-2.5 text-[9.5px] leading-[1.6] text-zinc-400">
        Every figure in this document was produced by SQL run against ClickHouse and
        checked against its result set. The queries behind each answer are printed with it.
      </footer>
    </div>,
    document.body
  )
}
