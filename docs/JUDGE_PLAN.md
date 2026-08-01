# Answer Judge — background evaluation of every chat answer

A secondary agent that grades each Analytics Agent answer out of band, on two axes the
user named: **was the data returned actually relevant to what was asked**, and **was the
SQL it wrote correct**. One entry per user question, surfaced in a new Observability tab.

---

## 1. Why this is not the quality gate we already have

`analytics.ts` already runs an inline `quality_gate` (`analytics_review_quality.txt`). It is
worth being precise about the difference, because building a second copy of it would be
waste:

| | existing `quality_gate` | proposed judge |
|---|---|---|
| when | inline, in the critical path | after the answer is sent, out of band |
| purpose | can force a **rewrite** before the user sees it | records a **verdict**; never changes the answer |
| sees | question, narration, result text | question, narration, results, **the SQL**, the live schema, the conventions |
| judges | is the prose actionable, does it cite numbers, name a segment, link a known issue, is confidence honest | **relevance** of the answer to the question, and **correctness of the SQL** |
| SQL | never looks at it | the whole point |
| independence | same run, same context, anchored on the agent's own framing | separate trace, given ground truth directly, asked to refute |

They coexist. The gate is a *rewriter*; the judge is an *auditor*. Where the two disagree —
gate passed, judge failed — that disagreement is itself the most interesting row in the
tab, and worth surfacing as a flag.

Two existing pieces are deterministic and already trustworthy; the judge consumes their
output as evidence rather than re-deriving it:

- `findUncitedNumbers()` — every number in the prose must exist in the results or be a
  verifiable difference/ratio of two that do.
- `sanityGate()` — drops empty result sets, flags rates above 100%.

---

## 2. The hard part: LLM-as-judge is a soft grader

A model asked "is this answer good?" says yes. Three things make this judge worth
believing:

**Deterministic pre-checks do the work code can do.** `base_context.md` documents the exact
traps this dataset was built around, and every one of them is checkable with a regex over
the SQL, with no model involved:

| check | what it looks for | source |
|---|---|---|
| `duplicate_id IS NULL` present | ~3% of rows are duplicates | `convention:data_hygiene` |
| `is_back_filled` filtered | ~2% backfilled | same |
| `os` empties bucketed | `os IS NULL OR os = ''` → `'unknown'`, ~18% of android | same |
| currency grouped | never `sum(value)` without `GROUP BY currency` | `table:purchase_completed` |
| denominator | session vs user — conversion is per **session** | `metric:conversion_rate` |
| top-of-funnel join | `application_id` is empty on `destination_card_clicked` | `instrumentation_notes` |

These produce a factual findings list. The model is then asked to *explain and weigh* them,
not to discover them. A missing hygiene filter is reported as fact whatever the model says.

**The judge is given ground truth, not the agent's reasoning.** It receives the live column
list from `system.columns` and the relevant `context_store` conventions directly. It is
deliberately **not** shown the agent's `confidence.note` or the `quality_gate` verdict
before judging — anchoring on the generator's self-assessment is exactly how a judge
becomes a rubber stamp.

**It is asked to refute, and to cite.** Each criterion requires a verdict *plus the
specific evidence* — a column name, a filter that is absent, a row count. A verdict with no
citation is rejected by the schema and regenerated.

**Open decision:** the judge uses the same model as the agent. Self-evaluation is a known
weakness. Cheapest mitigation is a different model tier for the judge; worth deciding
before demo.

---

## 3. Where the judge gets its inputs

This is the one real plumbing change. The stored `Insight` carries
`sql: [{task, title, query, rowCount}]` — the query text but **not the rows**. Judging
relevance without seeing the data is guesswork.

`runAnalytics` already has the rows in memory (`TaskResult[]`). The plan is to return them
alongside the insight rather than persist or re-query:

```ts
// analytics.ts — additive, does not change the Insight contract the UI reads
export interface AnalyticsOutcome {
  insight: Insight;
  /** Per task: the SQL and a bounded row sample. Not persisted with the message;
   *  handed straight to the judge, which stores what it needs. */
  evidence: Array<{
    task: string; title: string; sql: string;
    rowCount: number; rows: Record<string, unknown>[]; // capped at 20
    dropped?: string; flags: string[];
  }>;
}
```

`streamAnswer` keeps sending `insight` unchanged and passes `evidence` to the judge.

For **backfill** of turns answered before this ships, there are no rows in memory — the
judge re-executes the stored SQL through `queryReadonly` and marks the entry
`evidence_source: "replayed"`, because the data may have moved since. Live answers are
`"captured"`.

---

## 4. Trigger and isolation

Fire-and-forget at the end of `streamAnswer`, after `send("insight")` and outside the
`withRunSink` scope — a judge event leaking into a chat SSE stream that has already closed
is a bug waiting to happen.

Three isolation rules, all of which matter:

1. **A judge failure can never affect the answer.** The whole call is wrapped; it logs and
   drops.
2. **Never judge a cache hit.** `insight.cached === true` means no new SQL and no new
   reasoning — it is the same answer, already judged. The entry reuses the prior judgement
   for that `(question, contextVersion)` key and is flagged `reused: true`, so the tab still
   shows one row per question without paying for a duplicate LLM call.
