/**
 * Deterministic DDL synthesis — the type rules are arithmetic on measured stats,
 * so code does them: instant, free, and correct by construction. No LLM, no
 * retries, no quote-escaping bugs, no hallucinated columns.
 *
 * The LLM's remaining job (one small call per spec) is the human-facing prose:
 * purposes and rationale. If that call fails, the schema is still valid — only
 * the wording degrades.
 */
import type { FieldProfile, NdjsonProfile } from "./profiler.js";

const IDENTIFIER_RE =
  /(^|_)(id|ids|uuid|guid|token|hash|key)$|^(user_id|application_id|app_session_id|share_id|group_id|client_ip)$/i;

/** Matches 32-char hex strings (MD5-like event IDs). */
const HEX_ID_RE = /^[0-9a-f]{32}$/i;

const MONEY_RE = /(amount|value|price|revenue|fee|discount|total|balance)/i;
const LOW_CARDINALITY_MAX = 1000;

export interface ColumnPlan {
  name: string;
  type: string;
  comment: string;
  codec?: string;
}

export interface TablePlan {
  name: string;
  event: string;
  columns: ColumnPlan[];
  orderBy: string[];
  partitionBy: string;
  /** Facts the rationale is built from — no interpretation, just measurements. */
  facts: {
    rows: number;
    orderByReason: string;
    lowCardinality: string[];
    nullableDefaults: string[];
    notable: string[];
  };
}

function isIdentifier(field: string): boolean {
  return IDENTIFIER_RE.test(field);
}

/** Pick the narrowest correct ClickHouse type from the measured profile. */
export function chooseType(f: FieldProfile): { type: string; note?: string; codec?: string } {
  if (f.inferredType === "timestamp")
    return { type: "DateTime64(3)", codec: "CODEC(Delta(8), ZSTD(1))" };
  if (f.inferredType === "boolean") return { type: "UInt8", note: `${f.field}: boolean as 0/1` };
  if (f.inferredType === "number") {
    const max = f.numericRange?.max ?? 0;
    const min = f.numericRange?.min ?? 0;
    // sampleValues holds only the first 5 distinct values, so "no dot seen" is
    // weak evidence. Treat a wide-ranging, high-cardinality numeric as possibly
    // fractional: a too-wide column is harmless, a truncated one loses data.
    const looksContinuous = f.distinctCount > 50 && (f.numericRange?.max ?? 0) > 100;
    const fractional =
      f.sampleValues.some((v) => v.includes(".")) ||
      MONEY_RE.test(f.field) ||
      looksContinuous;
    if (fractional) {
      // Decimal64(2) for money — Float64 causes rounding errors on aggregation.
      // Float64 for other continuous values (latencies, scores, percentages).
      return MONEY_RE.test(f.field)
        ? { type: "Decimal64(2)", note: `${f.field}: monetary, Decimal64(2)` }
        : { type: "Float64" };
    }
    const intCodec = "CODEC(T64, ZSTD(1))";
    if (min >= 0 && max < 256) return { type: "UInt8", note: `${f.field}: max ${max} → UInt8`, codec: intCodec };
    if (min >= 0 && max < 65536) return { type: "UInt16", note: `${f.field}: max ${max} → UInt16`, codec: intCodec };
    if (min >= 0 && max < 4294967296) return { type: "UInt32", note: `${f.field}: max ${max} → UInt32`, codec: intCodec };
    return { type: "Int64", codec: intCodec };
  }
  if (f.inferredType === "json") return { type: "String", codec: "CODEC(ZSTD(1))" };
  // strings — detect 32-char hex IDs (MD5-like event IDs) for FixedString
  if (isIdentifier(f.field)) {
    const allHex = f.sampleValues.length > 0 && f.sampleValues.every((v) => HEX_ID_RE.test(v));
    if (allHex && f.maxLength === 32) {
      return { type: "FixedString(32)", note: `${f.field}: 32-char hex → FixedString(32)`, codec: "CODEC(ZSTD(1))" };
    }
    return { type: f.nullRate > 0 ? "String DEFAULT ''" : "String", codec: "CODEC(ZSTD(1))" };
  }
  if (f.distinctCount < LOW_CARDINALITY_MAX) {
    const base = "LowCardinality(String)";
    return {
      type: f.nullRate > 0 ? `${base} DEFAULT ''` : base,
      note: `${f.field}: ${f.distinctCount} distinct → LowCardinality`,
      // LowCardinality is already dictionary-encoded — no extra codec needed
    };
  }
  return { type: f.nullRate > 0 ? "String DEFAULT ''" : "String", codec: "CODEC(ZSTD(1))" };
}

