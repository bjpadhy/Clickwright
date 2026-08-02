# Clickwright — Architecture

## Overview

Clickwright is an agentic analytics pipeline for Atlys. A PM uploads a feature spec; three agents — Instrumentation, Context, and Analytics — collaborate through a shared ClickHouse-backed knowledge store to produce live tables, documented context, and cited insights. Every decision is traced in Langfuse.

## System Architecture

![System Architecture](../docs/architecture-overview.svg)

The three agents never call each other directly. All shared state flows through `context_store` in ClickHouse — this makes each agent independently testable and the pipeline recoverable after any failure.

**Agent handoff:** Instrumentation → Context is a direct function call (the context agent receives the instrumentation result as input). Analytics reads from `context_store` independently — it has no dependency on when instrumentation ran.

## Pipeline Detail

![Pipeline Detail](../docs/pipeline-detail.svg)

### ① Instrumentation Agent

Transforms a feature spec into live, optimized ClickHouse tables.

| Step | Type | What it does |
|------|------|-------------|
| Profile | Code | Per-event field types, null rates, cardinality, numeric ranges |
| Context + reconcile | Code (concurrent) | Load conventions + check live schema matches docs |
| Baseline schema | Code | Correct-but-plain DDL from measurements (the fallback) |
| Schema design | LLM (1 call) | Optimizes ALL tables together — codecs, ordering keys, type coherence |
| Validate | Code | Every profiled column present, none invented, EXPLAIN AST passes |
| **Approval gate** | Human | Approve or reject with feedback → regenerate |
| Execute + load | Code | CREATE TABLE → batch INSERT (5K/batch) with DML-specific retry |
| Verify | Code | Row count in table must match source file |

### ② Context Agent

Maintains the shared knowledge store that all agents read from.

| Step | Type | What it does |
|------|------|-------------|
| Table docs | Code | Synthesized from measured profile + executed DDL — no LLM needed |
| Feature half | LLM | `spec:` summary + `metric:`/`funnel:` definitions the PM's questions need |
| Convention half | LLM (concurrent, conditional) | Revisions to existing conventions + contradiction warnings — skipped when no deviations |
| Validate | Code | Namespaces, one entry per created table, size checks |
| **Approval gate** | Human | Approve proposed entries |
| Write | Code | Append as version n+1 — code owns versions, run_ids, timestamps |

### ③ Analytics Agent

Turns a PM's question into a cited, verified insight.

| Step | Type | What it does |
|------|------|-------------|
| Context load | Code (concurrent) | Knowledge bundle + schemas + cache check |
| Pre-plan lookup | Code | Surface relevant known issues + metrics before planning |
| Plan | LLM | ≤4 aggregate tasks with proactive segmentation |
| SQL per task | LLM (concurrent) | Write → guard (readonly=1) → execute → retry ≤3 |
| Result digest | Code | Full-set stats computed in ClickHouse (exact rates, not extrapolation) |
| Sanity gate | Code | Drop empties, flag >100% rates, low-n warnings |
| Verify | LLM (async) | Independent query cross-checks the headline figure |
| Knowledge lookup | LLM | Known issues that explain anomalies |
| Precision | Code | Wilson intervals on every rate |
| Narrate | LLM | Headline + findings + chart + segment table |
| Citation check | Code | Every number must trace to SQL results |
| Quality gate | Code/LLM | Deterministic when code checks pass; LLM only for edge cases |

## Context Store Schema

The knowledge store is an append-only, versioned ClickHouse table. Reads resolve the latest version per entity via `ORDER BY entity ASC, version DESC LIMIT 1 BY entity`.

| Namespace | What it stores |
|-----------|---------------|
| `overview:` | Business context |
| `convention:` | Rules every query must follow (hygiene filters, os bucketing, currency) |
| `join_map:` | How tables join (user_id, application_id paths) |
| `guide:` | Funnel analysis methodology |
| `table:` | Per-table docs: columns, join keys, gotchas |
| `metric:` | Metric definitions with exact numerator/denominator |
| `funnel:` | Funnel stage definitions |
| `spec:` | Feature summaries from instrumented specs |
| `known_issue:` | Data quirks (K1–K7) |

## Key Differentiators

### ClickHouse Best-Practice DDL Generation

Schemas are measured, not guessed. The Instrumentation Agent profiles every field — types, null rates, cardinality, numeric ranges — and code synthesizes a deterministic baseline DDL with correct `LowCardinality`, `Decimal64` for money, and data-driven ordering keys. The LLM then optimizes codecs, partitioning, cross-table type coherence, and TTL in a single call — guided by the ClickHouse architecture review skill. Every DDL is dry-run through `EXPLAIN AST` before execution. If the LLM fails, the measured baseline ships unchanged, so the pipeline never produces an invalid schema.

### Cross-Conversation Context

