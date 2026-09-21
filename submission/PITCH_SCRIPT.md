# Clickwright -- Pitch & Demo Script

> **Format:** 10-min pitch + demo, then 5-min jury Q&A
> **Audience:** ClickHouse + Anthropic judges, technical
> **Key emphasis:** ClickHouse is not just the database -- it IS the platform. Langfuse is not bolted on -- it's wired into the execution primitive.

---

## PART 1: PITCH (Slides 1-4) -- ~3 minutes

### Slide 1 -- Title (15s)

> "Hey everyone, we're Team Shard Spartans -- Biswaranjan, Wilson, and Harshit. We built **Clickwright** -- an agentic analytics pipeline built entirely on **ClickHouse Cloud**. A PM uploads a feature spec and gets back live optimized tables, documented context, and cited insights -- with every single decision traced end-to-end in **Langfuse**."

### Slide 2 -- Problem (45s)

> "Here's the reality of analytics today. Four pain points:
>
> **One** -- schema design is guesswork. Engineers pick ordering keys and codecs by intuition. A wrong ordering key in ClickHouse means rebuilding the table -- and with event-scale data, that's expensive.
>
> **Two** -- context lives in people's heads. Metric definitions, data quirks, known issues -- scattered across Slack and tribal knowledge. Every new analyst starts from zero.
>
> **Three** -- AI analytics hallucinate. LLMs generate plausible-looking insights that cite figures not in the data. A PM acts on a number that doesn't exist.
>
> **Four** -- no audit trail. When an insight is wrong, there's no way to trace it back to the query, the schema decision, or the context that shaped it. You need full observability across the entire pipeline -- and that's exactly what Langfuse gives us."

### Slide 3 -- Solution (45s)

> "Clickwright solves this with a four-step flow: **spec in, insight out, every step traced.**
>
> Step one -- a PM uploads a feature spec with event samples. Step two -- the Instrumentation Agent profiles every field and generates **ClickHouse-optimized DDL** -- correct codecs, data-driven ordering keys, LowCardinality, partitioning -- all validated through `EXPLAIN AST` before execution. Human approves the schema. Step three -- the Context Agent updates a **versioned knowledge store living in ClickHouse** with new metrics, table docs, and funnel definitions. Human approves changes. Step four -- the PM asks questions in natural language, and the Analytics Agent writes SQL, executes it **read-only against ClickHouse**, verifies the headline with an independent query, and bounds every rate with Wilson confidence intervals.
>
> The key line: **every number traces back to a ClickHouse query result, and every query traces to a Langfuse span.** Nothing is a black box."

### Slide 4 -- Architecture (45s)

> "Three agents, one shared brain -- and that brain is **ClickHouse**.
>
> ClickHouse is not just the analytics database here. It's the **entire data platform**. Event tables, the versioned knowledge store, the insight cache, conversation history, run logs, dashboards -- all in ClickHouse. We chose this deliberately: one engine, one query language, one operational surface.
>
> The **Instrumentation Agent** profiles fields and generates DDL with ClickHouse best practices -- codecs like Delta and Gorilla, ReplacingMergeTree for dedup, ordering keys chosen from measured cardinality. Every DDL is dry-run through `EXPLAIN AST`.
>
> The **Context Agent** maintains an append-only versioned knowledge store using `LIMIT 1 BY entity` for latest-version reads.
>
> The **Analytics Agent** executes all queries with `readonly=1` -- it literally cannot mutate data.
>
> And wrapping everything: **Langfuse**. Every step, every LLM generation, every SQL query and its result rows, every retry, every approval decision -- captured as nested spans. We score every run with 13 numeric metrics that are sortable across all runs in the Langfuse dashboard. A wrong number is findable in 30 seconds."

---

## PART 2: LIVE DEMO -- ~6 minutes

### Demo Flow (recommended order)

