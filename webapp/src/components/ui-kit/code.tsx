import * as React from "react"

import { cn } from "@/lib/utils"

/** Near-black code surface used for DDL, execution output and generated SQL. */
export function CodeSurface({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("overflow-auto bg-code px-4 py-3.5", className)} {...props} />
}

/**
 * DDL rendered line by line so trailing `--` comments can be dimmed without a
 * syntax-highlighting dependency.
 *
 * `pre-wrap`, not `pre`: the agent's own formatting is preserved, but a table
 * that comes back as one long `CREATE TABLE …` line wraps instead of running
 * off into a horizontal scrollbar the reviewer has to drag through.
 */
export function DdlBlock({ ddl, className }: { ddl: string; className?: string }) {
  const lines = React.useMemo(() => splitDdl(ddl), [ddl])

  return (
    <CodeSurface className={cn("overflow-x-hidden rounded-[10px]", className)}>
      {lines.map((line, index) => (
        <div
          key={index}
          className="font-mono text-[11.5px] leading-[1.68] break-words whitespace-pre-wrap"
        >
          <span className="text-zinc-200">{line.code}</span>
          <span className="text-gray-500">{line.comment}</span>
        </div>
      ))}
    </CodeSurface>
  )
}

export function splitDdl(ddl: string) {
  return ddl.split("\n").map((line) => {
    const at = line.indexOf("--")
    return at >= 0
      ? { code: line.slice(0, at), comment: line.slice(at) }
      : { code: line, comment: "" }
  })
}
