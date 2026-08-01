# Observe → Database health + Changelog — backend plan

> **Status: implemented (2026-08-01).** All three phases are built, typechecked, and verified
> against the live ClickHouse service; 52 unit tests pass. The shipped contract is documented in
> `backend/API.md`. This document is kept as the design rationale — where it and API.md disagree,
> API.md is authoritative. Deviations found during the build are recorded in §9.

What the SpecLoop Console mockup's **Observability** section needs from the backend, what
exists today, and the order to build it in.

Scope: the `Database health` and `Changelog` tabs. The `Agent activity` (traces) tab is a
Langfuse proxy and is out of scope here.

---

## 1. What the UI actually renders

Read off the mockup's view-model (`renderVals()` → `statVms`, `latVms`, `storVms`, `optVms`,
`slowVms`, `queryVms`, `logbookVms`).

### Tab: Database health (`obsTab === 'stack'`)

| Block | View-model | Data the backend must supply |
|---|---|---|
| 4 stat cards | `statVms` | queries in 24h · p95 latency ms · rows read in 24h · live table count split `8 base + N agent-created` |
| Query latency chart | `latVms` + `latLinePts` | 24 hourly p95 buckets, dense (gap-filled), one bucket flagged as a spike with a human-readable cause ("express_checkout backfill, INSERT 412k rows") |
| Storage by table | `storVms`, `storTotal` | per-table bytes, sorted desc, flag `agent-created` vs base (drives the green bars); footer needs total bytes, active part count, merge health |
| Optimization suggestions | `optVms` | severity `HIGH`/`MED`/`GOOD`, one-line action, a "why" paragraph citing measured evidence, and an `actionable` flag that shows the **"Ask agent to draft it"** button |
| Slowest queries · 24h | `slowVms` | query shape, duration, rows — deduped by shape, not raw rows |
| Recent queries | `queryVms` + `qFilterVms` | query text, duration, rows, **and which agent ran it** (filter chips: All / Analytics / Instrumentation) |

### Tab: Changelog (`obsTab === 'log'`)

| Block | View-model | Data the backend must supply |
|---|---|---|
| Filter chips | `logFilterVms` | one stream, filterable to `kind: 'table'` (schema changes) or `kind: 'ctx'` (context versions) |
| Timeline | `logbookVms` | time · kind · title · description · `traceId` (clickable, jumps to the traces tab) · `warn` flag rendering a **"contradiction surfaced"** badge |
| Header CTA | `obsCta` | "Export changelog" — a downloadable artifact |

Representative entries from the mockup:

```js
{ kind:'ctx',   title:'context v1.3', desc:'+ alert_delivery metrics · stale claim "all notifications are email" superseded', traceId:'tr_cx_31f0', warn:true }
{ kind:'table', title:'whatsapp_alert_events + 1 MV created', desc:'Instrumentation Agent · human-approved · 96,882 events backfilled', traceId:'tr_wa_55aa' }
```

---

## 2. Gap analysis against the current backend

`API.md` already froze a contract for this area:

```
GET /api/observe/clickhouse → { latencyP95ByHour, storageByTable, slowestQueries, recentQueries }
```

That covers four of the six Database-health blocks and **nothing** of the Changelog. Concretely:

**Already available, no new plumbing needed**
- `context_store` — entity, version, `source_spec`, `change_note`, `updated_at`, `run_id`. Everything the Changelog's context entries need.
- `runs_log` — every run event with payload. The `status:succeeded` payload carries `tables: LoadedTable[]`; `status:running` carries `traceUrl`; `approval_result` carries `identity`. Everything the Changelog's schema entries need.
- `reconcileWithLive()` in `src/agents/context.ts` already lists live tables minus internals.

**Missing and blocking**

1. **Query attribution.** The `Recent queries` panel groups by agent, and the advisor needs to know which agent issued which query. `system.query_log` has no idea. The only way to get it is to stamp `log_comment` on every query **at execution time** — a change to `src/core/db.ts`. This cannot be back-filled, so it must land first or all agent labels are guesses.
2. **No `system.query_log` access layer.** On ClickHouse Cloud `query_log` is per-replica; a plain `SELECT … FROM system.query_log` silently under-reports when the service has more than one node. Needs `clusterAllReplicas` with a probe and fallback.
3. **No global context version.** The UI shows `context v1.3`; `context_store` versions are per-entity (`table:foo` is at v2 while `metric:bar` is at v5). A derived global version is required.
4. **No changelog endpoint at all** — not in `API.md`, not in code.
5. **No optimization advisor.** This is a new agent: gather measured evidence → LLM proposes suggestions → store → optionally draft DDL through the existing approval gate.
6. **Self-pollution.** The health endpoint queries `query_log`; those queries are themselves logged and would inflate every number on the page. They must be tagged and excluded.

