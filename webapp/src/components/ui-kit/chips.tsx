import * as React from "react"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Icon } from "./icon"

/** Rounded status pill — "Live", "dry-run passed", agent + trace status tags. */
export function StatusPill({
  className,
  style,
  ...props
}: React.ComponentProps<typeof Badge>) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-auto rounded-full border-transparent px-2 py-[2.5px] text-[10.5px] leading-normal font-semibold",
        className
      )}
      style={style}
      {...props}
    />
  )
}

/** Boxed monospace chip, e.g. `specs/express_checkout.md` or `base_context v1.3`. */
export function MonoChip({
  icon,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Badge> & { icon?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-auto gap-1.5 rounded-[7px] border-zinc-200 bg-white px-[9px] py-[3px] font-mono text-[11px] leading-normal font-normal text-zinc-700",
        className
      )}
      {...props}
    >
      {icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </Badge>
  )
}

/** Clickable `tr_xx_1234` capsule that opens the trace in Langfuse. */
export function TraceChip({
  traceId,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { traceId: string }) {
  return (
    <Button
      variant="outline"
      title={`Open trace ${traceId}`}
      className={cn(
        "h-auto shrink-0 gap-[5px] rounded-full border-zinc-200 bg-transparent px-[9px] py-[3px] font-mono text-[11px] font-normal text-zinc-600",
        "hover:border-zinc-400 hover:bg-transparent hover:text-zinc-600",
        className
      )}
      {...props}
    >
      <Icon name="ti-route" size={12} />
      {traceId}
    </Button>
  )
}
