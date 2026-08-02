# Clickwright Backend API — Integration Spec

Base URL: `http://localhost:8787` · All routes under `/api`. In the webapp dev
server, `/api/*` is already proxied here (see `webapp/vite.config.ts`), so the
frontend calls relative paths (`fetch("/api/runs")`).

Reset the database with `cd backend && npm run reset` (add `--all` to clear run
history and chat as well; `--dry-run` to preview).

Start the backend with `cd backend && npm run dev` (hot reload) or `npm run serve`
(no watching — use this for demos and long runs, since a reload abandons an active run). No auth (hackathon; single
team). All bodies and responses are JSON except the SSE stream. Errors are
`{ "error": string }` with a 4xx/5xx status.

Sections marked **[LIVE]** exist and are tested. Sections marked **[PLANNED]**
are the agreed contract for endpoints not yet implemented — build UI against
them with mocks; shapes will not change without updating this file.

---

## Shared TypeScript types (copy into `webapp/src/lib/types.ts`)

```ts
// ── runs ─────────────────────────────────────────────────────────
export type RunStatus = "queued" | "running" | "awaiting_approval" | "succeeded" | "failed";
export type Gate = "ddl" | "context" | "optimization";
export type RunKind = "spec" | "optimization";

export interface RunSummary {
  id: string;               // "run_msafuwue_a5688b"
  spec: string;             // "02_group_family" | "optimize:auth_completed"
  kind: RunKind;            // "optimization" runs come from the advisor, not a spec
  status: RunStatus;
  pendingGate: Gate | null; // set while status === "awaiting_approval"
  traceUrl: string | null;  // Langfuse deep link, set once running
  createdAt: string;        // ISO timestamp
  specDir: string;          // server-side path (display only); "" for optimization runs
  suggestionId: string | null;  // set only when kind === "optimization"
}

export interface RunDetail extends RunSummary {
  events: RunEvent[];       // full buffered event log (same objects as SSE)
}

export type RunEventType =
  | "step_start" | "step_end" | "step_error"
  | "status" | "approval_request" | "approval_result"
  | "log";                  // per-statement execution progress (ddl_statement, data_load)

export interface RunEvent {
  seq: number;              // 0-based, dense, ordering key
  ts: string;               // ISO timestamp
  type: RunEventType;
  name: string;             // step name | status value | gate name
  payload: Record<string, unknown>; // see per-type shapes below
}

// ── gate proposals (payload.proposal of approval_request) ────────
export interface DdlProposal {
  reasoning: string;        // combined markdown (one "## <table>" section per table)
  tables: Array<{
    name: string;           // table to create
    event: string;          // source event type
    purpose: string;        // one-line description
    ddl: string;            // full CREATE TABLE statement (with COMMENTs)
    // structured rationale — render as the DESIGN RATIONALE panel per table
    rationale?: {
      ordering_key: string;
      partitioning: string;
      types_codecs: string;
      deviations: string;   // "" when nothing contradicts convention
    };
  }>;
}

export interface ContextProposal {
  entries: Array<{
    entity: string;         // e.g. "table:group_started", "metric:x", "convention:envelope"
    definition_md: string;  // full replacement text (markdown)
    change_note: string;    // why this entry/version exists
  }>;
  warnings?: string[];      // contradictions with existing context — the "contradiction surfaced" chips
}

// payload.proposal when gate === "optimization" (advisor-drafted schema change).
// NOTE: a different shape from DdlProposal — branch on the gate name, not on the run.
export interface OptimizationProposal {
  reasoning: string;        // why these statements, and what the reviewer should weigh
  statements: string[];     // 1–4 statements, executed byte-for-byte on approval
  expectedEffect: string;   // one plain sentence the operator can verify afterwards
}

// ── context store ────────────────────────────────────────────────
export interface ContextEntry {
  entity: string;           // namespaced: overview|convention|join_map|guide|entity|table|metric|funnel|spec|known_issue ":" name
  definition_md: string;
  version: number;          // 1-based, per entity
  source_spec: string;      // "base_context.md" | "data_audit" | spec name
  change_note: string;
  updated_at: string;       // "YYYY-MM-DD HH:MM:SS.mmm"
  run_id?: string;          // only in /history responses
}
```

