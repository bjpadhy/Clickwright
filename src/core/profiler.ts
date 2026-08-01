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

function inferType(
  values: unknown[]
): FieldProfile["inferredType"] {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (nonNull.length === 0) return "string";
  if (nonNull.every((v) => typeof v === "boolean")) return "boolean";
  if (nonNull.every((v) => typeof v === "number")) return "number";
  if (
    nonNull.every(
      (v) => typeof v === "string" && TIMESTAMP_RE.test(v as string)
    )
  )
    return "timestamp";
  if (nonNull.every((v) => typeof v === "object" && v !== null)) return "json";
  return "string";
}

export async function profileNdjson(filePath: string): Promise<NdjsonProfile> {
  const fieldValues: Map<string, unknown[]> = new Map();
  const fieldDistinct: Map<string, Set<string>> = new Map();
  const fieldDistinctCapped: Map<string, boolean> = new Map();
  let totalRows = 0;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    totalRows++;

    for (const [key, val] of Object.entries(row)) {
      if (!fieldValues.has(key)) {
        fieldValues.set(key, []);
        fieldDistinct.set(key, new Set());
        fieldDistinctCapped.set(key, false);
      }
      fieldValues.get(key)!.push(val);

      const ds = fieldDistinct.get(key)!;
      if (!fieldDistinctCapped.get(key)) {
        const repr =
          val === null || val === undefined
            ? "__null__"
            : typeof val === "object"
            ? JSON.stringify(val)
            : String(val);
        ds.add(repr);
        if (ds.size >= MAX_DISTINCT_TRACK) {
          fieldDistinctCapped.set(key, true);
        }
      }
    }
  }

  const fields: FieldProfile[] = [];

  for (const [field, values] of fieldValues.entries()) {
    const nullCount = values.filter(
      (v) => v === null || v === undefined || v === ""
    ).length;
    const nullRate = totalRows > 0 ? nullCount / totalRows : 0;

    const type = inferType(values);
    const isNested = type === "json";

    const distinct = fieldDistinct.get(field)!;
    const capped = fieldDistinctCapped.get(field)!;
    const distinctCount = capped ? MAX_DISTINCT_TRACK + 1 : distinct.size;

    const nonNullStr = values
      .filter((v) => v !== null && v !== undefined && v !== "")
      .map((v) =>
        typeof v === "object" ? JSON.stringify(v) : String(v)
      );

    const sampleSet = new Set<string>();
    for (const v of nonNullStr) {
      if (sampleSet.size >= SAMPLE_SIZE) break;
      sampleSet.add(v);
    }
    const sampleValues = [...sampleSet];

    const profile: FieldProfile = {
      field,
      inferredType: type,
      nullRate: Math.round(nullRate * 1000) / 1000,
      distinctCount,
      totalCount: totalRows,
      sampleValues,
      isNested,
    };

    if (type === "string" || type === "timestamp") {
      profile.maxLength = Math.max(
        0,
        ...nonNullStr.map((s) => s.length)
      );
    }

    if (type === "number") {
      const nums = values.filter(
        (v) => typeof v === "number"
      ) as number[];
      if (nums.length > 0) {
        profile.numericRange = {
          min: Math.min(...nums),
          max: Math.max(...nums),
        };
      }
    }

    fields.push(profile);
  }

  return { filePath, totalRows, fields };
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
