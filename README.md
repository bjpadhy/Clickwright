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
npm run dev             # http://localhost:8787, restarts on any .ts or prompt change

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
| `npm run dev` | API server with hot reload — restarts on `.ts` **and** `prompts/*.txt` edits |
| `npm run serve` | API server without watching (use for demos and any long run) |
| `npm test` | Unit tests (observe modules) |
| `npm run typecheck` | `tsc --noEmit` |
| `npx tsx scripts/run-instrumentation.ts ../specs/01_express_checkout --yes` | Run a spec from the CLI (`--yes` auto-approves both gates) |
| `npm run reset` | Reset to provided data only: drop every spec's tables + context rows, sweep orphans |
| `npm run reset -- --runs` | …and clear run history (`runs_log`) |
| `npm run reset -- --chat` | …and clear conversations, messages, insight cache, boards |
| `npm run reset -- --all` | Everything above |
| `npm run reset -- --dry-run` | Show what would change, touch nothing |
| `npx tsx scripts/reset-spec.ts <spec…>` | Reset one named spec (same logic, narrower scope) |
| `npx tsx scripts/apply-audit-context.ts` | Apply the base-data audit corrections |
| `npx tsx scripts/apply-ordering-finding.ts` | Apply the event-ordering finding |
| `npx tsx scripts/comment-tables.ts` | Project context knowledge onto base tables as ClickHouse COMMENTs |

### Hot reload

`npm run dev` watches both source and `prompts/*.txt`. Watching the prompts matters:
they are cached in memory after first load, so without a restart an edited prompt has
no effect and you debug a version of the file that is no longer on disk.

Restarts are graceful — SIGTERM drains queued `runs_log` inserts, flushes Langfuse
spans, closes open SSE streams and the ClickHouse client, with a 4s cap so a slow
network cannot hang the reload. Without that, every reload would truncate a run's
event history.

**Use `npm run serve` for demos and long runs.** A reload during an active run
abandons it: the shutdown logs a warning naming the run and reminding you that any
tables it created are now undocumented (`npx tsx scripts/reset-spec.ts --orphans`).

### Prompts

All prompts live in `backend/prompts/*.txt`, named `<agent>_<action>` — tuning one never
means editing TypeScript. `shared_system.txt` is prepended to every call.
`loadPrompt` throws if a `{{placeholder}}` is left unfilled, so a prompt and its call
site cannot silently drift.

| File | Used by |
|---|---|
| `shared_system.txt` | every LLM call (invariants + terseness) |
| `instrument_design_table.txt` | designs one production table from the measured profile |
| `context_write_knowledge.txt` | the two interpretive halves of a context update (scoped per call) |
| `context_retrieve_relevant.txt` | semantic lookup over the store's index |
| `analytics_plan_tasks.txt` | question → ≤4 aggregate tasks |
| `analytics_write_sql.txt` | one task → one guarded query |
| `analytics_narrate_insight.txt` | verified results → the Insight card |
| `analytics_review_quality.txt` | quality gate (skipped when code checks pass) |
| `optimization_scan.txt`, `optimization_ddl.txt` | Observe advisor |

Table purposes are parsed from each spec's own event descriptions, so no prompt is
needed for them.

`analytics_write_sql.txt` carries the query rules from the same official set —
one scan per table (conditional aggregation instead of UNION ALL over the same
source), filter before joining, `LEFT ANY JOIN` when one match suffices, filter on the
leading ORDER BY columns so the index prunes, and `uniq` over `uniqExact` on large
tables. Safety limits are enforced in code, not asked of the model: the guard clamps
LIMIT and the server applies a 30s cap.

