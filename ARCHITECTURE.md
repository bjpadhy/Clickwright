# Clickwright — Architecture

## Overview

Clickwright is an agentic analytics pipeline for Atlys. A PM uploads a feature spec; three agents — Instrumentation, Context, and Analytics — collaborate through a shared ClickHouse-backed knowledge store to produce live tables, documented context, and cited insights. Every decision is traced in Langfuse.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Clickwright                                 │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐                      │
│  │  ① Instr │───▶│② Context │    │③ Analtic │                      │
│  │   Agent  │    │  Agent   │◀───│  Agent   │                      │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘                      │
│       │               │               │                             │
│       ▼               ▼               ▼                             │
│  ┌─────────────────────────────────────────────┐                   │
│  │              ClickHouse Cloud                │                   │
│  │  ┌──────────┐ ┌───────────┐ ┌────────────┐  │                  │
│  │  │ Event    │ │ context   │ │ insight    │  │                   │
│  │  │ Tables   │ │ _store    │ │ _cache     │  │                   │
│  │  └──────────┘ └───────────┘ └────────────┘  │                  │
│  └─────────────────────────────────────────────┘                   │
│       │                                                             │
│       ▼                                                             │
│  ┌──────────┐    ┌──────────┐                                      │
│  │ Langfuse │    │  Webapp   │                                      │
│  │ (traces) │    │  (React)  │                                      │
│  └──────────┘    └──────────┘                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Agent Architecture

The three agents never call each other directly. All shared state flows through `context_store` in ClickHouse. This makes each agent independently testable and the pipeline recoverable after any failure.

### Agent Handoff

```
spec.md + events.ndjson
         │
         ▼
┌─────────────────┐     DDL approved      ┌─────────────────┐
│  ① Instrumenta- │─────────────────────▶│  ② Context      │
│  tion Agent     │  tables + profile     │  Agent (write)  │
│                 │  passed as input      │                 │
│  Profile → DDL  │                       │  Synthesize     │
│  → Execute →    │                       │  table docs +   │
│  Load → Verify  │                       │  metrics +      │
└─────────────────┘                       │  detect changes │
                                          └────────┬────────┘
                                                   │ writes to
                                                   ▼
                                          ┌─────────────────┐
                                          │  context_store   │
                                          │  (ClickHouse)    │
                                          └────────┬────────┘
                                                   │ reads from
         PM question                               ▼
              │                           ┌─────────────────┐
              └──────────────────────────▶│  ③ Analytics    │
                                          │  Agent          │
                                          │                 │
                                          │  Plan → SQL →   │
                                          │  Verify →       │
                                          │  Narrate        │
                                          └─────────────────┘
```

## Pipeline Detail

### ① Instrumentation Agent

Transforms a feature spec into live, optimized ClickHouse tables.

```
spec.md + events.ndjson
    │
    ├─ Profile (code) ──────── field types, null rates, cardinality, ranges
    │
    ├─ Context Load ─┐
    ├─ Reconcile ────┘──────── conventions + live table list (concurrent)
    │
    ├─ Baseline Schema (code)  correct-but-plain DDL from measurements
    │
    ├─ Schema Design (LLM) ──  ONE call for ALL tables in the spec
    │   │                      ├─ codecs (Delta+ZSTD, T64+ZSTD)
    │   │                      ├─ ordering key (low-card dims first)
    │   │                      ├─ cross-table type coherence
    │   │                      └─ falls back to baseline on failure
    │   │
    │   └─ Validate (code) ─── columns match profile, EXPLAIN AST passes
    │
    ├─ ⛔ HUMAN APPROVAL GATE
    │
    ├─ Execute DDL ─────────── CREATE TABLE statements
    │
    ├─ Load Data ───────────── batch INSERT (5K rows/batch)
    │   └─ DML retry ──────── transient errors retry load only,
    │                          schema errors trigger redesign
    │
    └─ Verify ──────────────── row count matches source file
```

### ② Context Agent

Maintains the shared knowledge store that all agents read from.

```
                    ┌─────────────────────────────────┐
                    │        context_store             │
                    │                                  │
   Read side        │  overview:*    convention:*      │
   (getContext)     │  join_map:*    guide:*           │  Write side
   ─────────────▶   │  table:*       metric:*          │  ◀──────────
   Any agent calls  │  funnel:*      spec:*            │  Only after
   this to get      │  entity:*      known_issue:*     │  instrumentation
   prompt-ready     │                                  │
   knowledge        │  Append-only, versioned          │
                    │  Latest = LIMIT 1 BY entity      │
                    └─────────────────────────────────┘

   Write flow:
   ┌──────────────┐   ┌────────────────┐   ┌──────────┐
   │ table:* docs │ + │ Feature half   │ + │Convention│  All run
   │ (code — from │   │ (LLM — spec    │   │half (LLM)│  CONCURRENTLY
   │ measurements)│   │ summary +      │   │— only if │
   │              │   │ metrics)       │   │deviations│
   └──────┬───────┘   └───────┬────────┘   └────┬─────┘
          │                   │                  │
          └───────────┬───────┘──────────────────┘
                      ▼
              ⛔ HUMAN APPROVAL GATE
                      │
                      ▼
              INSERT as version n+1
```

### ③ Analytics Agent

