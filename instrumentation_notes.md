# Instrumentation notes — the 8 raw event tables

Each table is a raw event stream (one table per event, auto-created by the client
event SDK). All share the common envelope (`id`, `timestamp`, `user_id`,
`application_id`, device/os/geo/app_version/session, acquisition ids) plus
event-specific columns. Join on `user_id` (whole journey) and `application_id`
(from `application_started` onward). Ordered in time by `timestamp`.

Four tables are the **conversion funnel**; four are **supporting** engagement events.

| Table | Kind | Emitted by / when | Notes |
|-------|------|-------------------|-------|
| `destination_card_clicked` | funnel | client, when a user taps a destination card | top of funnel; `application_id` empty (no application yet). Fires very often. |
| `application_started` | funnel | client, when the user starts an application | creates `application_id`; carries `purpose`, `co_travelers`, `eta_shown` (turnaround shown). |
| `document_uploaded` | funnel | client, when the passport image is submitted | one row per upload; `retry_count` and `is_crossed_failed_attempt_threshold` proxy capture quality. |
| `purchase_completed` | funnel | client, when payment succeeds | **the conversion event**; `value` (revenue) in `currency`, plus add-on amounts. |
| `search_typed` | supporting | client, when a destination search is typed | may precede any application (`application_id` often empty). Noisy discovery signal. |
| `landing_page_scrolled` | supporting | client, on landing-page scroll | engagement depth (`scroll_depth_pct`, `time_on_page_s`). |
| `auth_completed` | supporting | client, when login/signup finishes | fires around application start for most, plus some who auth but never apply. |
| `pay_now_clicked` | supporting | client, when Pay Now is tapped at checkout | sits between `document_uploaded` and `purchase_completed`; clicking ≠ paying. |

**Known texture (kept faithful to prod):**
- Wide, mostly-`Nullable` columns; empty strings and nulls are common.
- `os` is messy: some Android rows have `os = NULL` while `device_type = 'android'`;
  `device_type` values include `ios`, `android`, `web-user-b2c`, `Desktop`.
- `duplicate_id` / `is_back_filled` mark re-ingested or backfilled rows.
- All tables use the legacy event-table sort key `ORDER BY (id, timestamp, user_id)`.
- The supporting tables overlap the funnel on `user_id` but are not clean funnel
  steps — treat them as engagement/noise unless a question needs them.
