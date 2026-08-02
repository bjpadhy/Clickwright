/**
 * ③ Analytics Agent — a PM question in, a cited Insight out. The chat backend.
 *
 * plan → SQL per task (guarded, read-only, self-healing ≤3) → sanity gate →
 * knowledge lookup → narrate → citation check (every number must exist in the
 * SQL results) → quality gate. One Langfuse trace per question.
 *
 * READ-ONLY BY CONSTRUCTION: context via getContext/lookupContext only (this
 * agent cannot call updateContext — it lacks an instrumentation result), and
 * SQL runs through queryReadonly (ClickHouse readonly=1) after code guards.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { command, insert, isTransientDbError, query, queryReadonly } from "../core/db.js";
import { withQueryContext } from "../core/query-context.js";
import { step, scoreRun, recordQuery, emitRunEvent, type Ctx } from "../core/tracing.js";
import { complete, loadPrompt, stripFences } from "../core/llm.js";
import { getContext, lookupContext } from "./context.js";
import { precisionForRow, deriveConfidence, RATE_RE, type Precision } from "../core/precision.js";
import {
  digestFlags,
  populationRow,
  profileResult,
  renderDigest,
  type ResultDigest,
} from "../core/result-digest.js";
import { verifyTask, type VerificationResult } from "./verifier.js";

// ── answer cache ────────────────────────────────────────────────
// A question whose wording and context version are unchanged has the same
// answer: serve it from ClickHouse in milliseconds instead of re-running the
// agent. Any context write changes contextVersion, which invalidates naturally.

export async function initInsightCache(): Promise<void> {
  await command(`
    CREATE TABLE IF NOT EXISTS insight_cache (
      cache_key     String,
      question      String,
      context_key   String,
      insight_json  String,
      created_at    DateTime64(3)
    ) ENGINE = ReplacingMergeTree(created_at) ORDER BY cache_key
    TTL toDateTime(created_at) + INTERVAL 30 DAY
    COMMENT 'Analytics answers keyed by question + context version — repeat asks are instant'
  `);
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
 */
const INSIGHT_FORMAT_VERSION = "v3";

const cacheKey = (question: string, contextKey: string, historyDigest = "") =>
  createHash("sha256")
    .update(
      `${INSIGHT_FORMAT_VERSION}::${question.trim().toLowerCase().replace(/\s+/g, " ")}::${contextKey}::${historyDigest}`,
    )
    .digest("hex")
    .slice(0, 32);

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
   * a bar; it is derived from the same measurements, not an extra opinion. */
  confidence: { value: "high" | "medium" | "low"; score: number; note: string };
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

const PlanSchema = z.object({
  approach: z.string().min(1),
  tasks: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_]+$/i),
        title: z.string().min(1),
        question: z.string().min(1),
        tables: z.array(z.string()).min(1),
        dimensions: z.array(z.string()).optional(),
        /** When set, this task runs AFTER the named task and receives its result
         *  summary — use for funnel drop-off analysis or comparisons that need
         *  a prior stage's count as input. */
        depends_on: z.string().optional(),
      }),
    )
    .max(4),
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

/** Exact column names+types per table. Injected into plan/SQL prompts: the
 * single biggest accuracy win — the model stops guessing column names, which
 * also removes most retry rounds (so it is a latency win too). */
async function tableSchemas(): Promise<Map<string, string>> {
  const rows = await query<{ table: string; cols: string }>(`
    SELECT table, arrayStringConcat(groupArray(concat(name, ' ', type)), ', ') AS cols
    FROM system.columns
    WHERE database = currentDatabase() AND table NOT IN (
      'context_store', 'runs_log', 'conversations', 'messages', 'dashboards',
      'insight_cache', 'optimization_suggestions', 'schema_changelog', 'trace_summaries'
    )
    GROUP BY table ORDER BY table
  `);
  return new Map(rows.map((r) => [r.table, `- ${r.table}: ${r.cols}`]));
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
  if (BANNED.test(sql)) {
    throw new Error(`banned keyword in SQL: ${BANNED.exec(sql)?.[0]}`);
  }
  const limit = TRAILING_LIMIT.exec(sql);
  const authored = limit?.[1];
  return {
    validated: sql,
    core: limit ? sql.slice(0, limit.index).trimEnd() : sql,
    authoredLimit: authored === undefined ? null : Number(authored),
  };
}