1. **Upload a spec** (~1.5 min)
   - Show the spec upload UI
   - Point out the live step sidebar as the Instrumentation Agent runs: "You can see each step streaming in real time -- profiling, DDL design, dry run, approval gate, execution, data load, row count verification"
   - Approve the schema when the gate appears
   - **Emphasize:** "The DDL it generated uses Delta codec for timestamps, LowCardinality for the country field because profiling showed only 12 distinct values, and the ordering key puts application_id first because it has the highest cardinality. This was measured, not guessed."
   - Show the created tables in ClickHouse (or the success confirmation)

2. **Context update** (~1 min)
   - Show the Context Agent proposing new entries (metrics, table docs)
   - Approve the context changes
   - **Emphasize:** "This context store is a ClickHouse table -- append-only, versioned with ReplacingMergeTree. Any future agent or future conversation inherits what we just learned. Old versions are kept -- freshness is provable, not claimed."

3. **Ask a question** (~2 min)
   - Type a question like: "What is the checkout-to-purchase conversion rate by country?"
   - Show the step sidebar: planning, SQL execution, sanity gate, verification, narration
   - Point out the insight card: headline, findings, chart, segment table, confidence badge
   - **Emphasize:** "Notice the confidence badge says HIGH -- that's not the model's opinion. It's computed from the Wilson interval on the headline figure, an independent verification query that reproduced it, and zero citation retries -- and you can hover the badge to see every signal and what it cost. All of that is in the Langfuse trace."

4. **Ask a follow-up** (~1 min)
   - Ask: "How does this compare on iOS vs Android?"
   - **Emphasize:** "The system carries forward the prior answer's figures and denominators. If the denominator changes, it explains why -- no silent contradiction. The conversation history is stored in ClickHouse and hashed into the cache key."

5. **Show the Langfuse trace** (~1.5 min) -- SPEND TIME HERE
   - Open the trace for the answer you just got
   - **Walk through the tree:**
     - "Here's the root trace -- `chat:What is the conversion rate?` -- grouped by session ID so all turns in this conversation are together."
     - "Click into `plan` -- you see the full prompt we sent to the model and the plan it returned."
     - "Here's `task_t1` -- inside it, `sql_attempt_1` shows the generation (the SQL the model wrote), and `result_t1` shows the actual ClickHouse query and the first 50 result rows. **This is the audit trail -- every number in the insight traces back to this span.**"
     - "Here's `verification` -- a completely independent query that reproduced the headline figure. `verification_agreed: 1`."
   - **Show the scores sidebar:**
     - "These scores are sortable columns across ALL runs. I can sort by `citation_failures` to find runs where the narration needed retries. Sort by `verification_agreed` to find runs where the independent check disagreed. Sort by `rows_analyzed_total` to see how much data each answer actually covers."
     - "If a PM says 'this number looks wrong', I open the trace, find the SQL span, and see the exact query and rows that produced it. 30 seconds."

---

## PART 3: Q&A PREP -- Anticipated Questions & Answers

---

### Q1: "How does the confidence score work? What does LOW confidence actually mean?"

> "Confidence is **computed, never asked of the model**. A score starts at 1.0 and every weakness in the evidence subtracts from it, so the number is a receipt you can read line by line.
>
> **Three ceilings come first.** If an independently written verification query disagrees with the headline, the score cannot exceed **0.44** -- that is the strongest negative signal we have. If nothing could be verified, it cannot exceed **0.70**. If no figure carries a confidence interval at all -- sums, counts and means cannot be bounded -- it cannot exceed **0.60**.
>
> **Then the deductions.** The width of the Wilson interval on the *headline* figure. Small side segments, capped. Rates shipped without a denominator. Rates above 100%. Planned tasks that returned no data. Citation retries, where the narration named a number not in the results and had to be rewritten. And **assumptions** -- every gap the planner had to fill because the question did not pin it down.
>
> **One bonus:** naming a metric that is actually defined in the context store earns back 0.05.
>
> The key design decision is that the interval we charge for is the **headline** interval, not the widest one anywhere in the result. Ask 'how is checkout doing' and you get a population rate over 1,650 sessions alongside a couple of four-row device slices. Charging for the four-row slice would mark the whole answer LOW when the number the PM will actually act on is bounded to plus-or-minus 2.4 points. So the tails become a *note*, not a verdict.
>
> LOW means the evidence genuinely will not carry the claim: an independent query could not reproduce it, or the headline sample is too small to act on. It is a signal to collect more data, not a hedge.
>
> Bands are **non-overlapping**: HIGH is 0.75 and above, MEDIUM is 0.45 to 0.75, LOW is below 0.45, floored at 0.05. The label and the score can never disagree. Every signal ships to the UI as `name, delta, detail`, the deltas sum exactly to the score, and the score is recorded as a **Langfuse score** so you can sort every run by it in the dashboard."