`instrument_design_table.txt` distils the schema rules from ClickHouse's official
[agent-skills](https://github.com/ClickHouse/agent-skills) best-practices set —
immutable ordering keys, cardinality-ordered keys, filter prioritisation, native and
minimum-width types, LowCardinality, avoiding Nullable, and partitioning for lifecycle
rather than speed — and asks the designer to cite the rule it applied. They are
inlined rather than installed as a skill: that skill is built for an interactive agent
that reads rule files across many turns, while our design call is single-shot and runs
one per table in parallel.

### Known gaps

- **Materialized-view proposals** are in the product design but not implemented: no
  prompt asks for one and nothing executes one. The Observe advisor can propose schema
  changes separately.
- **Chat, Boards and Observe screens** still render mock data in the webapp;
  instrumentation is the only screen wired to the real backend.

## How it works

Three agents. They never call each other — all shared knowledge moves through the
context store, and every step is one Langfuse span.

### ① Instrumentation Agent — a spec becomes live tables

```
spec.md + events.ndjson
  ├─ profile (code)          per event type: field types, null rates, cardinality,
  │                          numeric ranges, nesting — measured, never guessed
  ├─ context load ┐          (these two run CONCURRENTLY — independent reads)
  ├─ reconcile    ┘          store conventions + the live table list
  ├─ baseline plan (code)    a correct-but-plain schema from the measurements;
  │                          also the fallback if design fails
  ├─ design (LLM) ×1         ONE call for the WHOLE schema, so shared columns get
  │                          one type, join keys stay comparable and enum members
  │                          match across tables — plus codecs, Enum8 vs
  │                          LowCardinality, and ordering keys shaped by the PM's
  │                          questions (low cardinality first)
  ├─ validate (code)         every profiled column present, none invented, one
  │                          statement, ClickHouse EXPLAIN-parses it — else retry
  │                          with the verbatim error; after 3 tries ship the baseline
  ├─ ⛔ HUMAN GATE            approve, or reject with feedback → regenerate
  └─ execute + load + verify row counts match the file, or the run fails
```

### ② Context Agent — the shared memory

Read side (`getContext`) assembles a prompt-ready bundle: core rules always, plus the
categories a caller asks for, with a `brief` mode that collapses entries to one-liners
when a caller only needs to know something exists. `lookupContext` is a semantic
retriever for mid-analysis questions ("anything about Apple devices?" finds K1).
`reconcileWithLive` compares documentation against the live schema.

Write side runs once per spec, after instrumentation:

```
  ├─ table:* entries (code)  synthesised from the measured profile and the DDL that
  │                          actually ran — no model needed for facts
  ├─ feature   (LLM) ┐       CONCURRENT: the spec summary + the metrics its questions
  ├─ conventions(LLM)┘       require · revisions to existing conventions + warnings
  ├─ validate (code)         namespaces, one entry per created table, size caps
  ├─ ⛔ HUMAN GATE            approve the proposed entries
  └─ write as version n+1    append-only; code owns versions, run ids, timestamps
```

### ③ Analytics Agent — a question becomes a cited insight

```
question
  ├─ context load (code)     4 CONCURRENT reads: knowledge bundle, SQL rules,
  │                          live tables, exact column schemas
  ├─ cache lookup            same question + same context digest ⇒ ~0.6s, no LLM
  ├─ plan (LLM)              ≤4 aggregate tasks
  ├─ per task ×N             ALL CONCURRENT: write SQL (LLM) → guard (code) →
  │                          execute read-only → retry ≤3 on a real SQL error
  ├─ sanity gate (code)      drop empty sets and blocked tasks, flag >100% rates
  │                          and n<50 — everything dropped is reported, not hidden
  ├─ knowledge lookup (LLM)  known issues that might explain an anomaly
  ├─ narrate (LLM)           the insight card
  ├─ citation check (code)   every number must be in the results, or a verified
  │                          difference/ratio of two that are — else regenerate
  └─ quality gate (LLM)      skipped when the code checks already pass
```

### What runs in parallel, and why that is safe

Parallelism here is never speculative — it is only ever applied to work with **no data
dependency and no shared mutable state**. Output tokens dominate latency (~60–100/s), so
splitting one large generation into several smaller concurrent ones is the single most
effective speed lever available.

| Concurrent work | Why it cannot interfere |
|---|---|
| ~~Per-table DDL design~~ | **Removed.** Tables in one spec are *not* independent — they share columns and join keys — so designing them separately produced incoherent types. It is now a single call; validation and retry are still per table within it. |
| Per-task analytics SQL (≤4 calls) | The planner produces independent tasks by construction; each writes one read-only query. Results are collected before any of them is interpreted. |
| Context write: feature vs conventions | Two disjoint entity sets — one may only emit `spec:`/`metric:`/`funnel:`/`entity:`, the other only revisions to existing `convention:`/`known_issue:` plus warnings. Neither reads the other's output. |
| Context bundle + live reconciliation | Two independent reads. |
| Chat prep queries (count + history) | Two independent reads. |

**Deliberately kept sequential**, because each genuinely consumes the previous stage's
output and parallelising would mean guessing: plan → SQL, SQL → sanity gate → narrate,
narrate → citation check → quality gate, and instrumentation ① → context write ②.

**Whole runs are serialized.** A run is a read-modify-write on shared state (it creates
tables and appends context versions), so the queue admits one at a time — that is what
makes the per-step concurrency above safe. Chat answers run alongside a run without
interference because each answer carries its own event sink (`AsyncLocalStorage`), so
their progress events never cross.

**Three invariants worth knowing before changing anything.** Numbers only come from
ClickHouse — the LLM never computes one. Knowledge only comes from the Context Agent
(`getContext` / `lookupContext`), never from sampling the database. And the Analytics
Agent is read-only by construction: SQL runs with ClickHouse `readonly=1` after code
guards, and `updateContext` requires an instrumentation result it can never have.

**Quality is never traded for speed.** Every prompt inherits `shared_system.txt`, which
makes fabrication the one unacceptable failure: an agent that cannot do the task returns
the requested shape with the honest answer inside it (an empty result, a headline saying
what is unanswerable, a `'cannot compute'` sentinel the code turns into a reported gap)
and escalates a judgement call to the human rather than guessing.

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

**Resetting.** `npm run reset` drops only the event tables a spec created and deletes
that spec's `context_store` rows. Two categories are protected by name in
`src/core/reset.ts`: the 8 provided event tables and every application table above —
**add new product tables to `PRODUCT_TABLES` there**, or a reset will treat them as spec
artifacts. Knowledge from `base_context.md` and any `data_audit*` pass is protected too,
since those are verified facts about the base tables rather than products of a run. The
script verifies the end state and exits non-zero if a provided table went missing or a
spec table survived.

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
