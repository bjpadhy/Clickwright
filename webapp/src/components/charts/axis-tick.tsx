const MONO = "'Geist Mono', ui-monospace, monospace"

interface TickProps {
  x?: string | number
  y?: string | number
  payload?: { value?: string | number }
}

/**
 * Custom category tick for horizontal bar charts.
 *
 * Recharts anchors ticks to the axis line: a left axis hands you its right
 * edge, a right axis its left edge. `dx` shifts from there so a value column
 * can be right-aligned against its far edge.
 */
export function makeCategoryTick({
  text = (value: string) => value,
  anchor,
  dx = 0,
  fontSize,
  fill,
  mono = true,
}: {
  text?: (value: string) => string
  anchor: "start" | "end"
  dx?: number
  fontSize: number
  fill: string
  mono?: boolean
}) {
  return function CategoryTick({ x = 0, y = 0, payload }: TickProps) {
    return (
      <text
        x={Number(x) + dx}
        y={Number(y)}
        dy={fontSize * 0.36}
        textAnchor={anchor}
        fontSize={fontSize}
        fontFamily={mono ? MONO : undefined}
        fill={fill}
      >
        {text(String(payload?.value ?? ""))}
      </text>
    )
  }
}
