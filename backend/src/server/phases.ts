/**
 * Step name → reader-facing phase, for both streams the webapp renders.
 *
 * Pure and dependency-free on purpose: `chat.ts` and `runs.ts` pull in the
 * database, Langfuse and the agents, so the phase tables live here where a unit
 * test can import them without a `.env` or a network.
 */

/**
 * Technical step names are noise in a chat UI. Each maps to one of a handful of
 * phases the reader actually cares about, so the FE can render
 * "Querying ClickHouse · 12s" instead of a stack of sql_attempt_1 / task_t2
 * lines. The raw name still rides along for the "how I got this" detail view.
 *
 * Order matters: the first matching pattern wins.
 */
export const CHAT_PHASES: ReadonlyArray<readonly [RegExp, string]> = [
  // the wrapper span and the cache probe are plumbing — no phase, so the UI skips
  // them rather than flashing a line the reader cannot act on
  [/^analytics$/, ""],
  [/^cache_lookup$/, ""],
  [/^context_load$/, "Reading the knowledge store"],
  [/^pre_plan_lookup$/, "Reading the knowledge store"],
  [/^plan/, "Planning the analysis"],
  [/^(task_|sql_attempt)/, "Querying ClickHouse"],
  [/^digest_/, "Analysing every row of the results"],
  [/^(sanity_gate|precision|verify)$/, "Validating the results"],
  [/^(context_lookup|related_insights)$/, "Looking for known issues"],
  [/^narrate/, "Writing the insight"],
  // quality_gate and the code-derived confidence score are both the "is this
  // answer good enough" pass — one phase, two steps
  [/^(quality_gate|confidence)/, "Reviewing the answer"],
];

/** "" means: plumbing, do not surface it in the chat timeline. */
export function phaseOf(stepName: string): string {
  for (const [re, label] of CHAT_PHASES) if (re.test(stepName)) return label;
  return "Working";
}

/**
 * Instrumentation runs: several steps and all their LLM progress ticks collapse
 * into one line, so "Executing on ClickHouse" shows table results only and never
 * a stream of thinking ticks. Unknown steps map to "" (not surfaced), unlike
 * chat where an unknown step is still shown as "Working".
 */
export const RUN_PHASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^profile$/, "Profiling the events"],
  [/^(context_load|schema_reconciliation)$/, "Reading the knowledge store"],
  [/^(ddl_generation_attempt|schema_design_attempt|schema_design)/, "Designing the schema"],
  [/^dry_run/, "Validating the schema"],
  [/^(approval_attempt|update_approval_attempt|optimization_approval_attempt)/, "Waiting for your approval"],
  [/^ddl_execution_attempt/, "Creating tables and loading data"],
  [/^(context_update|update_generation_attempt)/, "Updating the knowledge store"],
  // Optimization runs share the queue, the gates and the stream with spec runs,
  // but none of their step names — without these they streamed as blank lines.
  [/^optimization_generation_attempt/, "Drafting the change"],
  [/^optimization_execution_attempt/, "Applying the change"],
  [/^(instrumentation|optimization)$/, ""],
];

export function runPhaseOf(stepName: string): string {
  for (const [re, label] of RUN_PHASES) if (re.test(stepName)) return label;
  return "";
}

/**
 * Turn seqs come in pairs — user at 2k, agent at 2k+1 — so the agent row's slot
 * is reserved the moment the user row lands. A second question asked while the
 * first is still being answered reads max(seq) = 2k and lands at 2k+2, never on
 * top of the pending agent row. `count` disambiguates the empty conversation:
 * ClickHouse returns 0 for max() over no rows, which would otherwise look like
 * "one turn exists".
 */
export function nextTurnSeq(count: number, maxSeq: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  const max = Number.isFinite(maxSeq) && maxSeq >= 0 ? Math.floor(maxSeq) : 0;
  return (Math.floor(max / 2) + 1) * 2;
}
