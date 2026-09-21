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
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunManager, type StoredEvent } from "./runs.js";
import {
  initChatTables, createConversation, listConversations, getConversation,
  setStarred, deleteConversation, suggestions, streamAnswer,
  UnknownConversationError,
} from "./chat.js";
import { closeOpenStreams, registerStream } from "./streams.js";
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
    const llm = env.llm;
    res.json({
      ok: true,
      clickhouse: row?.v ?? "unknown",
      database: env.clickhouse.database,
      // llmBackend is a free-form string on the webapp side (api/instrumentation.ts):
      // "gemini-openai-compatible" | "anthropic-api" | "claude-code-oauth".
      llmProvider: llm.provider,
      llmBackend: llm.backend,
      model: llm.model,
      ...(llm.provider === "gemini" ? { llmBaseUrl: llm.baseUrl } : {}),
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

/** A run is over for good at these events — nothing follows them. */
const isTerminalEvent = (e: StoredEvent): boolean =>
  e.type === "status" && (e.name === "succeeded" || e.name === "failed");

app.get("/api/runs/:id/events", (req, res) => {
  const run = manager.get(req.params.id);
  if (!run) return res.status(404).json({ error: "unknown run" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let closed = false;
  let keepalive: NodeJS.Timeout | null = null;
  let unregister: (() => void) | null = null;

  /**
   * Close the stream for good. A finished run emits nothing more, so holding
   * the socket open costs a connection per replay and keeps a keepalive timer
   * ticking forever. The client closes its EventSource on the same terminal
   * event (see webapp `openRunStream`), so this never triggers a reconnect
   * loop.
   */
  const finish = () => {
    if (closed) return;
    closed = true;
    if (keepalive) clearInterval(keepalive);
    run.subscribers.delete(send);
    unregister?.();
    res.end();
  };

  const send = (e: StoredEvent) => {
    if (closed) return;
    res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    if (isTerminalEvent(e)) finish();
  };

  for (const e of run.events) send(e); // replay (may already be terminal)
  if (closed) return;

  run.subscribers.add(send); // live
  keepalive = setInterval(() => {
    if (!closed) res.write(": keepalive\n\n");
  }, 15000);
  unregister = registerStream({ end: () => res.end() });
  req.on("close", () => {
    closed = true;
    if (keepalive) clearInterval(keepalive);
    run.subscribers.delete(send);
    unregister?.();
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

/* ── sample specs ───────────────────────────────────────────────
 *
 * The six sample specs are ~14 MB / 35k lines of NDJSON in total, and this
 * endpoint used to read and JSON.parse all of it on EVERY call — synchronously
 * enough to stall the event loop, which stalls every in-flight SSE answer with
 * it. The files are static, so the counts are computed once and reused until a
 * file actually changes (size + mtime), and the parse streams line by line
 * instead of materialising a 14 MB string and a 35k-element array.
 */

const SPECS_ROOT = fileURLToPath(new URL("../../../specs", import.meta.url));

interface SpecFacts {
  id: string;
  specDir: string;
  events: number;
  eventTypes: number;
}

/** Count events and distinct event types without holding the file in memory. */
async function readSpecFacts(dir: string): Promise<SpecFacts> {
  const eventTypes = new Set<string>();
  let events = 0;
  const stream = createReadStream(path.join(SPECS_ROOT, dir, "events.ndjson"), {
    encoding: "utf-8",
  });
  try {
    // `for await` over readline yields between chunks, so a big file is read
    // in slices the event loop can interleave other work around.
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      events++;
      try {
        eventTypes.add(String((JSON.parse(line) as { event?: string }).event ?? ""));
      } catch {
        /* skip bad lines */
      }
    }
  } finally {
    stream.destroy();
  }
  return { id: dir, specDir: `../specs/${dir}`, events, eventTypes: eventTypes.size };
}

let specCache: { key: string; facts: SpecFacts[] } | null = null;
let specCacheInFlight: { key: string; facts: Promise<SpecFacts[]> } | null = null;

async function specFacts(): Promise<SpecFacts[]> {
  const dirs = (await readdir(SPECS_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  // Identity of the inputs, not a clock: a spec edited in place invalidates the
  // entry, and nothing else does.
  const stamps = await Promise.all(
    dirs.map((dir) =>
      stat(path.join(SPECS_ROOT, dir, "events.ndjson"))
        .then((st) => `${st.size}:${st.mtimeMs}`)
        .catch(() => "missing"),
    ),
  );
  const key = dirs.map((dir, i) => `${dir}@${stamps[i]}`).join("|");

  if (specCache?.key === key) return specCache.facts;
  // Concurrent first calls (two tabs, a StrictMode double mount) share one parse.
  if (specCacheInFlight?.key === key) return specCacheInFlight.facts;

  const facts = (async () => {
    const out: SpecFacts[] = [];
    // Serial, not Promise.all: six parallel multi-MB parses is a CPU spike on
    // the only thread serving the SSE streams.
    for (const [i, dir] of dirs.entries()) {
      if (stamps[i] === "missing") continue;
      out.push(await readSpecFacts(dir));
    }
    specCache = { key, facts: out };
    return out;
  })();
  specCacheInFlight = { key, facts };
  try {
    return await facts;
  } finally {
    if (specCacheInFlight?.facts === facts) specCacheInFlight = null;
  }
}

/** Sample specs from the repo's specs/ dir — the "start from a sample" list. */
app.get("/api/specs", async (_req, res) => {
  try {
    const [facts, instrumentedRows] = await Promise.all([
      specFacts(),
      query<{ s: string }>(`SELECT DISTINCT source_spec AS s FROM context_store`),
    ]);
    const instrumented = new Set(instrumentedRows.map((r) => r.s));
    res.json(
      facts.map((spec) => ({ ...spec, alreadyInstrumented: instrumented.has(spec.id) })),
    );
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** History that survives restarts. Uses run_summary (one row per run) when
 *  populated; falls back to the GROUP BY over runs_log for older data. */
app.get("/api/history", async (_req, res) => {
  // Try the fast path first — run_summary is O(runs), not O(events).
  // run_summary is a ReplacingMergeTree keyed on run_id: until the parts merge
  // a run can have several versions, and reading them raw showed a finished run
  // twice (once as it was at an earlier write). argMax collapses them on the
  // sort key — cheaper than FINAL, which merges at query time on every load.
  const summary = await query<{
    run_id: string; spec: string; started: string; finished: string;
    status: string; events: string; duration_ms: string;
  }>(`
    SELECT run_id,
           argMax(spec, finished)                  AS spec,
           toString(argMax(started, finished))     AS started,
           toString(max(finished))                 AS finished,
           argMax(status, finished)                AS status,
           toString(argMax(events, finished))      AS events,
           toString(argMax(duration_ms, finished)) AS duration_ms
    FROM run_summary
    GROUP BY run_id
    ORDER BY started DESC
    LIMIT 200
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

/** Parse a stored payload, degrading to an empty object rather than throwing. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

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
      // One malformed row must not 404/500 the whole decision record — the
      // replay is evidence, and 99 good events beat none.
      payload: safeJson(r.payload),
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

/**
 * 404 means the conversation does not exist; anything else is a 500.
 *
 * Every one of these routes used to answer 404 for any failure, so a ClickHouse
 * outage told the webapp the conversation had been deleted — and the webapp
 * dutifully cleared it from the screen. A database that is down must read as a
 * server fault, so the UI keeps the conversation and says it is offline.
 */
function conversationError(error: unknown, res: express.Response): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof UnknownConversationError ? 404 : 500;
  if (status === 500) console.warn("[conversations] request failed:", message);
  res.status(status).json({ error: message });
}

app.get("/api/conversations/:id", async (req, res) => {
  try {
    res.json(await getConversation(req.params.id));
  } catch (error) {
    conversationError(error, res);
  }
});

app.post("/api/conversations/:id/star", async (req, res) => {
  try {
    await setStarred(req.params.id, Boolean(req.body?.starred));
    res.json({ ok: true });
  } catch (error) {
    conversationError(error, res);
  }
});

/** Delete a conversation and its turns. Irreversible. */
app.delete("/api/conversations/:id", async (req, res) => {
  try {
    await deleteConversation(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    conversationError(error, res);
  }
});

/** Ask a question — SSE stream of agent steps, ending with the Insight. */
app.post("/api/conversations/:id/messages", async (req, res) => {
  const question = String(req.body?.question ?? "").trim();
  if (!question) return res.status(400).json({ error: "question required" });
  await streamAnswer(req.params.id, question, res, req);
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
  // Warm the sample-spec counts off the request path, so the first visitor to
  // the Instrumentation screen does not pay for the parse.
  void specFacts().catch((error: unknown) => {
    console.warn("[specs] warm-up failed:", error instanceof Error ? error.message : error);
  });
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
  // Run streams AND chat answer streams — both register in ./streams.ts.
  closeOpenStreams();

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