---

## 3. Design decisions

### 3.1 Query attribution via `log_comment` + AsyncLocalStorage

`db.query()` is called from many places; threading an `agent` parameter through every call
site would touch every module. Use `AsyncLocalStorage` instead: the run manager opens a
context for the run, agents narrow it per step, and `db.ts` reads it when building
`clickhouse_settings`.

```
withQueryContext({agent:'instrumentation', runId, step}, () => …)
        ↓
db.query() → clickhouse_settings.log_comment = '{"app":"clickwright","agent":"instrumentation","run":"run_…"}'
        ↓
system.query_log.log_comment → JSONExtractString(log_comment,'agent')
```

Queries with no context default to `agent:"server"`. Observability's own queries use
`agent:"observe"` and are excluded from every aggregate.

### 3.2 Base vs agent-created tables — derive it, don't hard-code it

The mockup colours agent-created tables green. Rather than a hard-coded list of the 8 base
tables, derive origin from `context_store`: a `table:*` entity whose **first** version came
from `source_spec = 'base_context.md'` is base; anything else was created by a run. Falls
back to the known 8 if `context_store` is empty. This stays correct as specs are added and
matches the project's rule that knowledge comes from the context layer, not from guessing.

### 3.3 Global context version = write batch index

One run writes one batch of `context_store` rows sharing a `run_id`. Order batches by time;
batch 0 (the `base_context.md` seed) is `v1.0`, batch 1 is `v1.1`, … batch 10 rolls to `v2.0`.
Pure function, trivially testable, and it gives the Changelog the version label the UI wants
without adding a new table.

### 3.4 `warn` = an existing definition was superseded

The mockup's "contradiction surfaced" badge maps cleanly onto data we already store: a batch
containing any entry with `version > 1` replaced a previous definition. That is exactly the
"the provided context was wrong and we corrected it" story the badge is telling.

### 3.5 Return raw numbers, not formatted strings

Consistent with the rest of `API.md` (`rowsInFile`, `rowsLoaded`). The backend returns
`rowsRead24h: 48214392`; the UI renders `48.2M`. Exception: Changelog titles/descriptions and
advisor prose are genuinely backend-authored text.

### 3.6 Degrade honestly when `query_log` is unavailable

A fresh Cloud service, or one with `query_log` disabled, must not render zeros as if they were
measurements — that would violate the project's "numbers only ever come from ClickHouse" rule.
The payload carries `queryLogAvailable: boolean` so the UI can show "not available" instead of
"0 queries".

---

## 4. API additions

Extends the frozen `[PLANNED]` contract; `API.md` must be updated in the same commit as each
endpoint.

```
GET  /api/observe/clickhouse            → DatabaseHealth        (extends the planned shape)
GET  /api/observe/changelog             → ChangelogEntry[]
GET  /api/observe/changelog/export      → text/markdown attachment
GET  /api/observe/suggestions           → { status, scannedAt, suggestions }
POST /api/observe/suggestions/scan      → 202 { status: "scanning" }
POST /api/observe/suggestions/:id/draft → 201 { id }   // an optimization run, gated like a spec run
```

