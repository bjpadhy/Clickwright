/**
 * /api/observe/* — the Observability screen's backend.
 *
 * Every handler runs inside withQueryContext({agent:"observe"}) so its own
 * queries are excluded from the numbers it reports; without that the page counts
 * itself and the totals climb on every refresh.
 *
 * Collectors are individually try/caught: a system table that is restricted on
 * some deployment tier must degrade one field, not 500 the whole screen.
 */
import { Router } from "express";
import { withQueryContext } from "../core/query-context.js";
import { queryLogSource } from "./query-log.js";
import {
  WINDOW_HOURS,
  collectLatency,
  collectPartsHealth,
  collectRecentQueries,
  collectSlowestQueries,
  collectStats,
  collectStorage,
  tableOrigins,
} from "./db-health.js";
import { changelogToMarkdown, getChangelog } from "./changelog.js";
import { latestScan, runScan, type ScanResult } from "./advisor.js";
import type { RunManager } from "../server/runs.js";

/** Run a collector, falling back to a safe value if its system table is unavailable. */
async function safely<T>(label: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[observe] ${label} unavailable:`, error instanceof Error ? error.message : error);
    return fallback;
  }
}

export function observeRouter(manager: RunManager): Router {
  const router = Router();

  // A scan is a single LLM call over measured evidence — a few seconds, but too
  // long to hold an HTTP request open behind a proxy. Kick it off, poll the GET.
  let scanning = false;
  let lastError: string | null = null;

  router.get("/clickhouse", async (_req, res) => {
    try {
      const payload = await withQueryContext({ agent: "observe" }, async () => {
        const source = await queryLogSource();
        const baseTables = await tableOrigins();
        const nowMs = Date.now();

        const [stats, latency, storage, partsHealth, slowest, recent] = await Promise.all([
          safely("stats", null, () => collectStats(baseTables)),
          safely("latency", [], () => collectLatency(nowMs)),
          safely("storage", { tables: [], totalBytes: 0 }, () => collectStorage(baseTables)),
          safely("partsHealth", null, () => collectPartsHealth()),
          safely("slowestQueries", [], () => collectSlowestQueries()),
          safely("recentQueries", [], () => collectRecentQueries()),
        ]);

        return {
          windowHours: WINDOW_HOURS,
          queryLogAvailable: source.available,
          queryLogClustered: source.clustered,
          stats,
          latencyP95ByHour: latency,
          storageByTable: storage.tables,
          storageTotalBytes: storage.totalBytes,
          partsHealth,
          slowestQueries: slowest,
          recentQueries: recent,
        };
      });
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/changelog", async (req, res) => {
    try {
      const kind = req.query["kind"];
      const entries = await withQueryContext({ agent: "observe" }, () => getChangelog());
      const filtered =
        kind === "table" || kind === "context" ? entries.filter((e) => e.kind === kind) : entries;
      res.json(filtered);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/changelog/export", async (_req, res) => {
    try {
      const entries = await withQueryContext({ agent: "observe" }, () => getChangelog());
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="clickwright-changelog.md"',
      );
      res.send(changelogToMarkdown(entries));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/suggestions", async (_req, res) => {
    try {
      if (scanning) {
        const pending: ScanResult = {
          status: "scanning",
          scannedAt: null,
          traceUrl: null,
          suggestions: [],
        };
        return res.json(pending);
      }
      const result = await withQueryContext({ agent: "observe" }, () => latestScan());
      res.json(lastError && result.status === "never_run" ? { ...result, status: "failed", error: lastError } : result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/suggestions/scan", (_req, res) => {
    if (scanning) return res.status(409).json({ error: "a scan is already running" });
    scanning = true;
    lastError = null;
    void runScan()
      .then((result) => {
        if (result.status === "failed") lastError = result.error ?? "scan failed";
      })
      .catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        scanning = false;
      });
    res.status(202).json({ status: "scanning" });
  });

  /** "Ask agent to draft it" — enqueues an optimization run behind the same
   *  approval gate as a spec run. Returns the run id; drive it off /api/runs/:id. */
  router.post("/suggestions/:id/draft", async (req, res) => {
    try {
      const run = await manager.create({ suggestionId: req.params.id });
      res.status(201).json({ id: run.id, spec: run.spec, kind: run.kind, status: run.status });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