/** Cap what crosses the wire. Byte-identical to what `guardSql` has always
 * returned — saved dashboards store this text, so a cosmetic reformat here would
 * silently rewrite every board on its next save. */
function capForFetch(parts: SqlParts): string {
  const { validated, authoredLimit } = parts;
  if (authoredLimit === null) return `${validated}\nLIMIT ${MAX_RESULT_ROWS}`;
  // clamp an oversized explicit LIMIT rather than rejecting an otherwise good query
  if (authoredLimit <= MAX_RESULT_ROWS) return validated;
  const limit = TRAILING_LIMIT.exec(validated);
  return limit ? validated.slice(0, limit.index) + `LIMIT ${MAX_RESULT_ROWS}` : validated;
}

export function guardSql(raw: string): string {
  return capForFetch(guardSqlParts(raw));
}

// ── citation checker: every number in prose must exist in results ──

interface TaskResult {
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
export function findUncitedNumbers(
  texts: string[],
  pool: number[],
  datePool: string[] = [],
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
      if (b !== 0) derived.push(a / b);
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

/** One entry per column, keeping the WIDEST interval — that is the figure a reader
 * should be most careful with, so it is the one worth reporting. */
function widestPerColumn(entries: Precision[]): Precision[] {
  const byColumn = new Map<string, Precision>();
  for (const p of entries) {
    const prev = byColumn.get(p.column);
    const wider =
      !prev ||
      (p.interval && prev.interval && p.interval.halfWidthPp > prev.interval.halfWidthPp) ||
      (!prev.interval && !!p.interval);
    if (wider) byColumn.set(p.column, p);
  }
  return [...byColumn.values()];
}

// ── sanity gate (pure code) ──────────────────────────────────────

function sanityGate(results: TaskResult[]): { kept: TaskResult[]; notes: string[] } {
  const notes: string[] = [];
  const kept: TaskResult[] = [];
  for (const r of results) {
    if (r.rows.length === 0) {
      r.dropped = "empty result set";
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
      notes.push(`task ${r.id} (${r.title}): the query could not be written — ${reason}`);
      continue;
    }
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
    const sampleCols = r.rows.flatMap((row) =>
      Object.entries(row).filter(([c]) => /^(n|count|total|users|sessions|payers|uploads)/i.test(c)),
    );
    // With a digest the same question is answered over every row instead of the
    // fetched ones, so let the stronger check speak rather than saying both.
    if (!r.digest && sampleCols.length > 0 && sampleCols.every(([, v]) => Number(v) < 50)) {
      r.flags.push("all sample sizes below 50 — low confidence");
    }
    if (r.digest) r.flags.push(...digestFlags(r.digest));
    r.flags = [...new Set(r.flags)];
    for (const f of r.flags) notes.push(`task ${r.id} (${r.title}): flagged — ${f}`);
    kept.push(r);
  }
  return { kept, notes };
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
  if (r.rows.length <= NARRATION_ROWS) return r;
  // The SQL writer's "cannot compute" sentinel is a message, not a result set.
  if (r.rows[0] && "blocked" in r.rows[0]) return r;
  try {
    const digest = await profileResult(parent, {
      taskId: r.id,
      core: r.coreSql,
      authoredLimit: r.authoredLimit,
      rows: r.rows,
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
  const llm =
    opts.llm ??
    ((parent: Ctx, name: string, prompt: string) =>
      complete(parent, name, prompt, { maxTokens: 8000 }));

  // Self-attributing: tagging here rather than at the call site means every
  // query this agent runs is labelled "analytics" in system.query_log (and so on
  // the Observe screen) no matter which route ends up invoking it.
  return withQueryContext({ agent: "analytics" }, () =>
   step(opts.trace, "analytics", { question: input.question }, async (span) => {
    // ── context (read-only) ──
    const { bundle, sqlRulesMarkdown, schemas, contextVersion, contextKey } = await step(
      span,
      "context_load",
      {},
      async () => {
        const [b, schemas] = await Promise.all([
          // metrics/conventions/known-issues in full (they define correctness);
          // table docs brief because `schemas` already gives exact columns.
          getContext({
            include: ["*"],
            brief: ["table", "spec", "overview", "entity"],
            require: ["convention:data_hygiene", "metric"],
          }),
          tableSchemas(),
        ]);
        // SQL generation needs conventions + join_map only — extracted from the
        // already-fetched bundle instead of a second getContext round-trip.
        const sqlRulesMarkdown = b.entries
          .filter((e) => {
            const cat = e.entity.split(":")[0] ?? "";
            return cat === "convention" || cat === "join_map";
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
        const maxV = Math.max(...b.entries.map((e) => e.version));
        return {
          bundle: b,
          sqlRulesMarkdown,
          schemas,
          contextVersion: `${b.entries.length} entities · max v${maxV}`,
          contextKey: versionDigest,
        };
      },
    );

    // Cache hit → milliseconds. Follow-ups now cacheable too: the history
    // digest makes the key conversation-aware, so "break it down by OS" after
    // different conversations produces different cache entries.
    const historyDigest = input.history?.length
      ? createHash("sha1")
          .update(input.history.map((h) => `${h.role}:${h.text}`).join("|"))
          .digest("hex")
          .slice(0, 10)
      : "";
    const key = cacheKey(input.question, contextKey, historyDigest);
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
          return PlanSchema.parse(JSON.parse(stripFences(text)));
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
        confidence: { value: "low", score: 0.05, note: "no queryable data for this question" },
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
                const sql = capForFetch(parts);
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
    const { kept, notes } = await step(span, "sanity_gate", {}, async () =>
      sanityGate(results.filter((r) => !r.dropped)),
    );
    const failedTasks = results.filter((r) => r.dropped);
    const sanityNotes = [...notes, ...failedTasks.map((r) => `task ${r.id}: ${r.dropped}`)];

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
            definitions: bundle.markdown,
            schemas: schemaSubset(schemas, plan.tasks.find((t) => t.id === toVerify.id)?.tables ?? []),
          },
          guardSql,
          llm,
        ).catch(() => null)
      : Promise.resolve(null);

    // ── knowledge lookup + precision + cross-conversation context ──
    // All three are independent: lookupContext uses an LLM call, precision is
    // pure math, and the cross-conv lookup is a simple DB query.
    const lookupDigest = kept
      .map((r) => `${r.title}: ${JSON.stringify(r.rows.slice(0, 3))}`)
      .join("\n")
      .slice(0, 1500);

    // Cross-conversation context: find related past insights the PM has seen
    // in other conversations, so the narrator can reference or contrast them.
    const relatedInsightsPromise = step(span, "related_insights", {}, async () => {
      try {
        // Extract key terms from the question for a lightweight search
        const terms = input.question.toLowerCase()
          .split(/[^a-z0-9]+/).filter((t) => t.length > 3)
          .slice(0, 5);
        if (terms.length === 0) return "";
        const likeClause = terms.map((t) => `question ILIKE '%${t}%'`).join(" OR ");
        const rows = await query<{ question: string; insight_json: string }>(
          `SELECT question, insight_json FROM insight_cache
           WHERE (${likeClause}) AND cache_key != {currentKey:String}
           ORDER BY created_at DESC LIMIT 3`,
          { currentKey: key },
        );
        if (rows.length === 0) return "";
        const summaries = rows.map((r) => {
          try {
            const ins = JSON.parse(r.insight_json) as Insight;
            return `- "${r.question}" → ${ins.headline}`;
          } catch { return null; }
        }).filter(Boolean);
        return summaries.length
          ? `\n## Related past insights (from other conversations)\n${summaries.join("\n")}`
          : "";
      } catch { return ""; }
    });

    const [lookup, { precision, headlinePrecision }, relatedContext] = await Promise.all([
      lookupContext(span, `${input.question}\n${lookupDigest}`, opts.llm),
      step(span, "precision", {}, async () => {
        // What the answer's main claims rest on: the listed rows and, when the result
        // was profiled, the whole-population figure.
        const headline: Precision[] = [];
        // The extreme rows. Real, and worth reporting — but by construction they
        // include the smallest segments in the result, so letting them decide overall
        // confidence would mark every large answer "low" because some tail row has n=2.
        const tails: Precision[] = [];
        for (const r of kept) {
          for (const row of r.rows.slice(0, NARRATION_ROWS)) {
            headline.push(...precisionForRow(row as Record<string, unknown>, r.semanticSql));
          }
          if (!r.digest) continue;
          headline.push(...precisionForRow(populationRow(r.digest), r.digest.sql));
          for (const row of [
            ...(r.digest.extremes?.top ?? []),
            ...(r.digest.extremes?.bottom ?? []),
          ]) {
            tails.push(...precisionForRow(row, r.semanticSql));
          }
        }
        return {
          precision: widestPerColumn([...headline, ...tails]),
          headlinePrecision: widestPerColumn(headline),
        };
      }),
      relatedInsightsPromise,
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

    let narration: Narration | null = null;
    let citationFailures = 0;
    let feedback = "";
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
            const uncited = findUncitedNumbers(texts, pool, datePool);
            if (uncited.length > 0) {
              citationFailures++;
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
        if (attempt === MAX_NARRATE_ATTEMPTS)
          throw new Error(`narration failed citation/schema checks ${attempt} times: ${feedback}`);
      }
    }
    if (!narration) throw new Error("unreachable: narration missing");

    // the verification started before the lookup has had the whole narration to finish in
    const verification = await verificationPromise;

    const confidence = deriveConfidence({
      precisions: headlinePrecision,
      sanityFlags: sanityNotes.length,
      citationRetries: citationFailures,
      verificationAgreed: verification?.agreed ?? null,
    });

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
    const hasAnomalyWithoutLink =
      sanityNotes.some((n) => /flagged/i.test(n)) && !narration.groundedInContext.trim();
    const selfEvident =
      sanityNotes.filter((n) => !/flagged/i.test(n)).length === 0 &&
      citationFailures === 0 &&
      /\d/.test(narration.headline) &&
      sectionsAreSubstantive(narration) &&
      !hasAnomalyWithoutLink;
    const quality = selfEvident
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
          lookup: lookup.markdown || "(nothing relevant retrieved)",
          context_version: contextVersion,
          history: input.history?.length ? `\n# Conversation so far\n${historyText}\n` : "",
          feedback: `\n# Quality reviewer's instruction — apply it\n${quality.revision_note}\n`,
        });
        const text = await llm(rSpan, "narrate", prompt);
        const parsed = NarrationSchema.parse(JSON.parse(stripFences(text)));
        const uncited = findUncitedNumbers(narrativeTexts(parsed), pool, datePool);
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
      }).catch(() => preRevision);
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
          }
        : null,
      contextVersion,
      droppedTasks: [...failedTasks, ...results.filter((r) => r.dropped && !failedTasks.includes(r))]
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
        insight_json: JSON.stringify(insight),
        created_at: new Date().toISOString().replace("T", " ").replace("Z", ""),
      },
    ]).catch(() => {});

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
    scoreRun(span, "sanity_flags", sanityNotes.length);
    scoreRun(span, "citation_failures", citationFailures);
    scoreRun(span, "quality_gate_passed", quality.verdict === "pass" ? 1 : 0);
    scoreRun(
      span,
      "verification_agreed",
      verification?.agreed === true ? 1 : verification?.agreed === false ? 0 : -1,
      verification?.note ?? "no verification run",
    );
    const tightest = precision.filter((p) => p.interval).sort((a, b) => a.interval!.halfWidthPp - b.interval!.halfWidthPp)[0];
    if (tightest) scoreRun(span, "precision_half_width_pp", tightest.interval!.halfWidthPp);
    scoreRun(span, "confidence_computed", confidence.value === "high" ? 2 : confidence.value === "medium" ? 1 : 0, confidence.note);

    return insight;
   }),
  );
}
