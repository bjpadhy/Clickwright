# Eval script — 08_embassy_appointment_slots

Chat questions for the analytics agent, keyed to the traps in `EXPECTED.md`.
Ask the opener, then the follow-ups **in order**.

Legend: **PASS** = what a correct agent does · **FAIL** = the tell that it fell in.

---

## Thread A — the funnel and the backfill (T2, T4) · the headline test

**A1 (open).** *"Walk me through the appointment funnel: search → hold → confirmed."*

- **PASS** — 2,400 searches → 1,203 holds → **651 distinct confirmed holds**. Filters
  `is_backfilled = 1` and says so.
- **FAIL** — reports **801** confirmations (the raw row count), overstating bookings by
  **23.0%**.

**A2 (follow-up — direct hygiene probe).** *"How many `slot_confirmed` rows are in the
table, and how many distinct `hold_id`s?"*

- **PASS** — 801 rows, 651 distinct holds; explains the 150-row ETL replay on
  2026-06-20 carrying `is_backfilled = 1` with fresh `id`s, and confirms A1 already
  excluded them.
- **FAIL** — the two numbers are equal (didn't check) · notices the gap but blames
  users double-booking · silently corrects A1 without saying it changed.

**A3 (follow-up — the zero-result denominator).** *"What share of searches lead to a
hold, and what happens to the ones that don't?"*

- **PASS** — keeps zero-result searches in the denominator: **561 of 2,400** searches
  return nothing at all. Overall search → hold is well below the "searched and saw
  something" rate, and the difference *is* the finding.
- **FAIL** — silently restricts to `results_count > 0`, reporting a healthy funnel and
  erasing the availability problem.

**A4 (follow-up — the actionable leak).** *"Of the holds that never converted, how many
simply expired?"*

- **PASS** — **351** `hold_expired` against 1,203 holds; contrasts with only 83
  voluntary `slot_released`. Concludes the 15-minute hold is short relative to
  checkout, and flags this as the one product fix the data supports.
- **FAIL** — treats every non-confirmed hold as a user rejection.

---

## Thread B — supply vs product (K4)

**B1 (open).** *"Schengen destinations look terrible in this funnel. What's broken?"*

Note the question contains a leading premise — a good agent tests it rather than
answering it.

- **PASS** — nothing in the product is broken. Schengen: **46.6%** of searches (466 of
  1,001) return zero slots vs **6.8%** (95/1,399) elsewhere; median lead time **42
  days** vs 10. Cites **K4** (Schengen summer slot scarcity, Apr–Jun) and calls it a
  supply constraint.
- **FAIL** — recommends redesigning the slot picker · calls it a regression · doesn't
  consult the known-issues log.

**B2 (follow-up — corroboration).** *"How do you know it's supply and not that people
don't like the slots we show?"*

- **PASS** — demand evidence: a zero-result Schengen search converts to a waitlist join
  **34.1%** of the time (159/466) vs **15.8%** (15/95) elsewhere, and Schengen
  hold→confirm is 44.4% (142/320) vs 69.4% (509/733) — consistent with people accepting
  bad dates when nothing better exists. Travellers want the slots; the slots aren't there.
- **FAIL** — restates the zero-result rate as if it were the proof · asserts intent
  with no query behind it.

**B3 (follow-up — seasonality boundary).** *"Will this fix itself in September?"*

- **PASS** — says the data cannot answer it. The window is **2026-06-08 → 2026-06-30**,
  three weeks inside the scarce season, with no comparison period. K4 describes Apr–Jun
  scarcity, which is context, not a measurement. Names what would be needed.
- **FAIL** — forecasts a recovery · extrapolates a trend from 23 days.

**B4 (follow-up — segmentation limit).** *"Break the expiries down by device and
country."*

- **PASS** — cannot be done. `hold_expired` is server-emitted and carries only
  `event, id, timestamp, hold_id, reason, expired_after_minutes` — no envelope. Offers
  the join back through `slot_held.hold_id` to recover device/geo, and reports that
  instead.
- **FAIL** — returns an empty or all-`unknown` breakdown and presents it as a result ·
  joins on `user_id` and silently gets nothing.

---

## Thread C — event ordering (T3, T5)

**C1 (open).** *"Are there any holds where our event data contradicts itself?"*

- **PASS** — finds **32** holds carrying both a `hold_expired` and a `slot_confirmed`.
- **FAIL** — reports none · reports the 150 backfilled pairs as the contradiction and
  stops there.

**C2 (follow-up).** *"For those, which event came first?"*

- **PASS** — the expiry, in **all 32**. Explains the sequence: the 5-minute sweeper
  fired at the 15-minute mark, then the payment landed and the booking was honoured
  anyway.
- **FAIL** — says the confirmation came first · calls the timestamps corrupt.

**C3 (follow-up — the consequence).** *"So should those 32 count as booked?"*

- **PASS** — yes. Confirmation is the terminal state regardless of timestamp order;
  last-event-wins logic would wrongly mark 32 real bookings as lost. Says whether its
  own earlier funnel numbers used that rule.
- **FAIL** — drops them · double-counts them in both the expired and confirmed buckets.

**C4 (follow-up — timestamp fidelity).** *"What's the average time between a hold
expiring and the traveller giving up?"*

- **PASS** — flags that `hold_expired` timestamps are rounded up to 5-minute sweeper
  boundaries, so they are write times, not event times; any gap computed against them
  carries up to 5 minutes of error. Offers `hold_expires_at` from `slot_held` as the
  true expiry instant.
- **FAIL** — computes the average off the sweeper timestamps and reports it flat.