function columnComment(f: FieldProfile, type: string): string {
  const bits: string[] = [];
  if (f.inferredType === "timestamp") bits.push("event time, ms precision");
  else if (f.inferredType === "boolean") bits.push("boolean 0/1");
  else if (type.startsWith("LowCardinality"))
    bits.push(`${f.distinctCount} distinct values`);
  else if (f.numericRange)
    bits.push(`range ${f.numericRange.min}–${f.numericRange.max}`);
  else if (isIdentifier(f.field)) bits.push("identifier, high cardinality");
  if (f.nullRate > 0)
    bits.push(`${(f.nullRate * 100).toFixed(1)}% empty — bucket as 'unknown' at query time`);
  if (/currency/i.test(f.field)) bits.push("never aggregate values across currencies");
  return bits.join("; ") || "measured from the spec sample";
}

/** Common filter/segment dimensions PMs query by — low cardinality, so they
 *  should lead the ordering key for granule pruning. */
const DIMENSION_CANDIDATES = ["device_type", "os", "geoip_country_code", "destination"];

/** Ordering key: low-cardinality dimensions first (for pruning), then join key,
 *  then timestamp. This follows ClickHouse's `schema-pk-cardinality-order` rule:
 *  low-cardinality leading columns let whole granules be skipped. */
function chooseOrderBy(profile: NdjsonProfile): { orderBy: string[]; reason: string } {
  const by = new Map(profile.fields.map((f) => [f.field, f]));
  const hasTs = by.has("timestamp");
  const key: string[] = [];
  const reasons: string[] = [];

  // 1. Lead with the best low-cardinality dimension present (for granule pruning)
  const dims = DIMENSION_CANDIDATES
    .filter((d) => by.has(d) && by.get(d)!.nullRate === 0)
    .sort((a, b) => (by.get(a)!.distinctCount) - (by.get(b)!.distinctCount));
  if (dims[0]) {
    key.push(dims[0]);
    reasons.push(`${dims[0]} (${by.get(dims[0])!.distinctCount} distinct) leads for pruning`);
  }

  // 2. Then the join key
  const joinCandidates = ["application_id", "share_id", "group_id", "user_id"];
  for (const c of joinCandidates) {
    const f = by.get(c);
    if (f && f.nullRate === 0) {
      key.push(c);
      reasons.push(`${c} is the join key (0% null)`);
      break;
    }
  }

  // 3. Then timestamp
  if (hasTs) {
    key.push("timestamp");
    reasons.push("timestamp for range scans");
  }

  // Fallback: if no dimension or join key found
  if (key.length === 0) {
    const anyId = profile.fields.find((f) => isIdentifier(f.field) && f.nullRate === 0);
    if (anyId) {
      return {
        orderBy: hasTs ? [anyId.field, "timestamp"] : [anyId.field],
        reason: `no standard key; ${anyId.field} (0% null) leads instead`,
      };
    }
    return { orderBy: hasTs ? ["timestamp"] : [], reason: "no always-present key; ordered by time only" };
  }

  return { orderBy: key, reason: reasons.join("; ") };
}

export function planTable(event: string, profile: NdjsonProfile): TablePlan {
  const columns: ColumnPlan[] = [];
  const lowCardinality: string[] = [];
  const nullableDefaults: string[] = [];
  const notable: string[] = [];

  for (const f of profile.fields) {
    const { type, note, codec } = chooseType(f);
    columns.push({ name: f.field, type, comment: columnComment(f, type), ...(codec ? { codec } : {}) });
    if (type.startsWith("LowCardinality")) lowCardinality.push(f.field);
    if (type.includes("DEFAULT ''")) nullableDefaults.push(f.field);
    if (note) notable.push(note);
  }

  const { orderBy, reason } = chooseOrderBy(profile);
  const hasTs = profile.fields.some((f) => f.field === "timestamp");

  return {
    name: event,
    event,
    columns,
    orderBy,
    partitionBy: hasTs ? "toYYYYMM(timestamp)" : "",
    facts: { rows: profile.totalRows, orderByReason: reason, lowCardinality, nullableDefaults, notable },
  };
}

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

export function renderCreateTable(plan: TablePlan, purpose: string): string {
  const cols = plan.columns
    .map((c) => {
      const parts = [`  \`${c.name}\` ${c.type}`];
      parts.push(`COMMENT ${q(c.comment)}`);
      if (c.codec) parts.push(c.codec);
      return parts.join(" ");
    })
    .join(",\n");
  const tableParts = [
    `CREATE TABLE ${plan.name} (\n${cols}\n) ENGINE = MergeTree`,
    plan.partitionBy ? `PARTITION BY ${plan.partitionBy}` : "",
    plan.orderBy.length ? `ORDER BY (${plan.orderBy.join(", ")})` : "ORDER BY tuple()",
    // Default 1-year TTL on event tables — prevents unbounded growth.
    plan.partitionBy ? "TTL toDateTime(timestamp) + INTERVAL 1 YEAR" : "",
    `COMMENT ${q(purpose)}`,
  ].filter(Boolean);
  return tableParts.join("\n");
}

