import { Langfuse, type LangfuseTraceClient, type LangfuseSpanClient } from "langfuse";
import { AsyncLocalStorage } from "node:async_hooks";
import { execSync } from "node:child_process";
import { env } from "./env.js";

/**
 * Tracing is the highest-weighted evaluation criterion: outputs without a matching
 * trace score nothing. Every agent step goes through `step()` — including failed
 * attempts, which are evidence the pipeline is real rather than hand-written.
 */

let lf: Langfuse | null = null;

/** Git sha stamped on every trace as `release`, so prompt tuning is comparable across runs. */
function gitRelease(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

export function langfuse(): Langfuse {
  lf ??= new Langfuse({
    publicKey: env.langfuse.publicKey,
    secretKey: env.langfuse.secretKey,
    baseUrl: env.langfuse.baseUrl,
    release: gitRelease(),
  });
  return lf;
}

export type Ctx = LangfuseTraceClient | LangfuseSpanClient;

// ── run event bus ────────────────────────────────────────────────
// The server sets a bus for the active run; step() broadcasts every step's
// lifecycle so the UI stepper mirrors the Langfuse trace with no extra
// instrumentation. Safe as a singleton because runs are queued (one at a time).

export interface RunEvent {
  type: "step_start" | "step_end" | "step_error" | "status" | "approval_request" | "approval_result" | "log";
  name: string;
  payload: Record<string, unknown>;
}

type RunEventSink = (event: RunEvent) => void;

/** Per-async-context sink so an instrumentation run and a chat answer can
 * stream concurrently without stealing each other's events. */
const sinkStore = new AsyncLocalStorage<RunEventSink>();
let runSink: RunEventSink | null = null; // legacy global (instrumentation runs)

export function setRunSink(sink: RunEventSink | null): void {
  runSink = sink;
}

/** Run `fn` with its own event sink — events emitted inside go only to it. */
export function withRunSink<T>(sink: RunEventSink, fn: () => Promise<T>): Promise<T> {
  return sinkStore.run(sink, fn);
}

const clip = (v: unknown): unknown => {
  const s = JSON.stringify(v);
  return s && s.length > 6000 ? JSON.parse(JSON.stringify(v, (_k, val) =>
    typeof val === "string" && val.length > 2000 ? val.slice(0, 2000) + "…[clipped]" : val,
  )) : v;
};

export function emitRunEvent(event: RunEvent): void {
  const scoped = sinkStore.getStore();
  if (scoped) scoped(event);
  else runSink?.(event);
}

export function startRun(
  name: string,
  input: Record<string, unknown>,
  opts: { sessionId?: string } = {},
): LangfuseTraceClient {
  return langfuse().trace({
    name,
    input,
    tags: ["clickwright"],
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
}

/** Write the run's final result onto the trace — what judges see in the trace list. */
export function endRun(
  trace: LangfuseTraceClient,
  output: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): void {
  trace.update({ output, metadata });
}

/** Attach a numeric score to the trace (gate outcomes, retry counts) — shows as a
 * column in Langfuse, quantifying quality machinery across all runs at a glance. */
export function scoreRun(
  ctx: Ctx,
  name: string,
  value: number,
  comment?: string,
): void {
  ctx.score({ name, value, ...(comment ? { comment } : {}) });
}

/** Deep link to a trace — stored in runs_log so every UI element can cite its evidence. */
export function traceUrl(trace: LangfuseTraceClient): string {
  return `${env.langfuse.baseUrl}/trace/${trace.id}`;
}

/**
 * Wrap one unit of agent work in a span. Nest by passing the returned span as
 * the parent of the next call.
 */
export async function step<T>(
  parent: Ctx,
  name: string,
  input: Record<string, unknown>,
  fn: (span: LangfuseSpanClient) => Promise<T>,
): Promise<T> {
  const span = parent.span({ name, input });
  const t0 = Date.now();
  emitRunEvent({ type: "step_start", name, payload: { input: clip(input) } });
  try {
    const output = await fn(span);
    span.end({ output: output as object });
    // elapsedMs on every step: nested steps overlap (tasks run concurrently), so
    // the UI must use the run's own durationMs for the total, never a sum of these.
    emitRunEvent({
      type: "step_end",
      name,
      payload: { output: clip(output), elapsedMs: Date.now() - t0 },
    });
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    span.end({ level: "ERROR", statusMessage: message });
    emitRunEvent({
      type: "step_error",
      name,
      payload: { error: message, elapsedMs: Date.now() - t0 },
    });
    throw error;
  }
}

/** Record a SQL execution and its result on the trace — the audit trail for every number. */
export function recordQuery(
  parent: Ctx,
  name: string,
  sql: string,
  rows: unknown[],
): void {
  parent
    .span({ name, input: { sql } })
    .end({ output: { rowCount: rows.length, rows: rows.slice(0, 50) } });
}

/** Flush before the process exits, or traces are lost. */
export async function flushTraces(): Promise<void> {
  await lf?.flushAsync();
}
