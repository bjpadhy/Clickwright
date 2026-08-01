# Eval script — 10_ai_visa_assistant

Chat questions for the analytics agent, keyed to the traps in `EXPECTED.md`.
Ask the opener, then the follow-ups **in order**.

Legend: **PASS** = what a correct agent does · **FAIL** = the tell that it fell in.

---

## Thread A — the split latency units (T3) · the headline test

**A1 (open).** *"How fast is the assistant? Give me a median and a p90."*

- **PASS** — one figure covering all 1,942 answers: median **2.75 s**, p90 **4.77 s**,
  built by unifying `latency_ms / 1000` with `latency_s`. States that two fields carry
  latency and that it combined them.
- **FAIL** — **1.88 s** (ms-only, 31.6% of answers) or **3.37 s** (s-only, 68.4%),
  presented as the whole picture.

**A2 (follow-up — the zero-fill).** *"How many rows went into that, and what did you do
about the rows where the field was missing?"*

- **PASS** — 614 rows carry `latency_ms`, 1,328 carry `latency_s`, 1,942 total with no
  overlap. Filters `> 0`, because the absent side is **default-filled with 0** at load —
  an unguarded `avg(latency_ms)` averages in 1,328 zeros and reports ~0.6 s.
- **FAIL** — row count equals 1,942 for a single field · a suspiciously fast average ·
  didn't notice the fill. Note the profiler reports `null=0.0%` for both fields, so
  the sparsity is only discoverable from `spec.md` or by querying — a run that trusted
  the profile alone will fail here.

**A3 (follow-up — why two fields).** *"Why are there two latency columns at all?"*

- **PASS** — the streaming renderer shipped in **7.46.0** and emits milliseconds; every
  older build emits float seconds. Confirms the split against `app_version`.
- **FAIL** — calls it a data-quality bug to be cleaned up · guesses web vs mobile
  without checking.

**A4 (follow-up — the finding hiding in the trap).** *"Is the new renderer actually
faster?"*

- **PASS** — yes, materially: **1.88 s** median on 7.46.0 vs **3.37 s** on older builds,
  ~1.5 s better. This is the real product finding the unit split was concealing.
- **FAIL** — says the two aren't comparable and stops · compares 1,884 against 3.37
  without converting.

---

## Thread B — quality metrics and survivorship (T4)

**B1 (open).** *"Is the assistant giving good answers? We have CSAT."*

- **PASS** — reports mean CSAT **4.04 / 5** and immediately discounts it: only **7.2%**
  of answers (140/1,942) are rated. Proposes escalation rate as the honest measure
  because it is observed on 100% of sessions.
- **FAIL** — "CSAT 4.04, quality is good."

**B2 (follow-up — quantify the bias).** *"Why don't you trust the CSAT number?"*

- **PASS** — rating is not random: answers with `confidence ≥ 0.75` are rated **11.0%**
  of the time (114/1,041), answers below 0.55 only **2.4%** (6/253) — **4.6x**. The bad
  answers are systematically the unrated ones, so the mean is biased upward by
  construction.
- **FAIL** — cites small sample size only · says "surveys are always biased" with no
  query behind it.

**B3 (follow-up — the alternative).** *"Fine — what's the honest quality number?"*

- **PASS** — deflection: **81.2%** of sessions (893/1,100) close without a hand-off;
  **207** escalate. Reports it on all sessions, not just those with an answer.
- **FAIL** — computes escalation per question rather than per session and reports a
  much smaller rate without saying which denominator it used.

**B4 (follow-up — adversarial, false premise).** *"CSAT went up this month, so the model
improved — can you confirm?"*

- **PASS** — refuses. The window is a single 23-day period (2026-06-08 → 06-30) with no
  prior month to compare, and on a 7.2% biased sample a CSAT move would not be
  evidence of model quality anyway. Offers escalation rate over time instead, with the
  caveat that 23 days is thin.
- **FAIL** — confirms the improvement · produces a month-over-month comparison from a
  single month of data.

---

## Thread C — shape, cardinality, and segments (T1, T2, T5)

**C1 (open).** *"What are travellers actually asking about?"*

- **PASS** — aggregates `intents` as an array (`arrayJoin`), not the raw column. Reports
  intent frequencies with sample sizes.
- **FAIL** — groups by the raw array and returns `["appointment","processing_time"]` as
  a single category · says the column can't be grouped.

**C2 (follow-up — the cardinality probe).** *"Show me the most common exact questions."*

- **PASS** — reports that `query_text` is effectively unique: **1,947 distinct values in
  1,993 rows**, so a top-N of raw strings is meaningless. Redirects to `intents`, or
  offers a normalised/prefix grouping and labels it as a heuristic.
- **FAIL** — returns a top-10 of one-off strings each with count 1 or 2 and presents it
  as a demand signal. (Related DDL check: `query_text` must **not** be
  `LowCardinality(String)` — 1,947 distinct is far past the <1k rule.)

**C3 (follow-up — the segment that matters).** *"Does the assistant work as well in
other languages?"*

- **PASS** — no. Escalation is **11.6%** for `lang = en` (96/830) vs **41.1%** for
  non-English (111/270) — 3.5x. Names it as the top product action.
- **FAIL** — reports CSAT by language (n is tiny after the 7.2% rating filter) instead
  of escalation · doesn't cut by `lang` at all.

**C4 (follow-up — competing explanation).** *"Is that a language problem or a confidence
problem?"*

- **PASS** — both, and they overlap: sessions containing a sub-0.55-confidence answer
  escalate **46.5%** of the time (101/217), and non-English answers score lower
  confidence on average. Says the two cuts are not independent and that this data
  cannot fully separate them — a cross-tab is directional, not causal.
- **FAIL** — picks one and asserts causation · presents the two rates as if they were
  independent contributions that sum.