---

### Q2: "Why didn't you use ClickHouse's built-in query cache?"

> "Great question. ClickHouse's query cache is keyed on **exact SQL text**. Our cache is keyed on **semantic meaning** -- and there are three specific reasons that matters:
>
> **First**, the Analytics Agent generates SQL dynamically -- table aliases, column order, LIMIT values can change between runs even for the same question. ClickHouse's cache would miss on all of those.
>
> **Second**, we need **context-aware invalidation**. Our cache key is a SHA-256 of the normalized question, the context version digest (a SHA-1 of every entity and its version in the knowledge store), and the conversation history digest. Any write to `context_store` changes the version digest, which automatically invalidates every cache key. ClickHouse's cache has no awareness of our application-level knowledge store.
>
> **Third**, we're caching the **complete insight** -- headline, chart, confidence, precision intervals, verification result -- not individual query results. A cache hit skips the entire agent pipeline (planning, SQL generation, narration, citation checking, verification) and returns in milliseconds. ClickHouse's cache would only speed up individual queries -- we'd still pay for all the LLM calls.
>
> The cache table itself is a ClickHouse **ReplacingMergeTree** with a 30-day TTL. So we're still using ClickHouse for caching -- just at the right abstraction level. The `cache_hit` metric is recorded as a Langfuse score on every run, so we can track hit rates across the dashboard."

---

### Q3: "Walk me through what happens between the PM's question and the final insight."

> "Twelve steps, and I'll call out where ClickHouse and Langfuse are involved in each:
>
> 1. **Context load** -- reads the knowledge bundle from **ClickHouse's `context_store` table** using `LIMIT 1 BY entity` for latest versions. Also loads table schemas. Computes a context version digest for cache lookup. *(Langfuse span: context_load)*
>
> 2. **Cache check** -- SHA-256 of question + context version + conversation history. Looks up the **ClickHouse `insight_cache` table**. If it hits, returns the cached insight in milliseconds. *(Langfuse score: cache_hit=1)*
>
> 3. **Pre-plan lookup** -- term-matching (no LLM) against context store entries in **ClickHouse** for relevant known issues and metric definitions. Surfaces things like 'K1: iOS OTP autofill regression' before planning even starts.
>
> 4. **Plan** -- the LLM creates up to 4 aggregate tasks. It sees simplified **ClickHouse table schemas** (DateTime->[time], String->[dim]) to save tokens. *(Langfuse: generation with full prompt and plan output)*
>
> 5. **SQL per task** -- each task gets SQL generated by the LLM, guarded (banned keywords, single statement, LIMIT cap), and executed against **ClickHouse with `readonly=1`**. Up to 3 self-healing retries -- the real ClickHouse error is fed back. Independent tasks run concurrently. *(Langfuse: generation for SQL write + recordQuery with query text and first 50 result rows)*
>
> 6. **Result digest** -- if a result exceeds 24 rows, we run aggregate queries **inside ClickHouse**: population-weighted rates, min/max/p50, top-5 and bottom-5 rows. This is critical -- accuracy comes from ClickHouse computing over the full result set, not Node extrapolating from a sample. *(Langfuse: recordQuery for digest SQL)*
>
> 7. **Sanity gate** -- code drops empty results, flags rates above 100%, warns when all sample sizes below 50. *(Langfuse score: sanity_flags)*
>
> 8. **Verification** -- started concurrently with narration. An independently written query is executed **read-only against ClickHouse** to cross-check the headline. Agreement within 2% counts as verified. *(Langfuse: generation + recordQuery + score: verification_agreed)*
>
> 9. **Knowledge lookup** -- LLM picks relevant entries from the **ClickHouse context store** that explain anomalies. This turns 'what' into 'why'.
>
> 10. **Precision** -- Wilson 95% confidence intervals computed in code on every proportion. Only proportions get intervals -- we're honest about what we can't bound. *(Langfuse score: precision_half_width_pp)*
>
> 11. **Narration** -- the LLM writes the insight: headline, what's happening, why, evidence, grounded context, recommended action. *(Langfuse: generation)*
>
> 12. **Citation check** -- every number in the narration is checked against values from the **ClickHouse query results**. Uncited numbers force a rewrite. Up to 3 attempts. *(Langfuse score: citation_failures)*
>
> Then a **quality gate** and the final insight is written to the **ClickHouse `insight_cache`** for future cache hits. *(Langfuse score: quality_gate_passed, confidence_computed, rows_analyzed_total)*
>
> Every single step is a Langfuse span. 13 numeric scores are recorded per run."