```ts
export type QueryAgent = "instrumentation" | "context" | "analytics" | "observe" | "server" | "script";
export type TableOrigin = "base" | "agent" | "internal";

export interface DatabaseHealth {
  windowHours: number;
  queryLogAvailable: boolean;
  stats: {
    queries24h: number; p95LatencyMs: number; rowsRead24h: number;
    tablesLive: number; baseTables: number; agentTables: number;
  };
  latencyP95ByHour: Array<{
    hourTs: number; hour: string; p95Ms: number; queries: number;
    isSpike: boolean; spikeCause: string | null;
  }>;
  storageByTable: Array<{
    table: string; bytes: number; rows: number; parts: number; origin: TableOrigin;
  }>;
  storageTotalBytes: number;
  partsHealth: { activeParts: number; activeMerges: number; failedMerges24h: number; healthy: boolean };
  slowestQueries: Array<{ shape: string; maxMs: number; runs: number; rows: number; agent: QueryAgent | null }>;
  recentQueries: Array<{
    queryId: string; at: string; query: string; ms: number; rows: number;
    agent: QueryAgent | null; step: string | null; runId: string | null;
  }>;
}

export interface ChangelogEntry {
  id: string;
  at: string;                       // ISO
  kind: "table" | "context";
  title: string;                    // "context v1.3" | "whatsapp_alert_events created"
  description: string;
  warn: boolean;                    // an existing definition was superseded
  traceUrl: string | null;
  runId: string | null;
  spec: string | null;
  contextVersion: string | null;    // "v1.3", context entries only
  entities: string[];               // context entries
  tables: Array<{ name: string; rows: number }>;  // table entries
}

export interface Suggestion {
  id: string; severity: "HIGH" | "MED" | "GOOD";
  action: string; why: string;
  targetTable: string | null;
  actionable: boolean;              // GOOD → false, hides "Ask agent to draft it"
  evidence: Record<string, string | number>;
  scannedAt: string;
}
```

---

## 5. File structure

```
backend/src/core/query-context.ts     NEW  AsyncLocalStorage + log_comment build/parse
backend/src/core/db.ts                MOD  stamp log_comment on query/command/insert
backend/src/core/env.ts               MOD  CLICKHOUSE_CLUSTER
backend/src/observe/query-log.ts      NEW  cluster-aware source probe + shared WHERE filter
backend/src/observe/db-health.ts      NEW  stats, latency, storage, parts, queries
backend/src/observe/changelog.ts      NEW  batch→version, pure changelog assembly, markdown
backend/src/observe/advisor.ts        NEW  evidence gathering + LLM scan + storage
backend/src/observe/routes.ts         NEW  express router for /api/observe/*
backend/src/agents/optimizer.ts       NEW  suggestion → DDL → gate → execute
backend/src/server/index.ts           MOD  mount the router
backend/src/server/runs.ts            MOD  optimization run kind
backend/prompts/optimization_scan.txt NEW
backend/prompts/optimization_ddl.txt  NEW
backend/test/**                       NEW  unit tests for the pure functions
backend/API.md                        MOD  per endpoint, in the same commit
```

Splitting `db-health.ts` from `routes.ts` matters: every SQL builder and row shaper is a pure
function that can be tested with fixtures, with no live ClickHouse in the loop. Only the thin
route layer needs a real database.

---

## 6. Build order

Phase A is the demo-critical core. Phase B is the advisor. Phase C is the write-back action
and can be cut without breaking either tab.

### Phase A — the two tabs

**A1. Test harness + query attribution** *(blocks everything; nothing can be attributed retroactively)*

Add to `package.json`: `"test": "node --import tsx --test \"test/**/*.test.ts\""`, and add
`test/**/*.ts` to `tsconfig.json`'s `include`. No new dependency — `tsx` is already a
devDependency and the package is already `"type": "module"`.

> Verified on this machine (Node 22.2.0): `node --test` resolves the `test/**/*.test.ts` glob
> and runs ESM tests. The `--import tsx` half was **not** executable here because
> `backend/node_modules` is not installed in this checkout — run `npm install` in `backend/`
> before A1.

`src/core/query-context.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";

export type QueryAgent =
  | "instrumentation" | "context" | "analytics" | "observe" | "server" | "script";

export interface QueryContext { agent: QueryAgent; runId?: string; step?: string }

const storage = new AsyncLocalStorage<QueryContext>();

export function withQueryContext<T>(ctx: QueryContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentQueryContext(): QueryContext | undefined {
  return storage.getStore();
}

/** Stamped into ClickHouse's log_comment so system.query_log can attribute every
 *  query to the agent that ran it. Kept short — stored per query row. */
export function buildLogComment(ctx: QueryContext | undefined): string {
  const c = ctx ?? { agent: "server" as const };
  const out: Record<string, string> = { app: "clickwright", agent: c.agent };
  if (c.runId) out["run"] = c.runId;
  if (c.step) out["step"] = c.step;
  return JSON.stringify(out);
}

export function parseLogComment(raw: string): {
  agent: QueryAgent | null; runId: string | null; step: string | null;
} {
  const empty = { agent: null, runId: null, step: null };
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (p["app"] !== "clickwright") return empty;
    return {
      agent: typeof p["agent"] === "string" ? (p["agent"] as QueryAgent) : null,
      runId: typeof p["run"] === "string" ? p["run"] : null,
      step: typeof p["step"] === "string" ? p["step"] : null,
    };
  } catch {
    return empty;
  }
}
```

