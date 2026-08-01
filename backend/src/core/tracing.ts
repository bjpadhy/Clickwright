import { Langfuse, type LangfuseTraceClient, type LangfuseSpanClient } from "langfuse";
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
  try {
    const output = await fn(span);
    span.end({ output: output as object });
    return output;
  } catch (error) {
    span.end({
      level: "ERROR",
      statusMessage: error instanceof Error ? error.message : String(error),
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
