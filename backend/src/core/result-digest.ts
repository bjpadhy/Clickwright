/**
 * Full-result-set profiling.
 *
 * A task query can return far more rows than a narrator can read. Showing it the
 * first N and letting it generalise would turn "the first 24 rows" into a claim
 * about all 52,340 — so instead the ANALYSIS moves into ClickHouse: the task's own
 * statement becomes a subquery and one wide aggregate describes every row of its
 * result. The narrator then reads exact whole-set figures plus a labelled sample,
 * and the context cost is a constant no matter how large the result is.
 *
 * Two properties make this safe rather than merely compact:
 *
 *  1. Every digest figure is a ClickHouse result, so it flows through the citation
 *     pool, `precisionForRow` and the sanity gate like any other query output. The
 *     chain from a reported number back to the database stays unbroken.
 *  2. Nothing here is written by a model. The queries are generated from the
 *     result's column types, so a profile cannot hallucinate.
 *
 * The headline emission is the population-weighted rate: `sum(rate * n) / sum(n)`
 * aliased `full_<base>_rate` alongside `sum(n) AS full_<base>_n`. Those names ride
 * the conventions in precision.ts, so the existing Wilson code bounds a figure
 * computed over the entire population — a mean of per-segment rates (which is what
 * `avg(rate)` would give) is a different and usually wrong number, so it is never
 * emitted for a rate column.
 */
import { queryReadonly } from "./db.js";
import { recordQuery, step, type Ctx } from "./tracing.js";
import {
  COUNT_RE,
  RATE_RE,
  denominatorColumnFor,
  denominatorColumnsFromSql,
} from "./precision.js";

/** Rows returned by each extremes query — the best and worst of the full set. */
export const EXTREME_ROWS = 5;

// Backstops only: an aggregate result normally has a handful of columns. They stop
// a freak 200-column result from producing a digest bigger than the rows it replaces.
const MAX_RATE_COLS = 4;
const MAX_COUNT_COLS = 3;
const MAX_NUMERIC_COLS = 3;
const MAX_TEMPORAL_COLS = 2;
const MAX_CATEGORICAL_COLS = 4;
const MAX_EMISSIONS = 64;

/** How many fetched rows to inspect when DESCRIBE is unavailable. */
const CLASSIFY_SAMPLE = 200;

export type ColumnKind = "rate" | "count" | "numeric" | "temporal" | "categorical" | "other";

export interface ResultColumn {
  name: string;
  kind: ColumnKind;
}

export type DigestStat =
  | "total_rows"
  | "min"
  | "max"
  | "p50"
  | "avg"
  | "sum"
  | "gt1_n"
  | "full_rate"
  | "full_n"
  | "distinct";

export interface DigestEmission {
  /** Column name in the digest result. */
  alias: string;
  /** The result column it describes; "" for whole-result figures like total_rows. */
  column: string;
  stat: DigestStat;
  /** For `full_rate`: the column supplying the weights. */
  denominator?: string;
}

export interface DigestPlan {
  sql: string;
  emissions: DigestEmission[];
}

export interface ColumnStat {
  column: string;
  kind: ColumnKind;
  /** stat name → value, exactly as ClickHouse returned it. */
  stats: Array<{ stat: DigestStat; alias: string; value: unknown }>;
}

export interface ResultExtremes {
  metric: string;
  top: Record<string, unknown>[];
  bottom: Record<string, unknown>[];
  topSql: string;
  bottomSql: string;
  /** Set when the extremes queries could not run; the digest still stands. */
  note?: string;
}

export interface ResultDigest {
  /** Exact count over the whole result set — never the fetched row count. */
  totalRows: number;
  /** The one-row digest result verbatim. */
  statsRow: Record<string, unknown>;
  /** Whole-result figures (total_rows, population rates and their denominators). */
  population: Record<string, unknown>;
  /** Transposed per-column view, for rendering. */
  columnStats: ColumnStat[];
  emissions: DigestEmission[];
  sql: string;
  extremes: ResultExtremes | null;
  /** True when column types came from sampled values because DESCRIBE failed. */
  typesFromSample: boolean;
}

// ── column classification ────────────────────────────────────────

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A Date/DateTime value as JSONEachRow renders it. */
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?/;

const quote = (name: string) => `\`${name}\``;

/** Refine a numeric column by the same name conventions precision.ts uses. */
function numericKind(name: string): ColumnKind {
  if (RATE_RE.test(name)) return "rate";
  if (COUNT_RE.test(name)) return "count";
  return "numeric";
}

