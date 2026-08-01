# Eval script — 07_bundled_price_experiment

Chat questions for the analytics agent, keyed to the traps in `EXPECTED.md`.
Ask the opener, then the follow-ups **in order**.

Legend: **PASS** = what a correct agent does · **FAIL** = the tell that it fell in.

---

## Thread A — Simpson's paradox (T1, T2) · the headline test

**A1 (open).** *"Which pricing variant should we ship?"*

- **PASS** — refuses the naive read. Reports overall bundle **51.7%** (434/840) vs
  control **46.4%** (817/1,760), *then* the within-tier picture showing bundle behind
  in all three tiers, and recommends **not** shipping bundle.
- **FAIL** — "ship bundle, +5.3pp" with no segmentation.

**A2 (follow-up — force the cut).** *"Break conversion down by `tier`."*

- **PASS** — economy 62.9% (373/593) vs **62.2%** (318/511) · standard 47.0% (271/576)
  vs **38.2%** (89/233) · priority 29.3% (173/591) vs **28.1%** (27/96). Bundle loses
  in every one. Explicitly names the reversal against the pooled number.
- **FAIL** — reports the tiers but doesn't notice they contradict A1 · omits sample
  sizes (the priority bundle cell is n=96 and that caveat is load-bearing).

**A3 (follow-up — why).** *"If bundle loses in every tier, how is it ahead overall?"*

- **PASS** — mix. Bundle traffic is **61% economy / 28% standard / 11% priority**
  against control's **34 / 33 / 34**, and economy converts about twice as well as
  priority. The arms aren't comparable populations.
- **FAIL** — calls it noise · calls it a statistical artefact without identifying the
  mix · invents a mechanism about the "no hidden fees" badge.

**A4 (follow-up — assignment integrity).** *"Was this experiment randomised properly?"*

- **PASS** — no. Bundle is ~96% India (the all-in pricing service is INR-only at
  launch), and India skews to economy. Recommends re-running with balanced assignment
  before trusting any headline; treats the current result as directional at best.
- **FAIL** — asserts the split was random · doesn't check the geo composition of the
  arms.

---

## Thread B — money (T3, T5)

**B1 (open).** *"What's the average price we quoted, and the average amount paid?"*

- **PASS** — refuses to average `price_local` / `payment_amount_local` across 7
  currencies (INR 1,578 · SGD 262 · AED 250 · USD 171 · AUD 132 · GBP 125 · SAR 82).
  Answers in `price_inr` / `payment_amount_inr`, or reports per-currency.
- **FAIL** — a single mixed-currency mean. This is the base-context violation to catch.

**B2 (follow-up — the real bottom line).** *"Revenue per quote by variant."*

- **PASS** — control **INR 3,376** vs bundle **INR 2,452** (totals 5,942,124 vs
  2,059,588). Points out that the arm that "won" conversion earns ~27% less per quote,
  which kills the ship recommendation independently of the paradox.
- **FAIL** — reports total revenue only (control's total is larger simply because it
  has 2.1x the quotes) · uses local amounts.

**B3 (follow-up — the coupon).** *"How much of this is the auto-coupon?"*

- **PASS** — SUMMER20 quotes convert **68.9%** (262/380) vs **44.5%** (989/2,220)
  without: a +24pp lift bought with a 20% discount. Cites **K6**. Notes the coupon is
  concentrated in India-economy, i.e. concentrated in the bundle arm — a second
  confound stacked on the first.
- **FAIL** — reports the conversion lift as a clean win without the discount cost ·
  misses that coupon exposure differs by arm.

**B4 (follow-up — adversarial, false premise).** *"Great — so if we auto-apply
SUMMER20 to every quote we'd add 24pp of conversion?"*

- **PASS** — no. The +24pp is measured on a self-selected slice (India economy), it
  costs 20% of realised value per order, and nothing here estimates incrementality on
  travellers who would have paid full price. Names what a proper holdout would need.
- **FAIL** — extrapolates the 24pp to all quotes and multiplies it out.

---

## Thread C — definitions and provenance (T4, T6)

**C1 (open).** *"What's the conversion rate for this feature?"*

- **PASS** — computes it per **session** (`session_id`, 2,600 quote sessions) per
  `base_context.md` §4, and says so.
- **FAIL** — per `user_id` · per quote row without noting rows and sessions coincide
  only on `price_quote_shown`.

**C2 (follow-up).** *"How many distinct users is that, and does it change the answer?"*

- **PASS** — reports both counts, and states which denominator the headline used.
  Doesn't quietly switch metrics mid-conversation.
- **FAIL** — silently re-answers on a user denominator and lets the number drift from
  C1.

**C3 (follow-up — checkout-stage split).** *"Where in the flow does bundle lose —
before or after `checkout_started`?"*

- **PASS** — splits quote → started and started → paid, with sample sizes at each
  stage, and reports which leg carries the gap.
- **FAIL** — a single quote → paid figure re-labelled as a step analysis.

**C4 (follow-up — provenance).** *"List every number you've given me and the query
behind it."*

- **PASS** — each figure maps to an attached result set; nothing untraceable.
- **FAIL** — any number it can't point at, especially a delta it computed in prose
  rather than in SQL.
