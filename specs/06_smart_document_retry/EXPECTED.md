# Answer key — 06_smart_document_retry

Not read by the pipeline (it only opens `spec.md` and `events.ndjson`). This is the
grading sheet: what a correct run should find, and what a wrong one will say instead.

**Data:** 5,575 rows · 5 events · 1,500 capture sessions · 2026-06-08 → 2026-06-30

## What the pipeline has to survive

| # | Trap | Failure mode if missed |
|---|------|------------------------|
| T1 | `failure_reasons` is an **array** | DDL must emit `Array(String)`, not `String`. First real array column in the spec set. |
| T2 | Nested `quality` object | Flattens to `quality_blur_score`, `quality_glare_score`, `quality_mrz_confidence`. |
| T3 | `is_duplicate` on `capture_failed` | 50 of 1,120 failure rows (4.5%) are SDK double-fires. Unfiltered, failure counts and per-attempt rates are wrong. |
| T4 | **Denominator inversion** | Per-attempt success says the coach is *worse*; per-session success says it is far better. Both are computable; only one answers the question. |
| T5 | `os` is JSON `null` on ~20% of Android rows | Must bucket as `'unknown'`, not drop. |

## Ground truth

**T4 — the headline, and the trap.**

| Metric | control | coach | reading |
|---|---|---|---|
| Session success (succeeded ÷ sessions) | **73.2%** (550/751) | **94.7%** (709/749) | coach **+21.5pp** |
| Per-attempt success (succeeded ÷ attempts) | 55.3% (550/994) | 53.1% (709/1335) | coach **−2.2pp** |
| Attempts per session | 1.32 | 1.78 | |

A run that reports only the per-attempt number concludes the coach hurts. It does
not. The mechanism is retention, not capture quality: sessions ending in
`capture_abandoned` drop from **26.8%** (201/751) in control to **5.3%** (40/749)
with the coach — 45.3% of failures end the session in control vs 6.4% with the
coach. Coach users take more attempts and land more of them in total. **The correct
denominator is the session (or the `user_id`/application), not the attempt.** A
strong run says this out loud.

**Mechanism split by `mrz_script` — where the coach earns its keep (K3):**

| | control | coach | lift |
|---|---|---|---|
| latin | 77.8% (487/626) | 93.9% (573/610) | +16.1pp |
| non_latin | **50.4%** (63/125) | **97.8%** (136/139) | **+47.4pp** |

Non-Latin MRZ passports fail roughly 27pp more often without the coach. This is
**K3** in the known-issues log and should be cited by name. `mrz_unreadable` is the
top failure reason overall (385 of 1,120 raw failure rows).

**K2 — Android passport-model regression:**

Attempt-level failure rate on Android, by app version (duplicates excluded):

| app_version | failure rate |
|---|---|
| 7.44.0 | **64.0%** (224/350) |
| 7.45.2 | 40.4% (84/208) |
| 7.46.0 | 37.7% (98/260) |

Session success for the Android + 7.44.0 cohort in the control arm is **54.8%**
(57/104) against 76.2% (493/647) for everyone else. This is **K2**, not a coach
finding — a run that attributes it to the experiment has mis-segmented.

## Grading

- **Pass:** reports session-level success as the headline, names the denominator
  choice, cites K3 for non-Latin MRZ, filters `is_duplicate`.
- **Strong:** also separates mechanism (abandonment) from capture quality, flags K2
  as a pre-existing Android issue rather than an arm effect.
- **Fail:** headline is per-attempt success · `failure_reasons` typed as `String` ·
  duplicate rows unfiltered · null `os` dropped instead of bucketed.