`src/core/db.ts` — merge into all three call sites:

```ts
import { buildLogComment, currentQueryContext } from "./query-context.js";

function tagged(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, log_comment: buildLogComment(currentQueryContext()) };
}
// query():   db().query({ query: sql, format: "JSONEachRow", clickhouse_settings: tagged() })
// command(): clickhouse_settings: tagged({ wait_end_of_query: 1 })
// insert():  clickhouse_settings: tagged({ date_time_input_format: "best_effort" })
```

Wire the context in at two points — `RunManager.execute()` wraps the whole run in
`withQueryContext({agent:'instrumentation', runId: run.id}, …)`, and `updateContext()` narrows
to `agent:'context'`.

Tests: `buildLogComment` defaults to `server` and includes run/step when set; `parseLogComment`
returns nulls for foreign or malformed comments; `withQueryContext` survives an `await`
boundary and nests (inner overrides outer).

**A2. Cluster-aware `query_log` source**

`src/observe/query-log.ts`. Add `cluster: optional("CLICKHOUSE_CLUSTER", "default")` to
`env.clickhouse`. Probe once at first use:

1. `SELECT count() FROM clusterAllReplicas('<cluster>', system.query_log) WHERE event_time >= now() - INTERVAL 1 MINUTE`
2. on error → same against `system.query_log`
3. on error → `{ available: false }`

Cache the winner for the process. Export the shared predicate so every collector filters
identically:

```sql
type = 'QueryFinish'
AND event_time >= now() - INTERVAL 24 HOUR
AND (has(databases, '<db>') OR current_database = '<db>')
AND JSONExtractString(log_comment, 'agent') != 'observe'
```

The last line is what stops the health page from counting itself.

**A3. Stats + latency series**

`src/observe/db-health.ts`. Return `toUnixTimestamp(toStartOfHour(event_time))` rather than a
formatted timestamp — epoch seconds avoid every timezone and separator ambiguity between
ClickHouse's `2026-08-01 13:00:00` and JS's ISO format.

Pure, unit-tested:
- `fillLatencyBuckets(rows, nowMs, hours = 24)` → exactly 24 dense buckets ending at the
  current hour, missing hours zero-filled. Tests: empty input yields 24 zero buckets; a
  single row lands in the right slot; rows outside the window are dropped.
- `markSpikes(buckets)` → flags buckets where `p95Ms >= max(2 × median of non-empty buckets, 100)`.
  Tests: a flat series flags nothing; one 5× outlier flags exactly one bucket.

Then one follow-up query per flagged hour fetches the slowest query in that hour and its
`log_comment`, producing `spikeCause` (e.g. `"instrumentation · INSERT · 412,900 rows"`).

`tablesLive` uses `reconcileWithLive()` for the live list and the origin map from §3.2 for the
base/agent split.

**A4. Storage + parts health**

```sql
SELECT table, sum(bytes_on_disk) AS bytes, sum(rows) AS rows, count() AS parts
FROM system.parts WHERE database = '<db>' AND active
GROUP BY table ORDER BY bytes DESC
```

Tag each row with `origin` (`base` / `agent` / `internal` for `context_store` and `runs_log`).
Parts health from `system.parts` (active count), `system.merges` (in-flight), and
`system.part_log` (24h errors) — `part_log` may be absent, so wrap it and report 0 rather than
failing the whole endpoint. `healthy = failedMerges24h === 0 && activeMerges < 10`.

**A5. Recent + slowest queries**

Recent — newest 20, text collapsed and truncated server-side so the UI never receives a 40 KB
query string:

```sql
SELECT query_id,
       toString(event_time)                                        AS at,
       query_duration_ms                                           AS ms,
       greatest(read_rows, written_rows)                           AS rows,
       log_comment,
       substring(replaceRegexpAll(query, '\\s+', ' '), 1, 240)     AS q
FROM <source> WHERE <shared filter>
ORDER BY event_time DESC LIMIT 20
```

