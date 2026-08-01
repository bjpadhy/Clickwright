import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChangelog,
  changelogToMarkdown,
  formatContextVersion,
  specFromDir,
  summariseRuns,
  type ContextRow,
  type RunLogRow,
} from "../../src/observe/changelog.js";

// ── version numbering ────────────────────────────────────────────

test("batch 0 is the seed at v1.0 and minors roll into a major", () => {
  assert.equal(formatContextVersion(0), "v1.0");
  assert.equal(formatContextVersion(3), "v1.3");
  assert.equal(formatContextVersion(9), "v1.9");
  assert.equal(formatContextVersion(10), "v2.0");
  assert.equal(formatContextVersion(21), "v3.1");
});

// ── spec names ───────────────────────────────────────────────────

test("specFromDir strips the upload timestamp but leaves sample specs alone", () => {
  assert.equal(specFromDir("/x/Clickwright/specs/02_group_family"), "02_group_family");
  assert.equal(
    specFromDir("/x/Clickwright/backend/uploads/03_status_sharing_msagtujv"),
    "03_status_sharing",
  );
  // A sample spec dir that happens to end in digits must not be mangled.
  assert.equal(specFromDir("/x/specs/05_instant_forex"), "05_instant_forex");
});

// ── run summarisation ────────────────────────────────────────────

const runRows: RunLogRow[] = [
  {
    runId: "run_a",
    at: "2026-08-01 14:00:13.801",
    type: "step_start",
    name: "instrumentation",
    payload: { input: { specDir: "/x/Clickwright/specs/02_group_family" } },
  },
  {
    runId: "run_a",
    at: "2026-08-01 14:00:13.800",
    type: "status",
    name: "running",
    payload: { traceUrl: "https://cloud.langfuse.com/trace/abc" },
  },
  // A later bare "running" (emitted when a gate resolves) must not blank the URL.
  { runId: "run_a", at: "2026-08-01 14:01:59.746", type: "status", name: "running", payload: {} },
  {
    runId: "run_a",
    at: "2026-08-01 14:01:59.746",
    type: "approval_result",
    name: "ddl",
    payload: { approved: true, feedback: "", identity: "wilson@atlys-hackathon" },
  },
  {
    runId: "run_a",
    at: "2026-08-01 14:04:52.730",
    type: "status",
    name: "succeeded",
    payload: {
      tables: [
        { name: "group_started", rowsLoaded: 1200 },
        { name: "traveller_added", rowsLoaded: 3400 },
      ],
    },
  },
];

test("summariseRuns keeps the first trace URL and the approver", () => {
  const facts = summariseRuns(runRows).get("run_a");
  assert.equal(facts?.traceUrl, "https://cloud.langfuse.com/trace/abc");
  assert.equal(facts?.identity, "wilson@atlys-hackathon");
  assert.equal(facts?.spec, "02_group_family");
  assert.equal(facts?.tables.length, 2);
});

// ── changelog assembly ───────────────────────────────────────────

const contextRows: ContextRow[] = [
  {
    runId: "seed",
    sourceSpec: "base_context.md",
    entity: "overview:business",
    version: 1,
    changeNote: "initial seed",
    updatedAt: "2026-08-01 09:46:12.574",
  },
  {
    runId: "data_audit",
    sourceSpec: "data_audit",
    entity: "entity:application",
    version: 2,
    changeNote: "corrected eta column",
    updatedAt: "2026-08-01 10:20:52.098",
  },
  {
    runId: "data_audit",
    sourceSpec: "data_audit",
    entity: "convention:sessionization",
    version: 1,
    changeNote: "new",
    updatedAt: "2026-08-01 10:20:52.098",
  },
];

test("context batches become versioned entries, newest first", () => {
  const entries = buildChangelog(contextRows, []);
  assert.deepEqual(
    entries.map((e) => e.title),
    ["context v1.1", "context v1.0"],
  );
});

test("warn is set only when an existing definition was superseded", () => {
  const entries = buildChangelog(contextRows, []);
  const seed = entries.find((e) => e.contextVersion === "v1.0");
  const audit = entries.find((e) => e.contextVersion === "v1.1");
  assert.equal(seed?.warn, false);
  assert.equal(audit?.warn, true);
  assert.match(audit?.description ?? "", /1 existing definition superseded/);
  assert.match(audit?.description ?? "", /\+1 new entry/);
});

test("a succeeded run becomes a schema entry naming its approver", () => {
  const entries = buildChangelog([], runRows);
  const table = entries.find((e) => e.kind === "table");
  assert.equal(table?.title, "group_started + 1 more created");
  assert.match(table?.description ?? "", /approved by wilson@atlys-hackathon/);
  assert.match(table?.description ?? "", /4,600 events loaded across 2 tables/);
  assert.equal(table?.traceUrl, "https://cloud.langfuse.com/trace/abc");
  assert.equal(table?.spec, "02_group_family");
});

test("a run that never succeeded produces no schema entry", () => {
  const started = runRows.filter((r) => r.name !== "succeeded");
  assert.equal(buildChangelog([], started).length, 0);
});

test("a reset run still reports its spec, having lost its context rows", () => {
  // reset-spec.ts deletes a run's context_store rows but leaves runs_log intact,
  // so the spec name has to come from specDir rather than the context batch.
  const entries = buildChangelog([], runRows);
  assert.equal(entries[0]?.spec, "02_group_family");
});

test("entries from both sources interleave by timestamp", () => {
  const entries = buildChangelog(contextRows, runRows);
  const timestamps = entries.map((e) => e.at);
  assert.deepEqual([...timestamps].sort((a, b) => b.localeCompare(a)), timestamps);
  assert.equal(entries.length, 3);
});

test("seed and audit batches are not attributed to a run", () => {
  const entries = buildChangelog(contextRows, []);
  assert.ok(entries.every((e) => e.runId === null));
});

// ── markdown export ──────────────────────────────────────────────

test("the export names every entry and keeps trace links", () => {
  const md = changelogToMarkdown(buildChangelog(contextRows, runRows));
  assert.match(md, /# Clickwright changelog/);
  assert.match(md, /context v1\.0/);
  assert.match(md, /context v1\.1/);
  assert.match(md, /group_started \+ 1 more created/);
  assert.match(md, /https:\/\/cloud\.langfuse\.com\/trace\/abc/);
  assert.match(md, /contradiction surfaced/);
});

// ── runs_log.spec column (added on main while this branch was in flight) ──

test("prefers the runs_log spec column when present", () => {
  const withSpec: RunLogRow[] = runRows.map((r) => ({ ...r, spec: "04_abandoned_checkout" }));
  const entries = buildChangelog([], withSpec);
  assert.equal(entries.find((e) => e.kind === "table")?.spec, "04_abandoned_checkout");
});

test("falls back to specDir for rows written before the spec column existed", () => {
  // ALTER ... ADD COLUMN backfills existing rows with '', not null.
  const legacy: RunLogRow[] = runRows.map((r) => ({ ...r, spec: "" }));
  const entries = buildChangelog([], legacy);
  assert.equal(entries.find((e) => e.kind === "table")?.spec, "02_group_family");
});
