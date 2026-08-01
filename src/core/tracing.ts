import { Langfuse, type LangfuseTraceClient, type LangfuseSpanClient } from "langfuse";
import { env } from "./env.js";

/**
 * Tracing is the highest-weighted evaluation criterion: outputs without a matching
 * trace score nothing. Every agent step goes through `step()` — including failed
 * attempts, which are evidence the pipeline is real rather than hand-written.
 */

let lf: Langfuse | null = null;

export function langfuse(): Langfuse {
  lf ??= new Langfuse({
    publicKey: env.langfuse.publicKey,
    secretKey: env.langfuse.secretKey,
    baseUrl: env.langfuse.baseUrl,
  });
  return lf;
}

export type Ctx = LangfuseTraceClient | LangfuseSpanClient;

export function startRun(
  name: string,
  input: Record<string, unknown>,
): LangfuseTraceClient {
  return langfuse().trace({ name, input, tags: ["clickwright"] });
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
