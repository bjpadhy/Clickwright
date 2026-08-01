/**
 * Button metrics from the design, applied on top of shadcn's `<Button>`.
 * Kept here rather than as extra cva variants so `button.tsx` stays a stock
 * shadcn file that `shadcn diff` can still update.
 */

/** 35px primary — "Run Instrumentation Agent". */
export const solidButton =
  "h-[35px] gap-[7px] rounded-lg bg-zinc-900 px-[15px] text-[13px] font-[550] text-white hover:bg-zinc-800"

/** 34px primary — approval gate, empty-state CTAs. */
export const solidButtonMd =
  "h-[34px] gap-[7px] rounded-lg bg-zinc-900 px-[14px] text-[12.5px] font-[550] text-white hover:bg-zinc-800"

/** 33px primary — screen header actions. */
export const solidButtonSm =
  "h-[33px] gap-[7px] rounded-lg bg-zinc-900 px-[13px] text-[12.5px] font-[550] text-white hover:bg-zinc-800"

/** 34px outline — "Request changes". */
export const outlineButtonMd =
  "h-[34px] gap-[7px] rounded-lg border-zinc-200 bg-white px-[14px] text-[12.5px] font-[550] text-zinc-900 hover:bg-zinc-50 hover:text-zinc-900"

/** 33px outline — "Refresh", "Ask about it". */
export const outlineButtonSm =
  "h-[33px] gap-[7px] rounded-lg border-zinc-200 bg-white px-[13px] text-[12.5px] font-[550] text-zinc-900 hover:border-zinc-900 hover:bg-white hover:text-zinc-900"

/** 28px square outline — "＋" affordances in the Boards / Conversations lists. */
export const iconButton =
  "size-7 rounded-lg border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 hover:text-zinc-700"

/** Borderless capsule that reads as a link — "SQL", "Save to dashboard". */
export const capsuleButton =
  "h-auto gap-[5px] rounded-full border-zinc-200 bg-transparent px-[9px] py-[3px] text-[10.5px] font-normal text-zinc-600 hover:border-zinc-400 hover:bg-transparent hover:text-zinc-600"
