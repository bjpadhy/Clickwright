# Clickwright — Agent Guide

Agentic analytics pipeline on ClickHouse. A feature spec goes in; live optimized tables,
updated business context, and PM-ready insights come out — every decision traced in Langfuse.

Built for Click-a-thon India 2026 (Atlys problem statement).

## The two non-negotiables

1. **Numbers only ever come from ClickHouse.** The LLM writes SQL and narrates results.
   It never computes, estimates, or recalls a figure. Every number in an insight must be
   present in an attached query result.
2. **If a step isn't traced, it didn't happen.** Judges score traceability directly:
   hand-written schemas or insights without a matching Langfuse trace score zero.
   Wrap every agent step in a span before writing its logic, not after.

## Architecture

```
SETUP (once, deterministic — no LLM)
  load.sh            → 8 base event tables in ClickHouse
  npm run seed       → base_context.md parsed into context_store (v1)

PER SPEC (agentic, strictly sequential)
  getContext()  →  Instrumentation  →  updateContext()  →  Analytics
```

| Agent | Input | Output | Verified by |
|---|---|---|---|
| **Instrumentation** | `spec.md`, `events.ndjson`, context | executed DDL, materialized views, loaded rows | ClickHouse executes the DDL; row-count reconciliation after load |
| **Context** | spec + new-tables summary | versioned rows in `context_store` | append-only writes; reads are plain queries, never LLM recall |
| **Analytics** | PM questions + fresh context + live tables | insight report citing real numbers | sanity gates (sample size, impossible rates) + citation check |

The Context Agent has two distinct jobs: **write** (`updateContext`, once per spec, between
Instrumentation and Analytics) and **serve** (`getContext`, callable anytime, especially by
the Analytics narrator when it finds an anomaly worth explaining).

## Layout

```
src/
  core/        db.ts · tracing.ts · llm.ts      — shared; import these, don't reimplement
  agents/      instrumentation.ts · context.ts · analytics.ts
  pipeline.ts  the orchestrator — opens the trace, runs the three stages in order
scripts/       seed-context.ts · run-spec.ts · check-env.ts
prompts/       ddl.txt · plan.txt · narrate.txt  — prompts live as text files, not in code
out/           generated insight reports (gitignored)
```

## Conventions

- **Prompts are files, not string literals.** Tuning a prompt should never mean editing a `.ts` file.
- **Every LLM call goes through `src/core/llm.ts`** so tracing, retries, and model config stay in one place.
- **Self-healing loops.** DDL and SQL both follow: generate → execute → on error, feed the real
  ClickHouse error back to the LLM → retry (max 3). Failed attempts stay in the trace; they're
  evidence of a working pipeline, not something to hide.
- **Validate agent boundaries with zod.** Malformed data must fail loudly at the handoff, not
  silently three stages later.
- **Commit to `main` every 30–45 minutes.** No feature branches — conflicts are cheaper when small.

## Data traps (deliberately planted in the dataset)

Handle these or the numbers will be wrong:

- Conversion is defined **per session**, not per user — see `base_context.md`.
- Duplicate and backfilled rows carry flags; filter them in every analytics query.
- Android rows are often missing `os` (empty string, not null) — bucket as `unknown`.
- `destination_card_clicked` has an empty `application_id` — join on `user_id` at top of funnel,
  `application_id` only after `application_started`.
- Revenue is `value` in `currency` — never sum across currencies without grouping.
- Known issues K1–K7 are documented in the context layer. Insights should cross-reference them
  (e.g. an iOS OTP failure spike is consistent with K1) rather than reporting the anomaly bare.

## The unseen spec

A sixth specification is released to all teams simultaneously in the final hours. It must run
through the pipeline untouched — no hand-editing outputs, no manual SQL. Build for generality:
prompts should reason from principles, and unknown fields should be absorbed gracefully rather
than crashing the run.

## Commands

```bash
npm run check-env                          # verify ClickHouse + Langfuse + LLM connectivity
npm run seed                               # base_context.md → context_store (v1)
npm run run-spec specs/01_express_checkout # full pipeline on one spec
npm run typecheck
```
