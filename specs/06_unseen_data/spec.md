# Feature spec — Promo / Coupon at Checkout (SEALED — 6th spec)
### ClickHouse Click-a-thon 2026 · "Agents That Instrument, Analyze, and Explain"

This is the **unseen sixth spec** promised in [`PROBLEM_STATEMENT.md`](../PROBLEM_STATEMENT.md): same format as the five known specs, same fictional universe, released to all teams simultaneously. Push it through your pipeline end to end — the output must come from your system, evidenced by the trace. **No trace, no credit.**

## What's in this folder

```
├── spec.md              ← this feature spec
└── events.ndjson        5,364 raw events (NDJSON) to map to your generated schema
```

## What it does

Adds a coupon field to the checkout screen. The traveller enters a promo code; it is validated (valid / rejected with a reason); if valid, a discount is applied and shown, and the user proceeds to pay at the discounted price. Goal is to lift conversion with promos while controlling margin.

## User actions (raw events emitted)

- `coupon_field_shown` — the coupon field renders (`cart_value`, `currency`)
- `coupon_entered` — user submits a code (`coupon_code`)
- `coupon_applied` — code is valid, discount computed (`discount_type`: percent/flat, `discount_amount`)
- `coupon_rejected` — code invalid (`reject_reason`: expired / invalid_code / min_cart_not_met / already_used)
- `discount_shown` — the discounted price is displayed
- `checkout_with_coupon` — checkout proceeds (`coupon_code` may be null for no-coupon baseline, `discount_amount`, `final_value`)

Envelope as usual (`device_type`, `os`, `geoip_country_code`, `destination`, `user_id`, `application_id`).

## Questions the PM will ask

- Coupon apply rate (field_shown → coupon_applied) and valid vs rejected mix; top reject reasons.
- Conversion lift: do coupon users reach `checkout_with_coupon` at a higher rate than the no-coupon baseline (rows where `coupon_code` is null)?
- Margin cost: total `discount_amount`; which codes drive volume vs erode margin.
- Segment cuts (device, geo, destination); which codes work where.

## What to submit

Your pipeline's output for this spec, as specified in the problem statement:

1. The **generated schema** your Instrumentation Agent produced
2. The **insight summary** — written for a product audience, not a database one
3. The **trace** that proves your system generated them

Every team gets the same input at the same time, so outputs are directly comparable. Build nothing new — this is the moment your pipeline either generalizes or shows its seams.
