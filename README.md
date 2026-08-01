# Clickwright

A feature spec goes in; live optimized ClickHouse tables, an updated business-context
store, and PM-ready insights come out — with every decision traced in Langfuse.

Built for Click-a-thon India 2026 (Atlys problem statement).

```
backend/    the pipeline + HTTP/SSE server   (all npm commands run from here)
webapp/     React + Vite frontend
specs/      sample feature specs (spec.md + events.ndjson)
base_context.md   human-authored seed for the knowledge store
```

## Quick start

```bash
cd backend
nvm use                 # Node 20
npm install
npm run check-env       # ClickHouse + LLM + Langfuse must all be green
npm run seed            # parse base_context.md into context_store (once)
npm run serve           # http://localhost:8787

cd ../webapp && npm install && npm run dev    # :5173, proxies /api → :8787
```

Auth for the LLM is either `ANTHROPIC_API_KEY` or, with no key, the machine's Claude
Code OAuth login (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in `backend/.env`).
`check-env` reports which backend is active.

### Useful scripts (from `backend/`)

| Command | What it does |
|---|---|
| `npm run check-env` | Verifies ClickHouse, LLM, Langfuse |
| `npm run seed` | Seeds `context_store` v1 from `base_context.md` |
| `npm run serve` | Starts the API server on :8787 |
| `npm test` | Unit tests (observe modules) |
| `npm run typecheck` | `tsc --noEmit` |
| `npx tsx scripts/run-instrumentation.ts ../specs/01_express_checkout --yes` | Run a spec from the CLI (`--yes` auto-approves both gates) |
| `npx tsx scripts/reset-spec.ts <spec…> \| --all-specs` | Drop a spec's tables and roll back its context rows |
| `npx tsx scripts/apply-audit-context.ts` | Apply the base-data audit corrections |
| `npx tsx scripts/apply-ordering-finding.ts` | Apply the event-ordering finding |
| `npx tsx scripts/comment-tables.ts` | Project context knowledge onto base tables as ClickHouse COMMENTs |

## How it works

```
Flow A — instrument a spec (human-gated, queued one at a time)
  spec.md + events.ndjson
    → profile (code)          measured stats per field per event type
    → context load            conventions + existing table names
    → DDL synthesis (CODE)    types/LowCardinality/ORDER BY are arithmetic on the
                              profile — no LLM, no retries, instant
    → purposes (1 small LLM call, optional)
    → dry-run                 ClickHouse EXPLAIN-parses every statement
    → ⛔ HUMAN GATE            approve, or reject with feedback → regenerate
    → execute + load + verify row counts match the file
    → context update (LLM)    versioned entries + contradiction warnings
    → ⛔ HUMAN GATE            approve the proposed context entries

Flow B — ask a question (chat)
  question
    → cache lookup            same question + same context version ⇒ ms, no LLM
    → plan (LLM)              ≤4 SQL tasks
    → SQL per task (LLM)      concurrent; guarded + read-only; self-heals ≤3
    → sanity gate (code)      drop empty sets, flag >100% rates and n<50
    → knowledge lookup (LLM)  retrieves known issues that explain anomalies
    → narrate (LLM)           the Insight card
    → citation check (code)   every number must exist in the SQL results, or be a
                              verified difference/ratio of two that do
    → quality gate (LLM)      skipped when the code checks already pass
```

**Three invariants worth knowing before changing anything.** Numbers only come from
ClickHouse — the LLM never computes one. Knowledge only comes from the Context Agent
(`getContext` / `lookupContext`), never from sampling the database. And the Analytics
Agent is read-only by construction: SQL runs with ClickHouse `readonly=1` after code
guards, and `updateContext` requires an instrumentation result it can never have.

## Database tables

All in one ClickHouse database (`atlys_dataset` by default). Nothing here is a cache of
something else — the store *is* the state.

### Provided event data (8 tables, ~3.5M rows) — never modified

`destination_card_clicked` · `application_started` · `document_uploaded` ·
`purchase_completed` (the four funnel stages) and `search_typed` ·
`landing_page_scrolled` · `auth_completed` · `pay_now_clicked` (supporting events).
Each carries a ~30-column shared envelope plus event-specific columns; all are
`ORDER BY (id, timestamp, user_id)`. Every table and all 276 columns carry ClickHouse
COMMENTs projected from `context_store`, so `DESCRIBE TABLE` explains the traps inline.

**Measured traps** (documented in the store, not obvious from the schema): rows with a
non-null `duplicate_id` are duplicate copies and `is_back_filled = 1` rows are backfill —
filtering both moves purchases 7,054 → 6,715 (−4.8%). `os` is NULL on ~18% of Android
rows. `application_id` is empty before application start. Nine currencies share the
`value` column. And **event timestamps do not encode funnel order** — ~48% of
applications have a purchase timestamped before their first pay-now click, so durations
between funnel events are meaningless and stages must be counted as set membership.