---

### Q4: "How do you read a Langfuse trace? What should I look for?"

> "Let me walk you through what you see when you open a trace.
>
> **Trace list view**: Every run appears as a row. The 13 scores we record -- `verification_agreed`, `citation_failures`, `confidence_computed`, `rows_analyzed_total`, `cache_hit`, `self_heal_attempts`, `sanity_flags` -- all show up as **sortable columns**. So you can instantly find: 'show me all runs where verification disagreed', or 'sort by citation failures to find unreliable runs'.
>
> **Inside a single trace**: You see a tree of nested spans that mirrors exactly how the code executed:
>
> ```
> Trace: chat:What is the conversion rate?
> +-- context_load (~500ms)
> +-- plan (contains LLM generation -- full prompt + response visible)
> +-- task_t1
> |   +-- sql_attempt_1 (LLM generation: the SQL the model wrote)
> |   +-- result_t1 (input: the SQL query text, output: row count + first 50 rows)
> |   +-- digest_t1 (the ClickHouse aggregate profiling query + stats)
> +-- task_t2 (concurrent with t1)
> +-- sanity_gate
> +-- verification
> |   +-- verify_sql (generation)
> |   +-- verification_result (the independent query + its rows)
> +-- narrate (generation: the insight text)
> +-- quality_gate
> Scores: [verification_agreed:1, citation_failures:0, confidence:2, rows_analyzed:6715, ...]
> ```
>
> **For every LLM generation**: you see the full prompt, the completion, the model, token count, and cost. This is invaluable for prompt debugging.
>
> **For every SQL execution**: you see the exact query text and the result rows. This is the audit trail -- every number in an insight traces back to one of these `recordQuery` spans.
>
> **Failed attempts are kept.** If SQL generation took 2 retries, you see `sql_attempt_1` (error), `sql_attempt_2` (success). The `self_heal_attempts` score tells you how many tries it took. This is evidence the self-healing loop works.
>
> The key value of Langfuse here: **if a PM says 'this number looks wrong', you open the trace, find the narration span, trace back to the SQL span, see the exact query, see the exact rows, and know in 30 seconds whether the number came from the data or was hallucinated.** That's the whole point."

---

### Q5: "What happens if the LLM generates bad SQL or a bad schema?"

> "Self-healing, with ClickHouse providing the feedback and Langfuse recording every attempt.
>
> For **DDL** in the Instrumentation Agent: we dry-run every schema through ClickHouse's `EXPLAIN AST`. If it fails, the **real ClickHouse error message** is fed back to the LLM and it regenerates. Up to 3 attempts. If all 3 fail, the **deterministic baseline ships unchanged** -- code-generated DDL from the profiling measurements, which is correct but not optimized. The pipeline never produces an invalid schema.
>
> For **SQL** in the Analytics Agent: every query is guarded (ClickHouse `readonly=1`, banned keywords, single statement, LIMIT cap). If execution fails, the ClickHouse error goes back to the LLM for retry. Up to 3 attempts. Transient ClickHouse errors (timeouts, network) get a 1-second delay before retry.
>
> For **JSON output**: everything is parsed through Zod schemas. Malformed output triggers a retry with the verbatim parse error.
>
> All of this is visible in Langfuse. Failed attempts are **kept as spans**, not deleted. The `self_heal_attempts` score counts how many tries it took. You can sort by this score in the dashboard to find runs where healing was needed and audit what went wrong."

