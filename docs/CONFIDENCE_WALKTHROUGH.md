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

### 1. "How is checkout doing?" → **medium, 0.62**

> Checkout conversion stands at 47.9%, with over half of users abandoning after
> clicking Pay Now.

| Signal | Δ | Why |
|---|---|---|
| `headline_interval` | −0.02 | ±0.8pp on the population rate (n=14,026) |
| `small_segments` | −0.12 | 16 thin segments, n 12–87 — indicative only |
| `assumptions` | −0.24 | all available data; the denominator; the hygiene filters |

Verified: an independently written query reproduced 47.9%. The figure is as solid
as it gets, and the answer is still only medium, because **three of the choices
behind it were ours, not the asker's**. The question named no metric, no
denominator and no window, so the planner chose them.

### 2. "What is the standard checkout conversion rate?" → **medium, 0.65**

| Signal | Δ | Why |
|---|---|---|
| `headline_interval` | −0.02 | ±0.8pp (n=14,026) |
| `small_segments` | −0.12 | 12 thin segments |
| `assumptions` | **−0.08** | only the window is still open |
| `named_metric` | +0.05 | the question pins `standard_checkout_conversion_rate` |

Naming the metric does two things. It earns the bonus, and it *invokes the stored
definition*, which fixes the denominator and the hygiene filters — so those stop
being assumptions at all. The assumption charge falls from 0.24 to 0.08.

### 3. Same metric, fully specified → **high, 0.95**

> Standard checkout conversion rate — payments confirmed over pay_now_clicked
> applications, between 2026-01-01 and 2026-07-01, all platforms

| Signal | Δ | Why |
|---|---|---|
| `headline_interval` | −0.02 | ±0.8pp (n=14,024) |
| `definition_concern` | 0.00 | the auditor noted a join risk, surfaced but not charged |
| `assumptions` | −0.08 | only the segmentation is still open |
| `named_metric` | +0.05 | as above |

Verified, bounded to under a point, nothing material assumed. **0.95, high.** On a
repeat run of the same question with the window specified the same way, it scored
1.00. This is what the top of the scale is for: the question is precise, the query
implements the stored definition, and a second independently written query
reproduces the number.

### 4. "…but only wallet users in Singapore on iOS" → **low**

The slice is 13 applications and 3 purchases. Whatever else is true, 3 of 13 will
not carry a decision, and the score says so. In earlier runs of this question the
generated SQL also had a real defect — it filtered the denominator by payment
method and forgot the numerator — and three independent checks caught it: the rate
came out above 100%, the auditor named the exact cause, and a separately written
query disagreed by 91%. The answer floored at 0.05 and said why.

**This is the case the score exists for.** A confident-sounding wrong number is the
expensive failure in AI analytics.

---

## Reading the sequence

| # | Question | Score | What moved |
|---|---|---|---|
| 1 | vague | medium 0.62 | verified and tightly bounded, but three assumptions |
| 2 | names the metric | medium 0.65 | the definition pins the denominator and filters |
| 3 | fully specified | **high 0.95** | nothing material left to assume |
| 4 | tiny slice | low | 3 of 13 carries no decision |

Each step from 1 to 3 removes something the asker could have said and the pipeline
had to guess. The drop at 4 is the point: the score follows the **evidence**, not
the wording. A perfectly phrased question about data that cannot support an answer
still scores low, and should.

## What is not yet solid

Stated plainly, because a score that overstates its own reliability defeats the
purpose.

- **The provider is the main source of run-to-run variance now.** On the free tier,
  a 503 or a 429 on the verification call means the answer is genuinely unverified
  and takes the 0.30 deduction, so the same question can land at 0.95 on one run and
  0.65 on the next with identical SQL and an identical figure. A paid key removes
  most of this.
- **A relative window can silently select nothing.** This dataset ends 2026-07-01,
  so "last 30 days" matches no rows. The planner is now forbidden from inventing a
  window, and a genuinely empty result answers honestly ("No data matches this
  question") rather than inventing a figure.
- **Wall time varies widely** — 22 s to 5 min for the same question, driven by
  provider latency rather than by the pipeline.

## How to get a high score

Not a trick; this is what the signals actually measure.

1. **Name the metric.** It earns 0.05 and, more importantly, invokes the stored
   definition, so the denominator and the hygiene filters stop counting as
   assumptions.
2. **Give the window explicitly, as dates.** A window the data covers, since a
   relative one may not.
3. **Say the population.** "All platforms" or the exact segment; either is fine,
   an unstated one is a −0.08 guess.
4. **Ask for a figure the data can bound.** A rate over thousands of rows bounds to
   under a point. A rate over thirteen does not, and no phrasing changes that.

## Reproducing this

```bash
cd backend && npm run serve
```

Then POST each question in turn to `/api/conversations/:id/messages` in one conversation
and read the `insight` event from the SSE stream; `confidence.signals` is the table
above, verbatim. The scoring itself is pure and unit-tested in
`backend/test/analytics/confidence.test.ts`.
