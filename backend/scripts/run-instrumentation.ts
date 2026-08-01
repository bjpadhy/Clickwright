/**
 * Flow A run handler: ① instrumentation + ② context update, chained under one
 * Langfuse trace. This is what the server will call per uploaded spec (with the
 * queue in front); as a CLI it powers manual runs and the fire drill.
 *
 *   npx tsx scripts/run-instrumentation.ts specs/02_group_family --yes
 *
 * --yes auto-approves both human gates (CLI mode). Without it, proposals are
 * printed and the run asks y/n on stdin.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  runInstrumentation,
  type InstrumentationProposal,
} from "../src/agents/instrumentation.js";
import { updateContext, type ContextUpdateProposal } from "../src/agents/context.js";
import { startRun, endRun, traceUrl, flushTraces } from "../src/core/tracing.js";
import { closeDb } from "../src/core/db.js";

const specDir = process.argv[2];
const autoYes = process.argv.includes("--yes");
if (!specDir) {
  console.error("usage: npx tsx scripts/run-instrumentation.ts <specDir> [--yes]");
  process.exit(1);
}
const specName = path.basename(specDir.replace(/\/+$/, ""));
const runId = `run_${Date.now().toString(36)}`;

async function ask(question: string): Promise<{ approved: boolean; feedback?: string }> {
  if (autoYes) return { approved: true };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N/reason-for-rejection] `)).trim();
  rl.close();
  if (answer.toLowerCase() === "y") return { approved: true };
  return { approved: false, feedback: answer || "rejected without reason" };
}

const trace = startRun(
  `pipeline:${specName}`,
  { spec: specName, runId },
  { sessionId: specName },
);
console.log(`▶ run ${runId} · trace ${traceUrl(trace)}\n`);

try {
  // ── ① instrumentation ──
  const instr = await runInstrumentation({
    specDir,
    trace,
    approve: async (proposal: InstrumentationProposal, attempt: number) => {
      console.log(`\n── DDL PROPOSAL (attempt ${attempt}) ──`);
      console.log(`reasoning: ${proposal.reasoning.slice(0, 600)}…\n`);
      for (const t of proposal.tables) console.log(`  ${t.name} — ${t.purpose}`);
      return ask("\nApprove DDL?");
    },
  });
  console.log(`\n✓ instrumentation: ${instr.tables.length} tables, attempt(s) ${instr.attempts}`);
  for (const t of instr.tables) console.log(`    ${t.name}: ${t.rowsLoaded}/${t.rowsInFile} rows`);

  // ── ② context update ──
  const specText = await readFile(path.join(specDir, "spec.md"), "utf-8");
  const ctx = await updateContext(
    {
      specName,
      specText,
      runId,
      instrumentation: {
        reasoning: instr.reasoning,
        newEnvelopeFields: instr.newEnvelopeFields,
        tables: instr.tables,
        tableEntries: instr.tableEntries,
      },
    },
    trace,
    {
      approve: async (proposal: ContextUpdateProposal, attempt: number) => {
        console.log(`\n── CONTEXT PROPOSAL (attempt ${attempt}) ──`);
        for (const e of proposal.entries) console.log(`  ${e.entity}\n    ${e.change_note}`);
        return ask("\nApprove context entries?");
      },
    },
  );
  console.log(`\n✓ context updated: ${ctx.entries.length} entries`);
  for (const e of ctx.entries) console.log(`    ${e.entity} v${e.version}`);
  for (const w of ctx.warnings) console.log(`  ⚠ contradiction: ${w}`);

  endRun(
    trace,
    {
      status: "success",
      tables: instr.tables.map((t) => `${t.name} (${t.rowsLoaded} rows)`),
      contextEntries: ctx.entries.map((e) => `${e.entity} v${e.version}`),
      contextWarnings: ctx.warnings,
      instrumentationAttempts: instr.attempts,
    },
    { spec: specName, runId },
  );
  console.log(`\n✔ run complete · ${traceUrl(trace)}`);
} catch (error) {
  endRun(trace, { status: "failed", error: String(error) }, { spec: specName, runId });
  console.error(`\n✗ run failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await flushTraces();
  await closeDb();
}
