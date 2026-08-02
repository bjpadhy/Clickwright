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
import type { Response } from "express";
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

/**
 * Technical step names are noise in a chat UI. Each maps to one of five phases the
 * reader actually cares about, so the FE can render "Querying ClickHouse · 12s"
 * instead of a stack of sql_attempt_1 / task_t2 lines. The raw name still rides
 * along for the "how I got this" detail view.
 */
const PHASES: Array<[RegExp, string]> = [
  // the wrapper span and the cache probe are plumbing — no phase, so the UI skips
  // them rather than flashing a line the reader cannot act on
  [/^analytics$/, ""],
  [/^cache_lookup$/, ""],
  [/^context_load$/, "Reading the knowledge store"],
  [/^plan/, "Planning the analysis"],
  [/^(task_|sql_attempt)/, "Querying ClickHouse"],
  [/^digest_/, "Analysing every row of the results"],
  [/^sanity_gate$/, "Validating the results"],
  [/^context_lookup$/, "Looking for known issues"],
  [/^narrate/, "Writing the insight"],
  [/^quality_gate/, "Reviewing the answer"],
];

/** "" means: plumbing, do not surface it in the chat timeline. */
export function phaseOf(stepName: string): string {
  for (const [re, label] of PHASES) if (re.test(stepName)) return label;
  return "Working";
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
  if (!(await loadConversation(convId))) throw new Error("unknown conversation");
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
  if (!current) throw new Error("unknown conversation");
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
  if (!current) throw new Error("unknown conversation");
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
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  const keepalive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      /* client gone */
    }
  }, 15000);
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

    // independent reads — run them together rather than back to back
    const [priorRows, historyRows] = await Promise.all([
      // count(), not max(seq): ClickHouse returns 0 for max() over an empty set,
      // which made nextSeq 1 for a new conversation and stopped it being titled.
      query<{ n: string }>(
        `SELECT toString(count()) AS n FROM messages WHERE conv_id = {conv:String}`,
        { conv: convId },
      ),
      query<{ role: string; question: string; insight_json: string }>(
        `SELECT role, question, insight_json FROM messages
         WHERE conv_id = {conv:String} ORDER BY seq DESC LIMIT 12`,
        { conv: convId },
      ),
    ]);
    const nextSeq = Number(priorRows[0]?.n ?? 0);
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
        { conv_id: convId, title: question.slice(0, 70), starred: 0, created_at: created, updated_at: created },
      ]).catch(() => {});
    }

    await insert("messages", [
      { conv_id: convId, seq: nextSeq, role: "user", question, insight_json: "", trace_url: url, ts: now() },
    ]);

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
      () => runAnalytics({ question, history }, { trace: activeTrace }),
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
    await flushTraces().catch(() => {});
  }
}
