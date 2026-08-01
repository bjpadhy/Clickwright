/**
 * Query attribution. ClickHouse's system.query_log records every query but has no
 * idea which agent issued it, and that cannot be reconstructed after the fact — the
 * only place the answer exists is the call site. So every query carries a
 * `log_comment` stamp naming the agent, run, and step.
 *
 * The context travels via AsyncLocalStorage rather than a parameter on query():
 * db.query() is called from a dozen modules and threading an `agent` argument
 * through all of them would couple every caller to observability.
 *
 *   withQueryContext({ agent: "instrumentation", runId }, () => runInstrumentation(...))
 *     → every query inside, however deep, is tagged instrumentation.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type QueryAgent =
  | "instrumentation"
  | "context"
  | "analytics"
  | "optimizer"
  | "observe"
  | "server"
  | "script";

export interface QueryContext {
  agent: QueryAgent;
  runId?: string;
  step?: string;
}

export interface ParsedLogComment {
  agent: QueryAgent | null;
  runId: string | null;
  step: string | null;
}

const storage = new AsyncLocalStorage<QueryContext>();

export function withQueryContext<T>(
  ctx: QueryContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentQueryContext(): QueryContext | undefined {
  return storage.getStore();
}

/**
 * Built into ClickHouse's `log_comment` setting, which lands verbatim in
 * system.query_log. Kept small — it is stored on every query row. The `app` key
 * lets us tell our queries apart from a teammate's console session.
 */
export function buildLogComment(ctx: QueryContext | undefined): string {
  const resolved = ctx ?? { agent: "server" as const };
  const out: Record<string, string> = { app: "clickwright", agent: resolved.agent };
  if (resolved.runId) out["run"] = resolved.runId;
  if (resolved.step) out["step"] = resolved.step;
  return JSON.stringify(out);
}

/** Inverse of buildLogComment. Anything not written by us reads as unattributed. */
export function parseLogComment(raw: string | null | undefined): ParsedLogComment {
  const empty: ParsedLogComment = { agent: null, runId: null, step: null };
  if (!raw) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty;
    const record = parsed as Record<string, unknown>;
    if (record["app"] !== "clickwright") return empty;
    return {
      agent: typeof record["agent"] === "string" ? (record["agent"] as QueryAgent) : null,
      runId: typeof record["run"] === "string" ? record["run"] : null,
      step: typeof record["step"] === "string" ? record["step"] : null,
    };
  } catch {
    return empty;
  }
}