`greatest(read_rows, written_rows)` is deliberate — the mockup shows `412.9k` for an INSERT,
which reads zero rows.

Slowest — grouped by shape so one heavy query run five times occupies one row:

```sql
SELECT normalizeQuery(query) AS shape, max(query_duration_ms) AS ms, count() AS runs,
       max(greatest(read_rows, written_rows)) AS rows, any(log_comment) AS log_comment
FROM <source> WHERE <shared filter>
GROUP BY shape ORDER BY ms DESC LIMIT 5
```

Both map `log_comment` through `parseLogComment` for the agent chip.

**A6. `GET /api/observe/clickhouse` + API.md**

`src/observe/routes.ts` runs the collectors with `Promise.all` inside
`withQueryContext({agent:'observe'}, …)`, mount it in `server/index.ts`. Each collector is
individually try/caught — a missing `part_log` must degrade one field, not 500 the page.
Update the `[PLANNED]` block in `API.md` to the shipped shape and mark it `[LIVE]`.

**A7. Changelog assembly**

`src/observe/changelog.ts`. Two cheap queries, then one pure function.

```sql
-- context write batches, oldest first
SELECT run_id, any(source_spec) AS source_spec, toString(min(updated_at)) AS at,
       count() AS entries, countIf(version > 1) AS superseded,
       groupArray(entity) AS entities, groupArray(change_note) AS notes
FROM context_store GROUP BY run_id ORDER BY min(updated_at) ASC
```

```sql
-- run milestones only, not the whole event log
SELECT run_id, toString(ts) AS at, type, name, payload
FROM runs_log
WHERE (type = 'status' AND name IN ('running','succeeded','failed'))
   OR type = 'approval_result'
ORDER BY ts ASC
```

Pure functions:

```ts
/** One run writes one batch; batch 0 is the base_context.md seed. */
export function formatContextVersion(batchIndex: number): string {
  return `v${1 + Math.floor(batchIndex / 10)}.${batchIndex % 10}`;
}

export function buildChangelog(batches: ContextBatch[], runRows: RunLogRow[]): ChangelogEntry[]
```

`buildChangelog` correlates the two by `run_id`: `status:running` supplies `traceUrl`,
`approval_result` supplies `identity`, `status:succeeded` supplies the loaded tables, and the
matching context batch supplies the spec name (`source_spec`) and version label. It emits one
`kind:"context"` entry per batch and one `kind:"table"` entry per succeeded run, newest first.

Tests with fixture arrays — no database: version rollover at batch 10; `warn` set only when
`superseded > 0`; a run with `running` but no `succeeded` produces no table entry; a table
entry's description names the approver from `approval_result`.

**A8. `GET /api/observe/changelog` + export + API.md**

The list route takes an optional `?kind=table|context`. Export is
`changelogToMarkdown(entries)` — another pure function — served as
`text/markdown; charset=utf-8` with
`Content-Disposition: attachment; filename="clickwright-changelog.md"`. Test that every entry
appears and trace links survive.

### Phase B — optimization advisor

**B1. Evidence gathering (pure code, no LLM).** Reads per table via
`arrayJoin(tables)` over `query_log` (24h and 30d), storage share from A4, top query shapes
with the tables they touch, latency spikes from A3, and existing materialized views from
`system.tables WHERE engine = 'MaterializedView'`. Produces a typed `AdvisorEvidence` object.
This is what makes the advisor's numbers real rather than invented — same discipline as the
analytics agent.

**B2. LLM scan + storage + endpoints.** `prompts/optimization_scan.txt` receives the evidence
and returns zod-validated suggestions; the prompt forbids any figure not present in the
evidence. Store in a new `optimization_suggestions` table (`scan_id`, `id`, `scanned_at`,
`severity`, `action`, `why`, `evidence`, `target_table`, `actionable`) so scans survive
restarts and are queryable. `POST /scan` runs it in the background under its own Langfuse trace
and flips a status flag; `GET` returns `{ status: "scanning" | "ready" | "never_run", … }`.

### Phase C — "Ask agent to draft it"