3. **Bounded concurrency.** A serial in-process queue (same shape as `RunManager`'s). Three
   people demoing at once must not fire three judge calls into the same rate limit as the
   answers they are waiting on.

---

## 5. Storage

```sql
CREATE TABLE IF NOT EXISTS chat_judgements (
  conv_id           String,
  seq               UInt32,          -- the agent turn being judged
  question          String,
  asked_at          DateTime64(3),
  judged_at         DateTime64(3),

  overall           LowCardinality(String),   -- pass | warn | fail
  relevance_verdict LowCardinality(String),
  relevance_score   Float32,                  -- 0..1
  relevance_reason  String,
  sql_verdict       LowCardinality(String),
  sql_score         Float32,
  sql_reason        String,

  findings_json     String,   -- per-query findings + deterministic check results
  gate_agreed       UInt8,    -- did the inline quality_gate agree?
  evidence_source   LowCardinality(String),   -- captured | replayed
  reused            UInt8,
  model             String,
  answer_trace_url  String,
  judge_trace_url   String
) ENGINE = ReplacingMergeTree(judged_at) ORDER BY (conv_id, seq)
COMMENT 'Independent post-hoc evaluation of each Analytics Agent answer'
```

`ReplacingMergeTree(judged_at)` so a re-judge supersedes cleanly rather than duplicating.

---

## 6. API

Follows the existing `/api/observe/*` surface and the `api/observability.ts` client pattern.

```
GET  /api/observe/judgements?limit=50&verdict=fail   → JudgementRow[]
POST /api/observe/judgements/:convId/:seq/rejudge    → 202
POST /api/observe/judgements/backfill                → 202 { queued: n }
```

```ts
export interface JudgementRow {
  convId: string; seq: number;
  question: string; askedAt: string; judgedAt: string;
  overall: "pass" | "warn" | "fail";
  relevance: { verdict: "pass" | "warn" | "fail"; score: number; reason: string };
  sql: { verdict: "pass" | "warn" | "fail"; score: number; reason: string };
  findings: Array<{
    kind: "hygiene" | "denominator" | "currency" | "join" | "citation" | "coverage";
    severity: "info" | "warn" | "fail";
    text: string;
    task: string | null;
  }>;
  queries: Array<{ task: string; title: string; sql: string; rowCount: number }>;
  gateAgreed: boolean;
  evidenceSource: "captured" | "replayed";
  reused: boolean;
  answerTraceUrl: string | null;
  judgeTraceUrl: string | null;
}
```

---

## 7. The tab

A fourth Observability tab, **Answer quality**, next to Agent activity / Database health /
Changelog. Reuses `useLoadable`, `LoadError`, `EmptyNote`, `UnavailableNote` from the
wiring already shipped.

- **Stat cards** — questions judged · pass rate · SQL-correctness pass rate · disagreements
  with the inline gate.
- **Filter chips** — Everything / Failed / Warnings / Gate disagreed.
- **One row per question**, newest first: the question, two verdict pills (Relevance, SQL),
  the time, and a chip linking to the conversation.
- **Expanded row** — each criterion's reason, the findings list with severity, the SQL per
  task with row counts, and both trace links (answer and judge).
- **Empty state** that says *no answers judged yet* rather than implying a clean bill of
  health. A quality screen showing an empty pass rate is worse than one saying nothing has
  been measured.

---

## 8. Tracing

One Langfuse trace per judgement, `judge:<question>`, `sessionId = convId` so it groups
with the conversation it audits, cross-linked both ways via `answer_trace_url` /
`judge_trace_url`. Spans: `judge_evidence` (deterministic checks, no LLM) →
`judge_relevance` → `judge_sql` → generation. Scores: `relevance`, `sql_correctness`,
`gate_agreement` — so the Langfuse score columns show quality drift across a demo without
opening the app.

---

## 9. Build order

**Phase 1 — evidence and checks (no LLM).** `runAnalytics` returns `evidence`; the
deterministic convention checks land as pure, unit-tested functions over SQL text. On their
own these already produce a useful findings list. Tests here are cheap and high value —
each documented trap gets a positive and a negative case.

**Phase 2 — the judge agent.** Prompt, zod-validated output with required citations, the
serial queue, storage, and the fire-and-forget trigger. Backfill endpoint for existing
turns.

**Phase 3 — the tab.** List, filters, expansion, stat cards, wired through
`api/observability.ts`.

**Phase 4 (optional) — surface it in Chat.** A quiet marker on an answer whose judgement
failed. Not requested; mentioned because it is the natural payoff and is cheap once the
data exists.

Phases 1–3 are the ask. Phase 1 is independently useful even if the LLM half is cut.

---

## 10. Risks

1. **Generous judging.** Handled by deterministic evidence, required citations, and refute
   framing — but it will not be eliminated. Treat the SQL-correctness axis as the reliable
   one (it is checkable) and relevance as advisory.
2. **Same model judging itself.** Flagged above; a different tier for the judge is the
   cheap fix.
3. **Cost.** One extra LLM call per distinct question. Cache hits are free by design, and
   backfill is bounded and explicit.
4. **No ground truth for the judge itself.** Worth hand-labelling ~10 answers before the
   demo to confirm the judge disagrees with the agent at least sometimes. A judge that
   passes everything is indistinguishable from no judge.
5. **Replayed evidence can drift.** Backfilled entries re-run SQL against data that may have
   changed; flagged in the row rather than hidden.
