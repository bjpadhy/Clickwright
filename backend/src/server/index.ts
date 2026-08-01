/**
 * Clickwright backend server — the thin HTTP/SSE layer the webapp talks to.
 *
 *   npm run serve      # http://localhost:8787
 *
 * Routes:
 *   GET  /api/health                      env + connectivity summary
 *   POST /api/runs                        {specDir} | {name, specMd, ndjson} → queued run
 *   GET  /api/runs                        run list (id, spec, status, traceUrl)
 *   GET  /api/runs/:id                    run detail incl. buffered events
 *   GET  /api/runs/:id/events             SSE: replay + live run events
 *   POST /api/runs/:id/approve            {approved, feedback?, identity?} resolves the pending gate
 *   POST /api/conversations               new chat conversation
 *   GET  /api/conversations               conversation list (sidebar)
 *   GET  /api/conversations/:id           full message history (insights included)
 *   POST /api/conversations/:id/messages  ask a question → SSE: steps then insight
 *   POST /api/conversations/:id/star      star/unstar
 *   GET  /api/suggestions                 suggested-question chips from spec context
 *   POST/GET/DELETE /api/dashboards       saved charts; GET :id/run re-executes the SQL
 *   GET  /api/context                     latest version of every entity
 *   GET  /api/context/:entity/history     full version history for one entity
 *   GET  /api/observe/clickhouse          database health (system tables)
 *   GET  /api/observe/changelog           schema + context change stream
 *   GET  /api/observe/changelog/export    the same, as a markdown download
 */
import express from "express";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunManager, type StoredEvent } from "./runs.js";
import {
  initChatTables, createConversation, listConversations, getConversation,
  setStarred, suggestions, streamAnswer,
} from "./chat.js";
import {
  initDashboardTables, saveDashboard, listDashboards, runDashboard, deleteDashboard,
} from "./dashboards.js";
import { query } from "../core/db.js";
import { env } from "../core/env.js";
import { observeRouter } from "../observe/routes.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

const manager = new RunManager();

app.use("/api/observe", observeRouter(manager));

