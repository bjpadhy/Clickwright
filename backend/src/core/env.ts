import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// Resolve backend/.env relative to this module, not the cwd — scripts can be
// launched from the repo root or backend/ interchangeably.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "" || value.endsWith("xxxxx")) {
    throw new Error(
      `Missing env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

/**
 * A real key enables the direct Anthropic API backend. Anything else (missing
 * or the "sk-ant-" placeholder) selects the Claude Agent SDK backend, which
 * authenticates via the machine's Claude Code OAuth login — in that case the
 * placeholder is scrubbed from process.env so the SDK's subprocess doesn't
 * mistake it for a key.
 */
function resolveApiKey(): string | null {
  const raw = process.env["ANTHROPIC_API_KEY"];
  if (raw && raw.trim().length > 15) return raw;
  delete process.env["ANTHROPIC_API_KEY"];
  return null;
}

export const env = {
  clickhouse: {
    url: required("CLICKHOUSE_URL"),
    username: optional("CLICKHOUSE_USER", "default"),
    password: process.env["CLICKHOUSE_PASSWORD"] ?? "",
    database: optional("CLICKHOUSE_DATABASE", "default"),
    // ClickHouse Cloud keeps system.query_log per replica; clusterAllReplicas()
    // over this cluster unions them. Measured on our service: the local table
    // sees roughly half the queries. See src/observe/query-log.ts.
    cluster: optional("CLICKHOUSE_CLUSTER", "default"),
  },
  langfuse: {
    publicKey: required("LANGFUSE_PUBLIC_KEY"),
    secretKey: required("LANGFUSE_SECRET_KEY"),
    baseUrl: optional("LANGFUSE_BASE_URL", "https://cloud.langfuse.com"),
  },
  llm: {
    // Two backends: an Anthropic API key if provided, otherwise the Claude
    // Agent SDK, which reuses the machine's Claude Code login (company plan).
    apiKey: resolveApiKey(),
    model: optional("CLICKWRIGHT_MODEL", "claude-sonnet-5"),
  },
};
