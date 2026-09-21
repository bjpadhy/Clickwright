import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The one thing hooks cannot do: catch a render error.
 *
 * The app is code-split — the chart canvas and both Instrumentation screens
 * are their own chunks — and a split point is a fetch that can fail on its
 * own: a deploy retires the hashed chunk an open tab still points at, a tunnel
 * drops mid-request. Uncaught, React unmounts the entire root, nav rail
 * included, and `React.lazy` remembers the rejection, so every later render
 * throws again and only a reload recovers.
 *
 * So every Suspense boundary is paired with one of these, and the root has one
 * as a backstop. A lost chunk costs its own region of the screen and nothing
 * else.
 */

export interface FallbackProps {
  error: unknown
  /** drop the error and render the children again */
  reset: () => void
}

interface ErrorBoundaryProps {
  children: React.ReactNode
  /**
   * Rendered in place of the children once one of them has thrown. Defaults to
   * a readable panel with Try again / Reload.
   */
  fallback?: (props: FallbackProps) => React.ReactNode
  /**
   * Any value: changing it clears a caught error and re-renders the children.
   * Callers that can rebuild what failed — a fresh `React.lazy`, which never
   * retries a rejected `import()` on its own — bump it to offer a retry that
   * costs less than a full page reload.
   */
  resetKey?: unknown
}

interface ErrorBoundaryState {
  error: unknown
  resetKey: unknown
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { error: null, resetKey: props.resetKey }
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error }
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState
  ): Partial<ErrorBoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null
    return { error: null, resetKey: props.resetKey }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // React swallows the throw once a boundary handles it — keep the trace.
    console.error("Render error caught by <ErrorBoundary>", error, info.componentStack)
  }

  reset = () => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    if (this.state.error === null) return this.props.children
    const fallback = this.props.fallback ?? defaultFallback
    return fallback({ error: this.state.error, reset: this.reset })
  }
}

const defaultFallback = (props: FallbackProps) => <ErrorPanel {...props} />

/** Why something is missing, and the two ways out of it. */
export function ErrorPanel({
  error,
  reset,
  className,
}: FallbackProps & { className?: string }) {
  return (
    <div
      role="alert"
      className={cn("flex min-h-0 flex-1 items-center justify-center p-6", className)}
    >
      <div className="max-w-[420px] rounded-xl border border-zinc-200 bg-white px-5 py-[18px] text-center">
        <div className="text-[13px] font-semibold text-zinc-900">
          This view failed to load
        </div>
        <div className="mt-1 text-[12px] leading-[1.6] text-zinc-500">
          Usually a network blip, or a new version of the app being deployed while
          this tab was open.
        </div>
        <div className="mt-2 font-mono text-[10.5px] break-words text-zinc-400">
          {describe(error)}
        </div>
        <div className="mt-3.5 flex justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-[33px] items-center gap-[7px] rounded-lg border border-zinc-200 bg-white px-[13px] text-[12.5px] font-[550] text-zinc-900 hover:border-zinc-900"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex h-[33px] items-center gap-[7px] rounded-lg bg-zinc-900 px-[13px] text-[12.5px] font-[550] text-white hover:bg-zinc-800"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  )
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
