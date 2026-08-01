# Clickwright Backend API — Integration Spec

Base URL: `http://localhost:8787` · All routes under `/api`. In the webapp dev
server, `/api/*` is already proxied here (see `webapp/vite.config.ts`), so the
frontend calls relative paths (`fetch("/api/runs")`).

Start the backend with `cd backend && npm run serve`. No auth (hackathon; single
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
  | "status" | "approval_request" | "approval_result";

export interface RunEvent {
  seq: number;              // 0-based, dense, ordering key
  ts: string;               // ISO timestamp
  type: RunEventType;
  name: string;             // step name | status value | gate name
  payload: Record<string, unknown>; // see per-type shapes below
}

// ── gate proposals (payload.proposal of approval_request) ────────
export interface DdlProposal {
  reasoning: string;        // the agent's design rationale, plain text
  tables: Array<{
    name: string;           // table to create
    event: string;          // source event type
    purpose: string;        // one-line description
    ddl: string;            // full CREATE TABLE statement (with COMMENTs)
  }>;
}

export interface ContextProposal {
  entries: Array<{
    entity: string;         // e.g. "table:group_started", "metric:x", "convention:envelope"
    definition_md: string;  // full replacement text (markdown)
    change_note: string;    // why this entry/version exists
  }>;
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

## [LIVE] GET /api/runs — run list

`200 RunSummary[]`, newest first. In-memory: restarts clear it (history
survives in the `runs_log` ClickHouse table; a history endpoint over it is
[PLANNED], see below).

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
implemented). With `EventSource`, either register `addEventListener` for each
of the six event types, or just use one generic handler via `onmessage`-style
listeners per type.

### Event payload shapes by type

| type | name | payload |
|---|---|---|
| `step_start` | step name (below) | `{ input: object }` |
| `step_end` | step name | `{ output: object }` — strings >2000 chars clipped with `…[clipped]` |
| `step_error` | step name | `{ error: string }` — verbatim failure, feeds the retry |
| `status` | the new `RunStatus` | varies: `running` first time → `{ traceUrl }`; `awaiting_approval` → `{ gate }`; `succeeded` → `{ tables: LoadedTable[], contextEntries: {entity, version}[], traceUrl }`; `failed` → `{ error }` |
| `approval_request` | `"ddl"` \| `"context"` | `{ proposal: DdlProposal \| ContextProposal }` |
| `approval_result` | gate | `{ approved: boolean, feedback: string, identity: string }` |

`LoadedTable = { name, event, purpose, rowsInFile, rowsLoaded }`.

### Step names, in order (the Run screen's stepper)

```
instrumentation                      (wrapper — spans the whole ① phase)
  profile                            output: field stats + newFields
  schema_reconciliation              output: liveTables, documentedNotLive, liveNotDocumented
  ddl_generation_attempt_N           N = 1.. (step_error ⇒ another attempt follows)
  approval_attempt_N                 (the gate; approval_request/result events bracket it)
  ddl_execution_attempt_N            output: LoadedTable[] (execute + load + verify)
context_update                       (wrapper — spans the whole ② phase)
  update_generation_attempt_N
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

## [LIVE] GET /api/context — the Context Browser's main list

`200 ContextEntry[]` — the **latest version of every entity** (what the agents
actually see). Group by namespace prefix (`entity.split(":")[0]`) for the
sidebar; badge entries where `version > 1` as updated.

## [LIVE] GET /api/context/:entity/history

`200 ContextEntry[]` ascending by version (includes `run_id`). URL-encode the
entity (`/api/context/table%3Agroup_started/history`). Render consecutive-pair
text diffs with `change_note` + `source_spec` as annotation.

---

## [PLANNED] Chat (Analytics Agent) — contract frozen, not yet served

```
POST /api/conversations                    { title? } → 201 { id }
GET  /api/conversations                    → [{ id, title, starred, updatedAt, preview }]
POST /api/conversations/:id/messages       { question: string } → SSE stream (below)
GET  /api/conversations/:id                → { messages: ChatMessage[] }
```

SSE events while the agent works: `plan` → `sql_start`/`sql_result` (per task,
includes SQL + row sample) → `insight` (final) → `done`; `step_error` for retries.

```ts
export interface Insight {
  headline: string;                     // one-sentence answer
  findings: Array<{ tag: string; text: string }>;   // tag: "driver" | "segment" | "caveat" | "known_issue"
  chart: null | { title: string; kind: "bar" | "line"; series: Array<{ label: string; value: number }> };
  segmentTable: null | { columns: string[]; rows: Array<Array<string | number>> };
  confidence: { value: "high" | "medium" | "low"; note: string };
  contextVersion: string;               // e.g. "v1.3-equivalent: max version set seen"
  traceId: string; traceUrl: string;
  sql: Array<{ task: string; query: string; rowCount: number }>;  // for collapsible "how I got this"
}
export interface ChatMessage { role: "user" | "agent"; text?: string; insight?: Insight; ts: string }
```

## [PLANNED] Dashboards

```
POST /api/dashboards            { title, sql, chartKind, meta? } → 201 { id }   // "Save to dashboard" on an insight chart
GET  /api/dashboards            → [{ id, title, chartKind, createdAt }]
GET  /api/dashboards/:id/run    → { headline?, series, ms, ranAt }              // re-executes the saved SQL — fresh data every load
DELETE /api/dashboards/:id
```

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
5. **runs list is in-memory** — after a backend restart, live runs are gone but
   `runs_log` (ClickHouse) still has all events; the History screen should not
   assume `/api/runs` is complete history once the [PLANNED] endpoint lands.
6. Statuses `queued → running` can flip fast for an idle queue — don't animate
   on `queued` unless it persists.
7. **Gate event ordering**: entering a gate emits `approval_request` *before*
   `status: awaiting_approval`; resolving one emits `status: running` *before*
   `approval_result`. Re-enable the approve panel on `approval_request`, not on
   `status: running`, or it flashes on every rejection.
8. **`queryLogAvailable: false` is not "zero activity."** On ClickHouse Cloud the
   query log lives per replica; the backend unions it with `clusterAllReplicas`
   (measured: the local table saw 63k queries in 24h against 127k clustered) and
   reports `queryLogClustered` so you can tell. It also flushes on an interval, so
   a query run seconds ago may not be listed yet.
9. **Query attribution is not retroactive.** `agent` comes from a `log_comment`
   stamped at execution time, so anything run before this shipped — or from a
   ClickHouse console — is `null` forever.
```