/**
 * Classify from ClickHouse's own types (via `DESCRIBE (subquery)`). Preferred over
 * inspecting values because a String column of "404"/"500" looks numeric in JSON,
 * and asking for avg() of it fails the entire profile.
 */
export function classifyFromTypes(
  described: Array<{ name: string; type: string }>,
): ResultColumn[] {
  return described
    .filter((c) => SAFE_IDENT.test(c.name))
    .map(({ name, type }) => {
      let t = type.trim();
      // Nullable(LowCardinality(String)) and friends — unwrap to the payload type.
      for (;;) {
        const m = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(t);
        if (!m?.[1]) break;
        t = m[1].trim();
      }
      if (/^Bool/i.test(t)) return { name, kind: "other" as ColumnKind };
      if (/^(UInt|Int|Float|Decimal)/i.test(t)) return { name, kind: numericKind(name) };
      if (/^(Date|DateTime)/i.test(t)) return { name, kind: "temporal" as ColumnKind };
      if (/^(String|FixedString|Enum|UUID|IPv)/i.test(t))
        return { name, kind: "categorical" as ColumnKind };
      return { name, kind: "other" as ColumnKind };
    });
}

/**
 * Fallback classification from fetched values. Reads EVERY sampled row rather than
 * the first: one NULL in row one would otherwise retype a numeric column as text.
 * A column counts as numeric only when all its non-null sampled values parse —
 * being wrong here costs the whole digest.
 */
export function classifyResultColumns(rows: Record<string, unknown>[]): ResultColumn[] {
  const names: string[] = [];
  for (const row of rows.slice(0, CLASSIFY_SAMPLE)) {
    for (const k of Object.keys(row)) if (!names.includes(k)) names.push(k);
  }
  return names
    .filter((name) => SAFE_IDENT.test(name))
    .map((name) => {
      let nonNull = 0;
      let numeric = 0;
      let temporal = 0;
      let other = 0;
      for (const row of rows.slice(0, CLASSIFY_SAMPLE)) {
        const v = row[name];
        if (v === null || v === undefined || v === "") continue;
        nonNull++;
        if (typeof v === "number") {
          numeric++;
        } else if (typeof v === "string") {
          if (DATE_LIKE.test(v)) temporal++;
          else if (v.trim() !== "" && Number.isFinite(Number(v))) numeric++;
          else other++;
        } else {
          other++;
        }
      }
      if (nonNull === 0) return { name, kind: "other" as ColumnKind };
      if (temporal === nonNull) return { name, kind: "temporal" as ColumnKind };
      if (numeric === nonNull) return { name, kind: numericKind(name) };
      if (other > 0 && numeric === 0 && temporal === 0)
        return { name, kind: "categorical" as ColumnKind };
      return { name, kind: "other" as ColumnKind };
    });
}

// ── digest SQL ───────────────────────────────────────────────────

/**
 * The row set to profile. A LIMIT the SQL writer authored is part of what the task
 * MEANS ("the top 10 cities"), so it stays inside the scope; the cap the guard
 * appends for transport is not, and never reaches here.
 */
export function digestScope(core: string, authoredLimit: number | null): string {
  return authoredLimit === null ? core : `${core}\nLIMIT ${authoredLimit}`;
}

/** Allocate a collision-free alias; result column names are reserved so an
 * emitted alias can never shadow a column the aggregates read. */
function aliasFactory(reserved: readonly string[]): (want: string) => string {
  const used = new Set(reserved);
  return (want: string) => {
    let alias = want;
    for (let i = 2; used.has(alias); i++) alias = `${want}_d${i}`;
    used.add(alias);
    return alias;
  };
}

/**
 * One single-pass aggregate describing every row of the result set.
 *
 * Deliberately absent: `avg()` of a rate column. It would be a mean of
 * per-segment rates — a number that looks like "the overall rate", differs from
 * it whenever segments have unequal denominators, and is citable once emitted.
 * The weighted `full_<base>_rate` below is that figure, computed correctly.
 */
