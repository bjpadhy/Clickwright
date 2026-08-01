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
}

const UPLOADS = fileURLToPath(new URL("../../uploads", import.meta.url));

export class RunManager {
  private runs = new Map<string, RunRecord>();
  private queue: RunRecord[] = [];
  private active: RunRecord | null = null;

  async init(): Promise<void> {
    await command(`
      CREATE TABLE IF NOT EXISTS runs_log (
        run_id  String,
        seq     UInt32,
        ts      DateTime64(3),
        type    LowCardinality(String),
        name    String,
        payload String
      ) ENGINE = MergeTree ORDER BY (run_id, seq)
      COMMENT 'Clickwright run events — powers the UI live stepper, replay, and history'
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
    const stored: StoredEvent = {
      ...event,
      seq: run.events.length,
      ts: new Date().toISOString(),
    };
    run.events.push(stored);
    for (const sub of run.subscribers) sub(stored);
    insert("runs_log", [
      {
        run_id: run.id,
        seq: stored.seq,
        ts: stored.ts.replace("T", " ").replace("Z", ""),
        type: stored.type,
        name: stored.name,
        payload: JSON.stringify(stored.payload),
      },
    ]).catch(() => {});
  }

  private status(run: RunRecord, status: RunRecord["status"], extra: Record<string, unknown> = {}): void {
    run.status = status;
    this.push(run, { type: "status", name: status, payload: extra });
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
      this.status(run, "succeeded", {
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
      const entries = await withQueryContext({ agent: "context", runId: run.id }, () =>
        updateContext(
          {
            specName: run.spec,
            specText,
            runId: run.id,
            instrumentation: {
              reasoning: instr.reasoning,
              newEnvelopeFields: instr.newEnvelopeFields,
              tables: instr.tables,
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
          contextEntries: entries.map((e) => `${e.entity} v${e.version}`),
          instrumentationAttempts: instr.attempts,
        },
        { spec: run.spec, runId: run.id },
      );
      this.status(run, "succeeded", {
        tables: instr.tables,
        contextEntries: entries.map((e) => ({ entity: e.entity, version: e.version })),
        traceUrl: run.traceUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      endRun(trace, { status: "failed", error: message }, { spec: run.spec, runId: run.id });
      this.status(run, "failed", { error: message });
    } finally {
      setRunSink(null);
      await flushTraces().catch(() => {});
    }
  }
}
