# Atlys Analytics — Base Context Layer

> This is the shared business + data context for the analytics agents. It describes
> what Atlys does, the conversion funnel we optimise, the events we capture, the
> metrics we track, and the quirks we already know about. Treat it as the starting
> point, not gospel: it is maintained by hand and can lag the data.

---

## 1. Business overview

Atlys is a digital visa platform. Travellers discover visa requirements for a
destination, start an application, upload their passport, and pay. The product's
north-star is **conversion**: turning a visitor who taps a destination card into a
paid application, with as little drop-off as possible across 120+ destinations,
each with its own rules.

The pre-purchase journey we instrument is a linear funnel:

```
destination_card_clicked  ->  application_started  ->  document_uploaded  ->  purchase_completed
```

Around that spine we also capture supporting engagement events (search, scroll,
authentication, pay-now click). Everything after payment (submission, embassy
processing, issuance, refunds) is handled by other systems and is **out of scope
for this context layer**.

Atlys operates at a run rate of 700K+ applications annually. The funnel is seasonal
(weekends dip, summer lifts leisure destinations) and mobile-heavy (iOS-first,
large Android base, a meaningful web cohort).

---

## 2. Entity definitions

**User** — a traveller. Identified by `user_id` (a 28-char string), present on every
event. A user may browse many destinations and start multiple applications.

**Application** — one visa application, identified by `application_id`. Created at
the **application_started** step, so events *before* it (card clicks, searches)
carry an empty `application_id`. The application records the chosen destination,
purpose, co-traveller count, and the predicted turnaround shown to the user: the
**`application_started` event carries `visa_issuance_eta_days`** (an integer number
of days) used downstream for on-time reporting.

**Destination** — the target country, ISO-2 code in `destination`. Each destination
belongs to a region (GCC, SEA, Schengen, Americas, …) with its own visa types.

**Event** — one row in one of the eight raw event tables. Every event shares the
common envelope (device, os, geo, app version, session, timestamps) plus
event-specific columns. Events are the grain of all analysis.

**Document** — the passport captured during KYC, recorded in `document_uploaded`.
The client records the capture mode, the number of retries (`retry_count`), and
whether the user crossed the failed-capture threshold
(`is_crossed_failed_attempt_threshold`) — a proxy for capture quality.

---

## 3. The eight raw event tables

All eight are raw event streams (one table per event), joined on `user_id` and
`application_id`, ordered in time by `timestamp`. Four are the **conversion funnel**;
four are **supporting** engagement events.

| Table | Kind | Emitted when | Key event-specific columns |
|-------|------|--------------|----------------------------|
| `destination_card_clicked` | funnel | user taps a destination card | `destination`, `visa_type`, `card_type`, `flow` |
| `application_started` | funnel | user starts an application | `purpose`, `eta_shown`, `co_travelers`, `destination` |
| `document_uploaded` | funnel | passport image submitted | `doc_type`, `capture_mode`, `retry_count`, `is_crossed_failed_attempt_threshold` |
| `purchase_completed` | funnel | payment succeeds (**conversion**) | `value` (revenue), `currency`, `insurance_amount`, `coupon_applied` |
| `search_typed` | supporting | user types a destination search | `search_term`, `results_count`, `source` |
| `landing_page_scrolled` | supporting | user scrolls a landing page | `scroll_depth_pct`, `time_on_page_s`, `page_version` |
| `auth_completed` | supporting | user finishes login/signup | `auth_method`, `is_new_user`, `attempts` |
| `pay_now_clicked` | supporting | user taps Pay Now at checkout | `payment_method`, `amount`, `currency`, `coupon_applied` |

**Instrumentation note:** these tables auto-create one-per-event via the client
event SDK. They are **sorted by `id` first** (`ORDER BY (id, timestamp, user_id)`) —
a legacy of the event-table template. Queries filter by time/segment, never by `id`.

---

## 4. Metric definitions

**Conversion rate** = completed purchases ÷ **sessions**. A session is a single
app-open / web visit. This is the headline number reported to leadership.

**Drop-off rate (per funnel stage)** = 1 − (users at stage N+1 ÷ users at stage N),
counting distinct `user_id` reaching each stage in order within the window.

**Step-through rate** = users at stage N+1 ÷ users at stage N.

**Passport-capture pass rate** = document uploads that did **not** cross the
failed-capture threshold (`is_crossed_failed_attempt_threshold = 0`) ÷ document
uploads.

**On-time delivery rate** = applications issued on or before `visa_issuance_eta_days`
÷ applications issued. (Reported by the fulfilment team from post-purchase systems;
not computable from the funnel tables here.)

**Revenue per conversion** = `value` on `purchase_completed`, in the event's `currency`.

> Note on funnel conversion: within the funnel, we treat **conversion as
> `purchase_completed` users ÷ users who started an application**
> (`application_started`). This is the denominator used in the drop-off dashboards.

---

## 5. Known-issues log

1. **K1 — iOS WebKit OTP autofill regression.** On recent iOS builds the payment OTP
   field fails to autofill, and some users abandon at the pay step. Payment-heavy
   geos (Gulf card users) are most exposed. Watch `pay_now_clicked → purchase_completed`
   for iOS.
2. **K2 — Passport scan model update (Apr 2026).** The on-device passport model was
   updated in early April. Some Android devices report more capture failures since;
   being monitored.
3. **K3 — MRZ OCR weaker on non-Latin passports.** Passports with non-Latin
   machine-readable zones need more capture retries.
4. **K4 — Schengen summer slot scarcity (Apr–Jun).** Appointment slots for Schengen
   destinations are scarce in summer; expect seasonal softness, not a bug.
5. **K5 — WhatsApp nudge launch (Feb 2026).** A WhatsApp re-engagement nudge went
   live in February; it can lift returns to the funnel for previously-dropped users.
6. **K6 — SUMMER20 coupon campaign.** A `SUMMER20` promo ran in Q2; expect elevated
   `coupon_applied` and lower realised `value`.
7. **K7 — App 7.45 rollout.** App version 7.45.x rolled out mid-quarter; minor
   funnel-timing shifts around the rollout are expected.

---

## 6. Entity relationships (join map)

- `destination_card_clicked.user_id` → all tables (`user_id`)
- `application_started.application_id` → `document_uploaded`, `pay_now_clicked`,
  `purchase_completed` (on `application_id`)
- supporting tables (`search_typed`, `landing_page_scrolled`, `auth_completed`) join
  on `user_id` (they may precede an application, so `application_id` can be empty)
- funnel order is by `timestamp` ascending within a `user_id` / `application_id`
- segment cuts: `device_type` / `os`, `geoip_country_code`, `destination`,
  `citizenship`, `co_travelers`, acquisition (`gclid` present ⇒ paid search)

---

## 7. How to analyse the funnel

- Compute step counts as `uniq(user_id)` (or `application_id` past application start)
  per stage, in `timestamp` order, over a time window. Prefer
  `windowFunnel`/`sequenceMatch` over per-table row dumps.
- Always cut by at least device, geo, and destination before concluding.
- Push aggregation into ClickHouse; interpret the aggregates, don't read raw rows.
</content>
