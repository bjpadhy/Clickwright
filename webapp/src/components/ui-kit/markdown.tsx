import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The agent writes markdown (DDL rationale, context definitions) and we render
 * the four things it actually uses — headings, bullets, bold, inline code —
 * rather than pulling in a parser for prose we control the shape of.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = React.useMemo(() => parse(text), [text])

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {blocks.map((block, index) =>
        block.kind === "heading" ? (
          <div
            key={index}
            className="mt-1.5 text-[10.5px] font-[650] tracking-[.07em] text-zinc-400 uppercase first:mt-0"
          >
            {block.text}
          </div>
        ) : block.kind === "bullet" ? (
          <div key={index} className="flex gap-2 text-[12px] leading-[1.6] text-zinc-700">
            <span className="text-zinc-300">•</span>
            <span>{inline(block.text)}</span>
          </div>
        ) : (
          <p key={index} className="text-[12px] leading-[1.6] text-zinc-700">
            {inline(block.text)}
          </p>
        )
      )}
    </div>
  )
}

type Block = { kind: "heading" | "bullet" | "paragraph"; text: string }

function parse(text: string): Block[] {
  const blocks: Block[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: "heading", text: heading[1]! })
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      blocks.push({ kind: "bullet", text: bullet[1]! })
      continue
    }
    const previous = blocks.at(-1)
    // Wrapped prose belongs to the paragraph above it.
    if (previous?.kind === "paragraph") previous.text += ` ${line}`
    else blocks.push({ kind: "paragraph", text: line })
  }
  return blocks
}

/** `**bold**` and `` `code` `` — the only inline markers the prompts produce. */
function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**"))
      return (
        <b key={index} className="font-semibold text-zinc-900">
          {part.slice(2, -2)}
        </b>
      )
    if (part.startsWith("`") && part.endsWith("`"))
      return (
        <code
          key={index}
          className="rounded-[5px] bg-zinc-100 px-1 py-px font-mono text-[11px] text-zinc-800"
        >
          {part.slice(1, -1)}
        </code>
      )
    return part
  })
}
