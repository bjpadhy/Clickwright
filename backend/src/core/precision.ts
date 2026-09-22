/**
 * How precise is a number we are about to report?
 *
 * A Wilson interval is only valid for a binomial proportion. Our queries also
 * produce means, quantiles and unbounded ratios, and applying Wilson to those
 * would yield a confidently wrong interval — worse than none, because it looks
 * rigorous. So each metric is CLASSIFIED first, and anything we cannot bound
 * honestly is reported as "not computable" rather than guessed.
 *
 * Caveat that applies to every interval here: rows are events, and several may
 * come from one user, so trials are not fully independent. Real uncertainty is
 * therefore a little WIDER than these intervals suggest — they are a lower bound.
 */

export type MetricKind = "proportion" | "mean" | "quantile" | "ratio" | "count" | "unknown";

export interface Precision {
  column: string;
  kind: MetricKind;
  value: number;
  /** Denominator for a proportion; null when we could not identify one. */
  n: number | null;
  /** 95% interval, only when the kind supports one and n is known. */
  interval: { lo: number; hi: number; halfWidthPp: number } | null;
  /** Why there is no interval, when there isn't one. */
  note: string;
}

/** Exported because the full-result-set digest must classify columns by exactly
 * the same conventions this module reads them by — a digest that named its
 * whole-population rate differently would compute no interval for it. */
export const RATE_RE = /(^|_)(rate|ratio|pct|percent|share)$/i;
export const COUNT_RE = /(^|_)(n|count|denominator|users|sessions|rows|events|applications|payers|uploads|opens|clicks)$/i;

/**
 * Classify from the SQL that produced the column, not the column name alone —
 * `avg(latency_ms) AS p50_latency` is a mean however it is aliased.
 */
export function classifyMetric(column: string, value: number, sql: string): MetricKind {
  const alias = column.toLowerCase();
  // parametric aggregates have two argument lists: quantile(0.95)(x)
  const aliasPattern = new RegExp(
    `(\\w+\\s*\\([^)]*\\)(?:\\s*\\([^)]*\\))?)\\s+as\\s+\`?${alias}\`?`,
    "i",
  );
  const fn = aliasPattern.exec(sql)?.[1]?.toLowerCase() ?? "";

  if (/^quantile|^median|^approx_top/.test(fn)) return "quantile";

  // The alias decides before the function does: avg() over a 0/1 column IS a
  // proportion, and that is how these queries compute success rates.
  if (RATE_RE.test(alias)) {
    // a "rate" above 1 is not a proportion but a per-unit ratio (2.4 travellers
    // per group), which Wilson cannot bound
    return value >= 0 && value <= 1.0001 ? "proportion" : "ratio";
  }

  if (/^avg|^mean/.test(fn)) return "mean";
  if (/^(count|uniq|uniqexact|sum)/.test(fn)) return "count";
  if (COUNT_RE.test(alias)) return "count";
  return "unknown";
}

const normalize = (s: string) => s.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The SELECT-list expression that produced `alias`, e.g. for
 * `uniqExactIf(x) / uniqExact(y) AS attach_rate` returns the text before `AS`.
 * Scans back from the alias to the enclosing depth-0 comma or opening paren, so
 * commas inside function calls do not split the item.
 */
function selectItemFor(alias: string, sql: string): string | null {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\bas\\s+\`?${escaped}\`?\\b`, "gi");
  let match: RegExpExecArray | null;
  let last = -1;
  while ((match = re.exec(sql)) !== null) last = match.index;
  if (last < 0) return null;

  let depth = 0;
  let i = last - 1;
  for (; i >= 0; i--) {
    const ch = sql[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) break;
  }
  // The FIRST item of a SELECT list has no comma or paren before it, so the scan
  // runs into the keyword itself — strip it, or a rate divided by the first
  // column of the query can never be resolved.
  const item = sql
    .slice(i + 1, last)
    .trim()
    .replace(/^select\s+(distinct\s+)?/i, "");
  return item.length > 0 ? item : null;
}

/** The divisor of the outermost division in an expression, if it is a division. */
function divisorOf(expression: string): string | null {
  let depth = 0;
  for (let i = expression.length - 1; i >= 0; i--) {
    const ch = expression[i];
    if (ch === ")") depth++;
    else if (ch === "(") depth--;
    else if (ch === "/" && depth === 0) {
      const divisor = expression.slice(i + 1).trim();
      return divisor.length > 0 ? divisor : null;
    }
  }
  return null;
}

