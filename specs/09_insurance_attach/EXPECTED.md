# Answer key — 09_insurance_attach

Not read by the pipeline (it only opens `spec.md` and `events.ndjson`).

**Data:** 5,167 rows · 5 events · 2,800 offers · 2026-06-08 → 2026-06-30

This is the **context** test of the set. The analytics are moderate; the hard part is
reconciling a new stream against documented base data and extending a context layer
that explicitly says this territory is out of scope.

## What the pipeline has to survive

| # | Trap | Failure mode if missed |
|---|------|------------------------|
| C1 | **Overlaps existing base data** | `purchase_completed.insurance_amount` already records insurance revenue (`base_context.md` §3). Adding this table's premiums to it double-counts. The context update must say which is authoritative. |
| C2 | **Crosses a documented scope boundary** | §1 says everything after payment — refunds included — is out of scope. `insurance_refund_requested` violates that. The context entry has to be *revised*, not ignored, and not crashed on. |
| T3 | Flatten collision | Top-level `policy_no` **and** nested `policy.no` both flatten to `policy_no` → the second becomes `policy_no__2`. The DDL must carry both columns and the load must not drop one. |
| T4 | Two units in one row | `premium_inr` (INR) next to `coverage_usd` (USD). Summing them is nonsense. |
| T5 | `policy.starts_on` is a **date string** (`2026-07-14`), not a timestamp | Should not be typed `DateTime64(3)`. |
| T6 | Right-censoring | Refunds can only be observed within the window; late-June purchases have had no time to refund, so the refund rate is a floor, not a final number. |

## Ground truth

**Rows:** offers 2,800 · opted_out 460 · plan_changed 431 · purchased 1,379 ·
refunds 97.

**The headline attach rate is inflated by the default.**

| | offers | attach rate |
|---|---|---|
| `default_on = true` (post-14 Jun) | 1,900 | **59.8%** (1,136) |
| `default_on = false` (pre-14 Jun) | 900 | **27.0%** (243) |
| All | 2,800 | 49.2% (1,379) |

The default more than doubles attach. Whether that is a win depends on the next table.

**Refunds concentrate almost entirely in the never-interacted cohort:**

| purchaser cohort | refund rate |
|---|---|
| never touched the widget (default carried them through) | **8.9%** (89/1,002) |
| actively changed plan | **2.1%** (8/377) |

4.2x. Median time to opt out is **5.0 seconds** (p90 9.1s) — people who notice the
tick box reject it almost instantly, which is the same signal from the other side.
`did_not_intend_to_buy` is the leading refund reason in the default-on cohort.

**Money (INR, single currency — safe to sum):**

- gross premium **INR 981,621**
- refunded **INR 73,553** (7.5% of gross)
- gross attach 49.2% → **net-of-refund attach 45.8%** (1,282/2,800)

Both figures are floors — see T6.

**The recommendation this supports:** the default is buying attach that partially
reverses, and it does so from travellers who did not intend to buy. Report attach
*net of refunds*, and treat the never-interacted cohort's 8.9% refund rate as the
cost of the default.

## Grading

- **Pass:** attach rate split by `default_on`, refunds netted off revenue, both
  `policy_no` columns present in the DDL and loaded.
- **Strong:** the context update explicitly reconciles this stream with
  `purchase_completed.insurance_amount` (names one as authoritative, or defines the
  join) **and** revises the §1 "post-payment is out of scope" entry rather than
  silently contradicting it. Notes right-censoring on the refund rate.
- **Fail:** reports 49.2% attach as the result · sums `premium_inr` with
  `coverage_usd` · adds these premiums to `purchase_completed.insurance_amount` ·
  drops `policy_no__2` · run crashes on the out-of-scope refund event.
