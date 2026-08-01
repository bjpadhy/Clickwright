# Feature spec — Embassy Appointment Slots

## What it does
For destinations that require an in-person appointment, travellers search embassy
slots inside the app, place a 15-minute hold on one, and confirm it as part of
checkout. If nothing is available they can join a waitlist. Goal is to stop losing
appointment-visa applications to third-party slot-booking sites.

## User actions (raw events emitted)
- `slot_search` — a slot search runs (`embassy_city`, `window_days`, `results_count`)
- `slot_held` — a slot is held for 15 minutes (`hold_id`, `slot_datetime`,
  `hold_expires_at`, `slot_capacity`, `is_backfilled`)
- `hold_expired` — **emitted server-side** by a 5-minute sweeper when a hold lapses
  (`hold_id`, `reason`, `expired_after_minutes`)
- `slot_released` — the user drops the hold themselves (`hold_id`)
- `slot_confirmed` — the appointment is booked (`hold_id`, `slot_datetime`,
  `lead_time_days`, `is_backfilled`)
- `waitlist_joined` — no slots available, user waits (`waitlist_position`)

Client events carry the full envelope. `hold_expired` is server-emitted and is keyed
by `hold_id` only — it has no device, geo or user columns.

## Questions the PM will ask
- The slot funnel: search → hold → confirmed. Where is the loss, and how much of it
  is holds lapsing rather than users choosing not to book?
- Availability by destination and `embassy_city` — how often does a search return
  nothing, and what do those travellers do next?
- Booking lead time (`lead_time_days`) — how far out are people forced to book?
- Are the Schengen numbers a product problem or a supply problem? Check the
  known-issues log before recommending a fix.