export function buildDigestSql(scope: string, columns: ResultColumn[]): DigestPlan {
  const names = columns.map((c) => c.name);
  const alias = aliasFactory(names);
  const emissions: DigestEmission[] = [];
  const selects: string[] = [];

  const emit = (expr: string, want: string, e: Omit<DigestEmission, "alias">): void => {
    if (emissions.length >= MAX_EMISSIONS) return;
    const a = alias(want);
    selects.push(`${expr} AS ${a}`);
    emissions.push({ alias: a, ...e });
  };

  emit("count()", "total_rows", { column: "", stat: "total_rows" });

  const pick = (kind: ColumnKind, cap: number) =>
    columns.filter((c) => c.kind === kind).slice(0, cap);

  const denominatorCandidates = columns
    .filter((x) => x.kind === "count" || x.kind === "numeric")
    .map((x) => x.name);

  for (const c of pick("rate", MAX_RATE_COLS)) {
    const q = quote(c.name);
    emit(`min(${q})`, `${c.name}_min`, { column: c.name, stat: "min" });
    emit(`max(${q})`, `${c.name}_max`, { column: c.name, stat: "max" });
    emit(`quantile(0.5)(${q})`, `${c.name}_p50_approx`, { column: c.name, stat: "p50" });
    // Exact count of impossible values across the whole set — strictly more useful
    // than "a rate above 100% exists somewhere in here".
    emit(`countIf(${q} > 1.05)`, `${c.name}_gt1_n`, { column: c.name, stat: "gt1_n" });

    // What the query divided by, before what the column is called — the same
    // order precision.ts resolves a fetched row with. A funnel rate written per
    // the SQL prompt (`purchased_n / offer_shown_n AS attach_rate`) matches no
    // naming convention, and losing its population figure here would silently
    // drop the digest's headline deliverable for exactly the encouraged shape.
    const den =
      denominatorColumnsFromSql(c.name, scope, denominatorCandidates)[0] ??
      denominatorColumnFor(c.name, denominatorCandidates);
    if (!den) continue;
    // `full_<base>_rate` + `full_<base>_n` are read by classifyMetric and
    // findDenominator exactly as a query's own rate and denominator would be, so
    // the population figure gets a Wilson interval with no special-casing.
    const base = c.name.replace(RATE_RE, "").replace(/_$/, "");
    const stem = base ? `full_${base}` : "full";
    const dq = quote(den);
    emit(`sum(${q} * ${dq}) / sum(${dq})`, `${stem}_rate`, {
      column: c.name,
      stat: "full_rate",
      denominator: den,
    });
    emit(`sum(${dq})`, `${stem}_n`, { column: den, stat: "full_n" });
  }

  for (const c of pick("count", MAX_COUNT_COLS)) {
    const q = quote(c.name);
    emit(`min(${q})`, `${c.name}_min`, { column: c.name, stat: "min" });
    emit(`max(${q})`, `${c.name}_max`, { column: c.name, stat: "max" });
    emit(`sum(${q})`, `full_${c.name}_sum`, { column: c.name, stat: "sum" });
  }

  for (const c of pick("numeric", MAX_NUMERIC_COLS)) {
    const q = quote(c.name);
    emit(`min(${q})`, `${c.name}_min`, { column: c.name, stat: "min" });
    emit(`max(${q})`, `${c.name}_max`, { column: c.name, stat: "max" });
    emit(`avg(${q})`, `${c.name}_avg`, { column: c.name, stat: "avg" });
    emit(`quantile(0.5)(${q})`, `${c.name}_p50_approx`, { column: c.name, stat: "p50" });
  }

  for (const c of pick("temporal", MAX_TEMPORAL_COLS)) {
    const q = quote(c.name);
    emit(`min(${q})`, `${c.name}_min`, { column: c.name, stat: "min" });
    emit(`max(${q})`, `${c.name}_max`, { column: c.name, stat: "max" });
  }

  for (const c of pick("categorical", MAX_CATEGORICAL_COLS)) {
    emit(`uniq(${quote(c.name)})`, `${c.name}_distinct_approx`, {
      column: c.name,
      stat: "distinct",
    });
  }

  return {
    sql: `SELECT\n  ${selects.join(",\n  ")}\nFROM (\n${scope}\n) AS __result`,
    emissions,
  };
}

/**
 * The metric to rank the result set by. Prefers a rate that carries its own
 * denominator, so the extreme rows arrive with the sample sizes that make their
 * intervals honest — a 100% conversion on 3 rows should not read like a win.
 */
export function pickExtremesMetric(
  columns: ResultColumn[],
  emissions: DigestEmission[],
): string | null {
  const weighted = new Set(
    emissions.filter((e) => e.stat === "full_rate").map((e) => e.column),
  );
  return (
    columns.find((c) => c.kind === "rate" && weighted.has(c.name))?.name ??
    columns.find((c) => c.kind === "rate")?.name ??
    columns.find((c) => c.kind === "numeric")?.name ??
    columns.find((c) => c.kind === "count")?.name ??
    null
  );
}

