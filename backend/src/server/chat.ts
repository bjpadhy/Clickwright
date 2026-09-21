/**
 * Chat: the Analytics Agent as a conversation. Each question is one traced
 * answer streamed over SSE; conversations and insights persist in ClickHouse so
 * a reload re-renders the card without recomputing anything.
 *
 * Read-only by construction — runAnalytics can only read context and run
 * guarded read-only SQL.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { command, insert, query } from "../core/db.js";
import {
  startRun,
  endRun,
  traceUrl,
  flushTraces,
  withRunSink,
  type RunEvent,
} from "../core/tracing.js";
import { runAnalytics, establishedFigures, type Insight } from "../agents/analytics.js";
import { nextTurnSeq, phaseOf } from "./phases.js";
import { registerStream } from "./streams.js";

// The step→phase tables live in ./phases.ts: they are pure, and a unit test has
// to be able to import them without a .env or a database.
export { phaseOf };

/**
 * "That conversation does not exist" — the only condition the HTTP layer may
 * answer with a 404. Anything else (a ClickHouse outage, a malformed row) is a
 * server fault and must surface as a 500: the webapp treats 404 on a
 * conversation as "it was deleted" and drops the user back to an empty screen,
 * which is the wrong recovery for a database that is merely down.
 */
export class UnknownConversationError extends Error {
  constructor() {
    // The wire message is load-bearing — the webapp matches on it.
    super("unknown conversation");
    this.name = "UnknownConversationError";
  }
}

/** One swallowed-error log per site, so a recurring failure is visible once
 *  instead of either silent or spamming every turn. */
const warnedOnce = new Set<string>();
function warnOnce(site: string, error: unknown): void {
  if (warnedOnce.has(site)) return;
  warnedOnce.add(site);
  console.warn(`[chat] ${site} failed:`, error instanceof Error ? error.message : error);
}

export interface ChatMessageRow {
  conv_id: string;
  seq: number;
  role: "user" | "agent";
  question: string;
  insight_json: string;
  trace_url: string;
  ts: string;
}