/**
 * The columns that could denominate `rateColumn`, read from the SQL that defined
 * it. This is not an inference: `a / b AS rate` states what it divided by, so we
 * resolve `b` — first as a bare column of the result, then as an expression that
 * appears again in the same SELECT under its own alias. Ordered candidates, so a
 * caller can apply its own validity check (a positive value in a row; a summable
 * column in the digest) and fall through.
 *
 * It exists because the naming convention alone cannot express a funnel. A rate
 * between two different stages — `currency_selected_n / offer_shown_n AS
 * offer_to_currency_rate` — has no shared base with either count, so demanding
 * `offer_to_currency_n` asks for a column no sensible query would write, and
 * every such rate came back "not computable".
 *
 * Exported for the full-result-set digest, which needs the denominator COLUMN
 * before any row exists to build `sum(rate * n) / sum(n)`. Sharing the resolver
 * is the point: the digest and per-row precision must never disagree about what
 * a rate divides by.
 */
/**
 * Calls that change a divisor's type or its null handling without changing
 * WHICH column supplies the value. `NULLIF(d, 0)` is the correct way to write a
 * safe division, and a query that used it was treated as having no denominator
 * at all — so the rate could not be bounded, the digest could not compute a
 * whole-population rate, and a correct, verified answer was reported to the PM
 * as low confidence. Measured on one question across two runs: the model wrote
 * `purchase_n / pay_now_n` and scored 0.79, then wrote
 * `purchase_n / NULLIF(p.pay_now_n, 0)` for the same figure and scored 0.31.
 */
const DIVISOR_WRAPPERS = new Set([
  "nullif",
  "coalesce",
  "ifnull",
  "assumenotnull",
  "cast",
  "greatest",
  "max2",
  "tofloat64",
  "tofloat32",
  "touint64",
  "touint32",
  "touint16",
  "touint8",
  "toint64",
  "toint32",
  "todecimal64",
  "todecimal32",
  "tonullable",
]);

/** Does the bracket opened at `open` close on the expression's last character? */
function spansWholeExpression(expression: string, open: number): boolean {
  let depth = 0;
  for (let i = open; i < expression.length; i += 1) {
    const ch = expression[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i === expression.length - 1;
    }
  }
  return false;
}

/** Split on commas that are not inside brackets. */
function topLevelArguments(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out;
}

/** Peel one wrapper, or null when there is nothing to peel. */
function unwrapOnce(expression: string): string | null {
  const e = expression.trim();
  if (e.startsWith("(") && spansWholeExpression(e, 0)) return e.slice(1, -1);
  const call = /^([a-z_][a-z0-9_]*)\s*\(/i.exec(e);
  if (!call?.[1]) return null;
  const fn = call[1].toLowerCase();
  if (!DIVISOR_WRAPPERS.has(fn)) return null;
  const open = e.indexOf("(", call[1].length);
  if (open < 0 || !spansWholeExpression(e, open)) return null;
  const first = topLevelArguments(e.slice(open + 1, e.length - 1))[0] ?? "";
  // CAST(d AS Float64) — the target type is part of CAST's first argument, and of
  // no other function's. Stripping ` AS <type>` from every wrapper ate the closing
  // paren of a nested call, because the pattern has to allow parens for
  // `Decimal(10, 2)`: `nullIf(CAST(p.pay_now_n AS Float64), 0)` reduced to the
  // unparseable `CAST(p.pay_now_n`, no column was found, and the most idiomatic
  // safe division in ClickHouse lost its denominator — the rate went unbounded and
  // a correct answer was capped at 0.60.
  const operand = (fn === "cast" ? first.replace(/\s+as\s+[a-z0-9_(), ]+$/i, "") : first).trim();
  return operand.length > 0 ? operand : null;
}

/** A divisor reduced to the operand that actually names a column. */
export function unwrapDivisor(expression: string): string {
  let current = expression.trim();
  for (let guard = 0; guard < 8; guard += 1) {
    const next = unwrapOnce(current);
    if (next === null) break;
    current = next.trim();
  }
  return current;
}

/** `p.pay_now_n` and `pay_now_n` are the same column; a table alias is plumbing. */
function stripQualifier(identifier: string): string {
  return /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(identifier)
    ? (identifier.split(".").pop() ?? identifier)
    : identifier;
}

export function denominatorColumnsFromSql(
  rateColumn: string,
  sql: string,
  columns: readonly string[],
): string[] {
  const item = selectItemFor(rateColumn, sql);
  if (!item) return [];
  const rawDivisor = divisorOf(item);
  if (!rawDivisor) return [];
  // Peel the null guards and casts first: they change how the division behaves,
  // never which column it reads.
  const divisor = unwrapDivisor(rawDivisor.replace(/`/g, ""));

  const out: string[] = [];
  const present = new Set(columns);

  // the divisor is itself one of the returned columns, with or without its
  // table alias
  const column = stripQualifier(divisor.trim());
  if (column && column !== rateColumn && present.has(column)) out.push(column);

  // the divisor is an expression that some other column also selects
  const canonical = (s: string) => stripQualifier(normalize(unwrapDivisor(s.replace(/`/g, ""))));
  const target = canonical(divisor);
  for (const candidate of columns) {
    if (candidate === rateColumn || out.includes(candidate)) continue;
    const candidateItem = selectItemFor(candidate, sql);
    if (candidateItem && canonical(candidateItem) === target) out.push(candidate);
  }
  return out;
}

