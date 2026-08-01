# Feature spec — Bundled Price Presentation

## What it does
Two ways to show the same checkout price. **control** itemises it (base fee +
service fee + taxes); **bundle** shows one all-in number with a "no hidden fees"
badge and hides the breakdown behind a tap. The best available coupon is
auto-applied in both arms. Goal is to stop the price-shock drop at checkout.

## User actions (raw events emitted)
- `price_quote_shown` — a quote renders (`variant`, `tier`: economy/standard/
  priority, `price_local`, `currency`, `price_inr`, `fee_local`, `auto_coupon`)
- `coupon_applied_auto` — a coupon is auto-applied (`coupon_code`, `discount_inr`)
- `price_details_expanded` — the user opens the fee breakdown (`fee_local`)
- `checkout_started` — the user proceeds to pay (`price_inr`)
- `checkout_paid` — payment succeeds (nested `payment`: `amount_local`, `currency`,
  `amount_inr`, `method`, `latency_ms`)

Envelope as usual, plus `session_id` and `variant` on every event.

## Questions the PM will ask
- Which arm converts better, quote → paid? Ship it or kill it.
- Is the lift real, or a mix effect? Cut by `tier`, `geoip_country_code` and
  `app_version` and say whether the arms are comparable to begin with.
- Revenue per quote by arm — does the conversion story survive on money?
- What does the auto-coupon do to conversion vs realised revenue?
