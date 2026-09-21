/**
 * ③ Analytics Agent — a PM question in, a cited Insight out. The chat backend.
 *
 * plan → SQL per task (guarded, read-only, self-healing ≤3) → sanity gate →
 * knowledge lookup → narrate → citation check (every number must exist in the
 * SQL results) → confidence (computed) → quality gate. One Langfuse trace per
 * question.
 *
 * DETERMINISTIC BY CONSTRUCTION: the same question in the same conversation over
 * the same data replays the same answer. Everything a prompt sees is either the
 * question, this conversation, the context store or a ClickHouse result — never
 * another conversation — and the answer cache is keyed on all of it.
 *
 * READ-ONLY BY CONSTRUCTION: context via getContext/lookupContext only (this
 * agent cannot call updateContext — it lacks an instrumentation result), and
 * SQL runs through queryReadonly (ClickHouse readonly=1) after code guards.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { command, insert, isTransientDbError, query, queryReadonly } from "../core/db.js";
import { env } from "../core/env.js";
import { withQueryContext } from "../core/query-context.js";
import { step, scoreRun, recordQuery, emitRunEvent, type Ctx } from "../core/tracing.js";
import { complete, loadPrompt, stripFences, type CompleteOptions } from "../core/llm.js";
import { getContext, lookupContext } from "./context.js";
import {
  COUNT_RE,
  RATE_RE,
  deriveConfidence,
  namedMetrics,
  unstatedAssumptions,
  precisionForRow,
  type ConfidenceInput,
  type ConfidenceSignal,
  type Precision,
} from "../core/precision.js";
import {
  digestFlags,
  populationRow,
  profileResult,
  renderDigest,
  type ResultDigest,
} from "../core/result-digest.js";
import { verifyTask, type VerificationResult } from "./verifier.js";

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

// ── feature switches ────────────────────────────────────────────
// Every switch is opt-OUT: only an explicit `ANALYTICS_*=0` in the environment
// turns a feature off, so a missing flag block (or a flag added later) means
// "on". Read through a helper so the pure guard functions below stay
// unit-testable whatever the environment holds.
type AnalyticsFlag = "qualityGate" | "llmLookup" | "relatedInsights" | "orderByAll";
const flagOn = (name: AnalyticsFlag): boolean => env.analytics?.[name] !== false;

// ── answer cache ────────────────────────────────────────────────
// A question whose wording, conversation, context version and underlying data
// are unchanged has the same answer: serve it from ClickHouse in milliseconds
// instead of re-running the agent. Any context write or data load changes the
// key, which invalidates naturally.

export async function initInsightCache(): Promise<void> {
  await command(`
    CREATE TABLE IF NOT EXISTS insight_cache (
      cache_key     String,
      question      String,
      context_key   String,
      conv_id       String DEFAULT '',
      insight_json  String,
      created_at    DateTime64(3)
    ) ENGINE = ReplacingMergeTree(created_at) ORDER BY cache_key
    TTL toDateTime(created_at) + INTERVAL 30 DAY
    COMMENT 'Analytics answers keyed by question + conversation + context version + data version — repeat asks are instant'
  `);
  // Which conversation an answer belongs to, so "related insights" can be scoped
  // to it. Rows written before the column existed carry '' and match no
  // conversation — they simply never surface as related.
  await command(`ALTER TABLE insight_cache ADD COLUMN IF NOT EXISTS conv_id String DEFAULT ''`);
  // The key includes the context version, so an entry is dead the moment any
  // definition it depended on changes — but nothing removed it. Expiry costs a
  // recompute on the next ask and never changes an answer.
  await command(`ALTER TABLE insight_cache MODIFY TTL toDateTime(created_at) + INTERVAL 30 DAY`);
}

/**
 * The figures an earlier answer already put in front of the user, with the sample
 * each rests on and the tables it came from.
 *
 * A follow-up plans from scratch, so nothing stopped it recomputing a quantity on a
 * different basis than the turn before: one evaluation had consecutive turns report
 * UAE standard-checkout conversion as 56.6% and then 5.4%, the second having silently
 * changed the denominator. Both answers passed their own citation and verification
 * checks, because every check we run is scoped to a single answer. Carrying the
 * established figures forward gives the planner and the narrator the one thing they
 * were missing: what the user has already been told.
 *
 * `n` is what makes this work — it identifies the population, so a later turn using a
 * different denominator is visible as a different n rather than just a different number.
 */
export function establishedFigures(insight: Insight): string {
  const tables = [
    ...new Set(
      (insight.sql ?? []).flatMap((s) =>
        [...s.query.matchAll(/\bfrom\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]!.toLowerCase()),
      ),
    ),
  ].filter((t) => !/^\(|^select$/.test(t));

  const figures = (insight.precision ?? [])
    .filter((p) => p.n !== null)
    .slice(0, 6)
    .map((p) => {
      const shown =
        p.kind === "proportion" && p.value <= 1.0001
          ? `${(p.value * 100).toFixed(1)}%`
          : String(Number(p.value.toFixed(4)));
      return `${p.column}=${shown} (n=${p.n})`;
    });

  if (figures.length === 0) return "";
  return `${figures.join("; ")}${tables.length ? ` — computed from ${tables.slice(0, 6).join(", ")}` : ""}`;
}

/**
 * Bump whenever the shape of an answer changes. Cached entries hold whole
 * insights, so without this a repeat question replays an answer built to the old
 * contract and the change looks like it never shipped. Entries under a retired
 * version are simply never read again, and the 30-day TTL clears them.
 *
 * v3 — sections: whatsHappening, whyItHappens, evidence{}, groundedInContext,
 *      recommendedAction, replacing the tagged `findings` list.
 * v4 — confidence carries `signals`; the key is scoped to the conversation,
 *      stamped with the data version, and covers the related-insights text.
 */
const INSIGHT_FORMAT_VERSION = "v4";

export interface CacheKeyParts {
  question: string;
  /** `${contextVersionDigest}:${dataKey}` — the definitions in force and the
   * data they ran over. Either moving means the answer may differ. */
  contextKey: string;
  /** The conversation the question was asked in; "" for an unscoped ask (a
   * script or the benchmark). Two conversations never share an entry. */
  convId?: string;
  /** The turns before this one, so a follow-up is cached per conversation state. */
  historyDigest?: string;
  /** sha1 of the related-insights text the narrator saw, or "" when there was
   * none — a replay can never disagree with the text that produced it. */
  relatedDigest?: string;
}

/** Exported for tests: what has to change for a question to be recomputed. */
export function cacheKey({
  question,
  contextKey,
  convId = "",
  historyDigest = "",
  relatedDigest = "",
}: CacheKeyParts): string {
  const normalized = question.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(
      `${INSIGHT_FORMAT_VERSION}::${normalized}::${contextKey}::${convId}::${historyDigest}::${relatedDigest}`,
    )
    .digest("hex")
    .slice(0, 32);
}

async function readCache(key: string): Promise<Insight | null> {
  const rows = await query<{ insight_json: string }>(
    `SELECT insight_json FROM insight_cache WHERE cache_key = {k:String}
     ORDER BY created_at DESC LIMIT 1`,
    { k: key },
  );
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0]!.insight_json) as Insight;
  } catch {
    return null;
  }
}

// ── output contract (mirrors backend/API.md `Insight`) ──────────

export interface InsightChart {
  kind: "bar" | "line";
  series: Array<{ label: string; value: number }>;
  sourceTask: string;
  /** How to render `value` — derived in code, never asked of the model. */
  valueFormat?: string | undefined;
}

export interface InsightTable {
  columns: string[];
  rows: Array<Array<string | number>>;
  sourceTask: string;
  /** Per-column render hint, parallel to `columns`. */
  columnFormats?: string[] | undefined;
}

export interface Insight {
  headline: string;
  /** The effect, in numbers. */
  whatsHappening: string;
  /** The mechanism behind it. */
  whyItHappens: string;
  /** The visual, and what basis it was computed on. */
  evidence: {
    title: string;
    chart: InsightChart | null;
    segmentTable: InsightTable | null;
  };
  /** Retrieved knowledge that bears on the answer; "" when none applies. */
  groundedInContext: string;
  /** The decision this implies, and what it should move. */
  recommendedAction: string;
  /** COMPUTED from measured precision and checks — never the model's opinion.
   * `score` is the same judgement as `value` on a 0–1 scale, so the UI can show
   * a bar; `signals` are the additive deductions and bonuses that produced it,
   * so a reader can see exactly what to sharpen in the question. */
  confidence: {
    value: "high" | "medium" | "low";
    score: number;
    note: string;
    signals: ConfidenceSignal[];
  };
  /** Per-figure 95% bounds, or a stated reason none could be computed. */
  precision: Precision[];
  /** Result of recomputing a figure with an independently written query. */
  verification: {
    agreed: boolean | null;
    originalValue: number | null;
    verifiedValue: number | null;
    sql: string;
    note: string;
    concern: string;
    definitionOk: boolean;
    answersQuestion: boolean;
    /** The result column the verifier set out to reproduce. */
    expectedToMatch: string;
  } | null;
  contextVersion: string;
  /** Every query that backed this answer, including the whole-set profiles.
   * `rowCount` is what the query returned; `totalRows` is how many rows the
   * analysis covered, which is larger whenever the fetch was capped. */
  sql: Array<{
    task: string;
    title: string;
    query: string;
    rowCount: number;
    totalRows?: number;
  }>;
  /** Tasks that were planned but dropped (SQL failures, empty results, blocked). */
  droppedTasks?: string[];
  /** True when served from insight_cache (no LLM calls, ~ms). */
  cached?: boolean;
}

const PlanTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/i),
  title: z.string().min(1),
  question: z.string().min(1),
  tables: z.array(z.string()).min(1),
  dimensions: z.array(z.string()).optional(),
  /** When set, this task runs AFTER the named task and receives its result
   *  summary — use for funnel drop-off analysis or comparisons that need
   *  a prior stage's count as input. */
  depends_on: z.string().optional(),
});

export const PlanSchema = z.object({
  approach: z.string().min(1),
  tasks: z
    .array(PlanTaskSchema)
    .max(4)
    // A dependency the executor cannot resolve used to surface only as an empty
    // `depContext` at run time. Validate it here, where the retry loop turns the
    // problem into feedback the planner can act on.
    .superRefine((tasks, ctx) => {
      const earlier = new Set<string>();
      tasks.forEach((t, i) => {
        if (earlier.has(t.id)) {
          ctx.addIssue({ code: "custom", path: [i, "id"], message: `duplicate task id "${t.id}" — ids must be unique` });
        }
        if (t.depends_on !== undefined && !earlier.has(t.depends_on)) {
          ctx.addIssue({
            code: "custom",
            path: [i, "depends_on"],
            message:
              t.depends_on === t.id
                ? `task "${t.id}" cannot depend on itself`
                : `depends_on "${t.depends_on}" must name a task listed BEFORE "${t.id}" (it is missing or comes later)`,
          });
        }
        earlier.add(t.id);
      });
    }),
  /** What the planner had to decide because the question did not say: metric,
   * denominator, window, segment. Each one costs confidence (see
   * core/precision.ts) and is reported in the confidence note, so a PM can see
   * exactly what to pin down. Never shown to the narrator — a "90 days" echo
   * would fail the citation check.
   *
   * NON-REJECTING BY DESIGN: this field is commentary, and the prompt never
   * states a length or a count, so a 121-character assumption (or a seventh one)
   * must not cost the question its plan — the retry loop is terminal after three
   * failures. Anything unusable is clamped here instead: blanks dropped, each
   * trimmed to 120 characters, at most six kept, and a shape we cannot read at
   * all falls back to none. `depends_on` above stays the only new hard check. */
  assumptions: z
    .preprocess(
      // The single most common malformed shape is a string where an array was
      // asked for: "last 90 days; all platforms". Falling straight to `.catch([])`
      // there silently removed the whole vague-question lever — the −0.25 that
      // makes "how is checkout doing?" score below a pinned-down question — and
      // the answer looked MORE confident for being less specific. Split it
      // instead; only a shape that is neither string nor array now falls back.
      (v) => (typeof v === "string" ? v.split(/[;\n]/) : v),
      z.array(z.string()),
    )
    .default([])
    .catch([])
    .transform((xs) =>
      xs
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => s.slice(0, 120))
        .slice(0, 6),
    ),
});
type Plan = z.infer<typeof PlanSchema>;

