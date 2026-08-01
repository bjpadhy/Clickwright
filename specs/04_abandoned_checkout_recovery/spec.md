# Feature spec — Abandoned Checkout Recovery

## What it does
Detects travellers who drop out at a funnel step without converting and sends a
re-engagement nudge (push, email, or WhatsApp) to bring them back to where they
left off. Goal is to recover conversions lost to funnel drop-off.

## User actions (raw events emitted)
- `abandonment_detected` — a drop is detected (`drop_step`: destination_card_clicked
  / application_started / document_uploaded / pay_now_clicked)
- `reminder_sent` — a nudge is sent (`channel`: push/email/whatsapp, `hours_since_drop`)
- `reminder_opened` — the nudge is opened (`channel`)
- `reminder_cta_clicked` — the user taps through (`channel`)
- `resumed_at_step` — the user returns to the funnel
- `reconverted` — the user completes payment after the nudge

Envelope as usual (`device_type`, `geoip_country_code`, `destination`, `user_id`,
`application_id`).

## Questions the PM will ask
- Reconversion (recovery) rate by **drop_step** — which step is most recoverable?
- Which **channel** recovers best (open → click → reconvert)?
- Does timing (`hours_since_drop`) matter — send at 1h vs 24h vs 48h?
- Segment cuts (device, geo, destination). Bonus: does recovery target the same
  drop-offs seen in the existing funnel tables?