Follow-up answers carry prior SQL, established figures (with their denominators and source tables), and dropped-task reasons from earlier turns. This prevents silent denominator drift: if one answer reports UAE conversion as 56.6%, the next turn knows both the number and the `n` it rests on. A changed denominator is explained rather than silently contradicting what the PM was already told. Failed tasks are forwarded so the planner doesn't repeat impossible work. The history window is 12 turns with smart compression.

### Wilson Score Validation

Every rate the Analytics Agent reports is classified (proportion, mean, quantile, ratio) — only proportions get a 95% Wilson confidence interval computed from the actual denominator. The interval is reported inline with the figure, not separately. Confidence (high/medium/low) is *computed* from the widest interval, sanity flags, citation retries, and whether an independent verification query reproduced the headline — never asked of the model. A ±10pp+ interval drops confidence to low; a verification disagreement does the same.

## Quality & Correctness Stack

Every insight passes through multiple deterministic checks before reaching the PM:

1. **SQL guard** — readonly=1, banned-keyword filter, single-statement, LIMIT cap
2. **Result digest** — full-population stats computed in ClickHouse, not extrapolated from samples
3. **Sanity gate** — empty results dropped, rates >100% flagged, n<50 warned
4. **Citation check** — every number in prose must exist in SQL results (or be a verified arithmetic of two that do)
5. **Wilson precision** — 95% confidence intervals on every rate, from the actual denominator
6. **Execution-backed verification** — an independently written query cross-checks the headline figure
7. **Established figures** — follow-up answers carry prior figures + denominators to prevent contradiction

## Tracing (Langfuse) — Deep Integration

Langfuse is not a bolt-on — it is wired into the core execution primitive that every agent operation passes through. The `step()` function in `core/tracing.ts` wraps every unit of work: it creates a Langfuse span on entry, records output (or error) on exit, and emits SSE events for the live UI. No agent code touches Langfuse directly — all tracing flows through this single function.

![Langfuse Integration](../docs/langfuse-integration.svg)

### How it's wired

| Integration point | File | What it records |
|---|---|---|
| `step(parent, name, input, fn)` | `core/tracing.ts:119` | Every agent operation — creates a Langfuse span with input, captures output or error, measures elapsed time |
| `recordQuery(parent, name, sql, rows)` | `core/tracing.ts:152` | Every SQL execution — the query text and a result sample (≤50 rows) as a child span |
| `complete(parent, name, prompt, opts)` | `core/llm.ts:134` | Every LLM call — records as a Langfuse generation with prompt, completion, model, and token usage |
| `scoreRun(ctx, name, value, comment)` | `core/tracing.ts:101` | Numeric scores attached to the trace — appear as sortable columns in the Langfuse dashboard |
| `startRun(name, input, opts)` | `core/tracing.ts:77` | Creates the root trace per pipeline run or chat answer, with session grouping and git release tag |

### What gets captured in every trace

- **LLM generations** — prompt, completion, model, token count, cost, latency
- **SQL executions** — query text, row count, result sample — the audit trail for every number
- **Approval decisions** — approved/rejected, human feedback, identity
- **Failed attempts** — kept as evidence that self-healing is real, not deleted
- **Timing** — per-span elapsed, so bottlenecks are visible
- **Scores** — numeric values that appear as sortable columns:

| Score | What it measures |
|-------|-----------------|
| `self_heal_attempts` | How many DDL/SQL retries before success |
| `rows_verified` | 1 if all row counts matched |
| `context_entries_written` | How many knowledge entries were added |
| `sanity_flags` | Number of flagged results |
| `citation_failures` | How many narration retries for uncited numbers |
| `cache_hit` | 1 if served from insight_cache |
| `rows_analyzed_total` | How many rows the answer actually covers |

### Why this matters

Every number in an insight traces backward: **narration span → SQL span → query text → ClickHouse result → verified by an independent query**. A wrong number is findable in the Langfuse trace in 30 seconds. Failed attempts are evidence, not noise — they prove the self-healing loop ran and recovered.

## LLM Provider

**Model:** Claude Sonnet 5 (configurable via `CLICKWRIGHT_MODEL`)

**Why Claude:** Structured JSON output with strict schema adherence, strong ClickHouse SQL generation, and reliable multi-section prompt following. Effort pinned to `medium` — prompts are tightly specified and schema-validated.

**Auth:** `ANTHROPIC_API_KEY` (direct API) or Claude Code OAuth login (company plan).

## Tech Stack

| Component | Technology | Why |
|---|---|---|
| Database | ClickHouse Cloud | Competition platform; ideal for event analytics at scale |
| Backend | Node.js + TypeScript | Async-native, strong typing, fast iteration |
| LLM | Claude (Anthropic) | Best structured-output reliability for SQL + JSON |
| Tracing | Langfuse Cloud | Full observability; every span, generation, and score queryable |
| Frontend | React + Vite + Tailwind | Component library with SSE streaming support |
| Validation | Zod | Runtime schema validation on every LLM output |
