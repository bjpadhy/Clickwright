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
export const COUNT_RE = /(^|_)(n|count|users|sessions|rows|events|applications|payers|uploads|opens|clicks)$/i;

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
export function denominatorColumnsFromSql(
  rateColumn: string,
  sql: string,
  columns: readonly string[],
): string[] {
  const item = selectItemFor(rateColumn, sql);
  if (!item) return [];
  const divisor = divisorOf(item);
  if (!divisor) return [];

  const out: string[] = [];
  const present = new Set(columns);

  // the divisor is itself one of the returned columns
  const bare = divisor.replace(/`/g, "").trim();
  const column = /^[a-z_][a-z0-9_]*$/i.test(bare) ? bare : bare.split(".").pop() ?? "";
  if (column && column !== rateColumn && present.has(column)) out.push(column);

  // the divisor is an expression that some other column also selects
  const target = normalize(divisor);
  for (const candidate of columns) {
    if (candidate === rateColumn || out.includes(candidate)) continue;
    const candidateItem = selectItemFor(candidate, sql);
    if (candidateItem && normalize(candidateItem) === target) out.push(candidate);
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

export interface ConfidenceInput {
  precisions: Precision[];
  sanityFlags: number;
  citationRetries: number;
  /** Did an independent verification query agree? null when none was run. */
  verificationAgreed: boolean | null;
}

/**
 * Confidence is COMPUTED, never asked of the model. Each input is a measurement:
 * the widest reported interval, gate flags, citation retries, and whether an
 * independently written query reproduced the number.
 */
export function deriveConfidence(input: ConfidenceInput): {
  value: "high" | "medium" | "low";
  score: number;
  note: string;
} {
  const reasons: string[] = [];
  let level: "high" | "medium" | "low" = "high";
  const drop = (to: "medium" | "low", why: string) => {
    reasons.push(why);
    if (to === "low" || level === "medium") level = to === "low" ? "low" : level;
    if (level === "high") level = to;
  };

  if (input.verificationAgreed === false) {
    level = "low";
    reasons.push("an independently written query did not reproduce the figure");
  }
  if (input.citationRetries > 0) drop("medium", "the narration had to be corrected for uncited numbers");
  if (input.sanityFlags > 0) drop("medium", "the sanity gate raised flags");

  const bounded = input.precisions.filter((p) => p.interval);
  const widest = bounded.sort((a, b) => (b.interval!.halfWidthPp) - (a.interval!.halfWidthPp))[0];
  if (widest) {
    const hw = widest.interval!.halfWidthPp;
    if (hw > 10) drop("low", `±${hw.toFixed(1)}pp on ${widest.column} (n=${widest.n}) — too wide to act on`);
    else if (hw > 4) drop("medium", `±${hw.toFixed(1)}pp on ${widest.column} (n=${widest.n})`);
    else reasons.push(`tightest bound ±${hw.toFixed(1)}pp on n=${widest.n}`);
  }

  const unbounded = input.precisions.filter((p) => !p.interval);
  if (bounded.length === 0 && unbounded.length > 0) {
    drop("medium", `precision not computable for ${unbounded.map((u) => u.column).join(", ")}`);
  }

  if (input.verificationAgreed === true) {
    reasons.push("an independently written query reproduced the figure");
  }

  return {
    value: level,
    score: confidenceScore(input, level),
    note: reasons.join("; ") || "no precision signals available",
  };
}

/**
 * The same judgement as `value`, on a 0–1 scale, so a reader can see that two
 * "medium" answers are not equally solid.
 *
 * It is a deduction from 1, not a model's guess: each measurement that weakens
 * the answer subtracts a fixed amount, and the widest interval subtracts in
 * proportion to how wide it is. Clamped into the band its level implies, so the
 * number and the label can never disagree.
 */
function confidenceScore(input: ConfidenceInput, level: "high" | "medium" | "low"): number {
  let score = 1;
  if (input.verificationAgreed === false) score -= 0.45;
  else if (input.verificationAgreed === true) score += 0.05;
  score -= Math.min(0.2, input.citationRetries * 0.1);
  score -= Math.min(0.2, input.sanityFlags * 0.07);

  const bounded = input.precisions.filter((p) => p.interval);
  const widest = Math.max(0, ...bounded.map((p) => p.interval!.halfWidthPp));
  // ±0pp costs nothing, ±15pp or worse costs the full 0.35
  if (bounded.length > 0) score -= Math.min(0.35, (widest / 15) * 0.35);
  else if (input.precisions.length > 0) score -= 0.15; // nothing could be bounded

  const band = level === "high" ? [0.75, 1] : level === "medium" ? [0.45, 0.8] : [0.05, 0.5];
  return Math.round(Math.min(band[1]!, Math.max(band[0]!, score)) * 100) / 100;
}