app.get("/api/health", async (_req, res) => {
  try {
    const [row] = await query<{ v: string }>("SELECT version() AS v");
    res.json({
      ok: true,
      clickhouse: row?.v ?? "unknown",
      database: env.clickhouse.database,
      llmBackend: env.llm.apiKey ? "anthropic-api" : "claude-code-oauth",
      model: env.llm.model,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post("/api/runs", async (req, res) => {
  try {
    const run = await manager.create(req.body ?? {});
    res.status(201).json({ id: run.id, spec: run.spec, status: run.status });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/runs", (_req, res) => {
  res.json(manager.list());
});

app.get("/api/runs/:id", (req, res) => {
  const run = manager.get(req.params.id);
  if (!run) return res.status(404).json({ error: "unknown run" });
  const { subscribers: _s, resolveApproval: _r, ...rest } = run;
  res.json(rest);
});

app.get("/api/runs/:id/events", (req, res) => {
  const run = manager.get(req.params.id);
  if (!run) return res.status(404).json({ error: "unknown run" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (e: StoredEvent) =>
    res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

  for (const e of run.events) send(e); // replay
  run.subscribers.add(send); // live
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15000);
  req.on("close", () => {
    clearInterval(keepalive);
    run.subscribers.delete(send);
  });
});

app.post("/api/runs/:id/approve", (req, res) => {
  try {
    const { approved, feedback, identity } = req.body ?? {};
    if (typeof approved !== "boolean")
      return res.status(400).json({ error: "approved: boolean required" });
    manager.approve(req.params.id, { approved, feedback, identity });
    res.json({ ok: true });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Sample specs from the repo's specs/ dir — the "start from a sample" list. */
app.get("/api/specs", async (_req, res) => {
  const specsRoot = fileURLToPath(new URL("../../../specs", import.meta.url));
  const instrumented = new Set(
    (
      await query<{ s: string }>(
        `SELECT DISTINCT source_spec AS s FROM context_store`,
      )
    ).map((r) => r.s),
  );
  const dirs = (await readdir(specsRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const specs = await Promise.all(
    dirs.map(async (dir) => {
      const nd = await readFile(path.join(specsRoot, dir, "events.ndjson"), "utf-8");
      const lines = nd.split("\n").filter((l) => l.trim());
      const eventTypes = new Set<string>();
      for (const line of lines) {
        try {
          eventTypes.add(String((JSON.parse(line) as { event?: string }).event ?? ""));
        } catch { /* skip bad lines */ }
      }
      return {
        id: dir,
        specDir: `../specs/${dir}`,
        events: lines.length,
        eventTypes: eventTypes.size,
        alreadyInstrumented: instrumented.has(dir),
      };
    }),
  );
  res.json(specs);
});

/** History that survives restarts — reconstructed from runs_log. */
app.get("/api/history", async (_req, res) => {
  const rows = await query<{
    run_id: string; spec: string; started: string; finished: string;
    last_status: string; events: string;
  }>(`
    SELECT run_id, any(spec) AS spec,
           toString(min(ts)) AS started, toString(max(ts)) AS finished,
           -- non-status rows must weigh LESS than any status row, otherwise ties
           -- make argMax return a step name (e.g. "profile") as the status
           argMax(name, if(type = 'status', toInt64(seq) + 1, -1)) AS last_status,
           toString(count()) AS events
    FROM runs_log GROUP BY run_id ORDER BY started DESC
  `);
  res.json(rows.map((r) => ({ ...r, events: Number(r.events) })));
});

/** Full decision record of one past run (replay source for the report view). */
app.get("/api/history/:runId", async (req, res) => {
  const rows = await query<{
    seq: string; ts: string; type: string; name: string; payload: string;
  }>(
    `SELECT toString(seq) AS seq, toString(ts) AS ts, type, name, payload
     FROM runs_log WHERE run_id = {runId:String} ORDER BY seq ASC`,
    { runId: req.params.runId },
  );
  if (rows.length === 0) return res.status(404).json({ error: "unknown run" });
  res.json(
    rows.map((r) => ({
      seq: Number(r.seq), ts: r.ts, type: r.type, name: r.name,
      payload: JSON.parse(r.payload) as unknown,
    })),
  );
});

// ── chat (Analytics Agent) ──────────────────────────────────────

app.post("/api/conversations", async (req, res) => {
  const id = await createConversation(req.body?.title);
  res.status(201).json({ id });
});

app.get("/api/conversations", async (_req, res) => {
  res.json(await listConversations());
});

app.get("/api/conversations/:id", async (req, res) => {
  res.json(await getConversation(req.params.id));
});

app.post("/api/conversations/:id/star", async (req, res) => {
  try {
    await setStarred(req.params.id, Boolean(req.body?.starred));
    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Ask a question — SSE stream of agent steps, ending with the Insight. */
app.post("/api/conversations/:id/messages", async (req, res) => {
  const question = String(req.body?.question ?? "").trim();
  if (!question) return res.status(400).json({ error: "question required" });
  await streamAnswer(req.params.id, question, res);
});

/** Suggested-question chips, from the PM questions instrumentation stored. */
app.get("/api/suggestions", async (_req, res) => {
  res.json(await suggestions());
});

// ── dashboards (Boards) ─────────────────────────────────────────

app.post("/api/dashboards", async (req, res) => {
  try {
    const { title, sql, chartKind, meta } = req.body ?? {};
    if (!title || !sql) return res.status(400).json({ error: "title and sql required" });
    res.status(201).json({ id: await saveDashboard({ title, sql, chartKind, meta }) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/dashboards", async (_req, res) => {
  res.json(await listDashboards());
});

/** Re-runs the saved SQL — fresh data on every load. */
app.get("/api/dashboards/:id/run", async (req, res) => {
  try {
    res.json(await runDashboard(req.params.id));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/dashboards/:id", async (req, res) => {
  try {
    await deleteDashboard(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/context", async (_req, res) => {
  const rows = await query(`
    SELECT entity, definition_md, toUInt32(version) AS version, source_spec, change_note, toString(updated_at) AS updated_at
    FROM context_store ORDER BY entity ASC, version DESC LIMIT 1 BY entity
  `);
  res.json(rows);
});

app.get("/api/context/:entity/history", async (req, res) => {
  const rows = await query(
    `SELECT entity, definition_md, toUInt32(version) AS version, source_spec, change_note, run_id, toString(updated_at) AS updated_at
     FROM context_store WHERE entity = {entity:String} ORDER BY version ASC`,
    { entity: req.params.entity },
  );
  res.json(rows);
});

const PORT = Number(process.env["PORT"] ?? 8787);
await manager.init();
await initChatTables();
await initDashboardTables();
await initInsightCache();
app.listen(PORT, () => {
  console.log(`Clickwright backend listening on http://localhost:${PORT}`);
});
