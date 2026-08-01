import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDigestSql,
  buildExtremesSql,
  classifyFromTypes,
  classifyResultColumns,
  digestFlags,
  digestScope,
  pickExtremesMetric,
  populationRow,
  renderDigest,
  shapeDigest,
  type ResultDigest,
} from "../../src/core/result-digest.js";
import { classifyMetric, findDenominator, precisionForRow } from "../../src/core/precision.js";

// ── scope ────────────────────────────────────────────────────────

test("an authored LIMIT stays inside the profiled scope, a transport cap never reaches it", () => {
  // "the 10 worst cities" means ten rows; profiling the unlimited query would
  // describe a different question than the one that was asked.
  assert.equal(digestScope("SELECT a FROM t ORDER BY a", 10), "SELECT a FROM t ORDER BY a\nLIMIT 10");
  assert.equal(digestScope("SELECT a FROM t", null), "SELECT a FROM t");
});

// ── classification ───────────────────────────────────────────────

test("classifyFromTypes unwraps Nullable and LowCardinality to the payload type", () => {
  const cols = classifyFromTypes([
    { name: "conversion_rate", type: "Float64" },
    { name: "conversion_n", type: "UInt64" },
    { name: "city", type: "LowCardinality(Nullable(String))" },
    { name: "day", type: "Date" },
    { name: "seen_at", type: "Nullable(DateTime64(3))" },
    { name: "latency_ms", type: "Decimal(10, 2)" },
    { name: "tags", type: "Array(String)" },
    { name: "ok", type: "Bool" },
  ]);
  assert.deepEqual(cols, [
    { name: "conversion_rate", kind: "rate" },
    { name: "conversion_n", kind: "count" },
    { name: "city", kind: "categorical" },
    { name: "day", kind: "temporal" },
    { name: "seen_at", kind: "temporal" },
    { name: "latency_ms", kind: "numeric" },
    { name: "tags", kind: "other" },
    { name: "ok", kind: "other" },
  ]);
});

test("classifyFromTypes keeps a numeric-looking String column categorical", () => {
  // The failure this prevents: JSONEachRow renders a String "404" indistinguishably
  // from a number, and asking ClickHouse for avg() of it fails the whole profile.
  assert.deepEqual(classifyFromTypes([{ name: "status_code", type: "String" }]), [
    { name: "status_code", kind: "categorical" },
  ]);
});

test("classifyResultColumns reads every sampled row, not just the first", () => {
  // A NULL in row one must not retype a numeric column as text.
  const rows = [
    { city: "Delhi", n: null, day: "2025-03-01" },
    { city: "Mumbai", n: 42, day: "2025-03-02" },
  ];
  assert.deepEqual(classifyResultColumns(rows), [
    { name: "city", kind: "categorical" },
    { name: "n", kind: "count" },
    { name: "day", kind: "temporal" },
  ]);
});

test("classifyResultColumns refuses to call a mixed column numeric", () => {
  // Being wrong costs the entire digest, so anything ambiguous is left out of it.
  const rows = [{ x: 1 }, { x: "not a number" }];
  assert.deepEqual(classifyResultColumns(rows), [{ name: "x", kind: "other" }]);
  assert.deepEqual(classifyResultColumns([{ x: null }]), [{ name: "x", kind: "other" }]);
});

test("classifyResultColumns skips names that cannot be safely quoted", () => {
  // A backtick in an identifier would break out of the quoting the digest relies on.
  assert.deepEqual(classifyResultColumns([{ "we`ird": 1, session_n: 2 }]), [
    { name: "session_n", kind: "count" },
  ]);
});

// ── digest SQL ───────────────────────────────────────────────────

const RATE_RESULT = [
  { name: "city", kind: "categorical" as const },
  { name: "conversion_rate", kind: "rate" as const },
  { name: "conversion_n", kind: "count" as const },
];

test("a rate with a resolvable denominator gets a population-weighted figure", () => {
  const plan = buildDigestSql("SELECT 1", RATE_RESULT);
  assert.match(
    plan.sql,
    /sum\(`conversion_rate` \* `conversion_n`\) \/ sum\(`conversion_n`\) AS full_conversion_rate/,
  );
  assert.match(plan.sql, /sum\(`conversion_n`\) AS full_conversion_n/);
  assert.match(plan.sql, /count\(\) AS total_rows/);
  assert.match(plan.sql, /FROM \(\nSELECT 1\n\) AS __result$/);
});

test("the population rate and its denominator are named so existing precision code bounds them", () => {
  // This is the whole point of the naming: no special-casing in precision.ts.
  const plan = buildDigestSql("SELECT 1", RATE_RESULT);
  const rateAlias = plan.emissions.find((e) => e.stat === "full_rate")?.alias ?? "";
  const nAlias = plan.emissions.find((e) => e.stat === "full_n")?.alias ?? "";
  const row = { [rateAlias]: 0.4, [nAlias]: 500 };

  assert.equal(classifyMetric(rateAlias, 0.4, plan.sql), "proportion");
  assert.equal(findDenominator(rateAlias, row), 500);

  const [precision] = precisionForRow(row, plan.sql);
  assert.equal(precision?.column, rateAlias);
  assert.equal(precision?.n, 500);
  assert.ok(precision?.interval, "a population rate with a denominator must get an interval");
});