/**
 * The answer, in the order a PM reads it: what is happening, why it happens, the
 * evidence, what the context store already knew, and what to do.
 *
 * Each section is its own key rather than an entry in a tagged `findings` list,
 * because a list lets an answer satisfy the schema while never saying why — six
 * observations and no mechanism used to pass. A named, required slot cannot be
 * skipped, and a reader always finds the same thing in the same place.
 */
const NarrationSchema = z.object({
  headline: z.string().min(1),
  /** The finding itself, in numbers: the size and shape of the effect. */
  whatsHappening: z.string().min(1),
  /** The mechanism behind it — the part that decides what gets built. */
  whyItHappens: z.string().min(1),
  evidence: z.object({
    /** What the chart or table shows, including the basis: population, window. */
    title: z.string().default(""),
    chart: z
      .object({
        kind: z.enum(["bar", "line"]),
        series: z.array(z.object({ label: z.string(), value: z.number() })).min(1).max(12),
        // Which task a visual came from is bookkeeping. Losing a chart because the
        // model omitted it beats losing the whole answer, and annotateFormats
        // recovers the reference when there is only one task it could mean.
        sourceTask: z.string().default(""),
        valueFormat: z.string().optional(),
      })
      .nullish()
      .transform((v) => v ?? null),
    segmentTable: z
      .object({
        columns: z.array(z.string()).min(2),
        rows: z.array(z.array(z.union([z.string(), z.number()]))).min(1).max(15),
        sourceTask: z.string().default(""),
        columnFormats: z.array(z.string()).optional(),
      })
      .nullish()
      .transform((v) => v ?? null),
  }),
  /**
   * What the context store already knew that bears on this answer — a known
   * issue, a definition, a caveat about the basis. Empty when nothing retrieved
   * applies: an invented connection is worse than an absent one.
   */
  groundedInContext: z.string().default(""),
  /** The decision this implies, and what it should move. */
  recommendedAction: z.string().min(1),
  // No confidence field: the level is computed from measured precision, and asking
  // the model for one only invites a plausible-sounding guess. Uncertainty belongs
  // in `groundedInContext` or in the basis stated in `evidence.title`.
});
type Narration = z.infer<typeof NarrationSchema>;

const QualitySchema = z.object({
  actionable: z.boolean(),
  cites_numbers: z.boolean(),
  names_segment: z.boolean(),
  /** Is the pattern a named phenomenon, or the metric restated as a label? */
  names_pattern: z.boolean(),
  /** Does `why` give a mechanism, or just describe the number again? */
  explains_why: z.boolean(),
  links_known_issue: z.boolean(),
  honest_confidence: z.boolean(),
  verdict: z.enum(["pass", "revise"]),
  revision_note: z.string(),
});

/** The application's own storage — not event data. Excluded from the schema
 * the model sees and from the data-version stamp, so writing an answer to
 * insight_cache can never invalidate the cache it was just written to. */
const INTERNAL_TABLES = [
  "context_store", "runs_log", "conversations", "messages", "dashboards",
  "insight_cache", "optimization_suggestions", "schema_changelog", "trace_summaries",
  // ReplacingMergeTree written by server/runs.ts: its `total_rows` drops when a
  // background merge collapses duplicates, which moved the data-version stamp
  // with no data change and invalidated every cached answer at random.
  "run_summary",
];
const INTERNAL_TABLES_SQL = INTERNAL_TABLES.map((t) => `'${t}'`).join(", ");

/** Exact column names+types per table. Injected into plan/SQL prompts: the
 * single biggest accuracy win — the model stops guessing column names, which
 * also removes most retry rounds (so it is a latency win too). */
async function loadTableSchemas(): Promise<Map<string, string>> {
  const rows = await query<{ table: string; cols: string }>(`
    SELECT table, arrayStringConcat(groupArray(concat(name, ' ', type)), ', ') AS cols
    FROM system.columns
    WHERE database = currentDatabase() AND table NOT IN (${INTERNAL_TABLES_SQL})
    GROUP BY table ORDER BY table
  `);
  return new Map(rows.map((r) => [r.table, `- ${r.table}: ${r.cols}`]));
}

const SCHEMA_TTL_MS = 5 * 60_000;
let schemaCache: { at: number; stamp: string; value: Promise<Map<string, string>> } | null = null;

/**
 * Memoised `system.columns`: the schema changes only when a run creates a table
 * or the optimizer alters one, yet every question paid the round trip. Reloaded
 * when the data-version stamp moves (DDL changes it), after five minutes, or on
 * `invalidateSchemaCache()` — which the run manager calls after instrumentation
 * and optimization so a fresh table is visible to the very next question.
 */
async function tableSchemas(stamp = ""): Promise<Map<string, string>> {
  const current = schemaCache;
  if (current && Date.now() - current.at < SCHEMA_TTL_MS && current.stamp === stamp) {
    return current.value;
  }
  const value = loadTableSchemas();
  const entry = { at: Date.now(), stamp, value };
  schemaCache = entry;
  // a failed load must not be served for five minutes; the caller still sees the error
  value.catch(() => {
    if (schemaCache === entry) schemaCache = null;
  });
  return value;
}

/** Drop the memoised schema so the next question re-reads `system.columns`.
 * Call after any DDL: an instrumentation run (success OR rollback) and an
 * applied optimization. */
export function invalidateSchemaCache(): void {
  schemaCache = null;
}

export interface DataVersion {
  /** Rows across every event table, as `system.tables` reports them. */
  rows: string;
  /** Latest DDL time across those tables. */
  modifiedAt: string;
  /** sha1(rows|modifiedAt)[:10] — the data-version stamp in the cache key. */
  key: string;
}

/**
 * What the event tables hold right now. A cached answer is only a replay while
 * the data it ran over is unchanged: a load adds rows, an optimizer `ALTER`
 * moves the metadata time, and either changes this stamp and so the key.
 */
async function dataVersion(): Promise<DataVersion> {
  const [row] = await query<{ rows: string | number; mod: string }>(`
    SELECT sum(coalesce(total_rows, 0)) AS rows, max(metadata_modification_time) AS mod
    FROM system.tables
    WHERE database = currentDatabase() AND name NOT IN (${INTERNAL_TABLES_SQL})
  `);
  const rows = String(row?.rows ?? 0);
  const modifiedAt = String(row?.mod ?? "");
  return { rows, modifiedAt, key: sha1(`${rows}|${modifiedAt}`).slice(0, 10) };
}

/** Only the tables this step needs — a SQL prompt paying for 13 schemas when it
 * touches 2 is pure waste, and the noise hurts accuracy as well as cost. */
function schemaSubset(all: Map<string, string>, tables: string[]): string {
  const picked = tables.map((t) => all.get(t)).filter(Boolean) as string[];
  const lines = picked.length ? picked : [...all.values()];
  // Whether the hygiene columns exist is a FACT we already have. Stating it per
  // table beats asking the model to infer it — it filtered duplicate_id on a
  // table that lacks the column when left to a general rule.
  return lines
    .map((line) => {
      const has = /\bduplicate_id\b/.test(line);
      return `${line}\n    → hygiene: ${has ? "HAS duplicate_id + is_back_filled — you MUST filter both" : "NO duplicate_id / is_back_filled columns — do NOT reference them, the query will fail"}`;
    })
    .join("\n");
}

// ── SQL guards (deterministic — prompts are not a security boundary) ──

const BANNED =
  /\b(insert|alter|drop|create|truncate|delete|rename|grant|revoke|attach|detach|optimize|system|kill|set|settings)\b/i;

/** How many rows cross the wire into Node. This is a TRANSPORT cap, not a limit on
 * what gets analysed: a larger result is profiled in full inside ClickHouse (see
 * core/result-digest.ts) and these rows serve as the illustrative sample. The
 * server cannot enforce it for us — ClickHouse Cloud pins this user to readonly=1,
 * which discards row-limit settings — so the cap lives here. */
const MAX_RESULT_ROWS = 1000;

const TRAILING_LIMIT = /\blimit\s+(\d+)\s*$/i;
/** `LIMIT n OFFSET m` / `LIMIT m, n` — already a bound on the fetch, and a second
 * LIMIT after either is a syntax error (which used to cost a wasted retry). */
const LIMIT_WITH_OFFSET = /\blimit\s+\d+\s*(?:,\s*\d+|\s+offset\s+\d+)/i;
/** The same shape with its numbers captured, for rewriting rather than testing:
 * `LIMIT <count> OFFSET <offset>` (groups 1, 3) or `LIMIT <offset>, <count>`
 * (groups 1, 2). */
const LIMIT_WITH_OFFSET_G = /\blimit\s+(\d+)\s*(?:,\s*(\d+)|\s+offset\s+(\d+))/gi;
/** `LIMIT n BY col` — an ORDER BY cannot follow it, so the cap stays plain. */
const LIMIT_BY = /\blimit\s+\d+\s+by\b/i;
const UNION = /\bunion\b/i;

/** Index just past the `"…"` / `` `…` `` identifier that starts at `i`, honouring
 * doubled-quote and backslash escapes. `s.length` when it is never closed. */
