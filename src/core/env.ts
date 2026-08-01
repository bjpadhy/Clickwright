import "dotenv/config";

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

export const env = {
  clickhouse: {
    url: required("CLICKHOUSE_URL"),
    username: optional("CLICKHOUSE_USER", "default"),
    password: process.env["CLICKHOUSE_PASSWORD"] ?? "",
    database: optional("CLICKHOUSE_DATABASE", "default"),
  },
  langfuse: {
    publicKey: required("LANGFUSE_PUBLIC_KEY"),
    secretKey: required("LANGFUSE_SECRET_KEY"),
    baseUrl: optional("LANGFUSE_BASE_URL", "https://cloud.langfuse.com"),
  },
  llm: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: optional("CLICKWRIGHT_MODEL", "claude-sonnet-5"),
  },
};