---

### Q6: "How does the context store work? Why not just use a vector database?"

> "The context store is an **append-only, versioned ClickHouse table** using ReplacingMergeTree. Each entry has an entity name, a namespace (like `metric:`, `convention:`, `table:`, `known_issue:`), a version number, and the definition text.
>
> Reads resolve the latest version per entity via ClickHouse's `ORDER BY entity ASC, version DESC LIMIT 1 BY entity`. Writes append as version n+1 -- old versions are kept for audit.
>
> Why not a vector database? Three reasons:
>
> 1. **Precision over recall.** We need exact metric definitions, not 'similar' ones. When the Analytics Agent needs the definition of `checkout_conversion_rate`, it needs the exact numerator and denominator, not a fuzzy match. ClickHouse gives us exact lookups.
>
> 2. **Versioning is critical.** We need to know what the definition was when the insight was generated. Append-only with versions gives us that for free in ClickHouse. A vector DB would need custom versioning bolted on.
>
> 3. **One platform.** Everything is in ClickHouse -- event tables, context, cache, run history, conversations, dashboards. Adding a vector DB means another system to operate, another failure mode, another latency hop. ClickHouse is already fast enough for our retrieval pattern (small table, exact lookups by entity), so a vector DB adds complexity without benefit."

---

### Q7: "What ClickHouse-specific features are you leveraging?"

> "ClickHouse isn't just the database -- it's the entire data platform. Here's what we use:
>
> **For schema generation:**
> - **Data-driven ordering keys**: The profiler measures cardinality per field. High-cardinality fields go first in the ORDER BY for optimal compression and query performance.
> - **LowCardinality wrapper**: Automatically applied when measured cardinality is below threshold. Not guessed -- measured from the actual data.
> - **Decimal64 for money**: Detected from field names and value ranges.
> - **Codec selection**: Delta for timestamps, DoubleDelta for monotonic sequences, Gorilla for floats, ZSTD for strings -- the LLM picks based on the data profile, guided by a ClickHouse architecture review skill.
> - **EXPLAIN AST**: Every DDL is dry-run before execution.
>
> **For the data platform:**
> - **ReplacingMergeTree**: Used for `context_store` (dedup by version) and `insight_cache` (dedup by timestamp). No manual cleanup needed.
> - **TTL**: 30-day expiry on cached insights.
> - **`LIMIT 1 BY entity`**: Elegant latest-version resolution for the knowledge store.
> - **`readonly=1`**: Analytics queries physically cannot mutate data.
>
> **For analytics accuracy:**
> - **Full-result profiling inside ClickHouse**: When results exceed 24 rows, we run aggregate queries (population-weighted rates, min/max/p50, extremes) in ClickHouse rather than pulling rows to Node. The insight's numbers come from ClickHouse computing over the full set, not from sampling.
> - **Materialized views**: Created during instrumentation for common access patterns.
>
> Everything -- events, context, cache, conversations, run logs, dashboards -- lives in one ClickHouse Cloud instance."

---

### Q8: "How do Wilson intervals work and why Wilson specifically?"

