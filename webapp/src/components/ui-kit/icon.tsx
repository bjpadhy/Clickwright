import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Tabler icon webfont glyph. The design sizes icons in exact px (13, 15, 19…),
 * so size is a number rather than a Tailwind scale step.
 */
export function Icon({
  name,
  size,
  className,
  style,
  ...props
}: React.ComponentProps<"i"> & { name: string; size: number }) {
  return (
    <i
      aria-hidden="true"
      className={cn("ti", name, className)}
      style={{ fontSize: size, ...style }}
      {...props}
    />
  )
}

/** The spinner used throughout the pipeline and chat plan steps. */
export function Spinner({
  size,
  className,
  ...props
}: React.ComponentProps<"i"> & { size: number }) {
  return (
    <Icon
      name="ti-loader-2"
      size={size}
      className={cn("animate-spin-fast", className)}
      {...props}
    />
  )
}