---

## [LIVE] GET /api/health

Connectivity + configuration summary. Use for a status dot in the header.

```json
200 {
  "ok": true,
  "clickhouse": "26.2.1.525",
  "database": "atlys_dataset",
  "llmBackend": "claude-code-oauth",   // or "anthropic-api"
  "model": "claude-sonnet-5"
}
500 { "ok": false, "error": "..." }
```

---

## [LIVE] POST /api/runs — start an instrumentation run

Two body variants:

```json
// A: run a spec that exists on the server (the 5 sample specs)
{ "specDir": "../specs/02_group_family" }

// B: upload a new spec (the "New feature spec" form / unseen 6th spec)
{ "name": "express_checkout_v2",     // becomes the spec id (lowercased, [a-z0-9_])
  "specMd": "<full spec.md text>",
  "ndjson": "<full events.ndjson text>" }   // body limit 50 MB
```

```json
201 { "id": "run_...", "spec": "02_group_family", "status": "running" }
400 { "error": "provide specDir OR {name, specMd, ndjson}" }
```

Runs are **queued FIFO, one at a time**. A second POST while a run is active
returns 201 immediately with `status: "queued"`; it starts when the active run
finishes. Show queued runs as "waiting behind N runs".

### Run lifecycle (drive the whole Run screen off this)

```
queued → running → awaiting_approval (gate: ddl) → running
       → awaiting_approval (gate: context) → running → succeeded | failed
```

Rejecting a gate does NOT fail the run — the agent regenerates with the
feedback and a NEW `approval_request` for the same gate arrives (possibly
several times). `failed` only occurs on exhausted retries or hard errors.

---

## [LIVE] GET /api/runs — run list (current server session)

`200 RunSummary[]`, newest first. This is the in-memory hot list (live +
recently finished runs). Every event is ALSO persisted to the `runs_log`
ClickHouse table as it happens — for history across restarts use the [LIVE]
`GET /api/history` endpoints below.

## [LIVE] GET /api/runs/:id — run detail

`200 RunDetail` (includes full `events` buffer — suitable for replay/report
rendering without SSE). `404` if unknown.

---

## [LIVE] GET /api/runs/:id/events — Server-Sent Events stream

`Content-Type: text/event-stream`. On connect the server **replays all buffered
events, then streams live** — safe to connect at any point during or after a
run. Wire format per event:

```
id: <seq>
event: <RunEventType>
data: <RunEvent as JSON>       // one line
```

Keepalive comments (`: keepalive`) every 15s — EventSource ignores them.
Reconnect = full replay (dedupe by `seq`; `Last-Event-ID` resume is not
implemented). With `EventSource`, register `addEventListener` for each of the
seven event types (they are named events, so plain `onmessage` will NOT fire).

### Event payload shapes by type

| type | name | payload |
|---|---|---|
| `step_start` | step name (below) | `{ input: object }` |
| `step_end` | step name | `{ output: object, elapsedMs }` — strings >2000 chars clipped with `…[clipped]` |
| `step_error` | step name | `{ error: string, elapsedMs }` — verbatim failure, feeds the retry |
| `status` | the new `RunStatus` | varies: `running` first time → `{ traceUrl }`; `awaiting_approval` → `{ gate }`; `succeeded` → `{ durationMs, tables: LoadedTable[], contextEntries: {entity, version}[], contextWarnings: string[], traceUrl }`; `failed` → `{ durationMs, error, resetHint }` |
| `approval_request` | `"ddl"` \| `"context"` | `{ proposal: DdlProposal \| ContextProposal }` — ContextProposal may carry `warnings: string[]` (the "contradiction surfaced" chips) |
| `log` | `"table_created"` \| `"rows_loaded"` \| `"execution_complete"` | `{ table?, rows?, expected?, tables?, verified?, ok, ms }` — **these three only** are execution progress; they are the whole of an "Executing on ClickHouse" panel |
| `log` | `"llm_start"` \| `"llm_progress"` \| `"llm_done"` | `{ call, elapsedMs?, promptChars?, outputChars? }` — progress ticks, one every 3s for **every** LLM call in the run. Ticks, not log lines: render as elapsed time on the running step, never as rows in a log |
| `log` | `"schema_designed"` \| `"schema_fallback"` | `{ tables, sharedColumns, joinPath }` / `{ note, reason }` — design outcome; `schema_fallback` means every attempt was rejected and the deterministic baseline shipped, which the run continues on. Belongs against the design step, not the execution log |
| `approval_result` | gate | `{ approved: boolean, feedback: string, identity: string }` |

