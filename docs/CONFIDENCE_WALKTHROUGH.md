# What the confidence score is, and how a better question raises it

Every figure Clickwright reports carries a score between 0.05 and 1.00 and a band:
**high ≥ 0.75, medium ≥ 0.45, low below that**. The bands do not overlap, so the word and
the number can never disagree.

The score is **computed, never asked of the model**. It starts at 1.00, three ceilings
can cap it, and every weakness in the evidence subtracts a named amount. The deductions
sum exactly to the score, so the card can be read as a receipt rather than a vibe.

This document is a transcript. Every number below came from running the four questions
against the live ClickHouse service and the live model on 21 September 2026, in one
conversation, cold cache. Nothing here is illustrative.

---

## The three ceilings

Applied first, and the lowest one wins. They express things no amount of good work
elsewhere can compensate for.

| Ceiling | When | Why it is absolute |
|---|---|---|
| **0.44** | an independently written verification query disagrees with the headline | two queries cannot both be right; one of them is wrong and we do not know which |
| **0.70** | nothing could be verified | an unchecked figure is not a checked one, however tight its interval |
| **0.60** | no figure carries a confidence interval | sums, counts and averages cannot be bounded — we can report them, not certify them |

## The deductions

Assumptions the planner had to make, the width of the interval on the **headline**
figure, thin side segments, rates shipped without a denominator, rates above 100%,
planned tasks that returned nothing, and narration retries. One bonus: naming a metric
that is actually defined in the context store earns back 0.05.

The interval charged is the one on the **headline** figure, not the widest anywhere in
the result. Ask "how is checkout doing" and you get a population rate over thousands of
sessions next to a handful of four-row device slices. Charging for the four-row slice
would mark the whole answer low when the number a PM will act on is bounded to a couple
of points. The thin slices become a *note*, not a verdict.

---

## The walkthrough

### 1. "How is checkout doing?" → **medium, 0.56**

> Standard checkout converts at 47.9%, while Express checkout achieves a significantly
> higher 83.0% completion rate.

| Signal | Δ | Why |
|---|---|---|
| `headline_interval` | −0.07 | ±2.3pp on `full_completion_rate` (n=1007) |
| `small_segments` | −0.12 | 31 thin segments, n 4–46 — indicative only |
| `definition_concern` | 0.00 | auditor noted a LEFT JOIN yielding NULL instead of 0.0, surfaced but not charged |
| `assumptions` | −0.25 | denominator for standard checkout; denominator for express; all platforms; all available data |

The question named no metric, no denominator, no window and no segment, so the planner
chose four of them. That is the whole 0.25 cap. The figure itself is good — an
independently written query reproduced it — and the answer is still only medium,
because **four of the choices behind it were ours, not the asker's**.

### 2. "What is the standard checkout conversion rate?" → **low, 0.31**

> Standard checkout converts at 47.9% overall, with significant performance variance
> across operating systems and regions.

| Signal | Δ | Why |
|---|---|---|
| `no_bounded_precision` | −0.40 | ceiling 0.60: no figure in the result carries an interval |
| `rates_without_denominator` | −0.10 | 34 rates shipped with no count column beside them |
| `assumptions` | −0.24 | denominator; data-hygiene filters; all platforms |
| `named_metric` | +0.05 | the question pins `standard_checkout_conversion_rate` |

Naming the metric earned the bonus, and the score still *fell*. This is the score doing
its job rather than flattering the question: the SQL emitted rates without the counts
they divide, so nothing could be bounded, and an unbounded figure is capped at 0.60
however well-phrased the question was. Same headline, 47.9%, verified again.

### 3. Same metric, fully specified → **medium, 0.47**

> Standard checkout conversion rate — payments confirmed over pay_now_clicked
> applications, between 2026-01-01 and 2026-07-01, all platforms

| Signal | Δ | Why |
|---|---|---|
| `no_bounded_precision` | −0.40 | same ceiling as question 2 |
| `rates_without_denominator` | −0.10 | same |
| `assumptions` | **−0.08** | only one left: the data-hygiene convention |
| `named_metric` | +0.05 | same |

**This is the controlled comparison.** Question 3 differs from question 2 only in what
the asker specified. Every other signal is identical — same ceiling, same penalty, same
bonus. Spelling out the window, the denominator and the platform set collapsed the
assumption charge from 0.24 to 0.08 and moved the answer from low to medium, **+0.16
bought purely by asking a better question**.

The remaining 0.08 is honest: the question still did not say how to treat duplicate and
back-filled rows, so the pipeline applied the stored convention and charged itself for
the choice.

### 4. "Same metric and window, but only wallet users in Singapore on iOS" → **low, 0.05**

> Standard checkout conversion data for Singapore wallet users on iOS is inconclusive
> due to low sample sizes.

| Signal | Δ | Why |
|---|---|---|
| `verification_failed` | −0.56 | an independent query got 0.231 where the analysis reported 2.615 — Δ 91.2% |
| `small_sample_flag` | −0.10 | every sample size below 50 |
| `definition_concern` | −0.10 | auditor: the numerator is not filtered by wallet, making purchases exceed clicks |
| `impossible_values` | −0.10 | one value is a rate above 100% |
| `citation_retries` | −0.10 | narration corrected once for an uncited number |
| `assumptions` | −0.24 | the window, the country code, the denominator |

Note what happened here. The slice is tiny, the generated SQL had a real defect — it
filtered the denominator by payment method and forgot the numerator — and three
independent checks caught it: the rate came out above 100%, the auditor named the exact
cause, and a separately written query disagreed by 91%. The answer is floored at 0.05
and says so in plain words.

**This is the case the score exists for.** A confident-sounding wrong number is the
expensive failure in AI analytics. Here the system produced the number, refused to stand
behind it, and said precisely why.

---

## Reading the sequence

| # | Question | Score | What moved |
|---|---|---|---|
| 1 | vague | medium 0.56 | four assumptions, thin segments |
| 2 | names the metric | low 0.31 | bonus earned, but nothing could be bounded |
| 3 | fully specified | medium 0.47 | **+0.16 from specificity alone** |
| 4 | tiny slice, bad SQL | low 0.05 | verification disagreed; three checks caught it |

The climb from 2 to 3 is the demonstration. The drop at 4 is the point: the score
follows the **evidence**, not the wording. A better-phrased question about data that
cannot support an answer still scores low, and should.

## What is not yet solid

Stated plainly, because a score that overstates its own reliability defeats the purpose.

- **The answer is stable; the score is not, entirely.** Across four live runs of this
  sequence the headline figure was 47.9% every single time and the verification agreed
  every time. Question 2's *score* ranged from 0.31 to 0.79 across those runs, because
  the model sometimes emits the count columns a rate divides by and sometimes does not.
  With them the figure is bounded and reaches high 0.79; without them the 0.60 ceiling
  applies. The prompt now makes this an explicit read-back step, but it is model
  compliance, not a guarantee.
- **A relative window can silently select nothing.** This dataset ends 2026-07-01, so
  "last 30 days" matches no rows. The pipeline answers honestly ("No data matches this
  question") rather than inventing a figure, but the question has to be asked with a
  window the data covers.
- **Wall time varies widely** — 29 s to 5 min for the same question on the free tier,
  driven by provider latency rather than by the pipeline.

## Reproducing this

```bash
cd backend && npm run serve
```

Then POST each question in turn to `/api/conversations/:id/messages` in one conversation
and read the `insight` event from the SSE stream; `confidence.signals` is the table
above, verbatim. The scoring itself is pure and unit-tested in
`backend/test/analytics/confidence.test.ts`.