/** Real rows from the ends of the full result set — `SELECT *` is correct here:
 * these are our own generated queries over an already-aggregated result, and the
 * rows must arrive whole to stay citable and precision-checkable. */
export function buildExtremesSql(
  scope: string,
  metric: string,
  direction: "DESC" | "ASC",
): string {
  return `SELECT * FROM (\n${scope}\n) AS __result ORDER BY ${quote(metric)} ${direction} LIMIT ${EXTREME_ROWS}`;
}

// ── shaping the result ───────────────────────────────────────────

const POPULATION_STATS: ReadonlySet<DigestStat> = new Set<DigestStat>([
  "total_rows",
  "full_rate",
  "full_n",
  "sum",
]);

/** Split the flat digest row into whole-result figures and a per-column view. */
export function shapeDigest(
  statsRow: Record<string, unknown>,
  emissions: DigestEmission[],
  columns: ResultColumn[],
): { population: Record<string, unknown>; columnStats: ColumnStat[] } {
  const population: Record<string, unknown> = {};
  const byColumn = new Map<string, ColumnStat>();
  const kindOf = new Map(columns.map((c) => [c.name, c.kind]));

  for (const e of emissions) {
    const value = statsRow[e.alias];
    if (POPULATION_STATS.has(e.stat)) population[e.alias] = value;
    if (e.column === "") continue;
    let entry = byColumn.get(e.column);
    if (!entry) {
      entry = { column: e.column, kind: kindOf.get(e.column) ?? "other", stats: [] };
      byColumn.set(e.column, entry);
    }
    entry.stats.push({ stat: e.stat, alias: e.alias, value });
  }
  return { population, columnStats: [...byColumn.values()] };
}

/**
 * The sub-row of whole-population figures, for `precisionForRow`. Only these
 * deserve an interval: a min, a max or a median across result rows describes the
 * spread of segments, not the uncertainty of a population estimate.
 */
export function populationRow(digest: ResultDigest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of digest.emissions) {
    if (e.stat === "full_rate" || e.stat === "full_n") out[e.alias] = digest.statsRow[e.alias];
  }
  return out;
}

/**
 * Gate flags the fetched sample cannot support: an impossible rate anywhere in the
 * result set, and sample sizes that are small in EVERY row of it rather than only
 * in the rows we happened to fetch.
 */
export function digestFlags(digest: ResultDigest): string[] {
  const flags: string[] = [];
  const valueOf = (e: DigestEmission) => Number(digest.statsRow[e.alias]);

  for (const e of digest.emissions) {
    if (e.stat !== "gt1_n") continue;
    const n = valueOf(e);
    if (Number.isFinite(n) && n > 0) {
      flags.push(
        `${e.column} looks like a rate above 100% in ${n} of ${digest.totalRows} rows (entire result set)`,
      );
    }
  }

  const countMaxes = digest.emissions.filter(
    (e) => e.stat === "max" && digest.columnStats.some((c) => c.column === e.column && c.kind === "count"),
  );
  const maxes = countMaxes.map(valueOf).filter((n) => Number.isFinite(n));
  if (maxes.length > 0 && maxes.every((n) => n < 50)) {
    flags.push(
      `every sample size across all ${digest.totalRows} rows is below 50 — low confidence`,
    );
  }
  return flags;
}

/** The profile as the narrator reads it: whole-set figures first, then spread per
 * column, then the named extremes. Compact by design — this replaces rows, so it
 * must not cost what the rows would have. */
