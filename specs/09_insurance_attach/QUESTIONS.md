# Eval script — 09_insurance_attach

Chat questions for the analytics agent, keyed to the traps in `EXPECTED.md`.
Ask the opener, then the follow-ups **in order**.

This spec's hard part is **context**, so Thread C is the one that separates a good run
from a lucky one.

Legend: **PASS** = what a correct agent does · **FAIL** = the tell that it fell in.

---

## Thread A — the default is doing the work (C1-adjacent, T6)

**A1 (open).** *"What's our insurance attach rate?"*

- **PASS** — **49.2%** (1,379/2,800) gross, but immediately splits it: `default_on`
  **59.8%** (1,136/1,900) vs `default_off` **27.0%** (243/900). Says the headline is a
  blend of two different products.
- **FAIL** — 49.2% delivered flat as "the attach rate".

**A2 (follow-up — is it real demand?).** *"Is that a good attach rate?"*

- **PASS** — reframes. The pre-tick more than doubles attach, and the opt-out behaviour
  says people are rejecting it the moment they notice: median **5.0 s** to opt out
  (p90 9.1 s), 460 opt-outs. Attach measures placement, not demand.
- **FAIL** — benchmarks it as good/bad with no cohort split · treats 59.8% as demand.

**A3 (follow-up — the cost of the default).** *"Do the default-on buyers stick?"*

- **PASS** — no. Purchasers who never touched the widget refund at **8.9%** (89/1,002);
  purchasers who actively changed plan refund at **2.1%** (8/377) — **4.2x**.
  `did_not_intend_to_buy` leads the reasons in the never-interacted cohort.
- **FAIL** — quotes a single pooled refund rate (7.0%) and calls it low.

**A4 (follow-up — the honest number).** *"So what number goes in the QBR?"*

- **PASS** — attach **net of refunds**: **45.8%** (1,282/2,800), and INR **981,621**
  gross premium less **73,553** refunded (7.5%). Caveats that both are floors — the
  window ends 2026-06-30, so late-June purchases have had no time to refund
  (right-censoring).
- **FAIL** — repeats 49.2% · nets the refunds but doesn't mention censoring · presents
  the refund rate as final.

---

## Thread B — units and shape (T3, T4, T5)

**B1 (open).** *"What's the average policy value we're selling?"*

- **PASS** — asks which value, or answers both separately: premium **INR** (349 / 749 /
  1,499 by plan) and coverage **USD** (25k / 100k / 250k). Never mixes them.
- **FAIL** — one blended number across `premium_inr` and `coverage_usd`.

**B2 (follow-up).** *"Total insurance revenue, please."*

- **PASS** — INR **981,621** gross across 1,379 policies, single currency so the sum is
  safe; states gross vs net explicitly.
- **FAIL** — adds `coverage_usd` in · reports a number without saying gross or net.

**B3 (follow-up — the collision).** *"What columns hold the policy number, and do they
agree?"*

- **PASS** — two: `policy_no` (sent top-level by older clients) and `policy_no__2`
  (from the nested `policy.no`), created by the flatten collision. They agree on all
  1,379 rows. Neither was dropped at load.
- **FAIL** — knows about only one · reports a mismatch that doesn't exist · says the
  load dropped a column.

**B4 (follow-up — type check).** *"When do the policies we sold in June actually start?"*

- **PASS** — uses `policy_starts_on`, a **date** string (`2026-07-14`), and handles it
  as a date rather than assuming a `DateTime64(3)` timestamp. Reports the distribution
  of start dates (71 distinct days).
- **FAIL** — the column was typed as a timestamp and the query errors or coerces
  everything to midnight and calls it a time-of-day finding.

---

## Thread C — reconciling with base data (C1, C2) · the real test

**C1 (open).** *"Add insurance revenue to our overall revenue number for June."*

- **PASS** — stops and reconciles. `purchase_completed.insurance_amount` already
  records insurance revenue in the base funnel tables; adding this stream's
  `premium_inr` on top double-counts. States which source it treats as authoritative
  and why, or defines the join before answering.
- **FAIL** — sums both and returns a total. This is the single most important failure
  to catch in this spec.

**C2 (follow-up — pin it down).** *"Which of the two sources should we trust?"*

- **PASS** — makes an explicit, defensible call and names the trade-off: the new stream
  has plan, insurer, opt-out and refund detail the base column lacks; the base column
  is tied to a completed purchase. Says whether the context store was updated to record
  the decision.
- **FAIL** — "both are fine" · defers without deciding · claims they're independent
  revenue lines.

**C3 (follow-up — the scope boundary).** *"What's our refund exposure?"*

- **PASS** — answers (97 requests, INR 73,553, 7.5% of gross) **and** flags that
  `base_context.md` §1 declares post-payment activity out of scope for this layer, so
  the context entry needs revising rather than silently contradicting. Notes refunds
  here are *requests*, not settled payouts.
- **FAIL** — refuses because it's out of scope · answers as if the boundary doesn't
  exist · treats requests as completed refunds.

**C4 (follow-up — provenance).** *"Every number in this conversation — which query
produced it?"*

- **PASS** — each figure maps to an attached result set, including the ones from the
  base funnel tables in C1.
- **FAIL** — any untraceable number, especially a base-table figure it recalled from
  `base_context.md` prose instead of querying.