**C1. `src/agents/optimizer.ts`** mirrors `runInstrumentation`'s shape: LLM writes DDL for the
suggestion, a validator allows **only** `ALTER TABLE … MODIFY TTL`, `ALTER TABLE … ADD COLUMN`,
`CREATE MATERIALIZED VIEW`, and `OPTIMIZE TABLE` — everything else is rejected before the gate,
so a prompt injection or a confused model cannot produce a `DROP`. Then the existing approval
gate, then execute. Tests cover the validator directly: each allowed form passes, `DROP TABLE`
/ `ALTER … DELETE` / multi-statement payloads are rejected.

**C2. Run-kind branch.** `RunRecord` gains `kind: "spec" | "optimization"`; `RunManager.create`
accepts `{ suggestionId }`; `execute()` branches to `runOptimization`. Reuses the queue, SSE
stream, and approval endpoint unchanged, so the Run screen renders an optimization exactly like
a spec run. `RunSummary.kind` is an additive field — update `API.md`.

---

## 7. Risks and gotchas

1. **`query_log` on ClickHouse Cloud is per-replica.** Without `clusterAllReplicas` the numbers
   are quietly partial. Worse than being wrong is being wrong and confident — hence the probe
   and the `queryLogAvailable` flag.
2. **Attribution is not retroactive.** Everything executed before A1 ships has an empty
   `log_comment` and shows as unattributed. Land A1 first and re-run a spec before the demo so
   the Recent-queries filter has data to filter.
3. **`query_log` has its own TTL** (Cloud defaults to 30 days, and it flushes on an interval —
   `system.query_log` can lag by up to ~7.5s). A query run seconds ago may not appear yet; don't
   treat an empty result immediately after a run as a bug.
4. **Self-pollution** is easy to reintroduce — any new observability query must go through
   `withQueryContext({agent:'observe'})` or it starts counting itself.
5. **`normalizeQuery` output can be very long.** Truncate before returning, or the slowest-query
   panel receives multi-kilobyte strings.
6. **Global context version is derived, not stored.** Deleting rows with `reset-spec.ts`
   renumbers history. Acceptable for the hackathon; if it needs to be stable, persist a
   `context_release` row per batch instead.
7. **`system.part_log` and `system.merges` may be restricted** on some Cloud tiers. Every
   collector degrades to a null/zero field with the rest of the payload intact.

---

## 8. Minimum viable demo

If time runs short, A1 → A8 (Phase A) delivers both tabs fully populated with real measured
data. The Optimization-suggestions card is the only block that would render empty, and it is a
single self-contained card in the Database-health grid.

---

## 9. What changed during the build

Five things the plan got wrong or under-specified, found by running it against the real service.

1. **`clusterAllReplicas` is not optional.** Measured on our service: the local
   `system.query_log` saw 63,395 queries in 24h, the clustered union 127,116. Reading the local
   table would have halved every number on the page.

2. **The database filter had to tighten.** The planned
   `has(databases, db) OR current_database = db` admitted ClickHouse Cloud's own monitoring,
   which runs against `system.*` inside a session pointed at our database: 1,712 matching
   queries in 24h versus 646 that actually touched the data. The `current_database` half was
   dropped.

3. **ClickHouse resolves SELECT aliases inside WHERE.** `any(log_comment) AS log_comment` in the
   slowest-queries aggregate made the shared filter reference the aggregate, and the query died
   with "aggregate function found in WHERE". Aliases in that collector are now prefixed
   (`sample_log_comment`, `row_count`), with a warning on `queryLogFilter`.

4. **The advisor needed the age of the data.** Its first live run recommended a TTL on
   `destination_card_clicked` because it had "no reads in 30 days" — on a database created that
   morning. Equal 24h and 30d read counts mean the data has not existed for 30 days, not that it
   went unread. `oldestDataAgeHours` is now part of the evidence and the prompt refuses
   retention arguments over a window longer than the data's age.

5. **`actionable` needed a stricter definition.** The advisor was marking ingestion and code
   changes actionable, which would offer a "draft it" button that no permitted DDL statement can
   satisfy. It now means specifically "expressible as one of the five allowed statement forms".
   Verified end-to-end: asked to chunk a slow INSERT, the optimizer correctly refused to emit
   `INSERT`, explained that no allowed form expresses it, and returned the closest safe subset
   with a caveat for the reviewer.

**Not verified:** approving an optimization run. The gate, the rejection loop and the safety
validator were all exercised, but every test run was rejected rather than approved — no
agent-generated DDL has been executed against the database. The first approval will be the first
real mutation; do it on a table you can afford to rebuild.
