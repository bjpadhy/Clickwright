import * as React from "react"

import { cn } from "@/lib/utils"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"

/* ── Screen-level segmented control ────────────────────────────────────── */

export function SegmentedTabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      className={cn("h-auto w-fit rounded-[9px] bg-zinc-100 p-[3px]", className)}
      {...props}
    />
  )
}

export function SegmentedTab({
  className,
  ...props
}: React.ComponentProps<typeof TabsTrigger>) {
  return (
    <TabsTrigger
      className={cn(
        "h-auto flex-none rounded-[7px] px-[14px] py-[6px] text-[12.5px] font-[550] text-zinc-500",
        "hover:text-zinc-950 data-active:bg-white data-active:text-zinc-950",
        "data-active:shadow-[0_1px_2px_rgba(0,0,0,.07)]",
        className
      )}
      {...props}
    />
  )
}

/* ── Inline segmented control on a zinc-100 track ──────────────────────── */

/** Single-select toggle group: `type` is fixed, so callers never pass it. */
type SingleSelectProps = Omit<
  React.ComponentProps<typeof ToggleGroup>,
  "type" | "value" | "defaultValue" | "onValueChange"
> & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
}

export function Segmented({ className, onValueChange, ...props }: SingleSelectProps) {
  return (
    <ToggleGroup
      {...props}
      type="single"
      className={cn("gap-0 rounded-lg bg-zinc-100 p-[2.5px]", className)}
      // a segmented control always keeps exactly one selection
      onValueChange={(value: string) => {
        if (value) onValueChange?.(value)
      }}
    />
  )
}

export function SegmentedItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupItem>) {
  return (
    <ToggleGroupItem
      className={cn(
        "h-auto min-w-0 rounded-md px-[11px] py-1 text-[11px] font-semibold text-zinc-500",
        "hover:bg-transparent hover:text-zinc-950",
        "data-[state=on]:bg-white data-[state=on]:text-zinc-950",
        "data-[state=on]:shadow-[0_1px_2px_rgba(0,0,0,.07)]",
        className
      )}
      {...props}
    />
  )
}

/** Square icon segment used by the bars / line chart switches. */
export function SegmentedIcon({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupItem>) {
  return (
    <SegmentedItem
      className={cn("h-6 w-7 rounded-md p-0", className)}
      {...props}
    />
  )
}

/* ── Outline filter pills ──────────────────────────────────────────────── */

export function FilterPills({ className, onValueChange, ...props }: SingleSelectProps) {
  return (
    <ToggleGroup
      {...props}
      type="single"
      className={cn("gap-2", className)}
      onValueChange={(value: string) => {
        if (value) onValueChange?.(value)
      }}
    />
  )
}

export function FilterPill({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupItem>) {
  return (
    <ToggleGroupItem
      className={cn(
        "h-auto min-w-0 rounded-full border border-zinc-200 bg-white px-[11px] py-[4.5px]",
        "text-[11.5px] font-[550] text-zinc-600 hover:bg-white hover:text-zinc-950",
        "data-[state=on]:border-zinc-900 data-[state=on]:bg-zinc-900 data-[state=on]:text-white",
        className
      )}
      {...props}
    />
  )
}
