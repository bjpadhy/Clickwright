import { createReadStream } from "fs";
import { createInterface } from "readline";

export interface FieldProfile {
  field: string;
  inferredType: "string" | "number" | "boolean" | "timestamp" | "json";
  nullRate: number;       // 0–1
  distinctCount: number;
  totalCount: number;
  sampleValues: string[];
  isNested: boolean;
  maxLength?: number;     // for strings
  numericRange?: { min: number; max: number };
}

export interface NdjsonProfile {
  filePath: string;
  totalRows: number;
  fields: FieldProfile[];
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const MAX_DISTINCT_TRACK = 5000;
const SAMPLE_SIZE = 5;

/**
 * Per-field running state. Everything a FieldProfile reports is a count, an
 * extreme, or a capped set, so none of it needs the values kept around — which
 * is what lets a profile of any number of rows fit in memory.
 */
interface FieldAccumulator {
  nullish: number;   // null | undefined | "" — a MISSING key is not counted
  nonNull: number;
  booleans: number;
  numbers: number;
  timestamps: number;
  objects: number;
  distinct: Set<string>;
  distinctCapped: boolean;
  samples: Set<string>;
  maxLength: number;
  numericCount: number;
  min: number;
  max: number;
}

const newAccumulator = (): FieldAccumulator => ({
  nullish: 0, nonNull: 0, booleans: 0, numbers: 0, timestamps: 0, objects: 0,
  distinct: new Set(), distinctCapped: false, samples: new Set(),
  maxLength: 0, numericCount: 0, min: Infinity, max: -Infinity,
});

/**
 * Accumulates a profile one row at a time, holding O(fields) state instead of
 * O(rows). Feed rows with `add`, then call `finish`.
 *
 * Field order in the output follows first appearance, matching what a
 * collect-then-reduce pass produced.
 */
export class ProfileAccumulator {
  private readonly fields = new Map<string, FieldAccumulator>();
  private totalRows = 0;

  add(row: Record<string, unknown>): void {
    this.totalRows++;
    for (const [key, val] of Object.entries(row)) {
      let acc = this.fields.get(key);
      if (!acc) {
        acc = newAccumulator();
        this.fields.set(key, acc);
      }

      const isNullish = val === null || val === undefined || val === "";
      if (isNullish) acc.nullish++;
      else {
        acc.nonNull++;
        if (typeof val === "boolean") acc.booleans++;
        else if (typeof val === "number") acc.numbers++;
        else if (typeof val === "object") acc.objects++;
        else if (typeof val === "string" && TIMESTAMP_RE.test(val)) acc.timestamps++;

        const asString = typeof val === "object" ? JSON.stringify(val) : String(val);
        if (asString.length > acc.maxLength) acc.maxLength = asString.length;
        if (acc.samples.size < SAMPLE_SIZE) acc.samples.add(asString);
      }

      // numericRange was taken over every present value of numeric type, which
      // is the same set as the non-null numbers: null is an object and "" a string
      if (typeof val === "number") {
        acc.numericCount++;
        if (val < acc.min) acc.min = val;
        if (val > acc.max) acc.max = val;
      }

      if (!acc.distinctCapped) {
        const repr =
          val === null || val === undefined
            ? "__null__"
            : typeof val === "object"
              ? JSON.stringify(val)
              : String(val);
        acc.distinct.add(repr);
        if (acc.distinct.size >= MAX_DISTINCT_TRACK) acc.distinctCapped = true;
      }
    }
  }

  finish(label: string): NdjsonProfile {
    const fields: FieldProfile[] = [];
    for (const [field, acc] of this.fields) {
      const type = inferTypeFromCounts(acc);
      const profile: FieldProfile = {
        field,
        inferredType: type,
        nullRate: Math.round((this.totalRows > 0 ? acc.nullish / this.totalRows : 0) * 1000) / 1000,
        distinctCount: acc.distinctCapped ? MAX_DISTINCT_TRACK + 1 : acc.distinct.size,
        totalCount: this.totalRows,
        sampleValues: [...acc.samples],
        isNested: type === "json",
      };
      if (type === "string" || type === "timestamp") profile.maxLength = acc.maxLength;
      if (type === "number" && acc.numericCount > 0) {
        profile.numericRange = { min: acc.min, max: acc.max };
      }
      fields.push(profile);
    }
    return { filePath: label, totalRows: this.totalRows, fields };
  }
}

/** Same decision tree as inferType, driven by counts rather than the values. */
function inferTypeFromCounts(acc: FieldAccumulator): FieldProfile["inferredType"] {
  if (acc.nonNull === 0) return "string";
  if (acc.booleans === acc.nonNull) return "boolean";
  if (acc.numbers === acc.nonNull) return "number";
  if (acc.timestamps === acc.nonNull) return "timestamp";
  if (acc.objects === acc.nonNull) return "json";
  return "string";
}

/** Profile a file without ever holding it in memory. */
export async function profileNdjson(filePath: string): Promise<NdjsonProfile> {
  const acc = new ProfileAccumulator();
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      acc.add(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return acc.finish(filePath);
}

/** Profile already-parsed records — used for per-event-type profiling. */
export function profileRecords(
  records: Record<string, unknown>[],
  label: string,
): NdjsonProfile {
  const acc = new ProfileAccumulator();
  for (const row of records) acc.add(row);
  return acc.finish(label);
}

export function profileSummary(profile: NdjsonProfile): string {
  const lines: string[] = [
    `File: ${profile.filePath}`,
    `Rows: ${profile.totalRows}`,
    `Fields (${profile.fields.length}):`,
  ];
  for (const f of profile.fields) {
    const nullPct = (f.nullRate * 100).toFixed(1);
    const card =
      f.distinctCount > MAX_DISTINCT_TRACK
        ? `>${MAX_DISTINCT_TRACK}`
        : String(f.distinctCount);
    const range =
      f.numericRange
        ? ` range=[${f.numericRange.min}, ${f.numericRange.max}]`
        : "";
    const samples = f.sampleValues.slice(0, 3).join(", ");
    lines.push(
      `  ${f.field}: ${f.inferredType}  null=${nullPct}%  distinct=${card}${range}  eg:[${samples}]`
    );
  }
  return lines.join("\n");
}
