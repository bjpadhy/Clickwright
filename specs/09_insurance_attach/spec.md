# Feature spec — Travel Insurance Attach

## What it does
Offers a travel-insurance policy alongside the visa at checkout. Since 14 June the
plan is **pre-selected by default** (`default_on`) with a visible opt-out; before
that the traveller had to add it themselves. Three plans (basic / plus / premium).
Goal is attach rate and margin on an existing checkout.

## User actions (raw events emitted)
- `insurance_offer_shown` — the offer renders (`plan_id`, `premium_inr`,
  `coverage_usd`, `default_on`)
- `insurance_opted_out` — the traveller unticks it (`plan_id`, `seconds_to_optout`)
- `insurance_plan_changed` — a different plan is chosen (`from_plan`, `to_plan`)
- `insurance_purchased` — the policy is paid for (`plan_id`, `premium_inr`,
  `coverage_usd`, `policy_no`, nested `policy`: `no`, `insurer`, `coverage_usd`,
  `starts_on`)
- `insurance_refund_requested` — the traveller asks for the premium back
  (`reason`, `days_since_purchase`)

Envelope as usual, plus `default_on` on every event. `policy_no` is also sent at the
top level by older clients.

## Questions the PM will ask
- Attach rate, and how much of it is the default doing the work? Compare the
  pre-14-June and post-14-June cohorts.
- What is insurance actually worth to us after refunds, in INR?
- Who asks for their money back, and why? Is the refund concentrated anywhere?
- We already record `insurance_amount` on `purchase_completed`. Reconcile this
  stream with that column before reporting any revenue number.
