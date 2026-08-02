/**
 * Run manager: the FIFO queue that makes every pipeline run an atomic
 * read-modify-write on shared state (tables + context_store). One run at a
 * time; concurrent uploads wait. Each run streams RunEvents (from tracing's
 * step() hook) to SSE subscribers and persists them to runs_log for replay.
 *
 * Human gates: the agents' approve callbacks park on a promise; the HTTP
 * layer resolves it via POST /api/runs/:id/approve.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runInstrumentation } from "../agents/instrumentation.js";
import { updateContext } from "../agents/context.js";
import { runOptimization } from "../agents/optimizer.js";
import { findSuggestion } from "../observe/advisor.js";
import {
  startRun,
  endRun,
  traceUrl,
  flushTraces,
  setRunSink,
  type RunEvent,
} from "../core/tracing.js";
import { command, insert, query } from "../core/db.js";
import { withQueryContext } from "../core/query-context.js";

/** The optimizer needs real column names and types; guessing them is how you get
 *  DDL that references a column that does not exist. */
async function describeTable(table: string | null): Promise<string> {
  if (!table) return "(no specific table — this suggestion is database-wide)";
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) return "(invalid table name)";
  const rows = await query<{ name: string; type: string }>(`
    SELECT name, type FROM system.columns
    WHERE database = currentDatabase() AND table = '${table}' ORDER BY position
  `);
  if (rows.length === 0) return `(table ${table} has no columns visible)`;
  return `Table ${table}:\n${rows.map((r) => `  ${r.name} ${r.type}`).join("\n")}`;
}

/** "optimization" gates an advisor-suggested schema change; its proposal shape is
 *  OptimizationProposal, not DdlProposal — the UI must branch on the gate name. */
/**
 * Step names are implementation detail; the UI wants phases. Several steps and all
 * their LLM progress ticks collapse into one line, so "Executing on ClickHouse"
 * shows table results only and never a stream of thinking ticks.
 */
const RUN_PHASES: Array<[RegExp, string]> = [
  [/^profile$/, "Profiling the events"],
  [/^(context_load|schema_reconciliation)$/, "Reading the knowledge store"],
  [/^(ddl_generation_attempt|schema_design_attempt|schema_design)/, "Designing the schema"],
  [/^dry_run/, "Validating the schema"],
  [/^(approval_attempt|update_approval_attempt)/, "Waiting for your approval"],
  [/^ddl_execution_attempt/, "Creating tables and loading data"],
  [/^(context_update|update_generation_attempt)/, "Updating the knowledge store"],
  [/^(instrumentation|optimization)$/, ""],
];

export function runPhaseOf(stepName: string): string {
  for (const [re, label] of RUN_PHASES) if (re.test(stepName)) return label;
  return "";
}

export type Gate = "ddl" | "context" | "optimization";
export type RunKind = "spec" | "optimization";

export interface ApprovalDecision {
  approved: boolean;
  feedback?: string;
  identity?: string;
}

export interface StoredEvent extends RunEvent {
  seq: number;
  ts: string;
  /** Reader-facing grouping; "" means plumbing the UI should not surface. */
  phase: string;
}

export interface RunRecord {
  id: string;
  spec: string;
  kind: RunKind;
  status: "queued" | "running" | "awaiting_approval" | "succeeded" | "failed";
  pendingGate: Gate | null;
  traceUrl: string | null;
  createdAt: string;
  events: StoredEvent[];
  subscribers: Set<(e: StoredEvent) => void>;
  resolveApproval: ((d: ApprovalDecision) => void) | null;
  /** Empty for optimization runs, which have no spec on disk. */
  specDir: string;
  /** Set only when kind === "optimization". */
  suggestionId: string | null;
  /** Most recent step, used to attribute progress ticks to a phase. */
  currentStep?: string;
  /** Wall-clock of the whole run: set when execution starts, not when queued. */
  startedAt: string | null;
  finishedAt: string | null;
  /** Total end-to-end milliseconds, gates and all — the number the UI shows. */
  durationMs: number | null;
}

const UPLOADS = fileURLToPath(new URL("../../uploads", import.meta.url));

