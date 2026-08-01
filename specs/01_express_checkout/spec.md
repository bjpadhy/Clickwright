# Feature spec — Express Checkout

## What it does
A one-tap checkout for returning travellers. When a user with a saved payment
method reaches checkout, we show an **Express** button that skips the full payment
form: it reuses the saved method, collects only an OTP, and confirms payment. Goal
is to cut time-to-pay and lift the checkout → success conversion.

## User actions (raw events emitted)
- `express_checkout_shown` — express eligible, button rendered (`shown_amount`, `currency`)
- `express_checkout_selected` — user taps Express (`saved_method_type`: card/upi/wallet)
- `saved_method_used` — the saved instrument is loaded
- `otp_entered` — OTP submitted (`otp_attempts`, `otp_success`)
- `express_payment_confirmed` — payment succeeds (nested `payment`: `amount`, `currency`, `latency_ms`)

Events carry the usual raw envelope (`device_type`, `os`, `geoip_country_code`,
`app_version`, `user_id`, `application_id`, `destination`).

## Questions the PM will ask
- Does Express lift checkout → success conversion vs standard checkout, and by how much?
- Is there a platform where OTP / payment fails more (e.g. iOS)? Cut `otp_success`
  and confirmation rate by `device_type` / `os` / `geoip_country_code`.
- How much faster is Express (`payment.latency_ms`, time from shown → confirmed)?
- Which segments adopt Express most (device, geo, saved-method type)?
