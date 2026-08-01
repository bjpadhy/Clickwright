# Clickwright — Agent Guide

Agentic analytics pipeline for the Atlys problem (Click-a-thon 2026). A feature spec goes in;
live optimized ClickHouse tables, updated business context, and a PM-ready insight report come
out — every decision traced in Langfuse.

## Repo layout

`backend/` — the pipeline: `src/` (core + agents), `prompts/`, `scripts/`, its own
package.json and `.env`. All npm commands run from here. `webapp/` — the frontend
(Run view, Chat, History, Context browser). Repo root — shared data only:
`specs/`, `base_context.md`, `docs/`.

## The two non-negotiables

1. **Numbers only ever come from ClickHouse.** The LLM writes SQL and narrates results. It never
   computes, estimates, or recalls a figure. Every number in an insight must exist in an attached
   query result. Numbers travel only along: `ndjson → tables → SQL results → report`.
2. **If a step isn't traced, it didn't happen.** Judges score traceability directly: outputs
   without a matching Langfuse trace score zero. Wrap the step in a span BEFORE writing its
   logic. Failed attempts stay in the trace — they are evidence the pipeline is real.

## Pipeline (strictly sequential per spec)

```
SETUP (once, pure code):   load.sh → 8 base tables · npm run seed → context_store v1
PER SPEC:                  getContext() → ① Instrumentation → ② updateContext() → ③ Analytics
```

Order matters: ① creates tables, ② documents them, ③ reads the documentation. Running ③ on
stale context is a scored failure.

## Module contracts

Shared core — import these, never reimplement:

```ts
// src/core/db.ts
query<T>(sql): Promise<T[]>          command(sql): Promise<void>
insert(table, rows): Promise<void>   rowCount(table): Promise<number>

// src/core/tracing.ts
startRun(name, input): trace                     // one per pipeline run
step(parent, name, input, fn): Promise<T>        // wrap EVERY unit of agent work
recordQuery(parent, name, sql, rows): void       // attach SQL + result rows to the trace
flushTraces(): Promise<void>                     // REQUIRED before process exit

// src/core/llm.ts
complete(parent, name, prompt, opts): Promise<string>   // the ONLY way to call the LLM
loadPrompt(name, vars): Promise<string>                  // prompts live in prompts/*.txt
stripFences(text) · splitStatements(sql)
```

Agent boundaries (validate handoffs with zod; fail loudly at the boundary):

```ts
// ① src/agents/instrumentation.ts
run(specPath, ndjsonPath, ctx, trace) → { tables: [{name, columns, purpose}], mvs: string[] }

// ② src/agents/context.ts
seed()                                   // base_context.md → context_store v1 (pure code, no LLM)
updateContext(spec, tablesSummary, trace) → ContextEntry[]     // LLM, once per spec
getContext(topic) → ContextBundle        // pure query: latest version per entity — never LLM recall

// ③ src/agents/analytics.ts
run(spec, ctx, trace) → InsightReport    // plan → SQL per task → sanity gate → narrate → quality gate
```

`context_store` schema: `(entry_id, entity, definition_md, version UInt32, updated_at, source_spec)`
— append-only; reads always `ORDER BY version DESC LIMIT 1 BY entity`.

## Generation rules

**DDL (①):** the profiler's measured stats are ground truth, not the LLM's guess.
`LowCardinality(String)` for <1k distinct values · `ORDER BY` starts with the join key
(`user_id` top-of-funnel, `application_id` after) then timestamp · `PARTITION BY toYYYYMM(ts)` ·
`DateTime64(3)` for timestamps · prefer defaults over `Nullable` · flatten nested JSON fields.

**SQL (③):** always filter duplicate/backfilled flag columns · bucket empty/missing `os` as
`'unknown'` · conversion is per SESSION (base_context.md) — never per user · never aggregate
`value` across currencies without grouping · include sample sizes in results.

**Self-healing loop (both):** generate → execute → on error, feed the verbatim ClickHouse error
back to the LLM → regenerate. Max 3 attempts, every attempt traced. Never silently swallow an
error; never "fix" generated SQL by hand.

**Narration (③):** the prompt must forbid uncited numbers. After narration, verify: extract
numbers from prose, check membership in attached results. When an anomaly is found, call
`getContext()` for related known issues (K1–K7) and cite matches — "iOS drop consistent with K1"
is the exact success example in the brief.

## Trace shape

One trace per run, named `pipeline:<spec_name>`. Spans nest:
`instrumentation` → `profile`, `ddl_generation`, `ddl_execution` (one child per attempt),
`data_load` · `context_update` (include v_n → v_n+1 diff) · `analytics` → `plan`,
`task_<n>_sql` (use `recordQuery`), `sanity_gate` (what was dropped and why), `narrate`,
`quality_gate`. LLM calls appear as generations automatically via `complete()`.

## Data traps (deliberately planted — recheck before trusting any result)

- `destination_card_clicked` has empty `application_id` (no application exists yet)
- Android rows often have empty-string `os` (not null)
- Duplicate + backfilled rows carry flags; unfiltered they corrupt every metric
- Supporting events (`search_typed`, `landing_page_scrolled`, `auth_completed`,
  `pay_now_clicked`) are engagement noise unless a question needs them
- Revenue = `value` in `currency`

## The unseen spec

A 6th spec drops in the final hours; it must run through the pipeline untouched — no hand-edited
DDL, SQL, or prose (trace must match output). Prefer general rules over spec-specific handling:
unknown envelope fields get added and noted in context, never crash the run.

## Working rules

- Prompts are files in `backend/prompts/` — tuning one never means editing `.ts`
- Commit to `main` every 30–45 min; no feature branches
- Node 20 (`nvm use`) · from `backend/`: `npm run check-env` before blaming code for a connection issue
- From `backend/`: `npm run seed` · `npx tsx scripts/run-instrumentation.ts ../specs/01_express_checkout [--yes]` ·
  `npx tsx scripts/reset-spec.ts <spec>` · `npm run typecheck`