### Application tables (created by the app — never dropped by resets)

| Table | Engine | Purpose |
|---|---|---|
| `context_store` | MergeTree | **The knowledge store.** One row per version of one fact. Append-only; reads resolve `ORDER BY entity ASC, version DESC LIMIT 1 BY entity`. Columns: `entry_id, entity, definition_md, version, updated_at, source_spec, change_note, run_id`. Entities are namespaced: `overview:` `convention:` `join_map:` `guide:` `entity:` `table:` `metric:` `funnel:` `spec:` `known_issue:`. |
| `runs_log` | MergeTree | Every run event (`run_id, spec, seq, ts, type, name, payload`). Powers the live stepper, replay, and history that survives restarts. Written before SSE fan-out and awaited before a run completes, so no event is lost. |
| `conversations` | ReplacingMergeTree(updated_at) | Chat sidebar: `conv_id, title, starred, created_at, updated_at`. |
| `messages` | MergeTree | Chat turns: `conv_id, seq, role, question, insight_json, trace_url, ts`. Agent turns store the whole Insight, so reloading a conversation re-renders cards with no recompute. |
| `insight_cache` | ReplacingMergeTree(created_at) | Answers keyed by `sha256(question + contextVersion)`. A repeat question is a millisecond read; any context write changes the version and invalidates it naturally. |
| `dashboards` | ReplacingMergeTree(created_at) | Saved charts: `dash_id, title, sql, chart_kind, meta_json, deleted, created_at`. **The stored artifact is the SQL** — re-executed on every load, so boards are always fresh data. |
| `optimization_suggestions` | MergeTree | Advisor output for the Observe screen (severity, target table, action, rationale, status). |

`scripts/reset-spec.ts` drops only the event tables a spec created and deletes that
spec's `context_store` rows; the seed, the `data_audit*` findings, and every table above
are protected explicitly.

### Spec-created tables

One per event type in a spec, named exactly after the event (e.g.
`express_checkout_shown`, `otp_entered`). Columns come from the flattened NDJSON
(`payment.amount` → `payment_amount`; collisions get a `__2` suffix). They are
`ENGINE = MergeTree PARTITION BY toYYYYMM(timestamp) ORDER BY (<join key>, timestamp)`
and carry per-column COMMENTs with the measured stats. Note these tables **do not have
the hygiene columns** (`duplicate_id`, `is_back_filled`) or `app_session_id`, so those
filters do not apply to them — the store records this as a documented exception.

## API

Full request/response contracts, SSE event shapes, TypeScript types to copy into the
frontend, and implementer gotchas live in **[backend/API.md](backend/API.md)** — that
file is the integration spec; this is the index.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | ClickHouse version, database, active LLM backend |
| `GET /api/specs` | Sample specs with event counts and `alreadyInstrumented` |
| `POST /api/runs` | Start a run: `{specDir}` or `{name, specMd, ndjson}` (upload) |
| `GET /api/runs` · `GET /api/runs/:id` | Session run list / one run with its event buffer |
| `GET /api/runs/:id/events` | **SSE** — replays buffered events then streams live |
| `POST /api/runs/:id/approve` | Resolve the pending gate: `{approved, feedback?, identity?}` |
| `GET /api/history` · `GET /api/history/:runId` | Runs and full decision records from `runs_log` |
| `GET /api/context` · `GET /api/context/:entity/history` | Latest of every entity / one entity's versions |
| `POST /api/conversations` · `GET /api/conversations` · `GET /api/conversations/:id` · `POST /api/conversations/:id/star` | Chat conversations |
| `POST /api/conversations/:id/messages` | **SSE** — agent steps, then the Insight |
| `GET /api/suggestions` | Suggested-question chips, from the PM questions in `spec:*` entries |
| `POST/GET/DELETE /api/dashboards` · `GET /api/dashboards/:id/run` | Boards; `:id/run` re-executes the saved SQL |
| `GET /api/observe/clickhouse` · `/changelog` · `/changelog/export` | Database health, change stream, markdown export |

## Tracing

One Langfuse trace per run (`pipeline:<spec>`) and per question (`chat:<question>`),
grouped into sessions and stamped with the git sha as `release`. Failed attempts stay in
the trace on purpose — they are the evidence that the self-healing loop is real. Each
trace carries scores (`self_heal_attempts`, `rows_verified`, `context_entries_written`,
`sanity_flags`, `citation_failures`, `quality_gate_passed`, `cache_hit`), which show up
as sortable columns in the Langfuse trace list.

Note: under subscription (OAuth) auth the CLI does not meter tokens, so usage is
estimated at ~4 chars/token and labeled as such in the generation metadata.

## Keeping this file current

Update this README in the same commit as any change to: a table's schema or purpose, an
API route, a pipeline step, or a script. The two files that must never drift from the
code are this one and `backend/API.md`.