`LoadedTable = { name, event, purpose, rowsInFile, rowsLoaded }`.

**Live events carry a `phase`** — render that, not `name`. An empty phase means
plumbing to skip. LLM progress ticks are attributed to the step that is running, so
"Designing the schema" shows elapsed time while "Creating tables and loading data"
shows table results only, never thinking ticks.

Phases in order: *Profiling the events · Reading the knowledge store · Designing the
schema · Validating the schema · Waiting for your approval · Creating tables and
loading data · Updating the knowledge store*.

⚠️ **`phase` is not persisted.** `runs_log` stores `type`/`name`/`payload` only, so
the events replayed by `GET /api/history/:runId` have **no `phase` field** — a report
screen must derive it from the step name. `GET /api/runs/:id` (in-memory, current
session) does carry it. Deriving from `name` works for both.

**Timing.** Show `durationMs` from the run (or the terminal `status` event) as the
elapsed time — it is measured from the start of execution to the terminal state and
includes time spent waiting at the human gates. Per-step `elapsedMs` values are for
the stepper only: **never sum them for a total**, because concurrent steps
(per-table DDL, per-task SQL) overlap and would double-count.

### Step names, in order (the Run screen's stepper)

```
instrumentation                      (wrapper — spans the whole ① phase)
  profile                            output: field stats + newFields
  context_load                       output.summary: entities count, byCategory, updatedEntries
  schema_reconciliation              output: liveTables, documentedNotLive, liveNotDocumented
  ddl_generation_attempt_N           N = 1.. (step_error ⇒ another attempt follows)
    ddl_synthesis                    deterministic baseline schemas from the profile
    schema_design_attempt_M          M = 1.. ONE call designs every table. A rejected
                                     design is its own step_error carrying the reasons,
                                     and attempt M+1 follows; after the last one the
                                     baseline ships and `schema_fallback` is logged.
    dry_run                          EXPLAIN AST on every statement
  approval_attempt_N                 (the gate; approval_request/result events bracket it)
  ddl_execution_attempt_N            output: LoadedTable[]; emits the execution log events

Runs recorded before the one-call redesign have `design_<event>` here instead — one
concurrent step per event type, with `design_rejected`/`design_fallback` log events.
History replays them, so a report screen has to keep rendering both.
context_update                       (wrapper — spans the whole ② phase)
  update_generation_attempt_N        two concurrent LLM calls inside (table docs
                                     + feature/metric/convention knowledge)
  update_approval_attempt_N
```

Rendering rule: group `*_attempt_N` under one stepper node; a `step_error` on
attempt N followed by attempt N+1 renders as the self-healing retry (show the
error text — it's the feature, not a bug). The wrapper steps (`instrumentation`,
`context_update`) emit `step_start` before their children and `step_end` after.

---

## [LIVE] POST /api/runs/:id/approve — resolve the pending gate

Valid only while `status === "awaiting_approval"`. Both gates use the same
endpoint; the server knows which gate is pending.

```json
{ "approved": true,  "identity": "wilson@team" }
// or reject WITH feedback — feedback goes verbatim to the LLM, which regenerates:
{ "approved": false, "feedback": "partition by day, not month", "identity": "wilson@team" }
```

```json
200 { "ok": true }
400 { "error": "approved: boolean required" }
409 { "error": "run ... is not awaiting approval" }   // stale UI — refetch run
```

