/**
 * Execution-backed verification.
 *
 * A reading judge can only say whether a query LOOKS right. This one writes an
 * independent query by a different route, runs it read-only, and compares the
 * numbers — the only method here that catches "valid SQL, wrong question": a
 * mistaken denominator or a join that fanned rows out produces a real number
 * that every other check accepts.
 *
 * Disagreement is not treated as proof the original is wrong; it is proof that
 * one of the two is, which is reported honestly and caps confidence well below
 * medium. An INCONCLUSIVE result (nothing to compare) caps it below high — so
 * this module works hard to find the figure the verifier meant: by the column
 * name it gave, else by the one column that holds the same value.
 */
import { z } from "zod";
import { queryReadonly } from "../core/db.js";
import { step, recordQuery, type Ctx } from "../core/tracing.js";
import { loadPrompt, stripFences } from "../core/llm.js";
import { COUNT_RE, RATE_RE } from "../core/precision.js";

const VerificationSchema = z.object({
  verification_sql: z.string().min(20),
  // Prose fields are truncated, never rejected: throwing away a completed
  // execution-backed comparison because its comment ran 20 characters long would
  // discard the one check that catches "valid SQL, wrong question".
  recomputes: z.string().transform((s) => s.slice(0, 160)).default(""),
  expected_to_match: z.string().default(""),
  definition_ok: z.boolean().default(true),
  answers_question: z.boolean().default(true),
  concern: z.string().transform((s) => s.slice(0, 300)).default(""),
});

export interface VerificationResult {
  /** null when no comparable figure could be produced — unknown, not "passed". */
  agreed: boolean | null;
  originalValue: number | null;
  verifiedValue: number | null;
  /** Relative difference between the two figures, when both exist. */
  relativeDelta: number | null;
  sql: string;
  recomputes: string;
  /** The column of THEIR result that was compared: the verifier's
   * `expected_to_match` when it named a real column, the column resolved by
   * value when it did not. Before a comparison happened it is whatever the
   * verifier wrote (`""` when it never produced a plan). Confidence uses it to
   * pick the headline figure, so after a comparison it is always a real column. */
  expectedToMatch: string;
  definitionOk: boolean;
  answersQuestion: boolean;
  concern: string;
  note: string;
}

/** Two figures agree when they are within 2% relatively, or 0.005 absolute for rates. */
function agrees(a: number, b: number): boolean {
  const absTol = Math.abs(a) <= 1 && Math.abs(b) <= 1 ? 0.005 : 0;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) <= Math.max(absTol, scale * 0.02);
}

/** A cell as a number, or null — ClickHouse ships UInt64 as strings, so strings
 * are parsed, but `null`, `""` and booleans are not figures. */
