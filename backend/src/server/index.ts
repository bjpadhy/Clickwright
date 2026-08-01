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
 *   GET  /api/context                     latest version of every entity
 *   GET  /api/context/:entity/history     full version history for one entity
 */
import express from "express";
import { RunManager, type StoredEvent } from "./runs.js";
import { query } from "../core/db.js";
import { env } from "../core/env.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

const manager = new RunManager();

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

app.get("/api/context", async (_req, res) => {
  const rows = await query(`
    SELECT entity, definition_md, toUInt32(version) AS version, source_spec, change_note, toString(updated_at) AS updated_at
    FROM context_store ORDER BY entity ASC, version DESC LIMIT 1 BY entity
  `);
  res.json(rows);
});

app.get("/api/context/:entity/history", async (req, res) => {
  const rows = await query(`
    SELECT entity, definition_md, toUInt32(version) AS version, source_spec, change_note, run_id, toString(updated_at) AS updated_at
    FROM context_store WHERE entity = {entity:String} ORDER BY version ASC
  `.replace("{entity:String}", `'${req.params.entity.replace(/'/g, "''")}'`));
  res.json(rows);
});

const PORT = Number(process.env["PORT"] ?? 8787);
await manager.init();
app.listen(PORT, () => {
  console.log(`Clickwright backend listening on http://localhost:${PORT}`);
});