Turns a PM's question into a cited, verified insight.

```
"What's our funnel conversion by platform?"
    │
    ├─ Context Load (concurrent) ── knowledge + schemas + cache check
    │
    ├─ Pre-plan Lookup (code) ───── relevant known issues + metrics
    │
    ├─ Plan (LLM) ──────────────── ≤4 tasks, proactive segmentation
    │   └─ depends_on ──────────── sequential tasks for funnels
    │
    ├─ SQL per task (concurrent) ── each: LLM write → code guard →
    │   │                           readonly execute → retry ≤3
    │   └─ Prior SQL memory ─────── follow-ups reuse prior queries
    │
    ├─ Result Digest (code) ─────── full-set stats in ClickHouse
    │                               (exact rates, not sample extrapolation)
    │
    ├─ Sanity Gate (code) ──────── drop empties, flag impossible rates
    │
    ├─ Verify (LLM, async) ─────── independent query cross-checks
    │                               the headline figure
    │
    ├─ Knowledge Lookup (LLM) ──── known issues that explain anomalies
    │   + Precision (code) ──────── Wilson intervals on every rate
    │   + Related Insights (DB) ─── past answers from other conversations
    │   (all three run concurrently)
    │
    ├─ Narrate (LLM) ───────────── headline + findings + chart + table
    │
    ├─ Citation Check (code) ────── every number must be in SQL results
    │                               or a verified arithmetic of two that are
    │
    └─ Quality Gate ─────────────── deterministic when code checks pass;
                                    LLM only when anomalies need review
```

## Data Flow

```
┌────────────────────────────────────────────────────────────────┐
│                      ClickHouse Cloud                          │
│                                                                │
│  PROVIDED (read-only)          CREATED BY SPECS                │
│  ┌────────────────────┐        ┌─────────────────────┐        │
│  │ 8 base event tables│        │ N tables per spec   │        │
│  │ ~3.5M rows         │        │ (express_checkout_   │        │
│  │ ORDER BY (id,ts,   │        │  shown, otp_entered, │        │
│  │   user_id)         │        │  ...)                │        │
│  └────────────────────┘        │ ORDER BY (dim,       │        │
│                                │   join_key, ts)      │        │
│  APPLICATION STATE             │ + codecs + TTL       │        │
│  ┌────────────────────┐        └─────────────────────┘        │
│  │ context_store      │ ◀── append-only knowledge             │
│  │ runs_log           │ ◀── event stream per run              │
│  │ run_summary        │ ◀── one row per completed run         │
│  │ conversations      │ ◀── chat state                        │
│  │ messages           │ ◀── chat turns (stores full Insight)  │
│  │ insight_cache      │ ◀── answer cache (question+context)   │
│  │ dashboards         │ ◀── saved SQL visualizations          │
│  └────────────────────┘                                       │
└────────────────────────────────────────────────────────────────┘
```

## Tracing (Langfuse)

Every pipeline run and every chat answer is a Langfuse trace.

```
Trace: pipeline:01_express_checkout
├─ span: instrumentation
│   ├─ span: profile
│   ├─ span: context_load          ┐
│   ├─ span: schema_reconciliation ┘ concurrent
│   ├─ span: ddl_synthesis
│   ├─ span: schema_design_attempt_1
│   │   └─ generation: schema_design (LLM)
│   ├─ span: dry_run
│   ├─ span: approval_attempt_1
│   ├─ span: ddl_execution_attempt_1
│   │   ├─ rows_loaded: express_checkout_shown (1650)
│   │   ├─ rows_loaded: otp_entered (1007)
│   │   └─ ...
│   └─ scores: self_heal_attempts=1, rows_verified=1
└─ span: context_update
    ├─ span: update_generation_attempt_1
    │   ├─ generation: context_write_feature (LLM)   ┐
    │   └─ generation: context_write_conventions (LLM)┘ concurrent
    ├─ span: update_approval_attempt_1
    └─ scores: context_entries_written=8
```

Traces carry numeric scores (self-heal attempts, rows verified, cache hits, sanity flags, citation failures) that appear as sortable columns in the Langfuse dashboard.

## LLM Provider

**Model:** Claude Sonnet 5 (configurable via `CLICKWRIGHT_MODEL`)

**Why Claude:** The pipeline needs structured JSON output with strict schema adherence (DDL, task plans, insight cards), strong SQL generation for ClickHouse dialect, and the ability to follow complex multi-section prompts. Claude's instruction-following and JSON mode reliability made it the best fit.

**Two auth modes:**
- `ANTHROPIC_API_KEY` → direct Anthropic Messages API
- No key → Claude Agent SDK with machine's OAuth login (company plan)

**Effort level:** Pinned to `medium` — the prompts are tightly specified and schema-validated, so extended thinking adds latency without improving output.

## Tech Stack

| Component | Technology | Why |
|---|---|---|
| Database | ClickHouse Cloud | The competition platform; also ideal for event analytics |
| Backend | Node.js + TypeScript | Fast iteration, strong typing, async-native |
| LLM | Claude (Anthropic) | Best structured-output reliability |
| Tracing | Langfuse | Required by competition; self-hosted on ClickHouse |
| Frontend | React + Vite + Tailwind | Rapid UI development |
| Validation | Zod | Runtime schema validation on every LLM output |