/** Rationale assembled from measurements — no model needed, always accurate. */
export function renderRationale(plan: TablePlan): {
  ordering_key: string;
  partitioning: string;
  types_codecs: string;
  deviations: string;
} {
  const lc = plan.facts.lowCardinality;
  const types = [
    plan.facts.notable.slice(0, 3).join("; "),
    lc.length ? `LowCardinality: ${lc.slice(0, 5).join(", ")}${lc.length > 5 ? ` +${lc.length - 5}` : ""}` : "",
  ]
    .filter(Boolean)
    .join(". ");
  const hasTs = plan.columns.some((c) => c.name === "timestamp");
  return {
    ordering_key: plan.facts.orderByReason,
    partitioning: plan.partitionBy
      ? `${plan.partitionBy} — monthly parts stay merge-friendly`
      : "no timestamp column, so unpartitioned",
    // the base tables are second-precision DateTime; say so, because a reviewer
    // seeing DateTime64(3) here will otherwise wonder if joins are safe
    types_codecs: (hasTs
      ? `timestamp DateTime64(3) — joins cleanly with the second-precision base tables. ${types}`
      : types
    ).slice(0, 300),
    deviations: plan.facts.nullableDefaults.length
      ? `empty values present in ${plan.facts.nullableDefaults.slice(0, 4).join(", ")} — String DEFAULT '' per hygiene convention`
      : "",
  };
}

/**
 * Specs describe their own events ("- `otp_entered` — OTP submitted (...)"), so the
 * table purpose is already written by the PM. Parsing beats asking a model: instant,
 * free, and it uses the author's own words.
 */
export function parseEventPurposes(specMd: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^\s*[-*]\s*`([a-z][a-z0-9_]*)`\s*[—–-]\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(specMd)) !== null) {
    const [, event, desc] = m;
    if (!event || !desc) continue;
    const clean = desc
      .replace(/`/g, "")
      .replace(/\s*\([^)]*\)\s*$/, "")   // trailing column list
      .trim();
    if (clean.length > 3) out.set(event, clean.slice(0, 140));
  }
  return out;
}

/** A ready-to-store `table:<name>` context entry, built from measurements. */
export function renderTableContextEntry(plan: TablePlan, purpose: string, specName: string): string {
  const eventSpecific = plan.columns.filter(
    (c) => !STANDARD_ENVELOPE.has(c.name) && c.name !== "timestamp" && c.name !== "id",
  );
  const lines = [
    `**\`${plan.name}\`** — ${purpose} Created by spec \`${specName}\` (${plan.facts.rows} sample rows).`,
    `Join key: \`${plan.orderBy[0] ?? "none"}\`; ordered by (${plan.orderBy.join(", ")}).`,
  ];
  if (eventSpecific.length) {
    lines.push(
      `Event-specific columns: ${eventSpecific.map((c) => `\`${c.name}\` (${c.comment})`).join("; ")}.`,
    );
  }
  const gotchas: string[] = [];
  if (plan.facts.nullableDefaults.length)
    gotchas.push(
      `empty values in ${plan.facts.nullableDefaults.join(", ")} — bucket as 'unknown', never treat as a category`,
    );
  if (!plan.columns.some((c) => c.name === "duplicate_id"))
    gotchas.push("no duplicate_id/is_back_filled columns — the hygiene filters do not apply here");
  if (!plan.columns.some((c) => c.name === "app_session_id"))
    gotchas.push("no app_session_id — outside the sessionization model; join via the key above");
  if (plan.columns.some((c) => /currency/.test(c.name)))
    gotchas.push("multi-currency: never aggregate amounts without grouping by currency");
  if (gotchas.length) lines.push(`Gotchas: ${gotchas.join("; ")}.`);
  return lines.join(" ");
}

const STANDARD_ENVELOPE = new Set([
  "user_id", "application_id", "app_session_id", "device", "device_type", "os",
  "app_version", "client_lib", "geoip_country_code", "geoip_subdivision_1_code",
  "city", "client_ip", "latitude", "longitude", "locale", "language", "funnel_type",
  "co_travelers", "citizenship", "destination", "is_guest", "is_referral",
  "is_enterprise", "is_guest_browse", "gclid", "fbclid", "gad_source",
  "is_back_filled", "duplicate_id",
]);
