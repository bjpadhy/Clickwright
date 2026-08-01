import * as React from "react"

import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader } from "@/components/ui/card"

/**
 * The white surface every screen is built from: 1px zinc-200 hairline, 12px
 * radius, no shadow, no intrinsic padding.
 */
export function Panel({ className, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        "gap-0 rounded-xl border border-zinc-200 bg-white py-0 text-zinc-950 ring-0",
        className
      )}
      {...props}
    />
  )
}

/** Icon + title strip with the inner zinc-100 divider. */
export function PanelHeader({
  className,
  ...props
}: React.ComponentProps<typeof CardHeader>) {
  return (
    <CardHeader
      className={cn(
        "flex flex-row items-center gap-2 border-b border-zinc-100 px-4 py-3",
        className
      )}
      {...props}
    />
  )
}

export function PanelBody({
  className,
  ...props
}: React.ComponentProps<typeof CardContent>) {
  return <CardContent className={cn("px-4 py-3", className)} {...props} />
}

/** Full-height screen with a sticky header strip. */
export function Screen({
  label,
  className,
  ...props
}: React.ComponentProps<"section"> & { label: string }) {
  return (
    <section
      aria-label={label}
      className={cn("flex h-full min-h-0 flex-col", className)}
      {...props}
    />
  )
}

export function ScreenHeader({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children?: React.ReactNode
}) {
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-6 py-[11px]">
      <div>
        <div className="text-[15px] font-[650] tracking-[-.01em]">{title}</div>
        <div className="mt-px text-[11.5px] text-zinc-500">{subtitle}</div>
      </div>
      {children}
    </header>
  )
}
