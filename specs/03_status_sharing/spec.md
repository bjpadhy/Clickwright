# Feature spec — Visa Status Sharing

## What it does
Lets a traveller share their live application status via a link (WhatsApp, copy,
email, SMS). The recipient sees the status and a call-to-action to start their own
application. Goal is a viral acquisition loop back into the top of the funnel.

## User actions (raw events emitted)
- `share_clicked` — user taps share (`status_shared`: submitted/processing/approved)
- `channel_selected` — picks a channel (`channel`)
- `link_generated` — a share link is created (`share_id`, `channel`)
- `link_opened` — a recipient opens the link (`recipient_is_new_user`, `channel`)
- `recipient_cta_clicked` — recipient taps "start your own application" (`cta`)

Sharer events carry the full envelope; recipient events (`link_opened`,
`recipient_cta_clicked`) are keyed by `share_id`.

## Questions the PM will ask
- Share rate, and does it vary by `status_shared` (do approvals get shared more)?
- Channel mix, and which channel drives the most **new-user** opens?
- Recipient → new-application conversion (a K-factor): opens → `recipient_cta_clicked`
  among `recipient_is_new_user`.
- Which destinations spread most?
