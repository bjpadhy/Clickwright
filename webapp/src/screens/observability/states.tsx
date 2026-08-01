/**
 * Shared loading / error / unavailable affordances for the Observability tabs.
 *
 * The distinction that matters here: an *error* means we could not reach the
 * backend, while *unavailable* means the backend answered honestly that a
 * measurement does not exist. Rendering the second as a zero would be inventing
 * data on an observability screen, which is worse than showing a gap.
 */

import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui-kit/icon"

export function LoadError({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3">
      <Icon name="ti-plug-connected-x" size={16} className="shrink-0 text-orange-700" />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold text-orange-900">
          Could not reach the backend
        </div>
        <div className="mt-0.5 font-mono text-[11px] break-words text-orange-800">
          {message}
        </div>
      </div>
      {onRetry ? (
        <Button
          variant="outline"
          onClick={onRetry}
          className="h-7 shrink-0 gap-1.5 border-orange-300 bg-white px-2.5 text-[11.5px] text-orange-900 hover:bg-orange-100"
        >
          <Icon name="ti-refresh" size={13} />
          Retry
        </Button>
      ) : null}
    </div>
  )
}

/** The backend reached us but says this measurement is not available. */
export function UnavailableNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-[11.5px] leading-[1.5] text-zinc-500">
      <Icon name="ti-info-circle" size={14} className="mt-px shrink-0 text-zinc-400" />
      <span>{children}</span>
    </div>
  )
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-8 text-center text-[12px] text-zinc-400">{children}</div>
  )
}
