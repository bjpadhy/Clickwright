# Answer key — 07_bundled_price_experiment

Not read by the pipeline (it only opens `spec.md` and `events.ndjson`).

**Data:** 6,999 rows · 5 events · 2,600 quote sessions · 2026-06-08 → 2026-06-30

## What the pipeline has to survive

| # | Trap | Failure mode if missed |
|---|------|------------------------|
| T1 | **Simpson's paradox** | `bundle` wins the headline and loses inside every tier. Ship the wrong arm. |
| T2 | Non-random assignment | Assignment is confounded with geo. The arms are not comparable and the run should say so. |
| T3 | Multi-currency `price_local` / `payment.amount_local` | 7 currencies. Averaging across them is meaningless; `price_inr` / `payment_amount_inr` are the comparable fields. |
| T4 | Conversion is per **session** | `session_id` is on every event. Per-user conversion is wrong per `base_context.md` §4. |
| T5 | K6 SUMMER20 | Coupon lifts conversion and cuts realised revenue — the two metrics move opposite ways. |
| T6 | Nested `payment` object | Flattens to `payment_amount_local`, `payment_currency`, `payment_amount_inr`, `payment_method`, `payment_latency_ms`. |

## Ground truth

**T1 — the paradox.** Quote → paid, per session:

| | control | bundle |
|---|---|---|
| **Overall** | 46.4% (817/1,760) | **51.7%** (434/840) ← *looks like a +5.3pp win* |
| economy | 62.9% (373/593) | 62.2% (318/511) |
| standard | 47.0% (271/576) | **38.2%** (89/233) |
| priority | 29.3% (173/591) | 28.1% (27/96) |

`bundle` is worse in **all three tiers**. The headline reverses because the arms
have completely different tier mixes:

| | economy | standard | priority |
|---|---|---|---|
| control | 34% | 33% | 34% |
| bundle | **61%** | 28% | 11% |

**T2 — why the mixes differ.** The all-in pricing service only supports
INR-denominated quotes at launch, so the bundle arm is ~96% India, and India skews
hard to the (best-converting) economy tier. Assignment is not random. The correct
call is either "segment by tier" or "this experiment is not readable as run" —
both are acceptable; "ship bundle" is not.

**T5 — revenue tells the true story.**

| | revenue per quote | total |
|---|---|---|
| control | **INR 3,376** | INR 5,942,124 |
| bundle | **INR 2,452** | INR 2,059,588 |

Bundle converts "better" and earns 27% less per quote — because its traffic is cheap
economy quotes carrying SUMMER20.

Coupon effect (both arms pooled): SUMMER20 quotes convert **68.9%** (262/380) vs
**44.5%** (989/2,220) without — a +24pp conversion lift bought with a 20% discount.
This is **K6** and should be cited.

**T3 — currency mix on `price_local`:** INR 1,578 · SGD 262 · AED 250 · USD 171 ·
AUD 132 · GBP 125 · SAR 82. Any INR-comparable aggregate must use `price_inr` /
`payment_amount_inr`, or group by `currency`.

**Distractor:** cutting by `app_version` shows both arms improving over the rollout
(control 44.0% → 51.1%). That is **K7** rollout drift, not the experiment.

## Grading

- **Pass:** reports the within-tier result, states that bundle loses, computes
  conversion per `session_id`, uses `price_inr` for money.
- **Strong:** also names the confound (arm ↔ geo ↔ tier), reports revenue per quote,
  cites K6 for the coupon, and recommends re-running with balanced assignment.
- **Fail:** recommends shipping bundle · averages `price_local` across currencies ·
  conversion per user · attributes the tier gap to the price presentation itself.
