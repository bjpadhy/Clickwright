import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLogComment,
  currentQueryContext,
  parseLogComment,
  withQueryContext,
} from "../../src/core/query-context.js";

test("buildLogComment falls back to the server agent when nothing is set", () => {
  assert.deepEqual(JSON.parse(buildLogComment(undefined)), {
    app: "clickwright",
    agent: "server",
  });
});

test("buildLogComment includes run and step only when present", () => {
  assert.deepEqual(JSON.parse(buildLogComment({ agent: "analytics" })), {
    app: "clickwright",
    agent: "analytics",
  });
  assert.deepEqual(
    JSON.parse(buildLogComment({ agent: "context", runId: "run_1", step: "update" })),
    { app: "clickwright", agent: "context", run: "run_1", step: "update" },
  );
});

test("parseLogComment round-trips what buildLogComment writes", () => {
  const raw = buildLogComment({ agent: "instrumentation", runId: "run_9", step: "ddl" });
  assert.deepEqual(parseLogComment(raw), {
    agent: "instrumentation",
    runId: "run_9",
    step: "ddl",
  });
});

test("parseLogComment ignores comments we did not write", () => {
  const unattributed = { agent: null, runId: null, step: null };
  // ClickHouse's own monitoring queries carry an empty log_comment.
  assert.deepEqual(parseLogComment(""), unattributed);
  assert.deepEqual(parseLogComment(null), unattributed);
  assert.deepEqual(parseLogComment("not json at all"), unattributed);
  // A foreign tool that also uses log_comment must not be mislabelled as ours.
  assert.deepEqual(parseLogComment('{"app":"grafana","agent":"analytics"}'), unattributed);
  assert.deepEqual(parseLogComment('"a bare string"'), unattributed);
});

test("withQueryContext survives an await boundary", async () => {
  await withQueryContext({ agent: "analytics", runId: "run_x" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(currentQueryContext()?.agent, "analytics");
    assert.equal(currentQueryContext()?.runId, "run_x");
  });
  assert.equal(currentQueryContext(), undefined);
});

test("nested contexts override, then restore", async () => {
  await withQueryContext({ agent: "instrumentation" }, async () => {
    await withQueryContext({ agent: "observe" }, async () => {
      assert.equal(currentQueryContext()?.agent, "observe");
    });
    assert.equal(currentQueryContext()?.agent, "instrumentation");
  });
});

test("concurrent contexts do not leak into each other", async () => {
  const seen: string[] = [];
  await Promise.all([
    withQueryContext({ agent: "analytics" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(currentQueryContext()?.agent ?? "none");
    }),
    withQueryContext({ agent: "observe" }, async () => {
      seen.push(currentQueryContext()?.agent ?? "none");
    }),
  ]);
  assert.deepEqual(seen.sort(), ["analytics", "observe"]);
});
