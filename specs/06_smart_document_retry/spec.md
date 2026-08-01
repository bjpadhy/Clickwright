# Feature spec — Smart Document Retry (Capture Coach)

## What it does
When a passport capture fails, we show an on-device coach: a hint tied to the
detected failure reason ("move into better light", "fit the whole page in frame")
and a one-tap retry. Shipped as a 50/50 holdout against today's silent retry.
Goal is to get more applications past KYC instead of losing them at the scanner.

## User actions (raw events emitted)
- `capture_attempt_started` — a capture begins (`attempt_no`, `capture_mode`:
  auto/manual/gallery)
- `capture_failed` — the scan is rejected (`attempt_no`, `failure_reasons` — an
  **array** of reasons, nested `quality`: `blur_score`, `glare_score`,
  `mrz_confidence`, `is_duplicate`)
- `coach_hint_shown` — coach arm only (`hint_id`, `failure_reasons`)
- `capture_succeeded` — the scan passes (`attempt_no`, `total_attempts`, nested
  `quality`)
- `capture_abandoned` — the user gives up (`attempt_no`, `last_failure_reason`)

Every event carries the usual envelope plus `variant` (coach/control) and
`mrz_script` (latin/non_latin).

## Questions the PM will ask
- Does the coach lift passport-capture success, and by how much? Be explicit about
  the denominator you chose and why.
- How many attempts does a traveller make before succeeding or giving up, per arm?
- Which `failure_reasons` dominate, and does the coach fix the ones it targets?
- Any segment where capture is worse (`device_type` / `os` / `app_version` /
  `mrz_script`)? Cross-check against the known-issues log before calling it a bug.