function numeric(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The numeric columns of the rows given, in first-seen order, deduplicated. */
export function numericColumns(...rows: (Record<string, unknown> | undefined)[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (!row) continue;
    for (const [column, raw] of Object.entries(row)) {
      if (numeric(raw) !== null && !out.includes(column)) out.push(column);
    }
  }
  return out;
}

type FigureKind = "rate" | "magnitude";
const kindOfValue = (v: number): FigureKind => (v >= 0 && v <= 1.0001 ? "rate" : "magnitude");
/** A column's kind from its NAME first — a count of 1 is not a 100% rate — and
 * from its value only when the name says nothing. */
function kindOfColumn(column: string, value: number): FigureKind {
  if (RATE_RE.test(column)) return "rate";
  if (COUNT_RE.test(column) || /(^|_)(sum|total|amount|avg|mean|median|p\d{2})$/i.test(column)) return "magnitude";
  return kindOfValue(value);
}

export type ResolvedColumn =
  | { column: string; value: number; matchedBy: "name" | "value" }
  | { column: null; value: null; matchedBy: null };

const UNRESOLVED: ResolvedColumn = { column: null, value: null, matchedBy: null };

/**
 * Which figure of THEIR result the verifier reproduced.
 *
 * 1. By NAME: `expected` is a column holding a number — whole-set profile first,
 *    since a population figure is the one worth checking, then the rows.
 * 2. By VALUE: the verifier named a column that does not exist (it wrote
 *    "total_discount" where the profile says `full_discount_sum`) — so the one
 *    column of the same kind (rate vs magnitude) whose value agrees with the
 *    recomputed figure is taken. Two such columns is ambiguous → unresolved: a
 *    guess between them would be a coin-flip dressed as verification.
 * 3. A single-row result with exactly one figure: that figure, whatever it is
 *    called — there is nothing else the verifier could have meant.
 */
export function resolveExpectedColumn(
  expected: string,
  verifiedValue: number | null,
  digestRow: Record<string, unknown> | undefined,
  rows: Record<string, unknown>[],
): ResolvedColumn {
  const haystack = [...(digestRow ? [digestRow] : []), ...rows];

  if (expected) {
    // The digest row first: it carries the whole-population figure, which is
    // what an independent verification query recomputes.
    if (digestRow) {
      const v = numeric(digestRow[expected]);
      if (v !== null) return { column: expected, value: v, matchedBy: "name" };
    }
    // With no digest — a result of 24 rows or fewer is never profiled — the
    // named column exists once PER ROW. Taking the first row compared the
    // verifier's population figure against one arbitrary city and reported that
    // the two "disagree", which now caps confidence at 0.44 and tells the PM the
    // answer failed its own audit. Only compare when the rows leave one
    // unambiguous figure; otherwise fall through to the value match below, which
    // resolves by agreement, and failing that to inconclusive. Unverified
    // (ceiling 0.70) is the honest verdict when we cannot tell what was compared.
    const values = rows
      .map((row) => numeric(row[expected]))
      .filter((v): v is number => v !== null);
    const first = values[0];
    if (first !== undefined && values.every((v) => agrees(v, first))) {
      return { column: expected, value: first, matchedBy: "name" };
    }
  }

  if (verifiedValue !== null) {
    const kind = kindOfValue(verifiedValue);
    const matches = new Map<string, number>();
    for (const row of haystack) {
      for (const [column, raw] of Object.entries(row)) {
        const v = numeric(raw);
        if (v === null || matches.has(column)) continue;
        if (kindOfColumn(column, v) !== kind) continue;
        if (agrees(v, verifiedValue)) matches.set(column, v);
      }
    }
    if (matches.size === 1) {
      const [column, value] = [...matches.entries()][0]!;
      return { column, value, matchedBy: "value" };
    }
    if (matches.size > 1) return UNRESOLVED;
  }

  if (rows.length === 1 && rows[0]) {
    const only = Object.entries(rows[0])
      .map(([column, raw]) => [column, numeric(raw)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== null);
    if (only.length === 1) return { column: only[0]![0], value: only[0]![1], matchedBy: "value" };
  }

  return UNRESOLVED;
}

/** How many result rows the verifier is shown — and therefore how many are
 * scanned for the column names it is told it may target. */
const VERIFY_SAMPLE_ROWS = 12;

export interface VerifyInput {
  question: string;
  taskTitle: string;
  taskQuestion: string;
  sql: string;
  rows: Record<string, unknown>[];
  /** Whole-result-set figures, when the result was too large to show in full.
   * These are the numbers a reader acts on, so they are what a second query
   * should have to reproduce. */
  digest: string;
  /** The same figures as values, so a verifier that targets one can be checked
   * against it — searching only the sample rows reported "inconclusive" for
   * exactly the population figures we most want verified. */
  digestRow?: Record<string, unknown>;
  definitions: string;
  schemas: string;
}

/**
 * The one number a verification query produced, or why there is not one.
 *
 * The verifier is asked for ONE row holding one number. When it returns many it
 * has grouped the figure instead of recomputing it, and taking row 0 compares
 * the population against whichever segment sorted first: a 14,026-application
 * rate of 47.9% was "disagreed" with by a 198-application slice of 41.9%, which
 * capped a correct answer at 0.44 and told the reader one of the two was wrong.
 * Rows that all agree still name one figure; rows that differ name none.
 */
function readVerifiedValue(rows: Record<string, unknown>[]): {
  value: number | null;
  inconclusive: string;
} {
  // `in`, not `??`. A SQL NULL from `avgIf(...) AS verified_value` made the `??`
  // fall through to the FIRST column of the row — typically the count beside it
  // — so a verification that simply found nothing compared a count against a
  // rate and reported "these disagree". An absent column still falls back; a
  // NULL one stays null and the verdict is inconclusive, which is the truth.
  const valueOf = (r: Record<string, unknown>): number | null =>
    numeric("verified_value" in r ? r["verified_value"] : Object.values(r)[0]);
  const first = rows[0];
  if (!first) return { value: null, inconclusive: "" };
  if (rows.length === 1) return { value: valueOf(first), inconclusive: "" };
  const values = rows.map(valueOf);
  const head = values[0];
  if (head !== null && head !== undefined && values.every((v) => v !== null && agrees(v, head))) {
    return { value: head, inconclusive: "" };
  }
  return {
    value: null,
    inconclusive: `the verification query returned ${rows.length} rows with different values — it grouped the figure instead of recomputing it, so there is nothing to compare against`,
  };
}

/** One more attempt at a verification query that would not execute. */
async function retryVerificationQuery(
  span: Ctx,
  llm: (parent: Ctx, name: string, prompt: string) => Promise<string>,
  guard: (sql: string) => string,
  buildPrompt: (feedback: string) => Promise<string>,
  message: string,
): Promise<
  | { plan: z.infer<typeof VerificationSchema>; sql: string; value: number | null; inconclusive: string }
  | null
> {
  try {
    const feedback =
      `\n# Your previous query did not run — fix it\nClickHouse rejected it:\n${message.slice(0, 300)}\n` +
      `Your query reads the BASE TABLES in the schema block. The other query's output column names are not tables and not columns; recompute the figure from source, aggregate everything you select, and return ONE row.\n`;
    const text = await llm(span, "verify", await buildPrompt(feedback));
    const plan = VerificationSchema.parse(JSON.parse(stripFences(text)));
    const sql = guard(plan.verification_sql);
    const rows = await queryReadonly<Record<string, unknown>>(sql);
    recordQuery(span, "verification_result_retry", sql, rows);
    const { value, inconclusive } = readVerifiedValue(rows);
    return { plan, sql, value, inconclusive };
  } catch {
    // the retry is a bonus; its failure must not replace the original reason
    return null;
  }
}

export async function verifyTask(
  parent: Ctx,
  input: VerifyInput,
  guard: (sql: string) => string,
  llm: (parent: Ctx, name: string, prompt: string) => Promise<string>,
): Promise<VerificationResult | null> {
  return step(parent, "verify", { task: input.taskTitle }, async (span) => {
    // The names the verifier may target, spelled out — three of four live probes
    // came back inconclusive because it named a column that was not there.
    // The same rows the verifier is shown: a column that is null in row 0 but
    // numeric further down is still a column it may target, and
    // `resolveExpectedColumn` searches all of them.
    const sample = input.rows.slice(0, VERIFY_SAMPLE_ROWS);
    const columns = numericColumns(input.digestRow, ...sample);
    const buildPrompt = (feedback: string): Promise<string> =>
      loadPrompt("analytics_verify_query", {
        question: input.question,
        task: `${input.taskTitle} — ${input.taskQuestion}`,
        sql: input.sql,
        result: JSON.stringify(sample),
        columns: JSON.stringify(columns),
        digest: input.digest,
        definitions: input.definitions,
        schemas: input.schemas,
        feedback,
      });
    const prompt = await buildPrompt("");

    let plan: z.infer<typeof VerificationSchema>;
    try {
      plan = VerificationSchema.parse(JSON.parse(stripFences(await llm(span, "verify", prompt))));
    } catch (error) {
      // a verifier that cannot produce a query tells us nothing — it must not be
      // reported as agreement
      return {
        agreed: null,
        originalValue: null,
        verifiedValue: null,
        relativeDelta: null,
        sql: "",
        recomputes: "",
        expectedToMatch: "",
        definitionOk: true,
        answersQuestion: true,
        concern: "",
        note: `verification could not be written: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
      } satisfies VerificationResult;
    }

    let verifiedValue: number | null = null;
    let inconclusive = "";
    let ran = "";
    try {
      ran = guard(plan.verification_sql);
      const rows = await queryReadonly<Record<string, unknown>>(ran);
      recordQuery(span, "verification_result", ran, rows);
      const read = readVerifiedValue(rows);
      verifiedValue = read.value;
      inconclusive = read.inconclusive;
    } catch (error) {
      // One retry, with the database's own words as feedback. A verification
      // that fails to RUN costs the answer 0.30 and the "not independently
      // verified" chip, and the failures are mostly one-line SQL mistakes the
      // writer can fix when told — the live case was
      // `sum(purchase_n) / sum(pay_now_n)` over the other query's output column
      // names, which are not columns of any table. Cheaper than losing the
      // check: one extra call, and only when the first query did not execute.
      const message =
        error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
      const retry = await retryVerificationQuery(span, llm, guard, buildPrompt, message);
      if (!retry) {
        return {
          agreed: null,
          originalValue: null,
          verifiedValue: null,
          relativeDelta: null,
          sql: ran,
          recomputes: plan.recomputes,
          expectedToMatch: plan.expected_to_match,
          definitionOk: plan.definition_ok,
          answersQuestion: plan.answers_question,
          concern: plan.concern,
          note: `verification query failed: ${message.slice(0, 140)}`,
        } satisfies VerificationResult;
      }
      plan = retry.plan;
      ran = retry.sql;
      verifiedValue = retry.value;
      inconclusive = retry.inconclusive;
    }

    // the figure it claims to reproduce, from the original result
    const resolved = resolveExpectedColumn(plan.expected_to_match, verifiedValue, input.digestRow, input.rows);

    if (resolved.matchedBy === null || verifiedValue === null) {
      const available = columns.length > 0 ? columns.join(", ") : "none";
      return {
        agreed: null,
        originalValue: resolved.value,
        verifiedValue,
        relativeDelta: null,
        sql: ran,
        recomputes: plan.recomputes,
        expectedToMatch: plan.expected_to_match,
        definitionOk: plan.definition_ok,
        answersQuestion: plan.answers_question,
        concern: plan.concern,
        note:
          inconclusive
            ? `${inconclusive} — verification inconclusive, not passed`
            : verifiedValue === null
            ? `the verification query returned no numeric verified_value — verification inconclusive, not passed`
            : `no comparable figure (expected_to_match="${plan.expected_to_match}" is not a column of their result; available: ${available}) — verification inconclusive, not passed`,
      } satisfies VerificationResult;
    }

    const originalValue = resolved.value;
    const ok = agrees(originalValue, verifiedValue);
    const scale = Math.max(Math.abs(originalValue), Math.abs(verifiedValue), 1e-9);
    const how =
      resolved.matchedBy === "value"
        ? `; matched by value — expected_to_match="${plan.expected_to_match}" is not a column, ${resolved.column} holds the figure`
        : "";
    return {
      agreed: ok,
      originalValue,
      verifiedValue,
      relativeDelta: Math.abs(originalValue - verifiedValue) / scale,
      sql: ran,
      recomputes: plan.recomputes,
      expectedToMatch: resolved.column,
      definitionOk: plan.definition_ok,
      answersQuestion: plan.answers_question,
      concern: plan.concern,
      note: ok
        ? `an independently written query reproduced ${resolved.column} (${verifiedValue})${how}`
        : `an independently written query got ${verifiedValue} where the analysis reported ${originalValue} (${resolved.column}) — one of them is wrong${how}`,
    } satisfies VerificationResult;
  });
}
