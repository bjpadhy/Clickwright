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
 *   DELETE /api/conversations/:id         delete a conversation and its turns
 *   GET  /api/suggestions                 suggested-question chips from spec context
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
  setStarred, deleteConversation, suggestions, streamAnswer,
} from "./chat.js";
import { initInsightCache } from "../agents/analytics.js";
import { closeDb, command, query } from "../core/db.js";
import { env } from "../core/env.js";
import { flushTraces } from "../core/tracing.js";
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
  const handle = { end: () => res.end() };
  openStreams.add(handle);
  req.on("close", () => {
    clearInterval(keepalive);
    run.subscribers.delete(send);
    openStreams.delete(handle);
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

/** History that survives restarts. Uses run_summary (one row per run) when
 *  populated; falls back to the GROUP BY over runs_log for older data. */
app.get("/api/history", async (_req, res) => {
  // Try the fast path first — run_summary is O(runs), not O(events).
  const summary = await query<{
    run_id: string; spec: string; started: string; finished: string;
    status: string; events: string; duration_ms: string;
  }>(`
    SELECT run_id, spec, toString(started) AS started, toString(finished) AS finished,
           status, toString(events) AS events, toString(duration_ms) AS duration_ms
    FROM run_summary ORDER BY started DESC LIMIT 200
  `).catch(() => [] as Array<{
    run_id: string; spec: string; started: string; finished: string;
    status: string; events: string; duration_ms: string;
  }>);

  if (summary.length > 0) {
    return res.json(
      summary.map((r) => ({
        run_id: r.run_id,
        spec: r.spec,
        started: r.started,
        finished: r.finished,
        last_status: r.status,
        events: Number(r.events),
        durationMs: Number(r.duration_ms),
      })),
    );
  }

  // Fallback: reconstruct from runs_log (pre-existing runs without summaries).
  const rows = await query<{
    run_id: string; spec: string; started: string; finished: string;
    last_status: string; events: string;
  }>(`
    SELECT run_id, any(spec) AS spec,
           toString(min(ts)) AS started, toString(max(ts)) AS finished,
           argMax(name, if(type = 'status', toInt64(seq) + 1, -1)) AS last_status,
           toString(count()) AS events,
           toString(dateDiff('millisecond', min(ts), max(ts))) AS durationMs
    FROM runs_log GROUP BY run_id ORDER BY started DESC
    LIMIT 200
  `);
  res.json(
    rows.map((r) => ({
      ...r,
      events: Number(r.events),
      durationMs: Number((r as unknown as { durationMs: string }).durationMs),
    })),
  );
});

/** Full decision record of one past run (replay source for the report view). */
app.get("/api/history/:runId", async (req, res) => {
  // The alias must NOT be `seq`: `ORDER BY seq` would bind to the String
  // projection and sort 0,1,10,11,…,2 — scrambling the replay.
  const rows = await query<{
    seq_text: string; ts: string; type: string; name: string; payload: string;
  }>(
    `SELECT toString(seq) AS seq_text, toString(ts) AS ts, type, name, payload
     FROM runs_log WHERE run_id = {runId:String} ORDER BY seq ASC`,
    { runId: req.params.runId },
  );
  if (rows.length === 0) return res.status(404).json({ error: "unknown run" });
  res.json(
    rows.map((r) => ({
      seq: Number(r.seq_text), ts: r.ts, type: r.type, name: r.name,
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
  try {
    res.json(await getConversation(req.params.id));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/conversations/:id/star", async (req, res) => {
  try {
    await setStarred(req.params.id, Boolean(req.body?.starred));
    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Delete a conversation and its turns. Irreversible. */
app.delete("/api/conversations/:id", async (req, res) => {
  try {
    await deleteConversation(req.params.id);
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

/** SSE responses have no natural end; track them so a shutdown can close them
 * cleanly instead of leaving clients waiting on a dead socket. */
const openStreams = new Set<{ end: () => void }>();

const PORT = Number(process.env["PORT"] ?? 8787);
await manager.init();
await initChatTables();
await initInsightCache();
// Materialized category column — ClickHouse derives it from entity on insert,
// so existing rows get it on the next merge and new rows have it immediately.
await command(
  `ALTER TABLE context_store ADD COLUMN IF NOT EXISTS category LowCardinality(String) ` +
  `MATERIALIZED splitByChar(':', entity)[1]`
).catch(() => {});
const server = app.listen(PORT, () => {
  console.log(`Clickwright backend listening on http://localhost:${PORT}`);
});

/**
 * Graceful shutdown — required for hot reload to be safe. `tsx watch` sends
 * SIGTERM on every restart; without this a reload would truncate runs_log
 * (inserts are queued), drop un-flushed Langfuse spans, and leave SSE clients
 * hanging on a socket that never closes.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const active = manager.activeRun();
  if (active) {
    console.warn(
      `⚠ ${signal} while run ${active.id} (${active.spec}) is ${active.status} — it will be abandoned. ` +
        `Any tables it created are undocumented: npx tsx scripts/reset-spec.ts --orphans`,
    );
  }

  server.close();
  for (const stream of openStreams) {
    try {
      stream.end();
    } catch {
      /* already gone */
    }
  }

  // bounded: never hang a reload waiting on a slow network
  await Promise.race([
    (async () => {
      await manager.drain();
      await flushTraces().catch(() => {});
      await closeDb().catch(() => {});
    })(),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}