`identity` is recorded in the Langfuse trace and `runs_log` — always send it
(free-text; use the user's name/handle). UI for reject = "Request changes" box.

---

## [LIVE] GET /api/specs — the "start from a sample spec" list

`200 [{ id, specDir, events, eventTypes, alreadyInstrumented }]` — pass `specDir`
straight to POST /api/runs. `alreadyInstrumented` disables the Use button.

## [LIVE] GET /api/history — runs that survive restarts (from runs_log)

`200 [{ run_id, spec, started, finished, last_status, events, durationMs }]`, newest
first. `durationMs` is the end-to-end wall clock reconstructed from the persisted
events.

**Capped at the 200 most recent runs.** This used to return every run ever recorded,
which grew the response without limit. If a history screen ever needs more than 200,
it needs pagination rather than a bigger cap. `runs_log` also carries a 90-day TTL and
`insight_cache` a 30-day one, so neither the scan behind this endpoint nor the storage
grows without bound; expiring a cache entry costs a recompute and never changes an
answer.

## [LIVE] GET /api/history/:runId — full decision record of a past run

`200 StoredEvent[]` — same shapes as the SSE stream; renders the report view
(executed DDL from approval_request, approver identity from approval_result,
rationale, context diff) without the run being in memory. `404` if unknown.

## [LIVE] GET /api/context — the Context Browser's main list

`200 ContextEntry[]` — the **latest version of every entity** (what the agents
actually see). Group by namespace prefix (`entity.split(":")[0]`) for the
sidebar; badge entries where `version > 1` as updated.

## [LIVE] GET /api/context/:entity/history

`200 ContextEntry[]` ascending by version (includes `run_id`). URL-encode the
entity (`/api/context/table%3Agroup_started/history`). Render consecutive-pair
text diffs with `change_note` + `source_spec` as annotation.

---

## [LIVE] Chat — the Analytics Agent as a conversation

```
POST   /api/conversations               { title? }              → 201 { id }
GET    /api/conversations               → [{ id, title, starred, updatedAt, preview, messages }]
GET    /api/conversations/:id           → { id, messages: ChatMessage[] } · 404 if unknown/deleted
POST   /api/conversations/:id/star      { starred: boolean }    → { ok: true }
DELETE /api/conversations/:id           → { ok: true } · 404 if unknown/already deleted
POST   /api/conversations/:id/messages  { question: string }    → SSE (below)
GET    /api/suggestions                 → [{ spec, question }]  // chips, from stored PM questions
```

Conversations and every answer persist in ClickHouse (`conversations`, `messages`),
so `GET /api/conversations/:id` re-renders past insight cards with no recompute.
The conversation is auto-titled from its first question.

**Delete is irreversible and has two halves.** The `conversations` row is
tombstoned (`deleted = 1` on a new ReplacingMergeTree version) so the list read
is immediate and deterministic; the `messages` rows are physically removed by a
mutation, so a deleted conversation's questions and answers are really gone —
not merely hidden. Every other conversation route treats a tombstoned id as
unknown (404). `insight_cache` is NOT touched: it is keyed by question text and
context version, not by conversation, and it holds no conversation reference.

### SSE stream of `POST /api/conversations/:id/messages`

Named events (use `addEventListener`, not `onmessage`).

**Timing:** a repeat question (same wording, unchanged context) returns from
`insight_cache` in **milliseconds** with `insight.cached === true` and no step
events at all. A fresh question takes ~1.5–2.5 min, so the progress events below
are what keeps the UI honest during the wait.

| event | data | meaning |
|---|---|---|
| `start` | `{ traceUrl, convId }` | trace link available immediately |
| `step_start` / `step_end` / `step_error` | `{ name, phase, payload }` | agent steps. **Render `phase`, not `name`** — it collapses the twelve technical steps into a handful of reader-facing lines ("Querying ClickHouse"), and concurrent tasks share one phase so they appear as a single entry. An **empty `phase` means plumbing: skip it.** `name` stays available for the "how I got this" detail view |
| `log` | `{ call, elapsedMs?, promptChars?, outputChars? }` | **progress ticks** — `llm_start`, then `llm_progress` every 3s with `elapsedMs`, then `llm_done`. Render as "writing SQL… 14s" per in-flight call |
| `insight` | `{ insight: Insight, traceUrl }` | the finished card |
| `failed` | `{ error, traceUrl }` | answer could not be produced |
| `done` | `{}` | stream closed (always fires, success or failure) |

**Concurrency in the stream.** `task_<id>` children run at the same time, so their
`sql_attempt_N` events interleave — group children by their `task_<id>` parent rather
than assuming sequential arrival. The same applies to `design_<event>` inside an
instrumentation run.

**Honest-failure semantics.** An agent that cannot answer returns the normal shape with
the gap stated inside it, never an invented value:
- a task the SQL writer declared impossible is dropped, with the reason in the sanity
  notes and reflected in a `caveat` finding;
- a question that cannot be answered at all yields a headline saying so, `chart: null`,
  `segmentTable: null`, `sql: []`, and `confidence: "low"`;
- a chart or table whose source task was dropped is removed rather than shown.
Render these as first-class outcomes — they are correct answers, not errors.

Phases, in the order a reader sees them: *Reading the knowledge store · Planning the
analysis · Querying ClickHouse · Validating the results · Looking for known issues ·
Writing the insight · Reviewing the answer* (the last two are skipped when the answer
is cached or the quality gate is not needed).

Underlying step names, for the detail view:

```
analytics                  (wrapper)
  context_load             knowledge + schemas + contextVersion
  cache_lookup             only when this is not a follow-up; a hit ends the run here
                           (keyed by question + a digest of every entity version, so
                           any context write invalidates it)
  plan                     → ≤4 tasks
  task_<id>                ONE PER TASK, RUN CONCURRENTLY — events interleave, so
    sql_attempt_N          group children by their task_<id> parent
    digest_<id>            only when the result exceeds the 24 rows the narrator
                           reads: profiles EVERY row of it in ClickHouse. Its
                           absence means the narrator saw the result in full.
  sanity_gate              what was dropped/flagged and why
  context_lookup           known issues that might explain an anomaly
  narrate_attempt_N        N>1 means the citation check rejected a number
  quality_gate             SKIPPED entirely when the code checks already pass —
                           its absence means the answer was clean, not that it failed
  narrate_revision         only when the quality gate asked for one
```

```ts
// The answer is a fixed set of named sections, in the order a PM reads them.
// A tagged `findings` list let an answer satisfy the schema while never saying
// WHY — six observations and no mechanism used to pass. A required, named slot
// cannot be skipped, and a reader finds the same thing in the same place.
export interface Insight {
  headline: string;                                  // one-sentence answer with the key number
  whatsHappening: string;                            // the effect in numbers: size, population, where
  whyItHappens: string;                              // the MECHANISM — never the measurement restated
  evidence: {
    title: string;                                   // what the visual shows + its basis (population, window)
    chart: null | {
      kind: "bar" | "line";
      series: Array<{ label: string; value: number }>; sourceTask: string;
      valueFormat?: ValueFormat;      // how to render `value` — see below
    };
    segmentTable: null | {
      columns: string[]; rows: Array<Array<string | number>>; sourceTask: string;
      columnFormats?: Array<ValueFormat | "text">;   // parallel to `columns`
    };
  };
  groundedInContext: string;          // retrieved knowledge bearing on the answer; "" when none applies
  recommendedAction: string;          // the decision this implies, and what it should move
  // COMPUTED in code, never the model's opinion — see "Confidence" below.
  // `score` is the same judgement on a 0–1 scale, clamped into the band its
  // level implies so the number and the label can never disagree.
  confidence: { value: "high" | "medium" | "low"; score: number; note: string };
  precision: Array<{
    column: string;
    kind: "proportion" | "mean" | "quantile" | "ratio" | "count" | "unknown";
    value: number;
    n: number | null;                    // denominator; null when none was emitted
    interval: { lo: number; hi: number; halfWidthPp: number } | null;
    note: string;                        // why there is no interval, when there isn't
  }>;
  verification: null | {
    agreed: boolean | null;              // null ⇒ inconclusive, NOT passed
    originalValue: number | null;
    verifiedValue: number | null;
    sql: string;                         // the independent query that was run
    note: string;
    concern: string;                     // strongest reason the figure might be wrong
    definitionOk: boolean;               // did the SQL use the documented denominator
    answersQuestion: boolean;
  };
  contextVersion: string;                            // e.g. "44 entities · max v2" — the badge
  sql: Array<{
    task: string;                        // "t1"; also "t1_profile" / "t1_top" / "t1_bottom"
    title: string;
    query: string;
    rowCount: number;                    // rows this query returned
    totalRows?: number;                  // rows the ANALYSIS covered; absent for small results
  }>;
  cached?: boolean;                                  // true ⇒ served from insight_cache, no LLM ran
}
export interface ChatMessage {
  role: "user" | "agent";
  ts: string;
  text?: string;                 // role=user
  insight?: Insight | null;      // role=agent
  traceUrl?: string;             // role=agent
}
```

**Confidence is computed, not claimed.** The model no longer rates its own answer.
`confidence.value` is derived from: the widest 95% interval among the reported figures,
whether the sanity gate flagged anything, whether the narration needed a citation
retry, and whether an **independently written query reproduced the headline figure**.
`high` requires a tight interval and a successful verification; a failed verification
forces `low`.

`precision[]` carries the bounds per figure. Only *proportions* get an interval —
means need a standard deviation, quantiles need bootstrapping, and unbounded ratios
(a K-factor, travellers per group) need a different method entirely. For those,
`interval` is `null` and `note` says why. **Render "precision not computable" rather
than implying certainty**; an interval we could not compute is never silently omitted.
Intervals assume independent trials, so they are a lower bound on real uncertainty —
several events can come from one user.

`verification` is the strongest correctness signal available: a second query, written
adversarially by a different route, recomputes the figure and the two are compared.
`agreed: null` means inconclusive — surface it as unverified, never as passed. Show
`concern` when present even if the numbers agreed; it is the auditor's best argument
that the figure is wrong.

**Query safety.** Generated SQL is read-only by construction: the guard rejects
anything that is not a single SELECT/WITH, strips banned keywords, and clamps any
LIMIT above 1000; the server runs it with `readonly=1` and a 30s execution cap.
(ClickHouse Cloud pins this user to `readonly=1`, which discards row-limit settings,
so the row cap is enforced in the guard rather than as a server setting — verified
against `system.settings`.)

**Fetched is not analysed.** That 1000-row cap is a *transport* limit, not a limit on
what the answer is based on. When a task's result is larger than the rows the narrator
can read (24), the agent wraps the task's own statement as a subquery and has
ClickHouse compute the statistics of **every** row of it — an exact `count()`, the
population-weighted rate with its denominator (`full_<base>_rate` / `full_<base>_n`),
per-column min/max/median, an exact count of impossible values, distinct counts, date
ranges — plus the highest and lowest rows by the leading metric. Those queries appear
in `sql[]` as `<task>_profile`, `<task>_top` and `<task>_bottom`; `totalRows` on the
task's own entry says how many rows the analysis covered.

So for a large result: `rowCount` is the sample that crossed the wire, `totalRows` is
what the numbers describe. **Render the pair, not `rowCount` alone** — "1,000 of 52,340
rows analysed" is the honest label; "1,000 rows" understates the answer. A LIMIT the
model authored is treated as part of the question ("the 10 worst cities") and stays
inside the profiled scope; the cap the guard appends never bounds the analysis. If a
profile cannot be computed the task degrades to the fetched rows, labelled as partial,
and says so in a caveat — it is never silently presented as the whole picture.

**Number guarantees** (worth surfacing in the UI): every number in an Insight
either appears in one of the attached `sql` results — including the whole-set profile
results — or is a code-verified difference/ratio of two such numbers. Profile figures
are ordinary ClickHouse output, so the chain from a reported number back to the
database is unbroken whatever the result's size. SQL runs read-only (`readonly=1`), so
chat can never mutate data, and the agent cannot write context.

**Value formatting.** Values stay exactly as the SQL produced them (so every number
remains traceable), and a **code-derived** hint says how to render each one:

```ts
type ValueFormat =
  | "fraction"          // 0..1 rate — display as value × 100 with %
  | "percent"           // already 0..100, means %
  | "percentage_points" // a gap/lift in pp
  | "count" | "ms" | "seconds" | "currency" | "number";
```

`chart.valueFormat` applies to every point in that chart; `segmentTable.columnFormats`
is parallel to `columns` and uses `"text"` for non-numeric columns. These are inferred
from the source query's column names and value ranges, never asked of the model, so
they are consistent across answers.

**Verified end-to-end.** Instrumentation (both gates), a fresh question, a cached
question, a follow-up, conversation persistence and reload, suggestion chips, and
and the changelog have all been exercised over HTTP. Measured: a fresh answer
40–67s, a cached answer **~0.6s**, instrumentation with both gates ~57s.

## [LIVE] GET /api/observe/clickhouse — the Database health tab

All figures measured from ClickHouse system tables. Nothing is estimated: when a
system table is unavailable the field degrades to a null/zero **and a flag says
so**, so the UI can render "unavailable" rather than presenting 0 as a
measurement.

```ts
export type QueryAgent =
  | "instrumentation" | "context" | "analytics" | "optimizer" | "observe" | "server" | "script";
export type TableOrigin = "base" | "agent" | "internal";

export interface DatabaseHealth {
  windowHours: number;              // 24
  queryLogAvailable: boolean;       // false ⇒ every query-derived number is meaningless, say so in the UI
  queryLogClustered: boolean;       // true = union across Cloud replicas (see gotcha 8)
  stats: {
    queries24h: number; p95LatencyMs: number; rowsRead24h: number;
    tablesLive: number; baseTables: number; agentTables: number;   // "8 base + N agent-created"
  } | null;
  latencyP95ByHour: Array<{         // always exactly 24, dense, oldest first
    hourTs: number;                 // epoch seconds, start of hour
    hour: string;                   // ISO
    p95Ms: number; queries: number; // both 0 for an hour with no traffic
    isSpike: boolean;               // p95 ≥ max(2 × median busy hour, 100ms)
    spikeCause: string | null;      // e.g. "instrumentation insert (412,900 rows)"
  }>;
  storageByTable: Array<{ table: string; bytes: number; rows: number; parts: number; origin: TableOrigin }>;
  storageTotalBytes: number;
  partsHealth: {
    activeParts: number; activeMerges: number; failedMerges24h: number;
    healthy: boolean; partLogAvailable: boolean;   // false ⇒ failedMerges24h is unknown, not zero
  } | null;
  slowestQueries: Array<{ shape: string; maxMs: number; runs: number; rows: number; agent: QueryAgent | null }>;
  recentQueries: Array<{
    queryId: string; at: string; query: string; ms: number; rows: number;
    agent: QueryAgent | null; step: string | null; runId: string | null;
  }>;
}
```

`agent` is `null` for anything Clickwright did not run (a teammate's console
session, ClickHouse Cloud's own internals) — render those as "unattributed"
rather than guessing. Numbers are raw; format them in the UI.

## [LIVE] GET /api/observe/changelog — the Changelog tab

`200 ChangelogEntry[]`, newest first. Optional `?kind=table|context` matches the
UI's filter chips.

```ts
export interface ChangelogEntry {
  id: string;
  at: string;                     // "YYYY-MM-DD HH:MM:SS.mmm"
  kind: "table" | "context";
  title: string;                  // "context v1.3" | "group_started + 3 more created"
  description: string;
  warn: boolean;                  // an existing definition was superseded → "contradiction surfaced" badge
  traceUrl: string | null;        // deep link; null for the seed and audit batches
  runId: string | null;
  spec: string | null;
  contextVersion: string | null;  // "v1.3" on context entries only
  entities: string[];             // context entries
  tables: Array<{ name: string; rows: number }>;   // schema entries
}
```

The global `contextVersion` is **derived**, not stored: one run writes one batch
of `context_store` rows sharing a `run_id`, batches are ordered by time, and
batch 0 (the `base_context.md` seed) is `v1.0`. `reset-spec.ts` deletes a run's
context rows, which renumbers later versions — don't cache these across a reset.

## [LIVE] GET /api/observe/changelog/export

`text/markdown` attachment (`clickwright-changelog.md`) of the same entries.

## [LIVE] Optimization advisor

```
GET  /api/observe/suggestions            → ScanResult
POST /api/observe/suggestions/scan       → 202 { status: "scanning" } · 409 if one is already running
POST /api/observe/suggestions/:id/draft  → 201 { id, spec, kind, status }  ("Ask agent to draft it")
```

```ts
export interface Suggestion {
  id: string;
  severity: "HIGH" | "MED" | "GOOD";
  action: string;                 // one imperative line
  why: string;                    // cites measured figures
  targetTable: string | null;
  actionable: boolean;            // false ⇒ hide "Ask agent to draft it"
  scannedAt: string;
}
export interface ScanResult {
  status: "never_run" | "scanning" | "ready" | "failed";
  scannedAt: string | null;
  traceUrl: string | null;
  suggestions: Suggestion[];      // HIGH → MED → GOOD
  error?: string;
}
```

A scan is one LLM call over measured evidence and takes **2–3 minutes**. `POST
/scan` returns immediately; poll `GET /suggestions` until `status !== "scanning"`.

`actionable` is true only when the change is expressible as one of the five
statement forms the drafting agent may emit (`MODIFY TTL`, `ADD COLUMN`,
`MODIFY COLUMN`, `CREATE MATERIALIZED VIEW`, `OPTIMIZE TABLE`). Good suggestions
that need a code or policy change are returned with `actionable: false`.

`POST /suggestions/:id/draft` enqueues an **optimization run** on the normal run
queue. It is driven exactly like a spec run — `/api/runs/:id`, the SSE stream,
and `/api/runs/:id/approve` — but its gate is `"optimization"` and its
`payload.proposal` is an `OptimizationProposal`, not a `DdlProposal`. Approving
executes the statements byte-for-byte; rejecting sends feedback back to the model,
which regenerates (up to 4 attempts).

## [PLANNED] Remaining observability

```
GET /api/observe/traces?limit=50      → proxy of Langfuse traces (name, id, tokens, cost, duration, status, scores)
GET /api/observe/activity             → runs_log aggregated per 15min per type (agent activity chart)
```

---

## Gotchas for the implementer

1. **EventSource + POST don't mix** — create the run with `fetch`, then open
   `EventSource` on `/api/runs/:id/events`. Replay makes late-connect safe.
2. **Multiple `approval_request`s for the same gate are normal** after a
   rejection — always render the LATEST one; disable the approve panel the
   moment `approval_result` arrives.
3. **`step_end` outputs may be clipped** (`…[clipped]`) — fine for the UI; the
   full artifact is always in the Langfuse trace (`traceUrl`).
4. **Timings**: a run takes 3–6 minutes; generation steps are 1–3 min each with
   no intermediate events — show an elapsed timer/spinner on the running step,
   don't treat silence as a stall (keepalives confirm liveness).
5. **`/api/runs` is the session's hot list, `/api/history` is the truth** —
   after a backend restart the hot list is empty but every event is already in
   `runs_log` (verified: inserts happen per-event, not on completion). History
   screen = `/api/history`; live screen = `/api/runs` + SSE.
6. Statuses `queued → running` can flip fast for an idle queue — don't animate
   on `queued` unless it persists.
7. **A `dry_run_attempt_N` `step_error` is not a run failure** — it feeds the
   retry loop like any other error; a new generation attempt follows.
8. **Gate event ordering**: entering a gate emits `approval_request` *before*
   `status: awaiting_approval`; resolving one emits `status: running` *before*
   `approval_result`. Re-enable the approve panel on `approval_request`, not on
   `status: running`, or it flashes on every rejection.
9. **`queryLogAvailable: false` is not "zero activity."** On ClickHouse Cloud the
   query log lives per replica; the backend unions it with `clusterAllReplicas`
   (measured: the local table saw 63k queries in 24h against 127k clustered) and
   reports `queryLogClustered` so you can tell. It also flushes on an interval, so
   a query run seconds ago may not be listed yet.
10. **Query attribution is not retroactive.** `agent` comes from a `log_comment`
    stamped at execution time, so anything run before this shipped — or from a
    ClickHouse console — is `null` forever.