test("a rate column named exactly `rate` still resolves its denominator", () => {
  const plan = buildDigestSql("SELECT 1", [
    { name: "rate", kind: "rate" },
    { name: "n", kind: "count" },
  ]);
  const rateAlias = plan.emissions.find((e) => e.stat === "full_rate")?.alias;
  const nAlias = plan.emissions.find((e) => e.stat === "full_n")?.alias;
  assert.equal(rateAlias, "full_rate");
  assert.equal(nAlias, "full_n");
  assert.equal(findDenominator("full_rate", { full_n: 12 }), 12);
});

test("a funnel rate written as a division of named counts keeps its population figure", () => {
  // The SQL prompt asks for rates as divisions of counts named for what they
  // count — attach_rate shares no name stem with offer_shown_n, so the naming
  // convention alone dropped the whole-set figure for exactly the encouraged shape.
  const core = `SELECT city,
    uniqExact(user_id) AS offer_shown_n,
    uniqExactIf(user_id, purchased = 1) AS purchased_n,
    purchased_n / offer_shown_n AS attach_rate
  FROM events GROUP BY city`;
  const plan = buildDigestSql(core, [
    { name: "city", kind: "categorical" },
    { name: "offer_shown_n", kind: "count" },
    { name: "purchased_n", kind: "count" },
    { name: "attach_rate", kind: "rate" },
  ]);
  assert.match(
    plan.sql,
    /sum\(`attach_rate` \* `offer_shown_n`\) \/ sum\(`offer_shown_n`\) AS full_attach_rate/,
  );
  assert.match(plan.sql, /sum\(`offer_shown_n`\) AS full_attach_n/);
});

test("the division in the scope wins over a name-matched column", () => {
  // Both resolutions are available here and they disagree; what the query actually
  // divided by is a fact, and the name is only a convention.
  const core = `SELECT city,
    uniqExact(user_id) AS conversion_n,
    count() AS shown_n,
    purchases / shown_n AS conversion_rate
  FROM events GROUP BY city`;
  const plan = buildDigestSql(core, [
    { name: "conversion_n", kind: "count" },
    { name: "shown_n", kind: "count" },
    { name: "conversion_rate", kind: "rate" },
  ]);
  assert.match(plan.sql, /sum\(`shown_n`\) AS full_conversion_n/);
});

test("a rate without a denominator gets spread figures but no population rate", () => {
  // Inventing a denominator would produce a plausible, wrong, precision-bounded number.
  const plan = buildDigestSql("SELECT 1", [
    { name: "city", kind: "categorical" },
    { name: "conversion_rate", kind: "rate" },
  ]);
  assert.equal(plan.emissions.some((e) => e.stat === "full_rate"), false);
  assert.match(plan.sql, /min\(`conversion_rate`\)/);
  assert.match(plan.sql, /quantile\(0\.5\)\(`conversion_rate`\) AS conversion_rate_p50_approx/);
});

test("a rate column never gets a bare avg()", () => {
  // avg(rate) is a mean of per-segment rates: it reads as "the overall rate", differs
  // from it whenever denominators are unequal, and becomes citable once emitted.
  const plan = buildDigestSql("SELECT 1", RATE_RESULT);
  assert.equal(/avg\(`conversion_rate`\)/.test(plan.sql), false);
  // a plain numeric column is a different case and does get one
  const numeric = buildDigestSql("SELECT 1", [{ name: "latency_ms", kind: "numeric" }]);
  assert.match(numeric.sql, /avg\(`latency_ms`\) AS latency_ms_avg/);
});

test("impossible rates are counted exactly across the whole result set", () => {
  const plan = buildDigestSql("SELECT 1", RATE_RESULT);
  assert.match(plan.sql, /countIf\(`conversion_rate` > 1\.05\) AS conversion_rate_gt1_n/);
});

test("categorical and temporal columns get cardinality and a range", () => {
  const plan = buildDigestSql("SELECT 1", [
    { name: "city", kind: "categorical" },
    { name: "day", kind: "temporal" },
  ]);
  assert.match(plan.sql, /uniq\(`city`\) AS city_distinct_approx/);
  assert.match(plan.sql, /min\(`day`\) AS day_min/);
  assert.match(plan.sql, /max\(`day`\) AS day_max/);
});

test("an emitted alias never collides with a result column or another emission", () => {
  // The result already contains what we would have called a stat, so the digest
  // must rename rather than emit a duplicate alias ClickHouse would reject.
  const plan = buildDigestSql("SELECT 1", [
    { name: "x", kind: "numeric" },
    { name: "x_min", kind: "numeric" },
  ]);
  const aliases = plan.emissions.map((e) => e.alias);
  assert.equal(new Set(aliases).size, aliases.length, "aliases must be unique");
  assert.equal(aliases.includes("x_min"), false, "must not shadow the x_min column");
  assert.ok(aliases.includes("x_min_d2"));
});

