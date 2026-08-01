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
import { runAnalytics, type Insight } from "../agents/analytics.js";

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
      created_at DateTime64(3),
      updated_at DateTime64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY conv_id
    COMMENT 'Clickwright chat conversations (sidebar)'
  `);
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
    { conv_id: id, title: title ?? "New conversation", starred: 0, created_at: ts, updated_at: ts },
  ]);
  return id;
}

export async function listConversations(): Promise<unknown[]> {
  // Correlated subqueries are rejected by ClickHouse ("Cannot check Sorting plan
  // step for correlated expressions") — aggregate once and join. FINAL collapses
  // the ReplacingMergeTree versions from title/star updates.
  return query(`
    WITH stats AS (
      SELECT conv_id,
             toUInt32(count()) AS messages,
             argMaxIf(question, seq, role = 'user') AS preview
      FROM messages GROUP BY conv_id
    )
    SELECT c.conv_id AS id, c.title, toUInt8(c.starred) AS starred,
           toString(c.updated_at) AS updatedAt,
           coalesce(s.preview, '') AS preview,
           coalesce(s.messages, toUInt32(0)) AS messages
    FROM conversations AS c FINAL
    LEFT JOIN stats AS s ON s.conv_id = c.conv_id
    ORDER BY c.updated_at DESC
    LIMIT 100
  `);
}

export async function getConversation(convId: string): Promise<unknown> {
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
  const rows = await query<{ title: string; created_at: string }>(
    `SELECT title, toString(created_at) AS created_at FROM conversations
     WHERE conv_id = {conv:String} ORDER BY updated_at DESC LIMIT 1`,
    { conv: convId },
  );
  if (rows.length === 0) throw new Error("unknown conversation");
  await insert("conversations", [
    {
      conv_id: convId,
      title: rows[0]!.title,
      starred: starred ? 1 : 0,
      created_at: rows[0]!.created_at,
      updated_at: now(),
    },
  ]);
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
      const section = /##\s*Questions[^\n]*\n([\s\S]*?)(\n##|$)/i.exec(md)?.[1] ?? md;
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

  let seq = 0;
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

  // count(), not max(seq): ClickHouse returns 0 for max() over an empty set, which
  // made nextSeq 1 for a brand-new conversation and stopped it ever being titled.
  // independent reads — run them together rather than back to back
  const [priorRows, historyRows] = await Promise.all([
    query<{ n: string }>(
      // count(), not max(seq): ClickHouse returns 0 for max() over an empty set, which
      // made nextSeq 1 for a brand-new conversation and stopped it ever being titled.
      `SELECT toString(count()) AS n FROM messages WHERE conv_id = {conv:String}`,
      { conv: convId },
    ),
    query<{ role: string; question: string; insight_json: string }>(
      `SELECT role, question, insight_json FROM messages
       WHERE conv_id = {conv:String} ORDER BY seq DESC LIMIT 6`,
      { conv: convId },
    ),
  ]);
  const nextSeq = Number(priorRows[0]?.n ?? 0);
  const history = historyRows.reverse().map((m) => ({
    role: m.role as "user" | "agent",
    text:
      m.role === "user"
        ? m.question
        : ((JSON.parse(m.insight_json || "{}") as Insight).headline ?? ""),
  }));

  const trace = startRun(
    `chat:${question.slice(0, 60)}`,
    { question, convId },
    { sessionId: convId },
  );
  const url = traceUrl(trace);
  send("start", { traceUrl: url, convId });

  await insert("messages", [
    {
      conv_id: convId,
      seq: nextSeq,
      role: "user",
      question,
      insight_json: "",
      trace_url: url,
      ts: now(),
    },
  ]);

  try {
    const insight = await withRunSink(
      (e: RunEvent) => send(e.type, { name: e.name, payload: e.payload }),
      () => runAnalytics({ question, history }, { trace }),
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
    // title the conversation from its first question
    if (nextSeq === 0) {
      const created = now();
      await insert("conversations", [
        {
          conv_id: convId,
          title: question.slice(0, 70),
          starred: 0,
          created_at: created,
          updated_at: created,
        },
      ]);
    }
    endRun(trace, { headline: insight.headline, confidence: insight.confidence.value });
    send("insight", { insight, traceUrl: url });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    endRun(trace, { status: "failed", error: message });
    send("failed", { error: message, traceUrl: url });
  } finally {
    clearInterval(keepalive);
    send("done", {});
    res.end();
    await flushTraces().catch(() => {});
  }
}
