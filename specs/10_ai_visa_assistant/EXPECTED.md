# Answer key — 10_ai_visa_assistant

Not read by the pipeline (it only opens `spec.md` and `events.ndjson`).

**Data:** 6,482 rows · 6 events · 1,100 assistant sessions · 2026-06-08 → 2026-06-30

## What the pipeline has to survive

| # | Trap | Failure mode if missed |
|---|------|------------------------|
| T1 | `query_text` is genuinely high-cardinality | **1,947 distinct values in 1,993 rows.** `LowCardinality(String)` is wrong here — a direct test of the <1k-distinct rule, which every other column in the spec set passes. |
| T2 | `intents` is an **array** | `Array(String)`. Counting intents needs `arrayJoin`, not a group-by on the raw column. |
| T3 | **Split latency units** | 7.46.0 emits `latency_ms` (Int), older builds emit `latency_s` (Float seconds). Each is *absent* on the other's rows. Reporting one field describes a third or two thirds of traffic. Note the profiler reports `null=0.0%` for both — it only sees keys that are present, so the sparsity is invisible in the profile and must be read off `spec.md`. Once loaded, the missing side is **default-filled with 0**, so a naive `avg(latency_ms)` over `answer_shown` averages in 1,328 zeros. Filter `latency_ms > 0` / `latency_s > 0`. |
| T4 | CSAT is sparse **and** non-randomly sampled | 7.2% of answers rated, and high-confidence answers are rated 4.6x more often. Mean CSAT is a survivorship artefact. |
| T5 | `os` JSON-null on Android, `sources_count` legitimately 0 | Bucket, don't drop; 0 sources is a real value, not missing. |

## Ground truth

**Volume:** 1,100 sessions · 1,993 questions · 1,942 answers (51 questions timed out
with no answer) · 140 rated · 207 escalations.

**T3 — latency. The only defensible number is the unified one:**

| field | coverage | median |
|---|---|---|
| `latency_ms` (7.46.0) | 31.6% of answers (614) | 1,884 ms = **1.88 s** |
| `latency_s` (older builds) | 68.4% of answers (1,328) | **3.37 s** |
| **unified (all answers, seconds)** | 100% | **2.75 s** (p90 4.77 s) |

There is a real finding hiding in the unit split: the 7.46.0 streaming renderer is
**~1.5 s faster** than the old one. A run that reports "median latency 1.88 s"
(ms-only) or "3.37 s" (s-only) is describing a minority of traffic and missing the
renderer improvement entirely.

**T4 — quality. CSAT is the wrong headline:**

| | rating rate |
|---|---|
| answers with `confidence` ≥ 0.75 | **11.0%** (114/1,041) |
| answers with `confidence` < 0.55 | **2.4%** (6/253) |

Mean CSAT among rated answers is **4.04 / 5** — on a 7.2% sample that is biased
upward by construction: the answers people disliked are the ones they walked away
from. **Escalation rate is the honest quality metric**, because it is observed on
100% of sessions.

**Escalation — the actual finding:**

| segment | escalation rate |
|---|---|
| `lang = en` | **11.6%** (96/830) |
| `lang != en` | **41.1%** (111/270) |
| sessions containing a <0.55-confidence answer | **46.5%** (101/217) |

Overall deflection is **81.2%** of sessions (893/1,100 close without a hand-off).
Non-English sessions escalate 3.5x more, and low confidence is the strongest single
predictor. `low_confidence` is the second-largest escalation reason (73 of 207)
behind `wanted_human` (79).

## Grading

- **Pass:** `query_text` typed as plain `String`, `intents` as `Array(String)`,
  latency reported as one unified figure across both fields, deflection/escalation
  reported on all sessions.
- **Strong:** also caveats CSAT as a biased sample and quantifies the bias, surfaces
  the 7.46.0 renderer speed-up found via the unit split, and flags the non-English
  escalation gap as the top product action.
- **Fail:** `LowCardinality(String)` on `query_text` · latency reported from one
  field only · mean CSAT presented as the quality headline · `intents` typed as
  `String`.