> "A Wilson score interval computes a confidence interval for a binomial proportion that stays valid at small sample sizes and near 0% or 100%.
>
> The normal approximation breaks down at small n or extreme p -- it can produce intervals below 0 or above 1. Wilson corrects for this by adjusting both the center and the width.
>
> We use z=1.96 for a 95% interval. The output is a lower and upper bound clamped to [0, 1].
>
> We only apply Wilson to **proportions** -- rates, shares, percentages. Means would need a standard deviation (which our ClickHouse queries don't emit). Quantiles would need bootstrapping. Unbounded ratios need Poisson intervals. We don't pretend -- if we can't compute a valid interval, we say so explicitly in the precision notes.
>
> The denominator resolution is smart: for funnel queries like `purchased / offer_shown AS attach_rate`, we parse the SQL to find the divisor. For simpler cases, we match by naming convention (`success_rate` -> `success_n`). If the row has multiple rate columns and an ambiguous bare `n`, we refuse to assign it -- a wrong denominator would produce a misleading interval.
>
> One caveat we document: rows are events, and multiple events can come from one user, so trials aren't fully independent. The real uncertainty is a little wider than Wilson suggests. We note this as a lower bound.
>
> The half-width of the widest interval is recorded as the Langfuse score `precision_half_width_pp` -- so you can sort all runs by interval width."

---

### Q9: "What about security? Can the LLM modify or delete data?"

> "No, by construction -- and ClickHouse enforces it.
>
> Analytics queries run via `queryReadonly()` which sets **ClickHouse `readonly=1`** at the connection level. Even if the LLM somehow generated a DROP TABLE, ClickHouse itself would reject it.
>
> On top of that, we have a SQL guard that bans keywords before execution: INSERT, ALTER, DROP, CREATE, TRUNCATE, DELETE, UPDATE, GRANT, REVOKE. Single statement only -- no semicolons allowed. And there's a LIMIT cap to prevent accidental full-table scans.
>
> The Instrumentation Agent is the only agent that can write DDL, and that requires explicit human approval through the approval gate before any CREATE TABLE runs. That approval decision is recorded in the **Langfuse trace** as an `approval_result` event."

---

### Q10: "How does conversation history work across follow-up questions?"

> "We carry forward the last 12 turns with smart compression. The most recent 4 turns get full detail -- the complete question, SQL, ClickHouse results, and insight. Older turns (up to 8 more) are compressed to just the question and headline.
>
> Critically, we carry **established figures** -- the actual numbers from prior answers along with their denominators and source tables. If a previous answer reported UAE conversion as 56.6% with n=1,007, the next turn knows both the number and the denominator it rests on.
>
> If a follow-up answer produces a different denominator for the same metric, it's **explained in the narration**, not silently changed. This prevents denominator drift, which is one of the sneakiest sources of confusion in analytics.
>
> We also forward **dropped tasks** -- tasks that failed in previous turns -- so the planner doesn't repeat impossible work.
>
> Conversation history is stored in **ClickHouse** and hashed into the cache key, so the same question in different conversations gets separate cache entries."

---

### Q11: "What model are you using and why?"

> "Claude Sonnet 5 via the Anthropic API. We chose Claude for three reasons:
>
> 1. **Structured output reliability** -- every LLM call returns JSON parsed through a Zod schema. Claude has the best adherence to strict output formats in our testing.
> 2. **Strong SQL generation** -- particularly for ClickHouse-specific syntax (codecs, ordering keys, LowCardinality, ReplacingMergeTree).
> 3. **Multi-section prompt following** -- the Analytics Agent's narration prompt has six distinct sections. Claude reliably fills all of them without merging or skipping.
>
> We pin effort to `medium` -- our prompts are tightly specified and schema-validated, so extended thinking isn't needed and would just add latency.
>
> Every LLM call is recorded as a **Langfuse generation** -- full prompt, completion, token count, cost. So we can audit any model decision and track token costs across all runs."

---

### Q12: "What's the latency? How long does it take?"

> "Three scenarios:
>
> - **Spec to live tables**: ~30 seconds (profiling, DDL design with ClickHouse best practices, EXPLAIN AST dry-run, execution, data load, row count verification)
> - **Question to cited insight**: ~15 seconds (planning, SQL execution against ClickHouse, verification, narration, citation check)
> - **Cached repeat question**: ~0.6 seconds (single ClickHouse SELECT from `insight_cache` + JSON parse)
>
> The bottleneck is LLM calls -- we run them concurrently wherever possible (independent SQL tasks, verification parallel with narration, knowledge lookup parallel with precision). The ClickHouse queries themselves are fast -- typically under 200ms.
>
> You can see exact timings per step in the **Langfuse trace** -- every span records `elapsedMs`, so you know exactly where the time went."

---

### Q13: "Is this production-ready or a hackathon prototype?"

> "It's closer to production than most hackathon projects, but there are things we'd add:
>
> What's production-grade today: type safety end-to-end (TypeScript + Zod), data safety by construction (ClickHouse `readonly=1`), full observability via Langfuse with 13 scored metrics per run, self-healing retries, human approval gates, versioned context with audit trail in ClickHouse.
>
> What we'd add for production: authentication and RBAC, rate limiting, more granular TTLs per insight type, support for scheduled reports, and a feedback loop where PM corrections update the ClickHouse context store automatically."

---

### Q14: "How deep is the Langfuse integration? Is it just logging?"

> "Langfuse is not a bolt-on logger -- it's wired into the **core execution primitive** that every agent operation passes through.
>
> There's a single function called `step()` in `core/tracing.ts` that wraps every unit of work. It creates a Langfuse span on entry, records output (or error) on exit, measures elapsed time, and emits SSE events for the live UI. No agent code touches Langfuse directly -- all tracing flows through this one function.
>
> Five integration points:
> 1. **`step(parent, name, input, fn)`** -- wraps every operation as a Langfuse span
> 2. **`recordQuery(parent, name, sql, rows)`** -- records every SQL execution with query text and first 50 result rows
> 3. **`complete(parent, name, prompt, opts)`** -- records every LLM call as a Langfuse generation with prompt, completion, model, and token usage
> 4. **`scoreRun(ctx, name, value, comment)`** -- attaches numeric scores to the trace
> 5. **`startRun(name, input, opts)`** -- creates the root trace with session grouping
>
> We record **13 numeric scores** per analytics run: `cache_hit`, `analytics_tasks`, `sql_attempts_total`, `digests_computed`, `digest_failures`, `rows_analyzed_total`, `sanity_flags`, `citation_failures`, `quality_gate_passed`, `verification_agreed`, `precision_half_width_pp`, `confidence_computed`, and `rows_listed`. These show up as sortable columns in the Langfuse dashboard.
>
> The result: every number in an insight traces backward through the Langfuse tree -- narration span to SQL span to query text to ClickHouse result to verified by an independent query. A wrong number is findable in 30 seconds. Failed attempts are kept as evidence, not deleted. This is what makes the system auditable."

---

### Q15: "Why did you put everything in ClickHouse instead of using separate databases?"

> "Deliberate architectural decision. ClickHouse is not just our analytics engine -- it's our **entire application data platform**.
>
> Here's what lives in ClickHouse:
> - **8 base event tables** (~3.5M rows) + spec-created tables with optimized schemas
> - **`context_store`** -- versioned knowledge (ReplacingMergeTree, LIMIT 1 BY for latest version)
> - **`insight_cache`** -- semantic answer cache (ReplacingMergeTree, 30-day TTL)
> - **`conversations`** -- chat history
> - **`runs_log`** -- pipeline execution history
> - **Dashboards** -- materialized views for common access patterns
>
> Why one system?
> 1. **Operational simplicity** -- one connection string, one backup strategy, one monitoring surface
> 2. **Consistent query language** -- the same SQL the Analytics Agent writes to query events can also query context and cache
> 3. **Atomic cache invalidation** -- any context write changes the version digest, which invalidates all cache keys. This works because context and cache are in the same engine
> 4. **ClickHouse is fast enough** -- context lookups are small-table exact matches (microseconds). We don't need Redis. Cache lookups are primary-key reads on ReplacingMergeTree. We don't need Memcached.
>
> Adding Postgres, Redis, or a vector DB would mean more systems to operate, more failure modes, and more latency hops -- with no performance benefit for our access patterns."