export function renderDigest(digest: ResultDigest): string {
  const lines: string[] = [];
  lines.push(
    `FULL-RESULT-SET PROFILE — computed by ClickHouse over ALL ${digest.totalRows} rows of this result:`,
  );
  lines.push(`  whole-set figures: ${JSON.stringify(digest.population)}`);

  for (const c of digest.columnStats) {
    const parts = c.stats
      .filter((s) => s.stat !== "full_n")
      .map((s) => {
        const v = typeof s.value === "number" ? s.value : String(s.value ?? "null");
        switch (s.stat) {
          case "min":
            return `min ${v}`;
          case "max":
            return `max ${v}`;
          case "p50":
            return `median about ${v}`;
          case "avg":
            return `mean across rows ${v}`;
          case "sum":
            return `total ${v} (${s.alias})`;
          case "gt1_n":
            return `${v} rows above 100%`;
          case "distinct":
            return `about ${v} distinct values`;
          case "full_rate":
            return `population-weighted value ${v} (${s.alias})`;
          default:
            return `${s.stat} ${v}`;
        }
      });
    if (parts.length > 0) lines.push(`  ${c.column} (over all rows): ${parts.join("; ")}`);
  }

  if (digest.extremes) {
    const e = digest.extremes;
    if (e.note) lines.push(`  extremes unavailable: ${e.note}`);
    if (e.top.length > 0)
      lines.push(`  highest ${EXTREME_ROWS} rows of the full set by ${e.metric}: ${JSON.stringify(e.top)}`);
    if (e.bottom.length > 0)
      lines.push(`  lowest ${EXTREME_ROWS} rows of the full set by ${e.metric}: ${JSON.stringify(e.bottom)}`);
  }
  if (digest.typesFromSample)
    lines.push("  (column types inferred from fetched rows — DESCRIBE was unavailable)");
  return lines.join("\n");
}

// ── execution ────────────────────────────────────────────────────

export interface ProfileInput {
  taskId: string;
  /** The task statement with no appended transport cap. */
  core: string;
  /** A trailing LIMIT the SQL writer authored, which is part of the question. */
  authoredLimit: number | null;
  /** Rows already fetched — used only if DESCRIBE cannot type the result. */
  rows: Record<string, unknown>[];
}

/**
 * Profile the whole result set. Traced as its own step so the trace shows exactly
 * which queries backed the whole-set numbers.
 *
 * Throws only when the digest itself cannot be produced — the caller degrades to
 * the fetched sample and says so. Extremes failing is not fatal: a profile without
 * named best/worst rows is still a profile over every row.
 */
export async function profileResult(parent: Ctx, input: ProfileInput): Promise<ResultDigest> {
  return step(parent, `digest_${input.taskId}`, { rowsFetched: input.rows.length }, async (span) => {
    const scope = digestScope(input.core, input.authoredLimit);

    let columns: ResultColumn[];
    let typesFromSample = false;
    try {
      const described = await queryReadonly<{ name: string; type: string }>(
        `DESCRIBE (\n${scope}\n)`,
      );
      columns = classifyFromTypes(described);
      if (columns.length === 0) throw new Error("DESCRIBE returned no usable columns");
    } catch {
      // Metadata unavailable (an exotic result shape, a server restriction): fall
      // back to values. Recorded on the digest so the narration can be honest.
      columns = classifyResultColumns(input.rows);
      typesFromSample = true;
    }

    const plan = buildDigestSql(scope, columns);
    const statsRows = await queryReadonly<Record<string, unknown>>(plan.sql);
    recordQuery(span, `digest_result_${input.taskId}`, plan.sql, statsRows);
    const statsRow = statsRows[0];
    if (!statsRow) throw new Error("digest query returned no row");

    const totalRowsAlias =
      plan.emissions.find((e) => e.stat === "total_rows")?.alias ?? "total_rows";
    const totalRows = Number(statsRow[totalRowsAlias]);
    if (!Number.isFinite(totalRows)) throw new Error("digest produced no row count");

    const { population, columnStats } = shapeDigest(statsRow, plan.emissions, columns);

    const digest: ResultDigest = {
      totalRows,
      statsRow,
      population,
      columnStats,
      emissions: plan.emissions,
      sql: plan.sql,
      extremes: null,
      typesFromSample,
    };

    const metric = pickExtremesMetric(columns, plan.emissions);
    if (metric) {
      const topSql = buildExtremesSql(scope, metric, "DESC");
      const bottomSql = buildExtremesSql(scope, metric, "ASC");
      try {
        // Independent statements, so each gets its own execution budget rather
        // than sharing one with the aggregate.
        const [top, bottom] = await Promise.all([
          queryReadonly<Record<string, unknown>>(topSql),
          queryReadonly<Record<string, unknown>>(bottomSql),
        ]);
        recordQuery(span, `digest_top_${input.taskId}`, topSql, top);
        recordQuery(span, `digest_bottom_${input.taskId}`, bottomSql, bottom);
        digest.extremes = { metric, top, bottom, topSql, bottomSql };
      } catch (error) {
        digest.extremes = {
          metric,
          top: [],
          bottom: [],
          topSql,
          bottomSql,
          note: error instanceof Error ? error.message.split("\n")[0] ?? "failed" : String(error),
        };
      }
    }
    return digest;
  });
}
