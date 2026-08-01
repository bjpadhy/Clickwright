/**
 * Verifies ClickHouse, Langfuse, and the LLM are all reachable with the current .env.
 * Run this before anything else — three green checks means the team is unblocked.
 */
import { query, closeDb } from "../src/core/db.js";
import { startRun, flushTraces } from "../src/core/tracing.js";
import { complete } from "../src/core/llm.js";
import { env } from "../src/core/env.js";

const BASE_TABLES = [
  "destination_card_clicked",
  "application_started",
  "document_uploaded",
  "purchase_completed",
  "search_typed",
  "landing_page_scrolled",
  "auth_completed",
  "pay_now_clicked",
];

async function main() {
  let failed = false;

  // 1 — ClickHouse
  try {
    const versionRows = await query<{ version: string }>(
      "SELECT version() AS version",
    );
    console.log(
      `✓ ClickHouse  ${versionRows[0]?.version ?? "?"}  (${env.clickhouse.database})`,
    );

    const tables = await query<{ name: string; rows: string }>(
      `SELECT name, total_rows AS rows FROM system.tables
       WHERE database = '${env.clickhouse.database}' ORDER BY name`,
    );
    const present = new Set(tables.map((t) => t.name));
    const missing = BASE_TABLES.filter((t) => !present.has(t));

    if (tables.length === 0) {
      console.log("  ⚠ no tables yet — run the Atlys data/load.sh first");
    } else {
      for (const t of tables) {
        console.log(`    ${t.name.padEnd(28)} ${Number(t.rows).toLocaleString()} rows`);
      }
    }
    if (missing.length > 0) {
      console.log(`  ⚠ missing base tables: ${missing.join(", ")}`);
    }
  } catch (error) {
    failed = true;
    console.log(`✗ ClickHouse  ${(error as Error).message}`);
  }

  // 2 — Langfuse + 3 — LLM (one call proves both)
  try {
    const trace = startRun("check-env", { purpose: "connectivity smoke test" });
    const reply = await complete(
      trace,
      "smoke-test",
      "Reply with exactly: ok",
      { maxTokens: 16 },
    );
    await flushTraces();
    console.log(`✓ LLM         ${env.llm.model} → "${reply.trim()}"`);
    console.log(`✓ Langfuse    trace sent to ${env.langfuse.baseUrl}`);
  } catch (error) {
    failed = true;
    console.log(`✗ LLM/Langfuse  ${(error as Error).message}`);
  }

  await closeDb();
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
