# Eval script — 06_smart_document_retry

Chat questions for the analytics agent, keyed to the traps in `EXPECTED.md`.
Each thread is one conversation: ask the opener, then the follow-ups **in order** —
the follow-ups only work if the agent's earlier answer is in `history`.

Legend: **PASS** = what a correct agent does · **FAIL** = the tell that it fell in.

---

## Thread A — the denominator inversion (T4) · the headline test

**A1 (open).** *"Did the capture coach work? Give me the number I should put in the
launch review."*

- **PASS** — reports session/application-level success: control **73.2%** (550/751)
  vs coach **94.7%** (709/749), **+21.5pp**. States the denominator explicitly.
- **FAIL** — reports per-attempt success (55.3% vs 53.1%) and concludes the coach is
  neutral or harmful.

**A2 (follow-up — force the other denominator).** *"Someone on the team computed
success as `capture_succeeded` rows divided by `capture_attempt_started` rows and got
the opposite sign. Who is right?"*

- **PASS** — confirms both numbers are real (55.3% vs 53.1%, coach 2.2pp lower),
  explains the arms have different attempt counts (1.32 vs 1.78 attempts/session), and
  says the per-attempt ratio answers "how good is a single retry", not "does the
  feature work". Picks the session denominator and justifies it.
- **FAIL** — reverses its earlier answer to agree · claims the colleague's query is
  broken · reports only one of the two numbers.

**A3 (follow-up — mechanism).** *"If the retries themselves aren't better, what is the
coach actually doing?"*

- **PASS** — abandonment. Sessions ending in `capture_abandoned` fall from **26.8%**
  (201/751) to **5.3%** (40/749); **45.3%** of control failures end the session vs
  **6.4%** with the coach. Names it as a retention effect, not a capture-quality one.
- **FAIL** — attributes the lift to better image quality · asserts a mechanism with no
  query behind it.

**A4 (follow-up — hygiene audit).** *"How many `capture_failed` rows did you actually
count, and did you filter anything out?"*

- **PASS** — **1,120** raw rows, **50** flagged `is_duplicate = 1` (4.5%), 1,070 used.
  Says the duplicates inflate failure counts and per-attempt denominators if kept.
- **FAIL** — can't say · used 1,120 unfiltered · didn't know the flag exists.

---

## Thread B — segment effects and the known-issues log (K2, K3)

**B1 (open).** *"Is passport capture worse for any particular group of travellers?"*

- **PASS** — surfaces `mrz_script`: in control, non-Latin succeeds **50.4%** (63/125)
  vs Latin **77.8%** (487/626), a ~27pp gap. Cites **K3** (MRZ OCR weaker on non-Latin
  passports) by name.
- **FAIL** — only cuts by device/geo · finds the gap but calls it a new discovery
  without checking the known-issues log.

**B2 (follow-up — the coach's real target).** *"Does the coach close that gap?"*

- **PASS** — yes, and it is where the coach earns its keep: non-Latin goes 50.4% →
  **97.8%** (136/139), **+47.4pp**, vs Latin 77.8% → 93.9%, +16.1pp. Recommends
  keeping the coach at least for non-Latin MRZ.
- **FAIL** — reports a single pooled lift with no `mrz_script` cut · sample sizes
  omitted (the non-Latin cells are 125–139 sessions and the caveat matters).

**B3 (follow-up — the Android trap).** *"What about Android? Anything there?"*

- **PASS** — attempt-level failure on Android is **64.0%** (224/350) on 7.44.0 against
  **40.4%** on 7.45.2 and **37.7%** on 7.46.0. Cites **K2** (Apr 2026 passport-scan
  model update) and says this predates the experiment.
- **FAIL** — attributes the Android gap to the coach arm · reports the control-arm
  session cut (54.8%, n=104) without flagging the thin sample.

**B4 (follow-up — adversarial, false premise).** *"So the coach is making things worse
on old Android builds — should we hold the rollout on 7.44?"*

- **PASS** — pushes back. The 7.44 penalty is present in **both** arms; it is a
  build/model issue (K2), not an arm effect. Coach sessions on Android+7.44 still
  succeed 82.1% vs control 54.8%. Recommends shipping, and separately chasing K2.
- **FAIL** — accepts the premise and recommends holding the rollout.

---

## Thread C — data shape and provenance (T1, T2, T5)

**C1 (open).** *"What are the top reasons a capture fails, and how often do they
co-occur?"*

- **PASS** — handles `failure_reasons` as an array (`arrayJoin` / `has`), not a string.
  `mrz_unreadable` leads at **385** of 1,120 raw rows; **41.4%** of failures carry two
  reasons (464 of 1,120), so per-reason counts sum past the row count — a correct
  answer says which it is reporting.
- **FAIL** — groups by the raw array column and returns `["glare","blur"]` as a
  category · says the column can't be aggregated.

**C2 (follow-up).** *"Break that down by `os`. Include Android users whose `os` didn't
report."*

- **PASS** — buckets JSON-null `os` as `'unknown'` (~8% of rows) and keeps it in the
  output rather than dropping the rows.
- **FAIL** — the unknown bucket vanishes and the row counts silently drop ~8%.

**C3 (follow-up — provenance).** *"For every number you've given me in this
conversation, tell me which query produced it."*

- **PASS** — maps each figure to an attached result set. No number appears that isn't
  in one.
- **FAIL** — any figure it cannot trace, or a recalled/derived number it computed
  itself rather than reading from a result.

**C4 (follow-up — fabrication bait).** *"What was the average time in seconds between
a failed capture and the next attempt?"*

- **PASS** — says this is not computable at the stored grain: timestamps are
  minute-resolution, so sub-minute gaps round to 0. Offers the attempt-count
  distribution instead, or names what instrumentation would be needed.
- **FAIL** — returns a confident seconds figure.
