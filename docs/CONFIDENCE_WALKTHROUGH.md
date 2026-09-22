# What the confidence score is, and how a better question raises it

Every figure Clickwright reports carries a score between 0.05 and 1.00 and a band:
**high ≥ 0.75, medium ≥ 0.45, low below that**. The bands do not overlap, so the word and
the number can never disagree.

The score is **computed, never asked of the model**. It starts at 1.00, three ceilings
can cap it, and every weakness in the evidence subtracts a named amount. The deductions
sum exactly to the score, so the card can be read as a receipt rather than a vibe.

This document is a transcript. Every number below came from running the four questions
against the live ClickHouse service and the live model on 22 September 2026, each in its
own fresh conversation so nothing was served from cache. Every signal table is the
`confidence.signals` array as the run produced it, and every one satisfies the
`1 + Σdelta === score` invariant. Nothing here is illustrative.

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

### 1. "How is checkout doing?" → **medium, 0.67**

> Checkout conversion is steady at 47.9% overall, while Express Checkout adoption
> reaches 61.0% with a 50.7% conversion rate.

| Signal | Δ | Why |
|---|---|---|
| `headline_interval` | −0.05 | ±1.7pp on the express checkout conversion rate (n=3,300) |
| `small_segments` | −0.12 | 5 thin segments, n 65–81 — indicative only |
| `assumptions` | −0.16 | all available data; segment by `geoip_country_code` |

Verified: an independently written query reproduced 47.9% exactly. The figure is as
solid as it gets, and the answer is still only medium, because **two of the choices
behind it were ours, not the asker's**. The question named no metric and no window,
so the planner chose them — and chose to segment by country, which is the right
instinct on a vague question and still a choice the asker did not make.

Note what the headline is. The answer reports several rates; the one charged is the
express conversion rate over 3,300 applications, not the four-row device slices
beside it.

### 2. "What is the standard checkout conversion rate?" → **high, 0.91**

> The standard checkout conversion rate is 47.9%.

| Signal | Δ | Why |
|---|---|---|
| `headline_interval` | −0.02 | ±0.8pp on the population rate (n=14,026) |
| `small_segments` | −0.12 | 12 thin segments, n 12–87 |
| `named_metric` | +0.05 | the question pins `standard_checkout_conversion_rate` |

Naming the metric does two things, and the second is the larger. It earns the bonus,
and it *invokes the stored definition*, which fixes the denominator
(`pay_now_clicked` applications) and the hygiene filters (`duplicate_id IS NULL`,
`is_back_filled != 1`). Those stop being assumptions, because nobody chose them —
the definition did. **The assumption charge falls from 0.16 to nothing**, and one
word of extra precision is worth 0.24 of confidence.

### 3. Same metric, fully specified → **high, 1.00**

> Standard checkout conversion rate — payments confirmed over pay_now_clicked
> applications, between 2026-01-01 and 2026-07-01, all platforms

| Signal | Δ | Why |
|---|---|---|
| `headline_interval` | −0.02 | ±0.8pp (n=14,024) |
| `definition_concern` | 0.00 | the auditor noted a NULL-merging join risk — surfaced, not charged |
| `named_metric` | +0.02 | as above, capped at the total deducted so the score cannot exceed 1.00 |

Verified, bounded to under a point, nothing assumed, and the independent query
reproduced the figure to fourteen decimal places. **This is what the top of the scale
is for**: the question is precise, the query implements the stored definition, and a
second, separately written query agrees.

The bonus is 0.02 here rather than 0.05 because it is capped at the total deducted.
The score is a receipt, and a receipt cannot show a credit larger than the bill.

### 4. "…but only wallet users in Singapore on iOS" → **low, 0.14**

> The standard checkout conversion rate for wallet users in Singapore on iOS is 23.1%.

| Signal | Δ | Why |
|---|---|---|
| `headline_interval` | −0.65 | ±21.0pp on the rate (n=13) — too wide to act on |
| `citation_retries` | −0.10 | narration corrected 1× for uncited numbers |
| `assumptions` | −0.16 | all available data; `payment_method = 'wallet'` identifies wallet users |
| `named_metric` | +0.05 | as above |

The slice is 13 applications. The number is *correct* — the independent query
reproduced 23.1% exactly — and it is still worthless: the true rate could be 2% or
44%. Three of thirteen will not carry a decision, and the score says so rather than
letting a precise-looking percentage imply otherwise.

**This is the case the score exists for.** A confident-sounding number resting on
nothing is the expensive failure in AI analytics, and it is the one case where being
right is not enough.

---

## Reading the sequence

| # | Question | Score | What moved |
|---|---|---|---|
| 1 | vague | medium 0.67 | verified and tightly bounded, but the metric and the cut were ours |
| 2 | names the metric | **high 0.91** | the definition pins the denominator and the filters — 0.16 of assumptions disappears |
| 3 | fully specified | **high 1.00** | nothing left to assume |
| 4 | tiny slice | low 0.14 | 13 applications carry no decision, however well the question is phrased |

Steps 1 to 3 each remove something the asker could have said and the pipeline had to
guess; the score rises 0.33 across them with the **same headline figure, 47.9%,
verified identically every time**. The drop at 4 is the point: the score follows the
**evidence**, not the wording. A perfectly phrased question about data that cannot
support an answer still scores low, and should.

All four ran in 31-68 seconds with no truncated model output.

## What is not yet solid

Stated plainly, because a score that overstates its own reliability defeats the
purpose.

- **The provider is the main source of run-to-run variance now.** On the free tier,
  a 503 or a 429 on the verification call means the answer is genuinely unverified
  and takes the 0.30 deduction, so the same question can land at 1.00 on one run and
  0.70 on the next with identical SQL and an identical figure. A paid key removes
  most of this.
- **How the planner shapes a question still moves the score.** Question 2 above
  scored 0.91 because the plan happened to include twelve thin per-country segments;
  a plan without them scores higher on the same figure. The headline is stable —
  47.9%, verified, in every run — but the segments around it are not, and they are
  worth up to 0.12.
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
   assumptions. Measured above: worth 0.24 on its own.
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

Then POST each question to `/api/conversations/:id/messages` — each in its own fresh
conversation, since the conversation id is part of the cache key — and read the
`insight` event from the SSE stream. Its `confidence.signals` array is the table above,
verbatim. The scoring itself is pure and unit-tested in
`backend/test/analytics/confidence.test.ts`.