function skipQuotedIdent(s: string, i: number): number {
  const q = s[i]!;
  let j = i + 1;
  while (j < s.length) {
    const c = s[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === q) {
      if (s[j + 1] === q) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return s.length;
}

/** Single-quoted string literals replaced by `''`. A keyword INSIDE a literal is
 * data, not a statement: the SQL writer's own sentinel — `SELECT 'cannot compute'
 * AS blocked, 'the data set has no …' AS reason` — used to trip the ban on `set`.
 *
 * Identifier-aware: an apostrophe inside a quoted identifier (`"o'clock"`) is part
 * of the NAME, not the start of a literal. Reading it as one opened a phantom
 * literal that blanked the rest of the statement, so `FROM "o'clock", system.tables`
 * lost the word `system` and walked straight through the ban check. An unterminated
 * literal is left exactly as written for the same reason — blanking to end of input
 * would hide whatever follows it. */
export function blankStringLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === '"' || ch === "`") {
      const end = skipQuotedIdent(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        const c = sql[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        out += sql.slice(i);
        break;
      }
      out += "''";
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The statement with every parenthesised group and string literal removed —
 * what is left are the clauses of the OUTERMOST select. A parenthesis inside a
 * quoted identifier (`"revenue (usd)"`) is part of the name, not a group: counting
 * it unbalanced the depth, which let `ORDER BY ALL` be appended after an authored
 * ORDER BY — a syntax error and a wasted retry. */
export function topLevelSql(sql: string): string {
  let depth = 0;
  let out = "";
  const blanked = blankStringLiterals(sql);
  for (let i = 0; i < blanked.length; i++) {
    const ch = blanked[i]!;
    if (ch === '"' || ch === "`") {
      const end = skipQuotedIdent(blanked, i);
      if (depth === 0) out += blanked.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/** Does the outermost select order its rows? An ORDER BY inside a subquery or a
 * CTE does not — the outer result is still returned in arbitrary order. */
export function hasTopLevelOrderBy(sql: string): boolean {
  return /\border\s+by\b/i.test(topLevelSql(sql));
}

export interface SqlParts {
  /** The validated single statement, as the model wrote it. */
  validated: string;
  /** The statement with any trailing authored LIMIT removed. */
  core: string;
  /** A trailing LIMIT the model wrote. Unlike the transport cap this is part of
   * what the task MEANS ("the top 10 cities"), so it bounds the analysis too. */
  authoredLimit: number | null;
}

/** Validate and decompose, without capping. Prompts are not a security boundary,
 * so every check here is deterministic. */
export function guardSqlParts(raw: string): SqlParts {
  const sql = stripFences(raw).trim().replace(/;+\s*$/, "");
  if (sql.includes(";")) throw new Error("exactly one statement allowed (found ';')");
  if (!/^(select|with)\b/i.test(sql)) throw new Error("statement must start with SELECT or WITH");
  const code = blankStringLiterals(sql);
  if (BANNED.test(code)) {
    throw new Error(`banned keyword in SQL: ${BANNED.exec(code)?.[0]}`);
  }
  const limit = TRAILING_LIMIT.exec(sql);
  const authored = limit?.[1];
  return {
    validated: sql,
    core: limit ? sql.slice(0, limit.index).trimEnd() : sql,
    authoredLimit: authored === undefined ? null : Number(authored),
  };
}

export interface GuardOptions {
  /** Append `ORDER BY ALL` with the transport cap (default: the
   * `ANALYTICS_ORDER_BY_ALL` switch, on unless set to 0). */
  orderByAll?: boolean;
}

/**
 * Cap what crosses the wire — deterministically.
 *
 * `LIMIT 1000` on an unordered result hands the narrator an ARBITRARY thousand
 * rows: the chart and table are built from the first 24 of them, so the same
 * question could show different segments run to run. `ORDER BY ALL` (ClickHouse
 * ≥ 23.12) fixes which rows those are without knowing the column names. It is
 * added only where it is legal and meaningful: not after an authored ORDER BY,
 * not before a `LIMIT n BY`, and not on a top-level UNION (where it would sort
 * one arm only). Saved dashboards store this text, so any change here rewrites
 * boards on their next save — intended for this one, which is why the tests pin
 * the bytes.
 */
/** Clamp the row COUNT of the statement's last `LIMIT n OFFSET m` / `LIMIT m, n`
 * down to the transport cap, keeping the offset (and so the page) intact. A count
 * already within the cap is returned untouched, byte for byte. */
function clampOffsetLimit(sql: string): string {
  const matches = [...sql.matchAll(LIMIT_WITH_OFFSET_G)];
  const m = matches[matches.length - 1];
  if (!m || m.index === undefined) return sql;
  const commaForm = m[2] !== undefined;
  const count = Number(commaForm ? m[2] : m[1]);
  if (!Number.isFinite(count) || count <= MAX_RESULT_ROWS) return sql;
  const replaced = commaForm
    ? `LIMIT ${m[1]}, ${MAX_RESULT_ROWS}`
    : `LIMIT ${MAX_RESULT_ROWS} OFFSET ${m[3]}`;
  return sql.slice(0, m.index) + replaced + sql.slice(m.index + m[0].length);
}

function capForFetch(parts: SqlParts, orderByAll: boolean): string {
  const { validated, authoredLimit } = parts;
  if (authoredLimit !== null) {
    // clamp an oversized explicit LIMIT rather than rejecting an otherwise good query
    if (authoredLimit <= MAX_RESULT_ROWS) return validated;
    const limit = TRAILING_LIMIT.exec(validated);
    return limit ? validated.slice(0, limit.index) + `LIMIT ${MAX_RESULT_ROWS}` : validated;
  }
  const top = topLevelSql(validated);
  // A second LIMIT cannot follow this form, so the transport cap has to be written
  // INTO the authored one or it is simply bypassed — `LIMIT 50000 OFFSET 0` would
  // stream fifty thousand rows into Node and into the prompts. Clamp the count and
  // keep the offset; a page already within the cap is left byte-for-byte alone.
  if (LIMIT_WITH_OFFSET.test(top)) return clampOffsetLimit(validated);
  const ordered =
    orderByAll && !hasTopLevelOrderBy(validated) && !LIMIT_BY.test(top) && !UNION.test(top);
  return ordered
    ? `${validated}\nORDER BY ALL\nLIMIT ${MAX_RESULT_ROWS}`
    : `${validated}\nLIMIT ${MAX_RESULT_ROWS}`;
}

export function guardSql(raw: string, opts: GuardOptions = {}): string {
  return capForFetch(guardSqlParts(raw), opts.orderByAll ?? flagOn("orderByAll"));
}

// ── citation checker: every number in prose must exist in results ──

export interface TaskResult {
  id: string;
  title: string;
  /** The statement that actually executed, including the transport cap. */
  sql: string;
  /** The statement as the model wrote it — what the query MEANS. Used wherever a
   * reader or another prompt needs the query, since the transport cap is our
   * plumbing rather than part of the analysis. */
  semanticSql: string;
  /** `semanticSql` without its trailing authored LIMIT, for wrapping as a subquery. */
  coreSql: string;
  authoredLimit: number | null;
  rows: Record<string, unknown>[];
  /** Rows in the whole result set — exceeds `rows.length` when the fetch capped.
   * Exact when a digest ran; otherwise the fetched count. */
  totalRows: number;
  /** Whole-result-set statistics, computed in ClickHouse over every row. */
  digest: ResultDigest | null;
  /** Why a result large enough to want a profile does not have one. */
  digestNote: string;
  dropped?: string;
  flags: string[];
}

/** The parts of a result the citation machinery reads. A structural type keeps
 * these functions testable without building a whole TaskResult. */
export interface CitableResult {
  rows: Record<string, unknown>[];
  totalRows: number;
  digest: ResultDigest | null;
}

/** Values the narrator is allowed to cite. Built from exactly what it was shown:
 * using every fetched row let one 1000-row task consume the whole budget and
 * starve later tasks, so a number the narrator could see was reported as uncited
 * and the answer died. */
export function numericPool(results: CitableResult[], rowsShown: number): number[] {
  const pool: number[] = [];
  const pushRow = (row: Record<string, unknown>): void => {
    for (const v of Object.values(row)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) {
        pool.push(n);
        if (n >= -1 && n <= 1) pool.push(n * 100); // rates quoted as percentages
      }
    }
  };
  // Shown rows and row counts for EVERY task first: findUncitedNumbers only pairs
  // the leading distinct values, and a task's digest pushed ahead of another task's
  // visible rows would spend that window on figures nobody is comparing.
  for (const r of results) {
    // The fetched count, the true count, and the number of rows actually listed —
    // all three appear in the header the narrator reads, so all three are citable.
    pool.push(r.rows.length, r.totalRows, Math.min(r.rows.length, rowsShown));
    for (const row of r.rows.slice(0, rowsShown)) pushRow(row);
  }
  for (const r of results) {
    if (!r.digest) continue;
    pushRow(r.digest.statsRow);
    for (const row of r.digest.extremes?.top ?? []) pushRow(row);
    for (const row of r.digest.extremes?.bottom ?? []) pushRow(row);
  }
  return pool;
}

/** A Date or DateTime as ClickHouse renders it in JSON. */
const DATE_LITERAL = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?/;
const DATE_IN_TEXT = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/g;

/** Date literals the results actually contained. Dates are strings, so they never
 * enter the numeric pool — yet "2025-03-15" tokenises to -15, so quoting a date
 * straight out of its own results failed the citation check. */
export function collectDateLiterals(results: CitableResult[], rowsShown: number): string[] {
  const out = new Set<string>();
  const scan = (row: Record<string, unknown>): void => {
    for (const v of Object.values(row)) {
      if (typeof v === "string" && DATE_LITERAL.test(v)) out.add(v);
    }
  };
  for (const r of results) {
    for (const row of r.rows.slice(0, rowsShown)) scan(row);
    if (!r.digest) continue;
    scan(r.digest.statsRow);
    for (const row of r.digest.extremes?.top ?? []) scan(row);
    for (const row of r.digest.extremes?.bottom ?? []) scan(row);
  }
  return [...out];
}

const normalizeText = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/** Every prose field of an answer — the text a citation check must cover. */
const narrativeTexts = (n: Narration): string[] => [
  n.headline,
  n.whatsHappening,
  n.whyItHappens,
  n.evidence.title,
  n.groundedInContext,
  n.recommendedAction,
];

/**
 * Does each section say something the others did not?
 *
 * The failure mode this guards is specific and common: asked for a mechanism,
 * a model restates the measurement at greater length, so `whyItHappens` becomes
 * `whatsHappening` with different words. That is detectable without judgement —
 * the section repeats one already on the card, or is too short to carry a cause.
 * Anything subtler goes to the LLM gate.
 */
export function sectionsAreSubstantive(narration: {
  headline: string;
  whatsHappening: string;
  whyItHappens: string;
  recommendedAction: string;
}): boolean {
  const headline = normalizeText(narration.headline);
  const happening = normalizeText(narration.whatsHappening);
  const why = normalizeText(narration.whyItHappens);
  const action = normalizeText(narration.recommendedAction);
  if (!happening || !why || !action) return false;
  // a mechanism does not fit in a handful of words
  if (why.length < 60) return false;
  // …nor is it a sentence already on the card
  if (headline.includes(why) || happening.includes(why) || why.includes(happening)) return false;
  // an action has to say something to do
  if (action.length < 25) return false;
  return true;
}

/**
 * A number is citable when it appears in the results, OR when it is the
 * difference/ratio of two values that do — arithmetic code can verify, so the
 * chain back to ClickHouse stays unbroken (PMs need deltas; inventing them is
 * still forbidden).
 */
/** Numbers written in a piece of text — the question, or the planner's assumptions. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replaceAll(",", ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export function findUncitedNumbers(
  texts: string[],
  pool: number[],
  datePool: string[] = [],
  /** Numbers the question (or an assumption restating it) already contains. The
   * guard exists to catch figures invented about the DATA; "over the last 30
   * days" is the asker's own window quoted back, and rejecting it killed every
   * question that named one. Not pairable — quoting 30 does not license 30/7. */
  askedNumbers: number[] = [],
): string[] {
  const near = (a: number, b: number) =>
    Math.abs(a - b) <= Math.max(0.06, Math.abs(b) * 0.015);
  const base = [...new Set(pool)];
  // Derived pairs are for legitimate deltas, but ~n² of them makes the check
  // permissive on rich results. Only pair the values a narrator actually
  // compares — the first 60 distinct — keeping the guard tight.
  const pairable = base.slice(0, 60);
  const derived: number[] = [];
  for (let i = 0; i < pairable.length; i++) {
    for (let j = 0; j < pairable.length; j++) {
      if (i === j) continue;
      const a = pairable[i]!;
      const b = pairable[j]!;
      derived.push(a - b);
      if (b !== 0) {
        const ratio = a / b;
        derived.push(ratio);
        // `numericPool` scales a FETCHED 0.478 to 47.8, so "47.9%" cites cleanly.
        // A rate the narrator had to DERIVE got no such scaling: 3 purchases over
        // 13 clicks was citable as 0.2308 but not as the "23.1%" every narration
        // prompt asks it to write, and the answer died after three retries.
        //
        // Restricted to two COUNTS on purpose. Scaling every ratio in [-1,1]
        // added ~3,600 values to a pool matched with 1.5% tolerance, which made
        // the guard permissive enough to admit figures it is here to catch — it
        // started accepting "-30" in the date test's negative control. Two
        // integers dividing to a rate is the shape that actually failed.
        // A pp GAP needs nothing extra: `numericPool` already holds both
        // fractions scaled, so 85.8 - 47.9 is an ordinary derived difference.
        if (Number.isInteger(a) && Number.isInteger(b) && ratio >= -1 && ratio <= 1) {
          derived.push(ratio * 100);
        }
      }
    }
  }
  const uncited: string[] = [];
  for (const text of texts) {
    // A date the results contained is one citation, not three numbers. Remove the
    // ones we know appeared before tokenising; an invented date survives and is
    // rejected as the digits it is made of.
    const scanned =
      datePool.length === 0
        ? text
        : text.replace(DATE_IN_TEXT, (found) =>
            datePool.some((d) => d.startsWith(found) || found.startsWith(d)) ? " " : found,
          );
    for (const m of scanned.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
      const raw = m[0];
      let n = Number(raw.replaceAll(",", ""));
      if (!Number.isFinite(n)) continue;
      // "34.9%-35.6%" and "Jan-2026" tokenise their second half as a negative
      // number. A minus sign directly after a digit, letter or bracket is a
      // separator, not a sign — reading it as one rejected figures the results
      // plainly contained. A genuine "-5.2pp" is preceded by a space.
      const before = m.index > 0 ? scanned[m.index - 1] ?? "" : "";
      if (raw.startsWith("-") && /[\w%)\]]/.test(before)) n = Math.abs(n);
      if (Number.isInteger(n) && Math.abs(n) <= 12) continue; // "3 steps", ordinals
      if (Number.isInteger(n) && Math.abs(n) >= 2020 && Math.abs(n) <= 2030) continue; // years
      if (base.some((v) => near(n, v))) continue;
      if (askedNumbers.some((v) => near(n, v))) continue;
      if (derived.some((v) => near(n, v))) continue;
      uncited.push(raw);
    }
  }
  return [...new Set(uncited)];
}

// ── value formatting (pure code) ─────────────────────────────────
// The same rate arrives as 0.83 from one query and 83 from another. Rather than
// mutating values (which would break the "every number is in the SQL result"
// chain), classify them so the UI can render correctly.

export type ValueFormat =
  | "fraction"   // 0..1 rate — display as value*100 with a % sign
  | "percent"    // already 0..100 with a % meaning
  | "percentage_points"
  | "count"
  | "ms"
  | "seconds"
  | "currency"
  | "number";

export function inferFormat(name: string, values: number[], sql = ""): ValueFormat {
  const n = name.toLowerCase();
  const max = values.length ? Math.max(...values.map(Math.abs)) : 0;
  // A query that multiplies by 100 emits percentages; 0.383 then means 0.383%,
  // not 38.3%. Values alone cannot distinguish this below 1%.
  const scaledToPercent = /\*\s*100(\.0)?\b/.test(sql);
  if (/_pp$|percentage_point|_delta_pct/.test(n)) return "percentage_points";
  if (/_ms$|latency|duration_ms/.test(n)) return "ms";
  if (/_s$|_sec|seconds|elapsed/.test(n)) return "seconds";
  if (/amount|revenue|value|price|discount|fee/.test(n)) return "currency";
  // suffix match — "share_clicked_applications" is a count, not a share
  if (/(^|_)(rate|ratio|pct|percent)$/.test(n) || /_rate_|success_rate/.test(n)) {
    if (scaledToPercent) return "percent";
    return max <= 1.05 ? "fraction" : "percent";
  }
  if (/^(n|count|users|sessions|rows|payers|uploads|events)/.test(n) || Number.isInteger(max))
    return "count";
  return "number";
}

/** Attach format hints to the chart and to every table column. */
function annotateFormats(insight: Narration, results: TaskResult[]): void {
  const columnsOf = (taskId: string) => {
    const r = results.find((x) => x.id === taskId);
    return r?.rows[0] ? Object.keys(r.rows[0]) : [];
  };
  const sqlOf = (taskId: string) => results.find((x) => x.id === taskId)?.sql ?? "";
  const known = new Set(results.map((r) => r.id));
  // With one surviving task there is only one thing a visual can be sourced from, so
  // repair a missing or wrong reference rather than discarding a usable chart.
  const onlyTask = results.length === 1 ? results[0]?.id : undefined;
  const { evidence } = insight;
  if (evidence.chart && !known.has(evidence.chart.sourceTask) && onlyTask)
    evidence.chart.sourceTask = onlyTask;
  if (evidence.segmentTable && !known.has(evidence.segmentTable.sourceTask) && onlyTask)
    evidence.segmentTable.sourceTask = onlyTask;
  // a chart or table pointing at a dropped task cannot be format-inferred, and
  // would cite results the reader cannot open — drop the visual instead
  if (evidence.chart && !known.has(evidence.chart.sourceTask)) evidence.chart = null;
  if (evidence.segmentTable && !known.has(evidence.segmentTable.sourceTask))
    evidence.segmentTable = null;
  if (evidence.chart) {
    const cols = columnsOf(evidence.chart.sourceTask);
    const valueCol =
      cols.find((c) => /rate|pct|percent|amount|latency|_ms|_pp/i.test(c)) ??
      cols.find((c) => !/^(os|device|platform|segment|label|country|city|month)/i.test(c)) ??
      evidence.title;
    evidence.chart.valueFormat = inferFormat(
      valueCol,
      evidence.chart.series.map((s) => s.value),
      sqlOf(evidence.chart.sourceTask),
    );
  }
  if (evidence.segmentTable) {
    const table = evidence.segmentTable;
    table.columnFormats = table.columns.map((col, i) => {
      const vals = table.rows.map((r) => Number(r[i])).filter((v) => Number.isFinite(v));
      return vals.length === 0 ? "text" : inferFormat(col, vals, sqlOf(table.sourceTask));
    });
  }
}

/**
 * Retry feedback the model can act on. A raw ZodError dump ("invalid_type",
 * "origin", nested paths) reads as noise, and three attempts were observed failing
 * on the same malformed field because none of them said which field, in words.
 */
function shapeFeedback(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issues = error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(top level)"} — ${i.message}`)
      .join("; ");
    return `Your JSON did not match the required shape: ${issues}. Re-read the "Output" section at the end and return exactly that structure, with every field it shows.`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The self-healing loop shared by the JSON-producing steps: run an attempt, and
 * when it throws feed a readable version of the error into the next attempt's
 * prompt. Exhaustion is the call site's decision — `onExhausted` throws for a
 * load-bearing step (plan) and returns a degraded value for an advisory one
 * (quality gate).
 */
export async function retryWithFeedback<T>(
  attempts: number,
  run: (feedback: string, attempt: number) => Promise<T>,
  onExhausted: (feedback: string) => T | Promise<T>,
): Promise<T> {
  let feedback = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run(feedback, attempt);
    } catch (error) {
      feedback = shapeFeedback(error);
    }
  }
  return onExhausted(feedback);
}

/**
 * Record a swallowed failure instead of discarding it.
 *
 * Four advisory paths here catch and return a default — a failed verification, a
 * failed related-insights query, a revision that could not be written, a cache
 * insert that did not land. Continuing is right (none of them changes whether
 * the answer is correct), but `catch {}` also meant nobody could ever see one:
 * the verification leg was returning null on prompt-render errors for an unknown
 * length of time. WARNING on the span, a `log` run event for the UI, and the run
 * carries on.
 */
function warn(ctx: Ctx, name: string, error: unknown): void {
  const message =
    error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
  ctx.event({ name, level: "WARNING", statusMessage: message.slice(0, 300) });
  emitRunEvent({ type: "log", name, payload: { warning: message.slice(0, 300) } });
}

/** One entry per column, keeping the WIDEST interval — that is the figure a reader
 * should be most careful with, so it is the one worth reporting.
 *
 * EXCEPT for a population column, where the widest is the wrong pick. Several
 * tasks answering one question emit the same column name at different grains:
 * a total, a breakdown by country, a breakdown by device, all called
 * `conversion_rate`. Keyed on the name alone, the 198-row country slice evicted
 * the 14,026-row total — so the answer's headline said 47.9% of 14,026 while
 * confidence was charged ±6.8pp for a figure bounded to ±0.8pp, and a verified,
 * fully-powered answer came back "medium". For those columns the entry that
 * matters is the one measured over the whole population: the largest n. */
function widestPerColumn(
  entries: Precision[],
  populationColumns: ReadonlySet<string> = new Set(),
): Precision[] {
  const byColumn = new Map<string, Precision>();
  for (const p of entries) {
    const prev = byColumn.get(p.column);
    if (!prev) {
      byColumn.set(p.column, p);
      continue;
    }
    const better = populationColumns.has(p.column)
      ? // bounded beats unbounded, then the larger sample
        (!!p.interval && !prev.interval) ||
        (!!p.interval === !!prev.interval && (p.n ?? 0) > (prev.n ?? 0))
      : (p.interval && prev.interval && p.interval.halfWidthPp > prev.interval.halfWidthPp) ||
        (!prev.interval && !!p.interval);
    if (better) byColumn.set(p.column, p);
  }
  return [...byColumn.values()];
}

// ── per-call budgets (pure) ──────────────────────────────────────

/**
 * What each call is allowed to spend, and whether it must return JSON.
 *
 * `max_tokens` is a CAP, not a reservation. An earlier round of this comment
 * claimed "on a thinking model the unused budget is spent, not saved" and sized
 * every call to its largest observed output, roughly doubled. That claim is
 * wrong, and measuring it settled the question: asked to reply with one word
 * under a 65,536-token cap, the model returns `completion_tokens: 1`. Nothing
 * is spent for headroom.
 *
 * Sizing to the visible answer cost a great deal. Across one four-question
 * walkthrough there were 13 truncations, every one of them a retry or a lost
 * check, while the largest SUCCESSFUL output of any call was 637 tokens — the
 * budgets were not being filled by answers, they were being filled by thinking
 * before the answer began. So these are now sized for reasoning plus output
 * with real headroom, and the ceiling to respect is the model's, not ours.
 *
 * `json` turns on the provider's JSON mode where it exists (Gemini), which
 * removes the fenced-prose failure that costs a retry.
 *
 * EVERY BUDGET MUST ALSO COVER REASONING/THINKING TOKENS. The first sizing was
 * measured against the Agent-SDK path, which ignores `maxTokens` altogether; on
 * the Anthropic API path (`output_config.effort`) and on Gemini, thinking tokens
 * are spent out of the SAME `max_tokens`, so a budget sized to the visible answer
 * truncates before the answer starts. What that cost: `quality` truncated twice
 * and the gate was silently replaced by an all-pass stub; `verify` truncated to
 * `agreed: null`, which pinned every answer at the 0.70 unverified ceiling and
 * made "high" confidence unreachable; a truncated `plan` is terminal. Size for
 * reasoning plus output, never output alone.
 *
 * `sql_*` is deliberately NOT json: it returns a bare SQL statement.
 * `context_lookup` returns a bare array and stays on the default.
 */
export const CALL_OPTIONS: Readonly<Record<string, CompleteOptions>> = Object.freeze({
  plan: { maxTokens: 16000, json: true },
  sql: { maxTokens: 16000 },
  verify: { maxTokens: 16000, json: true },
  narrate: { maxTokens: 32000, json: true },
  quality: { maxTokens: 12000, json: true },
  default: { maxTokens: 16000 },
});

/**
 * The budget for a named call. Names are per-task (`sql_t1`), so match on the
 * prefix. Exported for the bench and the tests; the injected `opts.llm`
 * signature is unchanged, which is what keeps every existing call site working.
 */
export function callOptions(name: string): CompleteOptions {
  if (name.startsWith("sql_")) return CALL_OPTIONS["sql"]!;
  return CALL_OPTIONS[name] ?? CALL_OPTIONS["default"]!;
}

// ── sanity gate (pure code) ──────────────────────────────────────

export interface SanityCounts {
  /** Rates above 105% — a definitional error, not noise. */
  impossible: number;
  /** "every sample size below 50" flags. */
  smallSample: number;
  /** Tasks the gate itself dropped (empty result, blocked query). */
  dropped: number;
}

export interface SanityGateResult {
  kept: TaskResult[];
  notes: string[];
  counts: SanityCounts;
}

/**
 * Did the queries find anything at all to talk about?
 *
 * A window with no events comes back as zero rows, or as a single row of zeros
 * and nulls from a COUNT over an empty set. Handed to the narrator that is not
 * an answer, it is a vacuum — and the model fills it. Measured on "conversion
 * rate over the last 30 days" against a dataset whose newest event is older
 * than that: the narrator reached back into the conversation for the PREVIOUS
 * turn's 6,715 and 14,026, failed the citation check three times, and the
 * question died with a parser error where the honest answer was one sentence.
 *
 * Zero is only "no evidence" when EVERY value is zero or null. A real 0%
 * against a real denominator still has a non-zero n, so it is a finding and
 * reaches the narrator as before.
 */
export function hasEvidence(results: TaskResult[]): boolean {
  for (const r of results) {
    for (const row of r.rows) {
      for (const v of Object.values(row)) {
        if (v === null || v === undefined || v === "") continue;
        const n = typeof v === "number" ? v : Number(v);
        // a non-numeric, non-empty cell (a country, a date) is something to report
        if (!Number.isFinite(n)) return true;
        if (n !== 0) return true;
      }
    }
  }
  return false;
}

/**
 * Drop what cannot be reported and classify what can, so confidence can weigh a
 * definitional error differently from a thin tail.
 *
 * Exported for the tests: `sanityFlags = notes.length` used to fold drops,
 * blocks and real flags into one number that was then double-counted against
 * the answer. The counts below are each incremented exactly once.
 */
export function sanityGate(results: TaskResult[]): SanityGateResult {
  const notes: string[] = [];
  const kept: TaskResult[] = [];
  const counts: SanityCounts = { impossible: 0, smallSample: 0, dropped: 0 };
  for (const r of results) {
    if (r.rows.length === 0) {
      r.dropped = "empty result set";
      counts.dropped++;
      notes.push(`task ${r.id} (${r.title}): dropped — empty result set`);
      continue;
    }
    // The SQL writer declares an impossible task instead of approximating it
    // (see analytics_write_sql). Honour that: drop the task and carry the reason
    // forward, rather than letting the sentinel row be read as data.
    const first = r.rows[0] as Record<string, unknown>;
    if (first && "blocked" in first) {
      const reason = String(first["reason"] ?? "not computable from the available columns");
      r.dropped = `not computable: ${reason}`;
      r.rows = [];
      counts.dropped++;
      notes.push(`task ${r.id} (${r.title}): the query could not be written — ${reason}`);
      continue;
    }
    // Guarded like the small-sample check below, and for the same reason: with a
    // digest the same question is answered over EVERY row rather than the fetched
    // ones, so letting both speak worded one finding two ways. `new Set` cannot
    // merge them — the wording differs — so a single bad value was classified
    // twice and cost 0.20 of confidence where the table says 0.10.
    if (!r.digest) {
      for (const row of r.rows) {
        for (const [col, v] of Object.entries(row)) {
          const n = Number(v);
          if (!Number.isFinite(n)) continue;
          // suffix match, not substring: "share_clicked_applications" is a count,
          // and matching "share" inside it flagged 1,601 as a rate above 100%
          if (/(^|_)(rate|ratio|pct|percent)$/i.test(col) && n > 1.05) {
            r.flags.push(`${col}=${n} looks like a rate above 100%`);
          }
        }
      }
    }
    // SUFFIX convention, as the SQL prompt mandates (`offer_shown_n`,
    // `applied_denominator`). The old prefix regex matched almost nothing a query
    // actually emits, so "every sample size below 50" essentially never fired.
    // A bare `_total` is NOT a sample size: `revenue_total`, `discount_total` and
    // `refund_total` are currency, and reading a ₹40 discount as a population of
    // 40 told the narrator the answer rested on nothing and took a real −0.10 off
    // the confidence of a correct answer.
    const sampleCols = r.rows.flatMap((row) =>
      Object.entries(row).filter(
        ([c]) => COUNT_RE.test(c) || /(^|_)(n|denominator|base)$/i.test(c),
      ),
    );
    // With a digest the same question is answered over every row instead of the
    // fetched ones, so let the stronger check speak rather than saying both.
    if (!r.digest && sampleCols.length > 0 && sampleCols.every(([, v]) => Number(v) < 50)) {
      r.flags.push("all sample sizes below 50 — low confidence");
    }
    if (r.digest) r.flags.push(...digestFlags(r.digest));
    r.flags = [...new Set(r.flags)];
    // Classify once, from the flag text — the digest and the per-row check word
    // the same finding differently, and confidence weighs the two kinds apart.
    for (const f of r.flags) {
      if (/above 100%/.test(f)) counts.impossible++;
      else if (/below 50/.test(f)) counts.smallSample++;
      notes.push(`task ${r.id} (${r.title}): flagged — ${f}`);
    }
    kept.push(r);
  }
  return { kept, notes, counts };
}

// ── main ─────────────────────────────────────────────────────────

/** Rows per task listed for the narrator. Beyond this the result is described by a
 * whole-set profile instead of more rows, so this bounds context cost without
 * bounding what the insight is based on. */
const NARRATION_ROWS = 24;
const MAX_SQL_ATTEMPTS = 3;
const MAX_NARRATE_ATTEMPTS = 3;
const MAX_PLAN_ATTEMPTS = 3;
/** Advisory only — exhaustion ships the answer unrevised, so a third call buys
 * nothing a second one didn't. */
const MAX_QUALITY_ATTEMPTS = 2;

/**
 * Profile the entire result set whenever it is larger than the narrator can read.
 *
 * Never throws. A task whose query worked and whose profile failed is still a
 * usable task — it degrades to today's behaviour (the listed rows, honestly
 * labelled as partial), and the note carries the reason into the narration and the
 * confidence calculation.
 */
async function attachDigest(parent: Ctx, r: TaskResult): Promise<TaskResult> {
  // One row is already its own population; anything more gets profiled.
  //
  // This used to skip every result of 24 rows or fewer, on the reasoning that
  // all its rows are shown so there is nothing left to summarise. But the digest
  // does not only summarise — it computes the WHOLE-POPULATION figure, and that
  // is not derivable from the shown rows: the citation checker allows a
  // difference or a ratio between two cited numbers, deliberately not a sum. So
  // "what is the standard checkout conversion rate?", planned as a four-row
  // breakdown by device, had no overall rate anywhere in its results. The
  // narrator reached for the one it had seen earlier in the conversation, the
  // citation check rejected it, and the question produced no answer. The same
  // gap left `headlineColumns` empty, so confidence scored a thin segment
  // instead of the population.
  if (r.rows.length <= 1) return r;
  // The SQL writer's "cannot compute" sentinel is a message, not a result set.
  if (r.rows[0] && "blocked" in r.rows[0]) return r;
  try {
    const digest = await profileResult(parent, {
      taskId: r.id,
      core: r.coreSql,
      authoredLimit: r.authoredLimit,
      rows: r.rows,
      // Every row is already in front of the reader; the extremes would repeat them.
      skipExtremes: r.rows.length <= NARRATION_ROWS,
    });
    return { ...r, digest, totalRows: digest.totalRows };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
    return {
      ...r,
      digestNote: `the full result set could not be profiled (${message}) — only the ${Math.min(r.rows.length, NARRATION_ROWS)} rows listed below are known`,
    };
  }
}

export interface AnalyticsInput {
  question: string;
  /** Force a fresh run, bypassing the answer cache. */
  noCache?: boolean;
  /** The conversation this question belongs to. Scopes BOTH the answer cache and
   * the related-insights lookup: without it a question can neither read nor
   * surface another conversation's answers. Omitted by scripts and the bench,
   * which then get an unscoped key and no related insights. */
  convId?: string;
  /** Recent conversation turns for follow-up questions (oldest first). */
  history?: Array<{
    role: "user" | "agent";
    text: string;
    figures?: string;
    sqlContext?: string;
    /** The actual SQL queries from the most recent agent turn — lets the SQL
     *  writer extend or refine them instead of writing from scratch. */
    priorSql?: Array<{ task: string; title: string; query: string }>;
    /** Tasks that were planned but could not be executed — the planner should
     *  avoid repeating the same impossible task on follow-ups. */
    droppedTasks?: string[];
  }>;
}

export interface RunAnalyticsOptions {
  trace: Ctx;
  llm?: (parent: Ctx, name: string, prompt: string) => Promise<string>;
}

export async function runAnalytics(
  input: AnalyticsInput,
  opts: RunAnalyticsOptions,
): Promise<Insight> {
  // Per-call budgets + JSON mode, keyed by the call name the pipeline already
  // passes. Injecting `opts.llm` (tests, scripts) overrides the lot, so its
  // signature stays exactly as it was.
  const llm =
    opts.llm ??
    ((parent: Ctx, name: string, prompt: string) =>
      complete(parent, name, prompt, callOptions(name)));
  const convId = input.convId ?? "";
  // Read once per run: every task's cap is then decided the same way, even if
  // the environment is edited mid-run.
  const orderByAll = flagOn("orderByAll");

  // Self-attributing: tagging here rather than at the call site means every
  // query this agent runs is labelled "analytics" in system.query_log (and so on
  // the Observe screen) no matter which route ends up invoking it.
  return withQueryContext({ agent: "analytics" }, () =>
   step(opts.trace, "analytics", { question: input.question }, async (span) => {
    // ── context (read-only) ──
    const { bundle, sqlRulesMarkdown, verifyDefinitions, schemas, contextVersion, contextKey, dataKey } =
      await step(
      span,
      "context_load",
      {},
      async () => {
        // The data stamp gates the SCHEMAS ONLY — they are cached against it, so a
        // load or an optimizer ALTER moves the stamp and re-reads system.columns.
        // Nothing else waits on it: awaiting it up front put its round trip in
        // front of every question, including a cache hit that needed neither.
        const dataP = dataVersion();
        const [b, data, schemas, verifyBundle] = await Promise.all([
          // metrics/conventions/known-issues in full (they define correctness);
          // everything the planner only needs to know EXISTS goes in brief —
          // `schemas` already carries the exact columns, and the plan prompt was
          // paying ~2k tokens to read the same table docs twice.
          getContext({
            include: ["*"],
            brief: ["table", "spec", "overview", "entity", "known_issue", "guide"],
            require: ["convention:data_hygiene", "metric"],
          }),
          dataP,
          dataP.then((d) => tableSchemas(d.key)),
          // The auditor needs the rules that decide whether a figure MEANS what it
          // claims — conventions, the join map, the metric definitions — not the
          // whole store. `latestEntries()` is cached, so this is CPU only.
          getContext({
            core: ["convention", "join_map"],
            include: ["metric"],
          }),
        ]);
        // Conventions, join maps AND metric definitions — extracted from the
        // already-fetched bundle instead of a second getContext round-trip.
        //
        // Metrics were excluded here as a prompt-size saving, which meant we
        // audited the SQL writer against rules we had withheld from it. The
        // independent auditor is given the metric definitions
        // (`verifyDefinitions` below) and it used them: every answer in a live
        // run came back carrying "the SQL uses user_id instead of
        // application_id, which contradicts the metric definition" — a real
        // wrong number, since one user with two applications is counted once
        // instead of twice, and a standing 0.10 off the confidence of a query
        // that had never been shown the rule it was breaking.
        const sqlRulesMarkdown = b.entries
          .filter((e) => {
            const cat = e.entity.split(":")[0] ?? "";
            return cat === "convention" || cat === "join_map" || cat === "metric";
          })
          .map((e) => e.definition_md)
          .join("\n\n");
        // A digest over every (entity, version) pair — the entity count and the
        // global max both miss a revision that lands below the current max, which
        // would serve a stale answer after a context write.
        const versionDigest = createHash("sha1")
          .update(b.entries.map((e) => `${e.entity}@${e.version}`).sort().join("|"))
          .digest("hex")
          .slice(0, 10);
        // An empty store makes `Math.max()` return -Infinity, which rendered as
        // `0 entities · max v-Infinity` in the UI and in the trace.
        const maxV = b.entries.length ? Math.max(...b.entries.map((e) => e.version)) : 0;
        return {
          bundle: b,
          sqlRulesMarkdown,
          verifyDefinitions: verifyBundle.markdown,
          schemas,
          contextVersion: `${b.entries.length} entities · max v${maxV}`,
          // Definitions AND data: a cached answer is a replay only while both
          // are unchanged.
          contextKey: `${versionDigest}:${data.key}`,
          dataKey: data.key,
        };
      },
    );

    const historyDigest = input.history?.length
      ? sha1(input.history.map((h) => `${h.role}:${h.text}`).join("|")).slice(0, 10)
      : "";

    // ── related insights, from EARLIER IN THIS CONVERSATION ──
    // What this used to do: an unbounded ILIKE over the whole insight_cache,
    // pulling up to 3 headlines from ANY conversation (including deleted ones)
    // into the narrator's prompt. Two costs: a PM's answer quietly shaped by a
    // colleague's unrelated question, and a cache key that did not cover the
    // text, so the same question drifted as the cache grew.
    //
    // Both are fixed rather than the feature removed: the query is scoped to
    // this conversation by conv_id, and the text is hashed into the cache key
    // below, so a replay can never disagree with the text that produced it.
    // Computed BEFORE the lookup for exactly that reason.
    const relatedContext = await (async (): Promise<string> => {
      // Nothing to relate to: no conversation (a script or the bench), the
      // conversation's first question, or the feature switched off.
      if (!flagOn("relatedInsights") || convId === "" || !input.history?.length) return "";
      return step(span, "related_insights", { convId }, async (relSpan) => {
        try {
          const terms = input.question
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length > 3)
            .slice(0, 5);
          if (terms.length === 0) return "";
          const likeClause = terms.map((_, i) => `question ILIKE {t${i}:String}`).join(" OR ");
          const params: Record<string, string> = { conv: convId, q: input.question };
          terms.forEach((t, i) => (params[`t${i}`] = `%${t}%`));
          const rows = await query<{ question: string; insight_json: string }>(
            `SELECT question, insight_json FROM insight_cache
             WHERE conv_id = {conv:String} AND question != {q:String} AND (${likeClause})
             ORDER BY created_at DESC LIMIT 3`,
            params,
          );
          if (rows.length === 0) return "";
          const summaries = rows
            .map((r) => {
              try {
                const ins = JSON.parse(r.insight_json) as Insight;
                return `- "${r.question}" → ${ins.headline}`;
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          return summaries.length
            ? `\n## Related insights from earlier in this conversation\n${summaries.join("\n")}`
            : "";
        } catch (error) {
          // Advisory context: an answer is complete without it, but a silent
          // empty string hid a broken query for the life of the feature.
          warn(relSpan, "related_insights_failed", error);
          return "";
        }
      });
    })();

    // Cache hit → milliseconds. The key now covers everything an answer depends
    // on: the question, the conversation and its turns so far, the definitions
    // in force, the data version, and the related text the narrator was shown.
    const key = cacheKey({
      question: input.question,
      contextKey,
      convId,
      historyDigest,
      relatedDigest: relatedContext ? sha1(relatedContext).slice(0, 10) : "",
    });
    if (!input.noCache) {
      const cached = await step(span, "cache_lookup", { key }, () => readCache(key));
      if (cached) {
        scoreRun(span, "cache_hit", 1, "served from insight_cache");
        return { ...cached, cached: true };
      }
    }

    // ── Fix 5: Smart history compression ──
    // Recent turns (last 4) get full detail; older turns compress to headline
    // + figures only. This expands the effective window from 6 to 12 turns
    // without bloating the prompt.
    const historyText = (() => {
      if (!input.history?.length) return "(none)";
      const all = input.history;
      const recent = all.slice(-4);
      const older = all.slice(0, -4).slice(-8); // up to 8 older turns, compressed
      const compress = (h: typeof all[0]) =>
        `${h.role}: ${h.text}${h.figures ? ` [${h.figures}]` : ""}`;
      const expand = (h: typeof all[0]) => {
        let line = `${h.role}: ${h.text}`;
        if (h.figures) line += `\n    already reported: ${h.figures}`;
        if (h.sqlContext) line += `\n    prior approach: ${h.sqlContext}`;
        if (h.droppedTasks?.length)
          line += `\n    failed tasks: ${h.droppedTasks.join("; ")}`;
        return line;
      };
      const parts: string[] = [];
      if (older.length) {
        parts.push("(earlier turns, compressed)");
        parts.push(...older.map(compress));
        parts.push("(recent turns, full detail)");
      }
      parts.push(...recent.map(expand));
      return parts.join("\n");
    })();

    // ── pre-planning knowledge lookup (term-match, no LLM) ──
    // Surface known issues and metric definitions relevant to the question BEFORE
    // planning, so the planner can account for data quirks and use the right
    // definitions. This is a fast term-match, not the LLM lookup that runs later.
    const prePlanKnowledge = await step(span, "pre_plan_lookup", {}, async () => {
      const preBundle = await getContext({ topic: input.question });
      const relevant = preBundle.entries
        .filter((e) => {
          const cat = e.entity.split(":")[0] ?? "";
          return cat === "known_issue" || cat === "metric" || cat === "funnel";
        })
        .map((e) => `${e.entity}: ${e.definition_md.split("\n")[0]?.slice(0, 200)}`)
        .slice(0, 6);
      return relevant.length
        ? `\n## Relevant known issues and definitions for this question\n${relevant.join("\n")}`
        : "";
    });

    // ── plan ──
    // Planning needs to distinguish dimensions from metrics and spot time
    // columns. Replace verbose types with short tags: DateTime→[time],
    // LowCardinality(String)→[dim], numeric types→[num], keep the rest as-is
    // for anything unusual. Saves ~40% of schema tokens while preserving the
    // information the planner actually uses to choose tables and dimensions.
    const planSchemas = [...schemas.values()]
      .map((line) => line
        .replace(/ DateTime64?\(\d\)/g, " [time]")
        .replace(/ LowCardinality\(String\)/g, " [dim]")
        .replace(/ (UInt\d+|Int\d+|Float\d+)/g, " [num]")
        .replace(/ Nullable\(([^)]+)\)/g, (_, inner) => ` [${/Int|UInt|Float/.test(inner) ? "num?" : "str?"}]`)
        .replace(/ String(,|$)/g, " [str]$1")
        .replace(/ UUID(,|$)/g, " [id]$1"))
      .join("\n");
    const plan: Plan = await retryWithFeedback(
      MAX_PLAN_ATTEMPTS,
      (planFeedback, attempt) =>
        step(span, `plan_attempt_${attempt}`, { feedback: planFeedback }, async (planSpan) => {
          const prompt = await loadPrompt("analytics_plan_tasks", {
            knowledge: bundle.markdown + prePlanKnowledge,
            schemas: planSchemas,
            history: historyText,
            question: input.question,
            feedback: planFeedback
              ? `\n# Feedback on your previous attempt — fix this\n${planFeedback}\n`
              : "",
          });
          const text = await llm(planSpan, "plan", prompt);
          const raw: unknown = JSON.parse(stripFences(text));
          const parsedPlan = PlanSchema.parse(raw);
          // `.catch([])` above cannot throw, so a shape we could not read would
          // otherwise vanish without trace. Say so in the trace instead.
          const rawAssumptions = (raw as { assumptions?: unknown })?.assumptions;
          if (rawAssumptions != null && parsedPlan.assumptions.length === 0) {
            warn(
              planSpan,
              "plan_assumptions_unreadable",
              `planner sent assumptions as ${typeof rawAssumptions} — dropped, so the answer is scored as if the question pinned everything down`,
            );
          }
          return parsedPlan;
        }),
      (planFeedback) => {
        // Everything downstream needs a plan — this failure is terminal.
        throw new Error(`planning failed schema checks ${MAX_PLAN_ATTEMPTS} times: ${planFeedback}`);
      },
    );

    // Surface the plan interpretation so the PM can catch a wrong reading
    // before waiting for SQL results. The chat UI renders this as a brief
    // "Approach: ..." line before the "Querying ClickHouse" phase.
    emitRunEvent({
      type: "log",
      name: "plan_summary",
      payload: {
        approach: plan.approach,
        tasks: plan.tasks.map((t) => t.title),
        tables: [...new Set(plan.tasks.flatMap((t) => t.tables))],
        // What the question left open and the planner had to choose. Each one
        // costs confidence, so showing them here is showing the PM exactly what
        // to pin down to raise it.
        assumptions: plan.assumptions,
      },
    });

    if (plan.tasks.length === 0) {
      // unanswerable — suggest related questions from the available schemas
      const availableTables = [...schemas.keys()];
      const suggestions = availableTables.slice(0, 5).map((t) => {
        const cols = schemas.get(t) ?? "";
        const hasRate = /rate|pct|percent/i.test(cols);
        const hasDim = /os|country|device|platform/i.test(cols);
        if (hasRate && hasDim) return `What is the conversion rate by platform for ${t} events?`;
        if (hasRate) return `What is the overall rate for ${t}?`;
        return `How many ${t} events are there by day?`;
      });
      return {
        headline: `This can't be answered from the current tables: ${plan.approach}`,
        whatsHappening: plan.approach,
        whyItHappens:
          "No table in the context store carries the fields this question needs, so there is nothing to measure — this is a gap in what has been instrumented, not a finding about the product.",
        evidence: { title: "", chart: null, segmentTable: null },
        groundedInContext: "",
        recommendedAction: suggestions.length
          ? `Instrument the events this question needs, or ask something the current tables can answer: ${suggestions.slice(0, 3).join(" · ")}`
          : "Instrument the events this question needs before asking it again.",
        confidence: {
          value: "low",
          score: 0.05,
          note: "no queryable data for this question",
          signals: [],
        },
        precision: [],
        verification: null,
        contextVersion,
        sql: [],
      };
    }

    // ── SQL per task, guarded + self-healing ──
    // Tasks are independent → generate + execute them CONCURRENTLY. Wall clock
    // becomes the slowest single task instead of their sum.

    // Prior SQL from the last agent turn — the SQL writer can reference or adapt
    // these instead of writing from scratch, which keeps filters, denominators
    // and table choices consistent across follow-ups.
    const lastAgentTurn = input.history?.filter((h) => h.role === "agent").at(-1);
    const priorSqlText = lastAgentTurn?.priorSql?.length
      ? lastAgentTurn.priorSql
          .map((s) => `-- ${s.task}: ${s.title}\n${s.query}`)
          .join("\n\n")
      : "";

    let sqlAttemptsTotal = 0;
    const completedResults = new Map<string, TaskResult>();

    /** Execute one task with self-healing retries. */
    const executeTask = (task: Plan["tasks"][0], depContext: string) =>
      step(span, `task_${task.id}`, { title: task.title }, async (taskSpan) => {
        let feedback = "";
        let lastTransient = "";
        for (let attempt = 1; attempt <= MAX_SQL_ATTEMPTS; attempt++) {
          sqlAttemptsTotal++;
          try {
            const executed = await step(
              taskSpan,
              `sql_attempt_${attempt}`,
              { task: task.title, feedback },
              async (sqlSpan) => {
                const prompt = await loadPrompt("analytics_write_sql", {
                  context: sqlRulesMarkdown,
                  schemas: schemaSubset(schemas, task.tables),
                  task: JSON.stringify(task),
                  prior_sql: (priorSqlText || depContext)
                    ? `\n<prior_sql>\n${depContext ? `Results from earlier tasks in this plan that this task builds on:\n${depContext}\n\n` : ""}${priorSqlText ? `Queries from the previous answer in this conversation. Reuse their tables,\nfilters and denominator logic where the task overlaps — consistency across\nturns matters more than a novel approach.\n${priorSqlText}` : ""}\n</prior_sql>\n`
                    : "",
                  feedback: feedback
                    ? `\n# Feedback on your previous attempt — fix this\n${feedback}\n`
                    : "",
                });
                const parts = guardSqlParts(await llm(sqlSpan, `sql_${task.id}`, prompt));
                const sql = capForFetch(parts, orderByAll);
                const rows = await queryReadonly(sql);
                recordQuery(sqlSpan, `result_${task.id}`, sql, rows);
                return {
                  id: task.id,
                  title: task.title,
                  sql,
                  semanticSql: parts.validated,
                  coreSql: parts.core,
                  authoredLimit: parts.authoredLimit,
                  rows,
                  totalRows: rows.length,
                  digest: null,
                  digestNote: "",
                  flags: [],
                } as TaskResult;
              },
            );
            const result = await attachDigest(taskSpan, executed);
            completedResults.set(task.id, result);
            return result;
          } catch (error) {
            if (isTransientDbError(error)) {
              feedback = "";
              lastTransient = error instanceof Error ? error.message : String(error);
              await new Promise((r) => setTimeout(r, 1000 * attempt));
              continue;
            }
            feedback = `Your SQL failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
          const failed: TaskResult = {
            id: task.id,
            title: task.title,
            sql: "",
            semanticSql: "",
            coreSql: "",
            authoredLimit: null,
            rows: [],
            totalRows: 0,
            digest: null,
            digestNote: "",
            flags: [],
            dropped: `gave up after ${MAX_SQL_ATTEMPTS} attempts: ${feedback || lastTransient || "unknown error"}`,
          };
          completedResults.set(task.id, failed);
          return failed;
        });

    // Split tasks: independent ones run in parallel, dependent ones run after
    // their dependency completes so they can reference its results.
    const independent = plan.tasks.filter((t) => !t.depends_on);
    const dependent = plan.tasks.filter((t) => t.depends_on);

    const results: TaskResult[] = await Promise.all(
      independent.map((task) => executeTask(task, "")),
    );

    // Dependent tasks run sequentially, each receiving a summary of its
    // dependency's result so the SQL writer can reference concrete counts.
    for (const task of dependent) {
      const dep = completedResults.get(task.depends_on!);
      const depContext = dep && dep.rows.length > 0
        ? `-- ${dep.id} (${dep.title}) returned ${dep.totalRows} rows. First row: ${JSON.stringify(dep.rows[0])}`
        : "";
      results.push(await executeTask(task, depContext));
    }

    // ── sanity gate ──
    // `sqlFailed` is captured BEFORE the gate runs: the gate sets `dropped` on
    // the tasks it drops itself, so reading `results.filter(r => r.dropped)`
    // afterwards counted those a second time — every gate-dropped task was
    // deducted for twice, and appeared twice in the note list.
    const sqlFailed = results.filter((r) => r.dropped);
    const { kept, notes, counts } = await step(span, "sanity_gate", {}, async () =>
      sanityGate(results.filter((r) => !r.dropped)),
    );
    const sanityNotes = [...notes, ...sqlFailed.map((r) => `task ${r.id}: ${r.dropped}`)];
    const droppedCount = counts.dropped + sqlFailed.length;

    // ── nothing to narrate ──
    // Every query ran and every one came back empty. Say that, rather than
    // spending three narration calls discovering the model cannot cite figures
    // that do not exist. See `hasEvidence`.
    if (!hasEvidence(kept)) {
      const ran = kept.length;
      const why =
        ran === 0
          ? "No query survived the sanity checks, so there is nothing to measure."
          : `${ran === 1 ? "The query" : `All ${ran} queries`} ran against ClickHouse and matched no rows — the filters in this question select an empty set.`;
      emitRunEvent({
        type: "log",
        name: "empty_result",
        payload: { tasks: ran, assumptions: plan.assumptions },
      });
      return {
        headline: "No data matches this question.",
        whatsHappening: why,
        whyItHappens: plan.assumptions.length
          ? `The window and filters were not fully specified, so the plan assumed: ${plan.assumptions.join("; ")}. One of those assumptions selects a range the data does not cover — the most common cause is a relative window (\u201clast N days\u201d) that ends before the newest event in the table.`
          : "The filters in this question select no rows. Either the events have not been instrumented for this period, or the segment genuinely has no activity.",
        evidence: { title: "", chart: null, segmentTable: null },
        groundedInContext: "",
        recommendedAction:
          "Widen the window or drop a filter and ask again — or check the table's newest event before choosing a relative window.",
        confidence: {
          value: "low",
          score: 0.05,
          note: "no rows matched — nothing to be confident about",
          signals: [],
        },
        precision: [],
        verification: null,
        contextVersion,
        sql: kept.map((r) => ({
          task: r.id,
          title: r.title,
          query: r.sql,
          rowCount: r.rows.length,
        })),
      };
    }

    // ── independent verification (started here, awaited after narration) ──
    // One task only: the cost is a full LLM call plus a query, and the figure a
    // reader acts on is the headline one. Skipped when nothing usable survived.
    //
    // Deliberately NOT awaited yet. Nothing between here and the narration reads the
    // verdict — it feeds deriveConfidence and the payload, both after the narration —
    // so awaiting it here just parked the lookup, precision and narration behind an
    // LLM call and a query they do not depend on. Every check still runs, on the same
    // inputs, in the same order relative to what it actually gates; only the waiting
    // overlaps. (Per-step elapsed times now overlap, which is why API.md says never to
    // sum them for a total.)
    // Verify the task most likely to produce the headline figure: prefer tasks
    // with rate columns (the headline is almost always a rate), then by row count.
    // The first task with rows was often the wrong one when the main result was t2.
    const toVerify = [...kept]
      .filter((r) => r.rows.length > 0)
      .sort((a, b) => {
        const rateCount = (r: TaskResult) =>
          r.rows[0] ? Object.keys(r.rows[0]).filter((c) => RATE_RE.test(c)).length : 0;
        const ra = rateCount(a), rb = rateCount(b);
        if (ra !== rb) return rb - ra; // prefer tasks with rate columns
        return b.totalRows - a.totalRows; // then by coverage
      })[0] ?? null;
    const verificationPromise: Promise<VerificationResult | null> = toVerify
      ? verifyTask(
          span,
          {
            question: input.question,
            taskTitle: toVerify.title,
            taskQuestion: plan.tasks.find((t) => t.id === toVerify.id)?.question ?? toVerify.title,
            sql: toVerify.semanticSql,
            rows: toVerify.rows as Record<string, unknown>[],
            // Whole-set figures are the ones a reader acts on, so they are what an
            // independently written query should have to reproduce.
            digest: toVerify.digest
              ? renderDigest(toVerify.digest)
              : "(none — this result was small enough to be shown in full)",
            ...(toVerify.digest ? { digestRow: toVerify.digest.statsRow } : {}),
            // Conventions + join map + metric definitions, not the whole store:
            // the auditor decides whether a figure means what it claims, and the
            // table docs it was also being sent are already in `schemas`.
            definitions: verifyDefinitions,
            schemas: schemaSubset(schemas, plan.tasks.find((t) => t.id === toVerify.id)?.tables ?? []),
          },
          guardSql,
          llm,
        ).catch((error: unknown) => {
          warn(span, "verification_failed_to_run", error);
          return null;
        })
      : Promise.resolve(null);

    // ── knowledge lookup + precision ──
    // Both are independent: lookupContext is a retrieval call, precision is pure
    // math. (Related insights ran earlier — its text is in the cache key.)
    //
    // The topic is what the analysis is ABOUT: the question, what the tasks set
    // out to measure, and the columns the results came back with. It used to be
    // `JSON.stringify(rows)` of three rows per task — up to 1.5k characters of
    // values, which are data, not topic: retrieval matched on city names and
    // timestamps, and on the LLM path they were pure prompt cost.
    const lookupTopic = [
      input.question,
      ...kept.map((r) => r.title),
      ...new Set(kept.flatMap((r) => (r.rows[0] ? Object.keys(r.rows[0]) : []))),
    ]
      .join("\n")
      .slice(0, 1500);

    const [lookup, { precision, allPrecision, headlineColumns }] = await Promise.all([
      lookupContext(span, lookupTopic, opts.llm),
      step(span, "precision", {}, async () => {
        // What the answer's main claims rest on: the listed rows and, when the result
        // was profiled, the whole-population figure.
        const headline: Precision[] = [];
        const headlineColumns: string[] = [];
        // The extreme rows. Real, and worth reporting — but by construction they
        // include the smallest segments in the result, so letting them decide overall
        // confidence would mark every large answer "low" because some tail row has n=2.
        const tails: Precision[] = [];
        for (const r of kept) {
          for (const row of r.rows.slice(0, NARRATION_ROWS)) {
            headline.push(...precisionForRow(row as Record<string, unknown>, r.semanticSql));
          }
          if (!r.digest) {
            // A task returning exactly one row has no segments to profile, so no
            // digest ran — but that row IS the whole population, and its rates
            // are headline figures. Without this, a question answered by a
            // single total left `headlineColumns` empty and confidence fell back
            // to whichever same-named segment row happened to survive the merge.
            const only = r.totalRows === 1 ? r.rows[0] : undefined;
            if (only) headlineColumns.push(...Object.keys(only).filter((c) => RATE_RE.test(c)));
            continue;
          }
          const population = populationRow(r.digest);
          headline.push(...precisionForRow(population, r.digest.sql));
          headlineColumns.push(...Object.keys(population).filter((c) => RATE_RE.test(c)));
          for (const row of [
            ...(r.digest.extremes?.top ?? []),
            ...(r.digest.extremes?.bottom ?? []),
          ]) {
            tails.push(...precisionForRow(row, r.semanticSql));
          }
        }
        const populationColumns = new Set(headlineColumns);
        return {
          // Every measurement, for the score. `pickHeadline` needs the
          // whole-population row of a column even when a thinner row of the same
          // name is the one worth displaying, and `small_segments` needs to see
          // every thin row rather than the one survivor of a per-name merge.
          allPrecision: [...headline, ...tails],
          precision: widestPerColumn([...headline, ...tails], populationColumns),
          // The population rates — the figures an answer's headline is actually
          // built on. Confidence picks its headline from these, so one tail row
          // with n=2 can no longer decide the level for the whole answer.
          headlineColumns: [...populationColumns],
        };
      }),
    ]);

    const precisionText =
      precision.length === 0
        ? "(no rate or average figures in these results)"
        : precision
            .map((p) =>
              p.interval
                ? `${p.column} = ${p.value} — 95% CI [${p.interval.lo.toFixed(4)}, ${p.interval.hi.toFixed(4)}] (±${p.interval.halfWidthPp.toFixed(1)}pp, n=${p.n})`
                : `${p.column} = ${p.value} — precision NOT computable: ${p.note}`,
            )
            .join("\n");

    // ── narrate → citation check → (maybe) quality revision ──
    const resultsText = kept
      .map((r) => {
        const flags = r.flags.length ? `; flags: ${r.flags.join("; ")}` : "";
        const shown = r.rows.slice(0, NARRATION_ROWS);
        const scope = r.digest
          ? `${r.totalRows} rows in total — the profile below was computed over ALL of them`
          : `${r.rows.length} rows`;
        const parts = [`### ${r.id} — ${r.title} (${scope}${flags})`, `SQL: ${r.semanticSql}`];
        if (r.digest) {
          parts.push(renderDigest(r.digest));
          parts.push(
            `sample rows (the first ${shown.length} of ${r.totalRows} in query order — illustrative only, NOT the population): ${JSON.stringify(shown)}`,
          );
        } else {
          parts.push(`rows: ${JSON.stringify(shown)}`);
          if (r.rows.length > NARRATION_ROWS) {
            parts.push(
              `(+${r.rows.length - NARRATION_ROWS} more rows not shown — do not infer beyond what is listed)`,
            );
          }
          if (r.digestNote) parts.push(`(${r.digestNote})`);
        }
        return parts.join("\n");
      })
      .join("\n\n");
    // What the queries ACTUALLY did, read off the executed SQL. The citation
    // checker guards numbers; without this the narrator would assert methodology
    // (e.g. "hygiene filters applied") that may not be true of the query that ran.
    const methodNotes = kept
      .map((r) => {
        const bits: string[] = [];
        // Only state what can be checked from the SQL itself. Whether the columns
        // exist is a separate fact we are not verifying here, so do not claim it.
        bits.push(
          /\bduplicate_id\b/i.test(r.semanticSql)
            ? "hygiene filters applied (duplicate_id / is_back_filled)"
            : "no hygiene filters were applied in this query",
        );
        if (/if\s*\(\s*os\s+IS\s+NULL|multiIf\s*\(\s*\(?\s*os\s+IS\s+NULL/i.test(r.sql))
          bits.push("empty/NULL os bucketed as 'unknown'");
        if (/group by[\s\S]*currency/i.test(r.sql)) bits.push("grouped by currency");
        return `${r.id}: ${bits.join("; ")}`;
      })
      .join("\n");

    const pool = [
      ...numericPool(kept, NARRATION_ROWS),
      // numbers the agent was shown in the gate notes are citable too
      ...sanityNotes
        .join(" ")
        .match(/-?\d[\d,]*(?:\.\d+)?/g)
        ?.map((n) => Number(n.replaceAll(",", "")))
        .filter((n) => Number.isFinite(n)) ?? [],
      // The precision block is shown to the narrator and the prompt instructs it to
      // caveat with THESE bounds — so the checker has to accept them, or obeying the
      // instruction costs a retry and drops confidence. They are computed in code
      // from the query results, the same standing as the gate notes above.
      ...precision
        .flatMap((p) => [
          p.value,
          p.n,
          ...(p.interval
            ? [
                p.interval.lo,
                p.interval.hi,
                p.interval.halfWidthPp,
                p.interval.lo * 100,
                p.interval.hi * 100,
              ]
            : []),
        ])
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n)),
    ];
    const datePool = collectDateLiterals(kept, NARRATION_ROWS);
    // The asker's own numbers. A question that names a window ("last 30 days")
    // or a threshold gets it echoed back in the prose, and the citation guard
    // read that as a figure invented about the data.
    const askedNumbers = [
      ...numbersIn(input.question),
      ...plan.assumptions.flatMap((a) => numbersIn(a)),
    ];

    let narration: Narration | null = null;
    let citationFailures = 0;
    let feedback = "";
    let uncitedAtEnd: string[] = [];
    for (let attempt = 1; attempt <= MAX_NARRATE_ATTEMPTS; attempt++) {
      try {
        narration = await step(
          span,
          `narrate_attempt_${attempt}`,
          { feedback },
          async (nSpan) => {
            const prompt = await loadPrompt("analytics_narrate_insight", {
              question: input.question,
              plan: plan.approach,
              results: resultsText || "(all tasks failed — say so honestly)",
              sanity: sanityNotes.join("\n") || "(clean)",
              method: methodNotes || "(no queries succeeded)",
              precision: precisionText,
              lookup: (lookup.markdown || "(nothing relevant retrieved)") + relatedContext,
              context_version: contextVersion,
              history: input.history?.length ? `\n# Conversation so far\n${historyText}\n` : "",
              feedback: feedback
                ? `\n# Feedback on your previous attempt — fix this\n${feedback}\n`
                : "",
            });
            const text = await llm(nSpan, "narrate", prompt);
            const parsed = NarrationSchema.parse(JSON.parse(stripFences(text)));

            // Every prose section is held to the citation rule, not just the
            // headline — an invented number in a recommendation is the most
            // expensive kind there is.
            const texts = [
              ...narrativeTexts(parsed),
              ...(parsed.evidence.chart?.series.map((s) => String(s.value)) ?? []),
              ...(parsed.evidence.segmentTable?.rows.flat().map(String) ?? []),
            ];
            const uncited = findUncitedNumbers(texts, pool, datePool, askedNumbers);
            if (uncited.length > 0) {
              citationFailures++;
              uncitedAtEnd = uncited;
              throw new Error(
                `these numbers are not in the SQL results and are not a difference/ratio of two numbers that are: ${uncited.join(", ")}. ` +
                  `Rewrite using only values present in the results (or a difference/ratio of two such values), or describe the comparison in words instead of a figure.`,
              );
            }
            return parsed;
          },
        );
        break;
      } catch (error) {
        feedback = shapeFeedback(error);
        if (attempt === MAX_NARRATE_ATTEMPTS) {
          warn(span, "narration_uncitable", feedback);
        }
      }
    }

    // ── the summary could not be written, but the analysis still ran ──
    // Throwing here lost the whole turn to an error toast, discarding queries
    // that had already executed and verified. The usual cause is the narrator
    // quoting a figure from an EARLIER turn of the conversation, which is not
    // evidence for this one (see rule 1f of the narration prompt); the guard is
    // right to reject it, but the PM should still get the queries, the rows and
    // the intervals rather than nothing at all.
    if (!narration) {
      await verificationPromise;
      const uncitedList = uncitedAtEnd.length > 0 ? uncitedAtEnd.join(", ") : "none recorded";
      return {
        headline: "The queries ran, but the summary could not be written.",
        whatsHappening: `${kept.length} quer${kept.length === 1 ? "y" : "ies"} executed and returned rows — the evidence below is real and is what the SQL produced. Only the prose around it failed.`,
        whyItHappens:
          `Every number in an answer has to appear in that answer's own query results. ` +
          `Three attempts each carried a figure that did not: ${uncitedList}. ` +
          `The most common cause is a number quoted from an earlier turn of this conversation, which measured a different window or population.`,
        evidence: { title: "", chart: null, segmentTable: null },
        groundedInContext: "",
        recommendedAction:
          "Ask the question again on its own, without relying on the previous turn — or read the queries and rows below directly.",
        confidence: {
          value: "low",
          score: 0.05,
          note: "no narration passed the citation check",
          signals: [],
        },
        precision,
        verification: null,
        contextVersion,
        sql: kept.map((r) => ({
          task: r.id,
          title: r.title,
          query: r.sql,
          rowCount: r.rows.length,
        })),
      };
    }

    // the verification started before the lookup has had the whole narration to finish in
    const verification = await verificationPromise;

    // Computed, never asked of the model: every input below is a measurement.
    // Its own step so the trace shows the inputs beside the score they produced.
    const confidence = await step(
      span,
      "confidence",
      { headlineColumns, assumptions: plan.assumptions },
      async () => {
        const confidenceInput: ConfidenceInput = {
          precisions: allPrecision,
          headlineColumns,
          verifiedColumn: verification?.expectedToMatch || null,
          verification: verification
            ? {
                agreed: verification.agreed,
                relativeDelta: verification.relativeDelta,
                definitionOk: verification.definitionOk,
                concern: verification.concern,
                note: verification.note,
              }
            : null,
          impossibleFlags: counts.impossible,
          smallSampleFlags: counts.smallSample,
          droppedTasks: droppedCount,
          plannedTasks: plan.tasks.length,
          citationRetries: citationFailures,
          // Only what the question left open. An assumption the asker already
          // stated is not a gap, and charging for it made a fully-specified
          // question score lower than a vague one.
          assumptions: unstatedAssumptions(input.question, plan.assumptions),
          namedMetrics: namedMetrics(input.question, bundle.entries.map((e) => e.entity)),
        };
        return deriveConfidence(confidenceInput);
      },
    );

    // ── quality gate ──
    // Skip the LLM call when deterministic checks already cover the rubric.
    // Most of the rubric is verifiable in code:
    //   cites_numbers — guaranteed by the citation checker above
    //   honest_confidence — confidence is computed by code, not the model
    //   links_known_issue — true when no anomaly, or when groundedInContext says so
    // `explains_why` and `actionable` need judgement, but their FAILURE mode is
    // mechanical — a `whyItHappens` that restates the measurement, or an action too
    // vague to do — so `sectionsAreSubstantive` catches the degenerate cases in code
    // and only a genuinely doubtful answer pays for a call.
    // A "below 50" note is now raised by a regex that actually matches the SQL
    // naming convention, so it fires where it silently never did before. It is a
    // precision signal, which confidence already weighs — treating it as an
    // unexplained anomaly here would buy a 4–6k LLM call per thin-sample answer
    // for no change in the text.
    const hasAnomalyWithoutLink =
      sanityNotes.some((n) => /flagged/i.test(n) && !/below 50/.test(n)) &&
      !narration.groundedInContext.trim();
    const selfEvident =
      sanityNotes.filter((n) => !/flagged/i.test(n)).length === 0 &&
      citationFailures === 0 &&
      /\d/.test(narration.headline) &&
      sectionsAreSubstantive(narration) &&
      !hasAnomalyWithoutLink;
    // The gate stays ON by default; `ANALYTICS_QUALITY_GATE=0` is an escape
    // hatch for the bench, not a new default. `selfEvident` is unchanged — it
    // already skips the call for an answer that passed every code check.
    const gateDisabled = !flagOn("qualityGate");
    // Set when the reviewer itself could not be used. The advisory all-pass stub
    // below is the right behaviour — an unusable reviewer must not kill an answer
    // that already passed the schema and citation checks — but reporting it as
    // "reviewed by the gate" made the trace claim a review that never ran.
    let gateUnusable = false;
    if (gateDisabled) {
      emitRunEvent({
        type: "log",
        name: "quality_gate_skipped",
        payload: { reason: "ANALYTICS_QUALITY_GATE=0" },
      });
    }
    const quality = gateDisabled || selfEvident
      ? {
          actionable: true, cites_numbers: true, names_segment: true,
          names_pattern: true, explains_why: true,
          links_known_issue: true, honest_confidence: true,
          verdict: "pass" as const, revision_note: "",
        }
      : await retryWithFeedback(
          MAX_QUALITY_ATTEMPTS,
          (qualityFeedback, attempt) =>
            step(span, `quality_gate_attempt_${attempt}`, { feedback: qualityFeedback }, async (qSpan) => {
              const prompt = await loadPrompt("analytics_review_quality", {
                question: input.question,
                insight: JSON.stringify(narration),
                results: resultsText.slice(0, 4000),
                feedback: qualityFeedback
                  ? `\n# Feedback on your previous attempt — fix this\n${qualityFeedback}\n`
                  : "",
              });
              const text = await llm(qSpan, "quality", prompt);
              return QualitySchema.parse(JSON.parse(stripFences(text)));
            }),
          (qualityFeedback) => {
            // The gate is advisory: an unusable reviewer must not kill an answer
            // that already passed schema and citation checks. Ship it unrevised,
            // and record that the review never happened.
            gateUnusable = true;
            emitRunEvent({
              type: "log",
              name: "quality_gate_unusable",
              payload: { reason: qualityFeedback.slice(0, 300) },
            });
            return {
              actionable: true, cites_numbers: true, names_segment: true,
              names_pattern: true, explains_why: true,
              links_known_issue: true, honest_confidence: true,
              verdict: "pass" as const, revision_note: "",
            };
          },
        );

    if (quality.verdict === "revise" && quality.revision_note) {
      const preRevision = narration;
      narration = await step(span, "narrate_revision", { note: quality.revision_note }, async (rSpan) => {
        const prompt = await loadPrompt("analytics_narrate_insight", {
          question: input.question,
          plan: plan.approach,
          results: resultsText || "(all tasks failed)",
          sanity: sanityNotes.join("\n") || "(clean)",
          method: methodNotes || "(no queries succeeded)",
          precision: precisionText,
          lookup: (lookup.markdown || "(nothing relevant retrieved)") + relatedContext,
          context_version: contextVersion,
          history: input.history?.length ? `\n# Conversation so far\n${historyText}\n` : "",
          feedback: `\n# Quality reviewer's instruction — apply it\n${quality.revision_note}\n`,
        });
        const text = await llm(rSpan, "narrate", prompt);
        const parsed = NarrationSchema.parse(JSON.parse(stripFences(text)));
        // The same surface as the main loop: a revision that introduces a
        // fabricated chart value must fail like a first attempt would. Checking
        // only the prose let one through.
        const revisedTexts = [
          ...narrativeTexts(parsed),
          ...(parsed.evidence.chart?.series.map((s) => String(s.value)) ?? []),
          ...(parsed.evidence.segmentTable?.rows.flat().map(String) ?? []),
        ];
        const uncited = findUncitedNumbers(revisedTexts, pool, datePool, askedNumbers);
        if (uncited.length > 0) {
          // keep the answer that already passed every check rather than failing
          // the request over a cosmetic revision
          emitRunEvent({
            type: "log",
            name: "revision_discarded",
            payload: { reason: `introduced uncited numbers: ${uncited.join(", ")}` },
          });
          return preRevision;
        }
        return parsed;
      }).catch((error: unknown) => {
        warn(span, "revision_failed", error);
        return preRevision;
      });
    }

    annotateFormats(narration, kept);

    const insight: Insight = {
      ...narration,
      confidence,
      precision,
      verification: verification
        ? {
            agreed: verification.agreed,
            originalValue: verification.originalValue,
            verifiedValue: verification.verifiedValue,
            sql: verification.sql,
            note: verification.note,
            concern: verification.concern,
            definitionOk: verification.definitionOk,
            answersQuestion: verification.answersQuestion,
            expectedToMatch: verification.expectedToMatch,
          }
        : null,
      contextVersion,
      // Every task with no usable result, each listed once — `sqlFailed` was
      // captured before the gate, so the gate's own drops are the remainder.
      droppedTasks: [...sqlFailed, ...results.filter((r) => r.dropped && !sqlFailed.includes(r))]
        .map((r) => `${r.title}: ${r.dropped}`)
        .filter(Boolean),
      // Every executed query, so a reader can see both what was sampled and how the
      // whole result set was measured.
      sql: results.flatMap((r) => [
        {
          task: r.id,
          title: r.title,
          query: r.sql,
          rowCount: r.rows.length,
          ...(r.digest ? { totalRows: r.digest.totalRows } : {}),
        },
        ...(r.digest
          ? [
              {
                task: `${r.id}_profile`,
                title: `${r.title} — profile of all ${r.digest.totalRows} rows`,
                query: r.digest.sql,
                rowCount: 1,
              },
            ]
          : []),
        ...(r.digest?.extremes && r.digest.extremes.top.length > 0
          ? [
              {
                task: `${r.id}_top`,
                title: `${r.title} — highest by ${r.digest.extremes.metric}`,
                query: r.digest.extremes.topSql,
                rowCount: r.digest.extremes.top.length,
              },
              {
                task: `${r.id}_bottom`,
                title: `${r.title} — lowest by ${r.digest.extremes.metric}`,
                query: r.digest.extremes.bottomSql,
                rowCount: r.digest.extremes.bottom.length,
              },
            ]
          : []),
      ]),
    };
    await insert("insight_cache", [
      {
        cache_key: key,
        question: input.question,
        context_key: contextKey,
        // Scopes the related-insights lookup above: an answer can only ever be
        // surfaced to the conversation it was written in.
        conv_id: convId,
        insight_json: JSON.stringify(insight),
        created_at: new Date().toISOString().replace("T", " ").replace("Z", ""),
      },
    ]).catch((error: unknown) => warn(span, "insight_cache_write_failed", error));

    scoreRun(span, "analytics_tasks", plan.tasks.length);
    scoreRun(span, "sql_attempts_total", sqlAttemptsTotal);
    // How much data the answer actually rests on, versus how much reached the model.
    const digested = kept.filter((r) => r.digest);
    scoreRun(span, "digests_computed", digested.length);
    scoreRun(
      span,
      "digest_failures",
      kept.filter((r) => r.digestNote).length,
      kept.map((r) => r.digestNote).filter(Boolean).join("; ") || "none",
    );
    scoreRun(
      span,
      "rows_analyzed_total",
      kept.reduce((sum, r) => sum + r.totalRows, 0),
      `${kept.reduce((sum, r) => sum + Math.min(r.rows.length, NARRATION_ROWS), 0)} rows were listed for the narrator`,
    );
    scoreRun(span, "sanity_flags", counts.impossible + counts.smallSample);
    scoreRun(span, "dropped_tasks", droppedCount);
    scoreRun(span, "citation_failures", citationFailures);
    scoreRun(
      span,
      "quality_gate_passed",
      quality.verdict === "pass" ? 1 : 0,
      gateDisabled
        ? "gate disabled (ANALYTICS_QUALITY_GATE=0)"
        : selfEvident
          ? "skipped — code checks cover the rubric"
          : gateUnusable
            ? "not reviewed — the reviewer returned nothing usable; shipped on the code checks alone"
            : "reviewed by the gate",
    );
    scoreRun(
      span,
      "verification_agreed",
      verification?.agreed === true ? 1 : verification?.agreed === false ? 0 : -1,
      verification?.note ?? "no verification run",
    );
    const tightest = precision.filter((p) => p.interval).sort((a, b) => a.interval!.halfWidthPp - b.interval!.halfWidthPp)[0];
    if (tightest) scoreRun(span, "precision_half_width_pp", tightest.interval!.halfWidthPp);
    scoreRun(span, "confidence_computed", confidence.value === "high" ? 2 : confidence.value === "medium" ? 1 : 0, confidence.note);
    scoreRun(span, "confidence_score", confidence.score, confidence.note);

    return insight;
   }),
  );
}