test("column caps bound the digest for a freakishly wide result", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    name: `m${i}_rate`,
    kind: "rate" as const,
  }));
  const plan = buildDigestSql("SELECT 1", many);
  const profiled = new Set(plan.emissions.map((e) => e.column).filter(Boolean));
  assert.ok(profiled.size <= 4, `expected at most 4 rate columns, profiled ${profiled.size}`);
});

// ── extremes ─────────────────────────────────────────────────────

test("extremes rank by a rate that carries its denominator, so intervals stay honest", () => {
  const plan = buildDigestSql("SELECT 1", [
    ...RATE_RESULT,
    { name: "bounce_rate", kind: "rate" },
  ]);
  assert.equal(pickExtremesMetric([...RATE_RESULT, { name: "bounce_rate", kind: "rate" }], plan.emissions), "conversion_rate");
});

test("extremes fall back through numeric then count, and give up on a result with no numbers", () => {
  assert.equal(pickExtremesMetric([{ name: "latency_ms", kind: "numeric" }], []), "latency_ms");
  assert.equal(pickExtremesMetric([{ name: "n", kind: "count" }], []), "n");
  assert.equal(pickExtremesMetric([{ name: "city", kind: "categorical" }], []), null);
});

test("extremes queries select whole rows from both ends", () => {
  assert.equal(
    buildExtremesSql("SELECT 1", "conversion_rate", "ASC"),
    "SELECT * FROM (\nSELECT 1\n) AS __result ORDER BY `conversion_rate` ASC LIMIT 5",
  );
});

// ── shaping, flags, rendering ────────────────────────────────────

const digestOf = (over: Partial<ResultDigest> = {}): ResultDigest => {
  const plan = buildDigestSql("SELECT 1", RATE_RESULT);
  const statsRow: Record<string, unknown> = {
    total_rows: 52340,
    conversion_rate_min: 0,
    conversion_rate_max: 0.94,
    conversion_rate_p50_approx: 0.06,
    conversion_rate_gt1_n: 0,
    full_conversion_rate: 0.0712,
    full_conversion_n: 48212,
    conversion_n_min: 3,
    conversion_n_max: 8801,
    full_conversion_n_sum: 48212,
    city_distinct_approx: 412,
  };
  const { population, columnStats } = shapeDigest(statsRow, plan.emissions, RATE_RESULT);
  return {
    totalRows: 52340,
    statsRow,
    population,
    columnStats,
    emissions: plan.emissions,
    sql: plan.sql,
    extremes: null,
    typesFromSample: false,
    ...over,
  };
};

test("shapeDigest separates whole-result figures from per-column spread", () => {
  const d = digestOf();
  assert.equal(d.population["total_rows"], 52340);
  assert.equal(d.population["full_conversion_rate"], 0.0712);
  // a min across rows describes spread, not the population — it is not a whole-set figure
  assert.equal("conversion_rate_min" in d.population, false);
  assert.deepEqual(
    d.columnStats.map((c) => c.column),
    ["conversion_rate", "conversion_n", "city"],
  );
});

test("populationRow hands precision only the figures that deserve an interval", () => {
  const row = populationRow(digestOf());
  assert.deepEqual(Object.keys(row).sort(), ["full_conversion_n", "full_conversion_rate"]);
  const [p] = precisionForRow(row, digestOf().sql);
  assert.equal(p?.n, 48212, "the interval must rest on the whole population");
});

test("digestFlags reports an impossible rate with an exact whole-set count", () => {
  const d = digestOf();
  d.statsRow["conversion_rate_gt1_n"] = 340;
  assert.deepEqual(digestFlags(d), [
    "conversion_rate looks like a rate above 100% in 340 of 52340 rows (entire result set)",
  ]);
});

test("digestFlags only calls samples small when every row of the full set is small", () => {
  const small = digestOf();
  small.statsRow["conversion_n_max"] = 12;
  assert.deepEqual(digestFlags(small), [
    "every sample size across all 52340 rows is below 50 — low confidence",
  ]);
  // one large segment anywhere in the result set means the claim is false
  assert.deepEqual(digestFlags(digestOf()), []);
});

test("renderDigest states the coverage and labels approximate figures", () => {
  const text = renderDigest(
    digestOf({
      extremes: {
        metric: "conversion_rate",
        top: [{ city: "Delhi", conversion_rate: 0.94, conversion_n: 120 }],
        bottom: [{ city: "Kochi", conversion_rate: 0.01, conversion_n: 3 }],
        topSql: "",
        bottomSql: "",
      },
    }),
  );
  assert.match(text, /computed by ClickHouse over ALL 52340 rows/);
  assert.match(text, /about 412 distinct values/);
  assert.match(text, /median about 0\.06/);
  assert.match(text, /highest 5 rows of the full set by conversion_rate/);
  assert.match(text, /Kochi/);
});