export async function initChatTables(): Promise<void> {
  await command(`
    CREATE TABLE IF NOT EXISTS conversations (
      conv_id    String,
      title      String,
      starred    UInt8 DEFAULT 0,
      deleted    UInt8 DEFAULT 0,
      created_at DateTime64(3),
      updated_at DateTime64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY conv_id
    COMMENT 'Clickwright chat conversations (sidebar)'
  `);
  // Databases created before delete shipped predate the column.
  await command(
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deleted UInt8 DEFAULT 0 AFTER starred`,
  );
  await command(`
    CREATE TABLE IF NOT EXISTS messages (
      conv_id      String,
      seq          UInt32,
      role         LowCardinality(String),
      question     String,
      insight_json String,
      trace_url    String,
      ts           DateTime64(3)
    ) ENGINE = MergeTree ORDER BY (conv_id, seq)
    COMMENT 'Chat turns; agent turns store the full Insight JSON so reloads need no recompute'
  `);
}

const now = () => new Date().toISOString().replace("T", " ").replace("Z", "");

/**
 * One write lock per conversation, in process.
 *
 * Reading the next turn number and writing the user row have to be atomic: two
 * questions asked at the same moment would otherwise both read the same
 * `max(seq)` and write their turns onto the same slot, interleaving the
 * conversation. The section is two statements long, so the lock is held for
 * milliseconds, and it is per conversation — different conversations never
 * wait on each other. (One process owns the writes; a second replica would
 * need the same guarantee from ClickHouse, which is why the seq is derived
 * from `max(seq)` rather than a counter held in memory.)
 */
const conversationLocks = new Map<string, Promise<void>>();

function withConversationLock<T>(convId: string, fn: () => Promise<T>): Promise<T> {
  const previous = conversationLocks.get(convId) ?? Promise.resolve();
  // `.then(fn, fn)` — the next waiter runs whether or not the previous one threw.
  const result = previous.then(fn, fn);
  const tail = result.then(
    () => {},
    () => {},
  );
  conversationLocks.set(convId, tail);
  void tail.then(() => {
    // Drop the entry once this conversation is idle, or the map grows forever.
    if (conversationLocks.get(convId) === tail) conversationLocks.delete(convId);
  });
  return result;
}

export async function createConversation(title?: string): Promise<string> {
  const id = `conv_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  const ts = now();
  await insert("conversations", [
    {
      conv_id: id,
      title: title ?? "New conversation",
      starred: 0,
      deleted: 0,
      created_at: ts,
      updated_at: ts,
    },
  ]);
  return id;
}

/** Latest version of one conversation, or null when unknown or deleted. */
async function loadConversation(
  convId: string,
): Promise<{ title: string; starred: number; created_at: string } | null> {
  const rows = await query<{
    title: string;
    starred: number;
    deleted: number;
    created_at: string;
  }>(
    `SELECT title, toUInt8(starred) AS starred, toUInt8(deleted) AS deleted,
            toString(created_at) AS created_at
     FROM conversations WHERE conv_id = {conv:String}
     ORDER BY updated_at DESC LIMIT 1`,
    { conv: convId },
  );
  const row = rows[0];
  if (!row || row.deleted) return null;
  return { title: row.title, starred: row.starred, created_at: row.created_at };
}

export async function listConversations(): Promise<unknown[]> {
  // Correlated subqueries are rejected by ClickHouse ("Cannot check Sorting plan
  // step for correlated expressions") — aggregate once and join.
  //
  // Two deliberate choices here, both about how this behaves as the tables grow:
  // argMax collapses the ReplacingMergeTree versions instead of FINAL (which
  // merges at query time on every sidebar load), and the message stats are
  // restricted to the 100 conversations actually being returned. Aggregating all
  // of `messages` first and only then taking the top 100 meant every sidebar load
  // scanned the entire chat history. The `conv_id IN (...)` predicate hits the
  // messages sort key, so it prunes instead of scanning.
  //
  // `max(updated_at) AS last_at`, not `AS updated_at`: an alias matching the
  // column makes ClickHouse resolve the argMax argument to the alias and reject
  // the query as a nested aggregate.
  return query(`
    WITH recent AS (
      SELECT conv_id,
             argMax(title, updated_at)   AS title,
             argMax(starred, updated_at) AS starred,
             argMax(deleted, updated_at) AS deleted,
             max(updated_at)             AS last_at
      FROM conversations
      GROUP BY conv_id
      HAVING deleted = 0
      ORDER BY last_at DESC
      LIMIT 100
    )
    SELECT r.conv_id AS id, r.title, toUInt8(r.starred) AS starred,
           toString(r.last_at) AS updatedAt,
           coalesce(s.preview, '') AS preview,
           coalesce(s.messages, toUInt32(0)) AS messages
    FROM recent AS r
    LEFT JOIN (
      SELECT conv_id,
             toUInt32(count()) AS messages,
             argMaxIf(question, seq, role = 'user') AS preview
      FROM messages
      WHERE conv_id IN (SELECT conv_id FROM recent)
      GROUP BY conv_id
    ) AS s ON s.conv_id = r.conv_id
    ORDER BY r.last_at DESC
  `);
}

export async function getConversation(convId: string): Promise<unknown> {
  if (!(await loadConversation(convId))) throw new UnknownConversationError();
  const messages = await query<ChatMessageRow>(
    `SELECT conv_id, toUInt32(seq) AS seq, role, question, insight_json, trace_url, toString(ts) AS ts
     FROM messages WHERE conv_id = {conv:String} ORDER BY seq ASC`,
    { conv: convId },
  );
  return {
    id: convId,
    messages: messages.map((m) => ({
      role: m.role,
      ts: m.ts,
      ...(m.role === "user"
        ? { text: m.question }
        : {
            insight: m.insight_json ? (JSON.parse(m.insight_json) as Insight) : null,
            traceUrl: m.trace_url,
          }),
    })),
  };
}

export async function setStarred(convId: string, starred: boolean): Promise<void> {
  const current = await loadConversation(convId);
  if (!current) throw new UnknownConversationError();
  await insert("conversations", [
    {
      conv_id: convId,
      title: current.title,
      starred: starred ? 1 : 0,
      // Carried, not defaulted: a new version with deleted = 0 would resurrect
      // a conversation the user had deleted.
      deleted: 0,
      created_at: current.created_at,
      updated_at: now(),
    },
  ]);
}

/**
 * Delete a conversation.
 *
 * The row is tombstoned rather than mutated away — same pattern as `dashboards`
 * — because ReplacingMergeTree gives the sidebar an immediate, deterministic
 * read, whereas an `ALTER … DELETE` is an async mutation the next list call
 * could race. The turns themselves ARE physically removed: hiding a
 * conversation while its questions and answers stayed queryable would not be a
 * delete. That mutation is small (one conversation's rows) and is applied in
 * the background; nothing reads those rows once the conversation is hidden.
 */
export async function deleteConversation(convId: string): Promise<void> {
  const current = await loadConversation(convId);
  if (!current) throw new UnknownConversationError();
  await insert("conversations", [
    {
      conv_id: convId,
      title: current.title,
      starred: current.starred,
      deleted: 1,
      created_at: current.created_at,
      updated_at: now(),
    },
  ]);
  await command(`ALTER TABLE messages DELETE WHERE conv_id = {conv:String}`, {
    conv: convId,
  });
}

/**
 * Suggested-question chips. Read from the spec files on disk for any spec that has
 * been instrumented — they carry the PM's questions as clean bullets, whereas the
 * stored summary paraphrases them inline. Falls back to the stored entry.
 */
export async function suggestions(): Promise<Array<{ spec: string; question: string }>> {
  const out: Array<{ spec: string; question: string }> = [];
  const seen = new Set<string>();
  const add = (spec: string, q: string) => {
    const clean = q.replace(/`/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (clean.length < 15 || clean.length > 200) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ spec, question: clean });
  };

  // which specs are live (source_spec is the spec directory name)
  const rows = await query<{ spec: string }>(`
    SELECT DISTINCT source_spec AS spec FROM context_store
    WHERE source_spec NOT IN ('base_context.md') AND source_spec NOT LIKE 'data_audit%'
  `);
  const specsRoot = fileURLToPath(new URL("../../../specs", import.meta.url));

  for (const { spec } of rows) {
    try {
      const md = await readFile(path.join(specsRoot, spec, "spec.md"), "utf-8");
      // the questions section, as authored
      // no Questions heading ⇒ no chips for this spec. Falling back to the whole
      // file turned the event list into "suggested questions".
      const section = /##\s*Questions[^\n]*\n([\s\S]*?)(\n##|$)/i.exec(md)?.[1];
      if (!section) continue;
      for (const line of section.split("\n")) {
        const m = /^\s*[-*]\s+(.+)$/.exec(line);
        if (m?.[1]) add(spec, m[1]);
      }
    } catch {
      /* spec not on disk (uploaded run) — fall through to the stored summary */
    }
  }

  if (out.length === 0) {
    // fallback: pull ?-terminated sentences out of the stored spec summaries
    const entries = await query<{ entity: string; definition_md: string }>(`
      SELECT entity, definition_md FROM context_store
      WHERE entity LIKE 'spec:%' ORDER BY entity ASC, version DESC LIMIT 1 BY entity
    `);
    for (const e of entries) {
      const spec = e.entity.slice("spec:".length);
      for (const m of e.definition_md.matchAll(/(?:^|\(\d\)\s*|\.\s+)([^.?]{15,180}\?)/g)) {
        if (m[1]) add(spec, m[1]);
      }
    }
  }
  return out.slice(0, 12);
}

/**
 * Answer one question, streaming agent steps over SSE. The whole answer runs
 * inside withRunSink so its events never leak into an instrumentation stream.
 */
export async function streamAnswer(
  convId: string,
  question: string,
  res: Response,
  req: Pick<Request, "on"> = res.req,
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // The answer keeps running when the reader leaves — both turns are persisted,
  // so a reload re-reads the finished card — but nothing should keep writing to
  // a socket that is gone, and the keepalive must not outlive it.
  let clientGone = false;
  const send = (event: string, data: unknown) => {
    if (clientGone) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  const keepalive = setInterval(() => {
    if (clientGone) return;
    try {
      res.write(": keepalive\n\n");
    } catch {
      /* client gone */
    }
  }, 15000);
  // Registered so a shutdown closes this stream instead of leaving the client
  // on a dead socket — the same treatment run streams already had.
  const unregister = registerStream({ end: () => res.end() });
  req.on("close", () => {
    clientGone = true;
    clearInterval(keepalive);
    unregister();
  });
  // trace/url must be visible to catch and finally; everything that can throw
  // goes inside the try, or a pre-flight failure leaves the keepalive interval
  // writing to a half-open response forever with no terminal event sent.
  let trace: ReturnType<typeof startRun> | null = null;
  let url = "";
  try {
    trace = startRun(
      `chat:${question.slice(0, 60)}`,
      { question, convId },
      { sessionId: convId },
    );
    url = traceUrl(trace);
    send("start", { traceUrl: url, convId });

    // Read the turn number and write the user row as one critical section, so
    // two questions asked at once cannot land on the same seq. The history read
    // rides along inside it: issued with the seq read (one round trip, as
    // before) and always finished before this turn's own row is written, so a
    // question never appears in its own history.
    const { nextSeq, history } = await withConversationLock(convId, async () => {
      // count() AND max(seq): ClickHouse returns 0 for max() over an empty set,
      // which would make a brand-new conversation look like it already had turn 0
      // and stop it being titled.
      const [priorRows, historyRows] = await Promise.all([
        query<{ n: string; max_seq: string }>(
          `SELECT toString(count()) AS n, toString(max(seq)) AS max_seq
           FROM messages WHERE conv_id = {conv:String}`,
          { conv: convId },
        ),
        query<{ role: string; question: string; insight_json: string }>(
          `SELECT role, question, insight_json FROM messages
           WHERE conv_id = {conv:String} ORDER BY seq DESC LIMIT 12`,
          { conv: convId },
        ),
      ]);
      const nextSeq = nextTurnSeq(
        Number(priorRows[0]?.n ?? 0),
        Number(priorRows[0]?.max_seq ?? 0),
      );
      const history = historyRows.reverse().map((m) => {
        if (m.role === "user") return { role: "user" as const, text: m.question };
        // Carry the figures forward, not just the sentence. A follow-up that recomputes
        // a quantity on a different basis than the turn before contradicts what the user
        // was already told, and no per-answer check can see that.
        let insight: Insight | null = null;
        try {
          insight = JSON.parse(m.insight_json || "{}") as Insight;
        } catch {
          /* a malformed stored answer must not break the next question */
        }
        // Carry the SQL context forward so the planner can reuse the same tables,
        // columns and approach rather than re-planning from scratch and drifting.
        const mainQueries = (insight?.sql ?? [])
          .filter((s) => !s.task.endsWith("_profile") && !s.task.endsWith("_top") && !s.task.endsWith("_bottom"));
        const sqlContext = mainQueries
          .map((s) => {
            const tables = [...s.query.matchAll(/\bfrom\s+([a-z_][a-z0-9_]*)/gi)]
              .map((m) => m[1]!).filter((t) => !/^select$/.test(t));
            return `${s.task}: ${s.title} (tables: ${[...new Set(tables)].join(", ")})`;
          })
          .join("; ");
        return {
          role: "agent" as const,
          text: insight?.headline ?? "",
          figures: insight ? establishedFigures(insight) : "",
          sqlContext,
          // Pass actual SQL from the most recent agent turn so the SQL writer
          // can reference or adapt them for follow-ups.
          priorSql: mainQueries.map((s) => ({
            task: s.task,
            title: s.title,
            query: s.query,
          })),
          droppedTasks: insight?.droppedTasks ?? [],
        };
      });

      // Title from the first question NOW, not after a successful answer: a failed
      // first answer still persists the user message, so a later retry would never
      // see nextSeq === 0 and the conversation would stay "New conversation".
      if (nextSeq === 0) {
        const created = now();
        await insert("conversations", [
          {
            conv_id: convId,
            title: question.slice(0, 70),
            starred: 0,
            // Explicit, not defaulted: this row is a new ReplacingMergeTree
            // version, and one written without `deleted` takes the column's
            // DEFAULT 0 anyway — but stating it keeps the two insert sites
            // identical and stops a future default change resurrecting rows.
            deleted: 0,
            created_at: created,
            updated_at: created,
          },
        ]).catch((error: unknown) => warnOnce("title insert", error));
      }

      await insert("messages", [
        { conv_id: convId, seq: nextSeq, role: "user", question, insight_json: "", trace_url: url, ts: now() },
      ]);
      return { nextSeq, history };
    });

    const activeTrace = trace;
    const insight = await withRunSink(
      (e: RunEvent) =>
        send(e.type, {
          name: e.name,
          // semantic grouping for the chat UI; several steps share a phase, and
          // concurrent tasks collapse into one "Querying ClickHouse" line
          phase: e.type.startsWith("step_") ? phaseOf(e.name) : undefined,
          payload: e.payload,
        }),
      // convId scopes the answer cache AND the related-insights lookup: without
      // it one conversation can be served another's cached answer, and the
      // narrator can cite headlines from conversations this reader never saw.
      () => runAnalytics({ question, history, convId }, { trace: activeTrace }),
    );
    await insert("messages", [
      {
        conv_id: convId,
        seq: nextSeq + 1,
        role: "agent",
        question: "",
        insight_json: JSON.stringify(insight),
        trace_url: url,
        ts: now(),
      },
    ]);
    // Title the conversation from its first question. Re-read first: a new
    // version written blind would undo a star — or resurrect a conversation
    // deleted while this answer was being written.
    if (nextSeq === 0) {
      const current = await loadConversation(convId);
      if (current) {
        await insert("conversations", [
          {
            conv_id: convId,
            title: question.slice(0, 70),
            starred: current.starred,
            deleted: 0,
            created_at: current.created_at,
            updated_at: now(),
          },
        ]);
      }
    }
    endRun(trace, { headline: insight.headline, confidence: insight.confidence.value });
    send("insight", { insight, traceUrl: url });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (trace) endRun(trace, { status: "failed", error: message });
    send("failed", { error: message, traceUrl: url });
  } finally {
    clearInterval(keepalive);
    send("done", {});
    res.end();
    unregister();
    await flushTraces().catch((error: unknown) => warnOnce("trace flush", error));
  }
}