export class RunManager {
  private runs = new Map<string, RunRecord>();
  private queue: RunRecord[] = [];
  private active: RunRecord | null = null;
  /**
   * runs_log writes are BUFFERED, not one insert per event. A run emits 50-100+
   * events; a round trip each is exactly the small-insert pattern ClickHouse warns
   * against (insert-batch-size). Events accumulate and flush on a short timer, on
   * a full buffer, or immediately for anything a reader might be waiting on
   * (approval requests, terminal states). `drain()` forces a flush and awaits it,
   * so durability is unchanged — a completed run still cannot lose its events.
   */
  private buffer: Array<Record<string, unknown>> = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  private static readonly FLUSH_MS = 250;
  private static readonly FLUSH_ROWS = 50;

  /** Queue one insert of everything buffered so far. Never throws. */
  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.writes = this.writes.then(() => insert("runs_log", batch).catch(() => {}));
  }

  async init(): Promise<void> {
    await command(`
      CREATE TABLE IF NOT EXISTS runs_log (
        run_id  String,
        spec    String,
        seq     UInt32,
        ts      DateTime64(3),
        type    LowCardinality(String),
        name    String,
        payload String,
        phase   String DEFAULT ''
      ) ENGINE = MergeTree ORDER BY (run_id, seq)
      TTL toDateTime(ts) + INTERVAL 90 DAY
      COMMENT 'Clickwright run events — powers the UI live stepper, replay, and history'
    `);
    await command(`ALTER TABLE runs_log ADD COLUMN IF NOT EXISTS spec String AFTER run_id`);
    await command(`ALTER TABLE runs_log ADD COLUMN IF NOT EXISTS phase String DEFAULT '' AFTER payload`);
    // Roughly 113 events (~73KB) per run, appended forever. /api/history
    // aggregates this whole table, so without a retention bound both the scan
    // and the storage grow without limit. 90 days keeps every run anyone would
    // reasonably look back at. Applied to already-created tables too, since the
    // CREATE above is a no-op once the table exists.
    await command(`ALTER TABLE runs_log MODIFY TTL toDateTime(ts) + INTERVAL 90 DAY`);

    // Materialized view: one summary row per run, written on completion. Makes
    // /api/history O(runs) instead of O(events) — no more GROUP BY over the
    // entire runs_log on every page load.
    await command(`
      CREATE TABLE IF NOT EXISTS run_summary (
        run_id     String,
        spec       String,
        started    DateTime64(3),
        finished   DateTime64(3),
        status     LowCardinality(String),
        events     UInt32,
        duration_ms UInt64
      ) ENGINE = ReplacingMergeTree(finished) ORDER BY run_id
      COMMENT 'One row per run — populated on run completion for fast history queries'
    `);
  }

  list(): Array<Omit<RunRecord, "events" | "subscribers" | "resolveApproval">> {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ events: _e, subscribers: _s, resolveApproval: _r, ...rest }) => rest);
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  /** Is a run mid-flight? A hot reload during one would abandon it. */
  activeRun(): RunRecord | null {
    return this.active;
  }

  /** Flush anything buffered and await every queued insert — call before the
   * process exits so a restart cannot truncate a run's event history. */
  async drain(): Promise<void> {
    this.flush();
    await this.writes.catch(() => {});
  }

  /** Create a run from an existing spec dir, uploaded content, OR an advisor
   *  suggestion (which runs the optimizer instead of the instrumentation agent). */
  async create(input: {
    specDir?: string;
    name?: string;
    specMd?: string;
    ndjson?: string;
    suggestionId?: string;
  }): Promise<RunRecord> {
    let specDir: string;
    let spec: string;
    let kind: RunKind = "spec";
    let suggestionId: string | null = null;

    if (input.suggestionId) {
      const suggestion = await findSuggestion(input.suggestionId);
      if (!suggestion) throw new Error(`unknown suggestion ${input.suggestionId}`);
      if (!suggestion.actionable) {
        throw new Error(`suggestion ${input.suggestionId} is not actionable`);
      }
      kind = "optimization";
      suggestionId = suggestion.id;
      specDir = "";
      spec = `optimize:${suggestion.targetTable ?? "database"}`;
    } else if (input.specDir) {
      specDir = path.resolve(fileURLToPath(new URL("../../", import.meta.url)), input.specDir);
      spec = path.basename(specDir);
      await readFile(path.join(specDir, "spec.md"));
    } else if (input.name && input.specMd && input.ndjson) {
      spec = input.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
      specDir = path.join(UPLOADS, `${spec}_${Date.now().toString(36)}`);
      await mkdir(specDir, { recursive: true });
      await writeFile(path.join(specDir, "spec.md"), input.specMd);
      await writeFile(path.join(specDir, "events.ndjson"), input.ndjson);
    } else {
      throw new Error("provide specDir OR {name, specMd, ndjson} OR {suggestionId}");
    }

    const record: RunRecord = {
      id: `run_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
      spec,
      kind,
      status: "queued",
      pendingGate: null,
      traceUrl: null,
      createdAt: new Date().toISOString(),
      events: [],
      subscribers: new Set(),
      resolveApproval: null,
      specDir,
      suggestionId,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    };
    this.runs.set(record.id, record);
    this.queue.push(record);
    this.pump();
    return record;
  }

  approve(id: string, decision: ApprovalDecision): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(`unknown run ${id}`);
    if (!run.resolveApproval || !run.pendingGate)
      throw new Error(`run ${id} is not awaiting approval`);
    const resolve = run.resolveApproval;
    run.resolveApproval = null;
    resolve(decision);
  }

  private push(run: RunRecord, event: RunEvent): void {
    // A step_start tells us which phase we are in; everything after it — including
    // the LLM progress ticks, which carry no step name of their own — belongs to
    // that phase until the next step begins.
    if (event.type === "step_start") run.currentStep = event.name;
    const phase =
      event.type === "status" || event.type.startsWith("approval_")
        ? runPhaseOf(run.currentStep ?? "")
        : runPhaseOf(event.type === "log" ? (run.currentStep ?? "") : event.name);

    const stored: StoredEvent = {
      ...event,
      seq: run.events.length,
      ts: new Date().toISOString(),
      phase,
    };
    run.events.push(stored);
    // buffer the durable write, then fan out — a broken SSE socket must never
    // lose history or starve other subscribers
    this.buffer.push({
      run_id: run.id,
      spec: run.spec,
      seq: stored.seq,
      ts: stored.ts.replace("T", " ").replace("Z", ""),
      type: stored.type,
      name: stored.name,
      payload: JSON.stringify(stored.payload),
      phase: stored.phase,
    });

    // Flush at once for anything someone may be about to read: a gate the UI is
    // waiting on, or a terminal state. Otherwise coalesce on a short timer.
    const urgent =
      stored.type === "approval_request" ||
      (stored.type === "status" && (stored.name === "succeeded" || stored.name === "failed"));
    if (urgent || this.buffer.length >= RunManager.FLUSH_ROWS) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), RunManager.FLUSH_MS);
      this.flushTimer.unref?.(); // never hold the process open for a pending flush
    }
    for (const sub of run.subscribers) {
      try {
        sub(stored);
      } catch {
        run.subscribers.delete(sub); // dead socket — drop it, never starve the rest
      }
    }
  }

  private status(run: RunRecord, status: RunRecord["status"], extra: Record<string, unknown> = {}): void {
    run.status = status;
    this.push(run, { type: "status", name: status, payload: extra });
    // Write a summary row on terminal states for fast history queries.
    if (status === "succeeded" || status === "failed") {
      const now = new Date().toISOString().replace("T", " ").replace("Z", "");
      insert("run_summary", [{
        run_id: run.id,
        spec: run.spec,
        started: run.startedAt?.replace("T", " ").replace("Z", "") ?? now,
        finished: now,
        status,
        events: run.events.length,
        duration_ms: run.durationMs ?? 0,
      }]).catch(() => {});
    }
  }

  /** Park until the HTTP layer resolves the gate. */
  private waitForApproval(run: RunRecord, gate: Gate, proposal: unknown): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      run.pendingGate = gate;
      run.resolveApproval = (d) => {
        run.pendingGate = null;
        this.status(run, "running", {});
        this.push(run, {
          type: "approval_result",
          name: gate,
          payload: { approved: d.approved, feedback: d.feedback ?? "", identity: d.identity ?? "" },
        });
        resolve(d);
      };
      this.push(run, { type: "approval_request", name: gate, payload: { proposal } });
      this.status(run, "awaiting_approval", { gate });
    });
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    const run = this.queue.shift()!;
    this.active = run;
    void this.execute(run).finally(() => {
      this.active = null;
      this.pump();
    });
  }

  /**
   * An advisor suggestion turned into DDL, gated and executed. Reuses the queue,
   * the SSE stream and the approval endpoint — from the Run screen's point of
   * view this is just a run whose gate happens to be "optimization".
   */
  private async executeOptimization(run: RunRecord, trace: ReturnType<typeof startRun>): Promise<void> {
    const startedMs = run.startedAt ? Date.parse(run.startedAt) : Date.now();
    try {
      const suggestion = run.suggestionId ? await findSuggestion(run.suggestionId) : null;
      if (!suggestion) throw new Error(`suggestion ${run.suggestionId} no longer exists`);

      const result = await withQueryContext({ agent: "optimizer", runId: run.id }, async () => {
        const schemaContext = await describeTable(suggestion.targetTable);
        return runOptimization({
          suggestion,
          trace,
          schemaContext,
          approve: async (proposal) => this.waitForApproval(run, "optimization", proposal),
        });
      });

      endRun(
        trace,
        {
          status: "success",
          statements: result.statements,
          expectedEffect: result.expectedEffect,
          attempts: result.attempts,
        },
        { kind: "optimization", runId: run.id },
      );
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - startedMs;
      this.status(run, "succeeded", {
        durationMs: run.durationMs,
        statements: result.statements,
        expectedEffect: result.expectedEffect,
        traceUrl: run.traceUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      endRun(trace, { status: "failed", error: message }, { kind: "optimization", runId: run.id });
      this.status(run, "failed", { error: message });
    } finally {
      setRunSink(null);
      await this.drain(); // every event is durable before we finish
      await flushTraces().catch(() => {});
    }
  }

  private async execute(run: RunRecord): Promise<void> {
    const trace = startRun(
      `pipeline:${run.spec}`,
      { spec: run.spec, runId: run.id },
      { sessionId: run.spec },
    );
    run.traceUrl = traceUrl(trace);
    run.startedAt = new Date().toISOString();
    const startedMs = Date.now();
    setRunSink((e) => this.push(run, e));
    this.status(run, "running", { traceUrl: run.traceUrl });

    if (run.kind === "optimization") {
      await this.executeOptimization(run, trace);
      return;
    }

    try {
      // Tag every query this phase issues, so system.query_log can attribute it
      // to the instrumentation agent on the Observe screen.
      const instr = await withQueryContext(
        { agent: "instrumentation", runId: run.id },
        () =>
          runInstrumentation({
            specDir: run.specDir,
            trace,
            approve: async (proposal) => this.waitForApproval(run, "ddl", proposal),
          }),
      );

      const specText = await readFile(path.join(run.specDir, "spec.md"), "utf-8");
      const ctx = await withQueryContext({ agent: "context", runId: run.id }, () =>
        updateContext(
          {
            specName: run.spec,
            specText,
            runId: run.id,
            instrumentation: {
              reasoning: instr.reasoning,
              newEnvelopeFields: instr.newEnvelopeFields,
              tables: instr.tables,
              // code-synthesised table:* entries — stored verbatim, and the
              // updateContext validator requires one per created table
              tableEntries: instr.tableEntries,
            },
          },
          trace,
          { approve: async (proposal) => this.waitForApproval(run, "context", proposal) },
        ),
      );

      endRun(
        trace,
        {
          status: "success",
          tables: instr.tables.map((t) => `${t.name} (${t.rowsLoaded} rows)`),
          contextEntries: ctx.entries.map((e) => `${e.entity} v${e.version}`),
          contextWarnings: ctx.warnings,
          instrumentationAttempts: instr.attempts,
        },
        { spec: run.spec, runId: run.id },
      );
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - startedMs;
      this.status(run, "succeeded", {
        durationMs: run.durationMs,
        tables: instr.tables,
        contextEntries: ctx.entries.map((e) => ({ entity: e.entity, version: e.version })),
        contextWarnings: ctx.warnings,
        traceUrl: run.traceUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      endRun(trace, { status: "failed", error: message }, { spec: run.spec, runId: run.id });
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - startedMs;
      this.status(run, "failed", {
        durationMs: run.durationMs,
        error: message,
        // A failure after the tables were created leaves them in place but
        // undocumented; the UI should offer a reset rather than a bare retry,
        // which would only hit a name collision.
        resetHint: `npx tsx scripts/reset-spec.ts ${run.spec} (or --orphans)`,
      });
    } finally {
      setRunSink(null);
      await this.drain(); // every event is durable before we finish
      await flushTraces().catch(() => {});
    }
  }
}
