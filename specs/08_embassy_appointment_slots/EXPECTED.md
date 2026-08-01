# Answer key — 08_embassy_appointment_slots

Not read by the pipeline (it only opens `spec.md` and `events.ndjson`).

**Data:** 5,012 rows · 6 events · 2,400 searches · 2026-06-08 → 2026-06-30

## What the pipeline has to survive

| # | Trap | Failure mode if missed |
|---|------|------------------------|
| T1 | `hold_expired` has **no envelope** | Server-emitted, keyed by `hold_id` only: `event, id, timestamp, hold_id, reason, expired_after_minutes`. A DDL that assumes the standard envelope breaks; a join on `user_id` returns nothing. |
| T2 | `is_backfilled` | An ETL replay re-ingested 150 `slot_held` + 150 `slot_confirmed` rows with fresh `id`s. Unfiltered, confirmations are inflated **23.0%** (801 rows vs 651 distinct `hold_id`). |
| T3 | Expiry/confirm race | 32 holds have **both** a `hold_expired` and a `slot_confirmed`, and in all 32 the expiry is timestamped **first** (the sweeper fired, then the payment landed and the booking was honoured). Last-event-wins logic marks them lost. |
| T4 | Zero-result searches | 561 of 2,400 searches return nothing. They belong in the search→hold denominator; dropping them hides the whole finding. |
| T5 | Sweeper timestamps are 5-minute-rounded | Expect ties; do not read them as real event times. |

## Ground truth

**Row counts:** search 2,400 · held 1,203 · confirmed 801 (**651 distinct holds**) ·
expired 351 · released 83 · waitlist 174.

**The funnel, split Schengen (FR/GR/IT/ES/DE) vs everything else:**

| | searches | zero-result | search → hold | hold → confirm | median lead time |
|---|---|---|---|---|---|
| Schengen | 1,001 | **46.6%** (466) | 32.0% (320) | **44.4%** (142) | **42 days** |
| Other | 1,399 | 6.8% (95) | 52.4% (733) | 69.4% (509) | 10 days |

**The finding:** the Schengen funnel does not leak at a UI step — it leaks at
availability. Nearly half of Schengen searches return **zero slots**, and the slots
that do appear are 42 days out. This is **K4 (Schengen summer slot scarcity,
Apr–Jun)** and must be cited: it is a supply constraint, not a bug and not a design
problem. A run that recommends "improve the slot-picker UX" has missed it.

Downstream behaviour confirms it: 174 travellers join a waitlist, and a zero-result
Schengen search converts to a waitlist join **34.1%** of the time (159/466) against
**15.8%** (15/95) elsewhere — the demand is there, the supply is not.

**Holds that lapse:** 351 `hold_expired` rows against 1,203 holds — 15 minutes is
too short relative to how long checkout takes. This is the one genuinely actionable
product recommendation in the spec.

## Grading

- **Pass:** filters `is_backfilled`, counts confirmations by distinct `hold_id`,
  reports the zero-result rate, cites K4.
- **Strong:** also handles the expiry/confirm race (confirmation wins), notes that
  `hold_expired` carries no envelope so it cannot be segmented by device or geo, and
  separates "no supply" from "user chose not to book".
- **Fail:** confirmations 23% high · zero-result searches excluded from the
  denominator · K4 reported as a product regression · a join from `hold_expired` to
  `user_id` that silently returns empty.