/** The denominator VALUE for a rate in one fetched row, resolved from the SQL. */
function denominatorFromSql(
  rateColumn: string,
  row: Record<string, unknown>,
  sql: string,
): number | null {
  for (const column of denominatorColumnsFromSql(rateColumn, sql, Object.keys(row))) {
    const n = Number(row[column]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * The denominator for a rate column, taken from the SAME row by naming
 * convention (`x_rate` → `x_n` / `x_denominator` / `x_total`, else a bare `n`).
 * Returns null rather than picking a nearby count — an inferred denominator
 * produces a plausible, verifiable-looking, wrong interval.
 */
export function findDenominator(
  rateColumn: string,
  row: Record<string, unknown>,
): number | null {
  // A bare `n` is unambiguous only when the row carries ONE rate. Beside two — a
  // per-segment rate and a whole-population one, say — it is the denominator of at
  // most one of them, and lending it to the other produces exactly the plausible,
  // verifiable-looking, wrong interval this function exists to refuse: a global
  // 35.2% was bounded at ±44pp off a row-local n=1 when its real bound was ±1.1pp.
  const ambiguous = Object.keys(row).filter((k) => RATE_RE.test(k)).length > 1;
  for (const c of denominatorCandidates(rateColumn)) {
    if (ambiguous && GENERIC_DENOMINATORS.has(c)) continue;
    const v = Number(row[c]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/** Denominator names that do not say which rate they belong to. */
const GENERIC_DENOMINATORS = new Set(["n", "denominator"]);

/** The naming convention itself, in one place: `x_rate` is denominated by `x_n`,
 * `x_denominator`, `x_total`, `x_base`, or a bare `n`. */
function denominatorCandidates(rateColumn: string): string[] {
  const base = rateColumn.replace(RATE_RE, "").replace(/_$/, "");
  return [`${base}_n`, `${base}_denominator`, `${base}_total`, `${base}_base`, "n", "denominator"];
}

/**
 * The denominator COLUMN NAME for a rate, by the same convention `findDenominator`
 * reads values with. Building SQL over a result set needs the name before any row
 * exists; returns null rather than guessing, so a rate without a declared
 * denominator simply gets no whole-population figure.
 */
export function denominatorColumnFor(
  rateColumn: string,
  columns: readonly string[],
): string | null {
  const present = new Set(columns);
  for (const c of denominatorCandidates(rateColumn)) {
    if (c !== rateColumn && present.has(c)) return c;
  }
  return null;
}

/** Wilson score interval — stable at small n and at proportions near 0 or 1. */
export function wilson(successes: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = Math.min(Math.max(successes / n, 0), 1);
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** Precision for every numeric column of one result row. */
export function precisionForRow(
  row: Record<string, unknown>,
  sql: string,
): Precision[] {
  const out: Precision[] = [];
  for (const [column, raw] of Object.entries(row)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const kind = classifyMetric(column, value, sql);
    if (kind === "count" || kind === "unknown") continue;

    if (kind === "proportion") {
      // what the query divided by, before what the column is called
      const n = denominatorFromSql(column, row, sql) ?? findDenominator(column, row);
      if (n === null) {
        out.push({
          column,
          kind,
          value,
          n: null,
          interval: null,
          note: `no denominator in the result — emit \`${column.replace(RATE_RE, "").replace(/_$/, "")}_n\` to make precision computable`,
        });
        continue;
      }
      const { lo, hi } = wilson(value * n, n);
      out.push({
        column,
        kind,
        value,
        n,
        interval: { lo, hi, halfWidthPp: ((hi - lo) / 2) * 100 },
        note: `Wilson 95% on n=${n}; approximate, since repeated events from one user are not independent trials`,
      });
      continue;
    }

    out.push({
      column,
      kind,
      value,
      n: null,
      interval: null,
      note:
        kind === "mean"
          ? "a mean needs its standard deviation to be bounded; not emitted by this query"
          : kind === "quantile"
            ? "a quantile needs bootstrapping to be bounded; not computed"
            : "an unbounded ratio needs a Poisson or bootstrap interval; not computed",
    });
  }
  return out;
}

// ── confidence ──────────────────────────────────────────────────────
//
// Confidence is COMPUTED, never asked of the model, and it is a SUM: every
// measurement that weakens the answer is one named signal with a signed delta,
// `1 + Σdelta` is the score, and the level is read off the score. A reader can
// therefore see exactly why two "medium" answers differ, and a PM who refines a
// vague question watches specific deductions disappear.
//
// The old rule took the WIDEST interval across every cell, so one tail row with
// n=2 marked an answer "low" whose headline figure (n≈850) had just been
// reproduced exactly by an independent query (spec-06 q1, low 0.50). Here the
// headline figure carries the precision weight and the tails are a small,
// capped deduction; the ceilings below say what a score can never exceed.
//
// Deterministic given the SQL results, `plan.assumptions` and the verification
// outcome — no model call sits between the inputs and the number.

export interface ConfidenceSignal {
  /** Stable id (`headline_interval`, `assumptions`, …) — the UI keys on it. */
  name: string;
  /** Signed contribution; `1 + Σdelta` over all signals is `score`. */
  delta: number;
  /** One line a reader can act on. */
  detail: string;
}

export interface ConfidenceInput {
  /** `widestPerColumn` of the headline rows + digest population row + tail rows. */
  precisions: Precision[];
  /** Digest population rate columns (`full_*_rate`) across the kept tasks. */
  headlineColumns: string[];
  /** `verification.expectedToMatch` when a comparison actually happened. */
  verifiedColumn: string | null;
  verification: {
    agreed: boolean | null;
    relativeDelta: number | null;
    definitionOk: boolean;
    concern: string;
    note: string;
  } | null;
  /** Sanity-gate flags: rates above 100%, and "every sample size below 50". */
  impossibleFlags: number;
  smallSampleFlags: number;
  /** Planned tasks that produced no usable result (each counted ONCE). */
  droppedTasks: number;
  plannedTasks: number;
  /** Narration attempts rejected for uncited numbers. */
  citationRetries: number;
  /** The planner's `assumptions` — choices the question left open. */
  assumptions: string[];
  /** Stored `metric:*` ids the question names, from `namedMetrics()`. */
  namedMetrics: string[];
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface Confidence {
  value: ConfidenceLevel;
  score: number;
  note: string;
  signals: ConfidenceSignal[];
}

// ── the weights (single source of truth; the table in API.md mirrors this) ──

/** Ceilings: while the condition holds the score cannot exceed the value. They
 * apply first, in this order, each lowering the running ceiling by what it adds,
 * so the deductions underneath stay visible instead of vanishing into a clamp. */
/** probe-2: two independently written queries disagree → never medium. */
const CEILING_VERIFICATION_FAILED = 0.44;
/** q3 / probe-1: nothing reproduced the figure → never high. */
const CEILING_UNVERIFIED = 0.7;
/** q3: sums, counts and means carry no interval → at most medium (was high 1.00). */
const CEILING_NO_BOUNDED_PRECISION = 0.6;

/** Headline interval, per half-width percentage point. spec-06 q1: ±3.1pp on
 * n=848 costs 0.09; walkthrough step 4: ±24pp on n=14 costs 0.65 (the maximum),
 * so a figure too wide to act on can never reach medium on its own. */
const HEADLINE_TIGHT_LIMIT_PP = 4;
const HEADLINE_TIGHT_PER_PP = 0.03;
const HEADLINE_MID_LIMIT_PP = 10;
const HEADLINE_MID_PER_PP = 0.075;
const HEADLINE_WIDE_BASE = 0.57;
const HEADLINE_WIDE_PER_PP = 0.008;
const HEADLINE_WIDE_EXTRA_CAP = 0.08;

/** TUNABLE — decides spec-06 q1 high vs medium: three tail segments (n=2, 14, 31)
 * beside a verified ±3.1pp headline cost 0.12 → 0.79 (high). At 0.06 each the same
 * answer would land on 0.73 (medium). */
const SMALL_SEGMENT_PENALTY = 0.04;
const SMALL_SEGMENTS_CAP = 0.12;
const SMALL_SEGMENT_N = 50;
const SMALL_SEGMENT_HW_PP = 10;

const RATES_WITHOUT_DENOMINATOR_PENALTY = 0.1;
const SMALL_SAMPLE_FLAG_PENALTY = 0.1;
const DEFINITION_CONCERN_PENALTY = 0.1;
const IMPOSSIBLE_VALUE_PENALTY = 0.1;
const IMPOSSIBLE_VALUES_CAP = 0.2;
const DROPPED_TASK_PENALTY = 0.07;
const DROPPED_TASKS_CAP = 0.21;
const CITATION_RETRY_PENALTY = 0.1;
const CITATION_RETRIES_CAP = 0.2;

/** TUNABLE — the vague-question lever of the walkthrough: "How is checkout doing?"
 * assumes metric, denominator, window and segment → the cap (−0.25) under an
 * unverified ceiling ≈ low 0.35; "What is the standard checkout conversion rate?"
 * assumes window and segment only → −0.16, still high (0.86) once verified. */
const ASSUMPTION_PENALTY = 0.08;
const ASSUMPTIONS_CAP = 0.25;

/** Naming a stored metric removes the definition ambiguity; the bonus only ever
 * offsets deductions, so a perfect answer stays at 1.00 rather than 1.05. */
const NAMED_METRIC_BONUS = 0.05;

const SCORE_FLOOR = 0.05;
/** Non-overlapping bands: high ≥ 0.75, medium ≥ 0.45, else low. */
const HIGH_FROM = 0.75;
const MEDIUM_FROM = 0.45;

const round2 = (x: number) => Math.round(x * 100) / 100;

type Bounded = Precision & { interval: NonNullable<Precision["interval"]> };
const isBounded = (p: Precision): p is Bounded => p.interval !== null;
const byColumn = (a: Precision, b: Precision) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0);

/**
 * The deduction for the headline figure's 95% half-width, in percentage points:
 * 0.03/pp up to ±4pp, then 0.075/pp up to ±10pp (0.57), then slowly on to 0.65.
 * Continuous at the joins so a figure just over a boundary is not punished for it.
 */
export function headlinePenalty(halfWidthPp: number): number {
  const hw = Math.max(0, Number.isFinite(halfWidthPp) ? halfWidthPp : 0);
  if (hw <= HEADLINE_TIGHT_LIMIT_PP) return HEADLINE_TIGHT_PER_PP * hw;
  if (hw <= HEADLINE_MID_LIMIT_PP) {
    return HEADLINE_TIGHT_PER_PP * HEADLINE_TIGHT_LIMIT_PP + HEADLINE_MID_PER_PP * (hw - HEADLINE_TIGHT_LIMIT_PP);
  }
  return HEADLINE_WIDE_BASE + Math.min(HEADLINE_WIDE_EXTRA_CAP, HEADLINE_WIDE_PER_PP * (hw - HEADLINE_MID_LIMIT_PP));
}

/**
 * The figure whose precision the answer rests on: the column an independent
 * query actually compared, else the widest whole-population (`full_*_rate`)
 * figure, else the bounded figure with the largest denominator. Ties break on
 * the column name, so a shuffled input picks the same headline. Null when
 * nothing is bounded.
 */
export function pickHeadline(
  precisions: Precision[],
  headlineColumns: string[],
  verifiedColumn: string | null,
): Precision | null {
  const all = precisions.filter(isBounded);
  if (all.length === 0) return null;

  // One entry per column FIRST, keeping the largest sample. Several tasks
  // answering one question emit the same column name at different grains — a
  // total, a breakdown by country, a breakdown by device, all `conversion_rate`.
  // The headline states the total, so that is the row whose interval the score
  // must reflect; picking the widest row of the column charged a 14,026-click
  // figure the ±6.8pp of a 198-row country slice and called a verified,
  // fully-powered answer "medium". Conservatism across DIFFERENT metrics is
  // still the rule below; within one metric, the best-supported row wins, and
  // the thin rows are charged separately by the `small_segments` signal.
  const byName = new Map<string, Bounded>();
  for (const p of all) {
    const prev = byName.get(p.column);
    const better =
      !prev ||
      (p.n ?? 0) > (prev.n ?? 0) ||
      ((p.n ?? 0) === (prev.n ?? 0) && p.interval.halfWidthPp > prev.interval.halfWidthPp);
    if (better) byName.set(p.column, p);
  }
  const bounded = [...byName.values()];

  const widestFirst = (a: Bounded, b: Bounded) =>
    b.interval.halfWidthPp - a.interval.halfWidthPp || byColumn(a, b);

  if (verifiedColumn) {
    const verified = bounded.filter((p) => p.column === verifiedColumn).sort(widestFirst)[0];
    if (verified) return verified;
  }
  const population = new Set(headlineColumns);
  const headline = bounded.filter((p) => population.has(p.column)).sort(widestFirst)[0];
  if (headline) return headline;

  return [...bounded].sort((a, b) => (b.n ?? 0) - (a.n ?? 0) || byColumn(a, b))[0] ?? null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words too common to prove an assumption was already stated in the question. */
const ASSUMPTION_STOPWORDS = new Set([
  "the", "and", "for", "all", "any", "with", "from", "into", "over", "per", "are",
  "was", "were", "use", "used", "using", "only", "both", "each", "that", "this",
  "than", "then", "data", "rows", "row", "value", "values", "applied", "apply",
  "assumed", "assume", "set",
  // "all platforms included" restricts nothing the question did not already say;
  // the word is filler. Its opposite is not — see POLARITY.
  "include", "included", "including",
]);

/**
 * Words that RESTRICT, folded to one form so tense cannot hide the restriction.
 *
 * `excluding` used to be a stopword, which let an assumption agree with a
 * question that said the opposite: asked "should we include refunded
 * transactions?", the plan "excluding refunded transactions" had only `refunded`
 * and `transactions` left to check, both stated, so the answer silently took the
 * other branch and was charged nothing for it.
 *
 * Only the restricting half is distinctive, and deliberately so. Leaving a
 * question out of a restriction is a real gap worth 0.08; the matching "all
 * platforms included" adds no restriction at all and stays filler. Folding
 * rather than listing keeps "excluding" agreeing with a question that said
 * "exclude", so specifying it still removes the charge.
 */
const POLARITY = new Map([
  ["excludes", "exclude"], ["excluded", "exclude"], ["excluding", "exclude"],
  ["omits", "exclude"], ["omitted", "exclude"], ["omitting", "exclude"],
  ["ignores", "exclude"], ["ignored", "exclude"], ["ignoring", "exclude"],
  ["without", "exclude"], ["drops", "exclude"], ["dropping", "exclude"],
]);

/**
 * A metric definition pins its FORMULA — numerator, denominator, filters, window.
 * It does not pin which slice was taken, even when it lists the dimensions the
 * metric can be cut by ("Cut by `device_type`/`geoip_country_code`..."). Reading
 * that menu as "stated" turned a real narrowing into a free one: the words of
 * "cut by device_type" were all present, so a segment choice the asker never made
 * cost nothing and vanished from the note telling them what to pin down.
 */
const stripDimensionMenu = (definition: string): string =>
  definition
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !/\b(cut|split|slice|segment|grouped?|break)\s+(it\s+)?by\b/i.test(sentence))
    .join(" ");

/**
 * Drop the "assumptions" the question already answered.
 *
 * Each assumption costs the answer 0.08 of confidence, which is the whole point:
 * it shows a PM exactly what to pin down to get a firmer number. That only works
 * if pinning it down actually removes the charge. The planner is told not to list
 * anything the question states (rule 9 of the plan prompt) and does it anyway —
 * asked for the rate "between 2026-01-01 and 2026-07-01, all platforms, payments
 * confirmed over pay_now_clicked applications", it returned all three back as
 * assumptions and the fully-specified question scored LOWER than the vague one.
 * Enforced here in code, deterministically, rather than hoped for in a prompt.
 *
 * Conservative by construction: an assumption is dropped only when every
 * distinctive word in it appears in the question. Anything that cannot be
 * checked — an assumption with no distinctive words, or one naming a value the
 * question expressed differently ("SG" for "Singapore") — is KEPT and still
 * charged. This can under-drop; it cannot silently erase a real assumption.
 */
export function unstatedAssumptions(
  question: string,
  assumptions: string[],
  /**
   * Definitions the question INVOKED — the stored `metric:*` entries it names.
   * A metric definition fixes its own denominator and filters, so a question
   * that names the metric has pinned those too, however many words it took. The
   * planner still lists them ("denominator = pay_now_clicked applications",
   * "apply data hygiene filters") and the answer was charged 0.08 each for
   * choices it was never free to make. Only the definitions of metrics the
   * question actually named are passed, never the whole store, so this stays a
   * narrow, relevant text rather than a sieve that drops real assumptions.
   */
  pinnedDefinitions: readonly string[] = [],
): string[] {
  // `.` and `-` stay word characters so `0.08`, `2026-01-01` and `p.pay_now_n`
  // survive; trimming them at the edges stops a sentence-final stop from making
  // `accounts.` a word that matches nothing.
  const tokenize = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, " ")
      .split(" ")
      .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
      .map((w) => POLARITY.get(w) ?? w)
      .filter(Boolean);

  const stated = new Set(
    tokenize([question, ...pinnedDefinitions.map(stripDimensionMenu)].join(" ")),
  );
  const statedList = [...stated];

  /**
   * Does the stated text contain this word?
   *
   * Exact token, or either half of a compound identifier: `applications`
   * matches `application_id`, and `hygiene` matches `convention:data_hygiene`.
   * Deliberately NOT a bare substring test — that would let `rate` match
   * `separate` — and deliberately not a stemmer. Only the plural `s` is
   * stripped, and only on a word long enough for it to mean anything.
   */
  const isStated = (word: string): boolean => {
    const forms = word.endsWith("s") && word.length >= 5 ? [word, word.slice(0, -1)] : [word];
    return forms.some(
      (f) =>
        stated.has(f) ||
        statedList.some((token) => token.startsWith(`${f}_`) || token.endsWith(`_${f}`)),
    );
  };

  return assumptions.filter((a) => {
    // "denominator = pay_now_clicked applications" is a claim about the part
    // AFTER the equals; the label is our vocabulary, not the asker's. Split on
    // the FIRST spaced `=` only: `lastIndexOf("=")` turned
    // "... is_back_filled != 1" into the claim " 1)", which has nothing
    // checkable in it, so the assumption was charged whatever the question said.
    const separator = / = /.exec(a);
    const claim = separator?.index !== undefined ? a.slice(separator.index + 3) : a;
    const words = tokenize(claim).filter(
      (w) => w.length >= 3 && !ASSUMPTION_STOPWORDS.has(w),
    );
    if (words.length === 0) return true; // nothing to check against — charge it
    return !words.every(isStated);
  });
}

/**
 * The stored `metric:*` entities a question names, detected in code: the id
 * (`metric:standard_checkout_conversion_rate`) is split on `_`, and it matches
 * when every word appears as a whole word in the lowercased question, or the id
 * itself appears literally. Sorted, so the same question always yields the same
 * list. Whole words only — "conversions" does not name `conversion_rate`.
 */
export function namedMetrics(question: string, entities: string[]): string[] {
  const q = question.toLowerCase();
  const matched = new Map<string, Set<string>>();
  for (const entity of entities) {
    if (!entity.toLowerCase().startsWith("metric:")) continue;
    const id = entity.slice("metric:".length).toLowerCase();
    const words = id.split("_").filter((w) => w.length > 0);
    if (words.length === 0 || matched.has(id)) continue;
    const literal = new RegExp(`(^|[^a-z0-9])${escapeRe(id)}(?![a-z0-9])`).test(q);
    const everyWord = words.every((w) => new RegExp(`\\b${escapeRe(w)}\\b`).test(q));
    if (literal || everyWord) matched.set(id, new Set(words));
  }
  // "the standard checkout conversion rate" contains every word of BOTH
  // `standard_checkout_conversion_rate` and `conversion_rate`. Only the specific
  // one was named: drop any match whose words are a strict subset of another's,
  // so the confidence note says which metric the question actually pins.
  const ids = [...matched.keys()];
  return ids
    .filter((id) => {
      const words = matched.get(id)!;
      return !ids.some((other) => {
        if (other === id) return false;
        const otherWords = matched.get(other)!;
        return otherWords.size > words.size && [...words].every((w) => otherWords.has(w));
      });
    })
    .sort();
}

/**
 * Confidence from measurements only. Ceilings first (a failed or missing
 * verification, nothing bounded), then additive deductions (headline interval,
 * small segments, gate flags, dropped tasks, citation retries, the planner's
 * assumptions), then a named-metric bonus that can only offset deductions.
 *
 * Invariants: `1 + Σsignals.delta === score` (to 2 dp — the UI can draw a
 * waterfall); `score ≤ every applicable ceiling`; `score ≥ 0.05`; the level is a
 * pure function of the score.
 */
export function deriveConfidence(input: ConfidenceInput): Confidence {
  const signals: ConfidenceSignal[] = [];
  const push = (name: string, delta: number, detail: string) =>
    signals.push({ name, delta: round2(delta), detail });

  // ── ceilings, in table order; each lowers the running ceiling by what it adds.
  // A ceiling already covered by a tighter one contributes 0 — surfaced, not counted.
  let ceiling = 1;
  const lowerCeiling = (name: string, to: number, detail: string) => {
    const next = Math.min(ceiling, to);
    push(name, next - ceiling, detail);
    ceiling = next;
  };

  const v = input.verification;
  if (v && v.agreed === false) {
    const delta = v.relativeDelta === null ? "" : ` (Δ ${(v.relativeDelta * 100).toFixed(1)}%)`;
    lowerCeiling(
      "verification_failed",
      CEILING_VERIFICATION_FAILED,
      `${v.note || "an independently written query did not reproduce the figure"}${delta}`,
    );
  } else if (!v || v.agreed === null) {
    lowerCeiling(
      "unverified",
      CEILING_UNVERIFIED,
      `not independently verified — ${v?.note || "no verification query was run"}`,
    );
  }

  const bounded = input.precisions.filter(isBounded);
  if (bounded.length === 0) {
    lowerCeiling(
      "no_bounded_precision",
      CEILING_NO_BOUNDED_PRECISION,
      "no figure carries an interval (sums, counts, means cannot be bounded)",
    );
  }

  // ── additive deductions
  let deductions = 0;
  const deduct = (name: string, amount: number, detail: string) => {
    const a = round2(amount);
    if (a <= 0) return;
    deductions = round2(deductions + a);
    push(name, -a, detail);
  };

  const headline = pickHeadline(input.precisions, input.headlineColumns, input.verifiedColumn);
  if (headline && isBounded(headline)) {
    const hw = headline.interval.halfWidthPp;
    const detail = `±${hw.toFixed(1)}pp on ${headline.column} (n=${headline.n})${
      hw > HEADLINE_MID_LIMIT_PP ? " — too wide to act on" : ""
    }`;
    const penalty = round2(headlinePenalty(hw));
    // a tight headline costs nothing but is still the fact the reader most wants
    if (penalty > 0) deduct("headline_interval", penalty, detail);
    else push("headline_interval", 0, detail);
  }

  const small = bounded
    .filter((p) => p !== headline)
    .filter((p) => (p.n !== null && p.n < SMALL_SEGMENT_N) || p.interval.halfWidthPp > SMALL_SEGMENT_HW_PP)
    .sort(byColumn);
  if (small.length > 0) {
    const ns = small.map((p) => p.n ?? 0);
    const range = small.length === 1 ? `n=${ns[0]}` : `n ${Math.min(...ns)}–${Math.max(...ns)}`;
    // Distinct column NAMES, not one per row. Confidence is fed every row so it
    // can count how many segments are thin, but a breakdown of 79 cities is 79
    // rows of two metrics — listing the names row by row wrote "adoption_rate,
    // adoption_rate, adoption_rate…" 79 times into the note a PM reads.
    const columns = [...new Set(small.map((p) => p.column))];
    const named = columns.slice(0, 4).join(", ");
    const rest = columns.length > 4 ? ` +${columns.length - 4} more` : "";
    deduct(
      "small_segments",
      Math.min(SMALL_SEGMENTS_CAP, small.length * SMALL_SEGMENT_PENALTY),
      `${small.length} small segment${small.length === 1 ? "" : "s"} (${named}${rest}; ${range}) — indicative only`,
    );
  }

  const rates = input.precisions.filter((p) => p.kind === "proportion");
  if (bounded.length === 0 && rates.length > 0) {
    deduct(
      "rates_without_denominator",
      RATES_WITHOUT_DENOMINATOR_PENALTY,
      `${rates.length} rate${rates.length === 1 ? " ships" : "s ship"} no denominator column`,
    );
  }
  if (bounded.length === 0 && input.smallSampleFlags > 0) {
    deduct("small_sample_flag", SMALL_SAMPLE_FLAG_PENALTY, "every sample size below 50");
  }

  if (v && v.definitionOk === false) {
    deduct(
      "definition_concern",
      DEFINITION_CONCERN_PENALTY,
      `auditor: ${v.concern || "the SQL did not use the documented denominator or filters"}`,
    );
  } else if (v && v.concern) {
    // the auditor agreed the definition holds but still had an argument — surfaced at no cost
    push("definition_concern", 0, `auditor: ${v.concern}`);
  }

  if (input.impossibleFlags > 0) {
    deduct(
      "impossible_values",
      Math.min(IMPOSSIBLE_VALUES_CAP, input.impossibleFlags * IMPOSSIBLE_VALUE_PENALTY),
      `${input.impossibleFlags} value${input.impossibleFlags === 1 ? " looks" : "s look"} like a rate above 100%`,
    );
  }
  if (input.droppedTasks > 0) {
    deduct(
      "dropped_tasks",
      Math.min(DROPPED_TASKS_CAP, input.droppedTasks * DROPPED_TASK_PENALTY),
      `${input.droppedTasks} of ${Math.max(input.plannedTasks, input.droppedTasks)} planned task${input.plannedTasks === 1 ? "" : "s"} returned no data`,
    );
  }
  if (input.citationRetries > 0) {
    deduct(
      "citation_retries",
      Math.min(CITATION_RETRIES_CAP, input.citationRetries * CITATION_RETRY_PENALTY),
      `narration corrected ${input.citationRetries}× for uncited numbers`,
    );
  }
  const assumptions = input.assumptions.map((a) => a.trim()).filter((a) => a.length > 0);
  if (assumptions.length > 0) {
    deduct(
      "assumptions",
      Math.min(ASSUMPTIONS_CAP, assumptions.length * ASSUMPTION_PENALTY),
      `assumed: ${assumptions.join("; ")}`,
    );
  }

  // ── bonus, never above what was deducted — so 1 + Σdelta stays the score
  let bonus = 0;
  if (input.namedMetrics.length > 0) {
    bonus = round2(Math.min(NAMED_METRIC_BONUS, deductions));
    push("named_metric", bonus, `question pins a stored metric: ${[...input.namedMetrics].sort().join(", ")}`);
  }

  let score = round2(ceiling - deductions + bonus);
  if (score < SCORE_FLOOR) {
    // the floor is a signal too, so the waterfall still sums to the score
    push("floor", SCORE_FLOOR - score, `score floored at ${SCORE_FLOOR.toFixed(2)}`);
    score = SCORE_FLOOR;
  }

  const value: ConfidenceLevel = score >= HIGH_FROM ? "high" : score >= MEDIUM_FROM ? "medium" : "low";

  const noted = signals.filter((s) => s.delta !== 0 || s.name === "definition_concern");
  const fallback = signals.filter((s) => s.name === "headline_interval");
  const note =
    (noted.length > 0 ? noted : fallback).map((s) => s.detail).join("; ") ||
    "verified, bounded, nothing assumed — no deductions";

  return { value, score, note, signals };
}
