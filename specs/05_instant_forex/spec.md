# Feature spec — Instant Forex Add-on

## What it does
At checkout, offers the traveller foreign currency (a forex card / cash order) for
their destination. The user picks an amount, sees the rate, adds it to the cart,
and pays for it alongside the visa. Goal is a high-margin add-on that lifts AOV.

## User actions (raw events emitted)
- `forex_offer_shown` — the offer renders (`from_currency`, `to_currency`, `fx_rate`)
- `currency_selected` — user engages with the currency
- `amount_entered` — user enters an amount (`amount`)
- `forex_added_to_cart` — added to the order (`amount`, `addon_value_inr`)
- `forex_purchased` — forex paid for (`amount`, `addon_value_inr`)

Envelope as usual (`device_type`, `geoip_country_code`, `destination`, `user_id`,
`application_id`).

## Questions the PM will ask
- Attach rate: offer_shown → forex_purchased, overall and by `destination`.
- AOV uplift: distribution of `addon_value_inr` among attachers.
- Where is the drop — offer → amount_entered, or added_to_cart → purchased?
- Which destinations / currencies attach best; any segment (device/geo) skew?
