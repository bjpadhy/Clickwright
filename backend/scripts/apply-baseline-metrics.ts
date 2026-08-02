/**
 * Define the comparison baselines, so they stop being re-invented per conversation.
 *
 * A PM-workflow evaluation asked the same question in two conversations and got
 * standard-checkout conversion as 45.6% once and 47.9% the next time, and inside a
 * single conversation two consecutive turns reported UAE standard checkout as 56.6%
 * and then 5.4%. Carrying figures across turns fixed the within-conversation case, but
 * a new conversation starts with no figures, so the drift returned.
 *
 * The cause is that "standard checkout conversion" was never a definition. It appears
 * only as a prose aside inside metric:express_checkout_conversion_rate, and this
 * dataset carries THREE defensible conversion denominators — sessions, application
 * starts, and pay-now clicks — so an undefined baseline is not one number but a choice
 * the agent re-makes every time.
 *
 * Every figure below was measured against the live tables, not asserted.
 *
 *   npx tsx scripts/apply-baseline-metrics.ts           # refuses to run twice
 *   npx tsx scripts/apply-baseline-metrics.ts --force   # replaces prior rows
 */
import { command, insert, query, closeDb } from "../src/core/db.js";

// The "data_audit" prefix is what marks a source protected from reset (see
// isProtectedSource in src/core/reset.ts) — these definitions must outlive a
// spec reset, since they describe the base tables rather than any one spec.
const SOURCE = "data_audit_baselines";

interface Entry {
  entity: string;
  definition_md: string;
  change_note: string;
}

const ENTRIES: Entry[] = [
  {
    entity: "metric:standard_checkout_conversion_rate",
    change_note:
      "New: the baseline every checkout comparison is measured against had no definition of its own — only a passing mention inside metric:express_checkout_conversion_rate — so each question chose its own denominator. Denominator, filters and current value verified against the live tables.",
    definition_md:
      "**Standard checkout conversion rate** = `uniqExact(application_id)` in " +
      "`purchase_completed` ÷ `uniqExact(application_id)` in `pay_now_clicked`, both with " +
      "`convention:data_hygiene` filters applied (`duplicate_id IS NULL` and " +
      "`is_back_filled != 1`), counted as set membership within the same window — no " +
      "timestamp ordering, per `convention:event_ordering`.\n\n" +
      "**This is the baseline for every express-vs-standard comparison.** Use it verbatim; " +
      "do not substitute `application_started` or sessions as the denominator when comparing " +
      "against express checkout, because `metric:express_checkout_conversion_rate` is " +
      "denominated on `express_checkout_shown` — the users who reached the payment step. " +
      "A comparison is only valid when both sides sit at the same funnel stage.\n\n" +
      "**Measured 2026-08-02:** 6,715 ÷ 14,026 = **47.9%** overall. Per-country it varies " +
      "widely — AE is 1,111 ÷ 1,963 = 56.6%. Treat these as the expected values: a query " +
      "returning a materially different figure for the same population has changed the " +
      "denominator and should be re-checked before the number is reported.",
  },
  {
    entity: "metric:express_payment_completion_rate",
    change_note:
      "New: express-vs-standard comparisons need a stage-matched express metric. Without one, asking for the comparison made the agent quietly redenominate express_checkout_conversion_rate onto express_checkout_selected and report 83.0% under a name whose stored definition means 50.7%. Both denominators are legitimate; only sharing a name was not. Measured against the live tables.",
    definition_md:
      "**Express payment completion rate** = `uniqExact(application_id)` in " +
      "`express_payment_confirmed` ÷ `uniqExact(application_id)` in " +
      "`express_checkout_selected` — of the users who CHOSE express, how many paid.\n\n" +
      "This is the stage-matched counterpart to `metric:standard_checkout_conversion_rate`: " +
      "both are denominated on committing to pay (`express_checkout_selected` ≈ " +
      "`pay_now_clicked`), so they are the pair to use for an express-vs-standard comparison.\n\n" +
      "**It is a different metric from `metric:express_checkout_conversion_rate`**, which is " +
      "denominated on `express_checkout_shown` and answers 'of everyone offered express, how " +
      "many paid'. Do not use one name for the other.\n\n" +
      "**Measured 2026-08-02:** 836 ÷ 1,007 = **83.0%**. For contrast, " +
      "`metric:express_checkout_conversion_rate` is 836 ÷ 1,650 = **50.7%**, and the gap " +
      "between them is express adoption (`metric:express_adoption_rate`), not payment success.",
  },
  {
    entity: "guide:conversion_denominators",
    change_note:
      "New: four defensible conversion denominators exist in this schema and nothing said which to use when, so the same question could be answered several ways without any of them being wrong.",
    definition_md:
      "**Which conversion denominator to use.** This schema supports several, and they are " +
      "not interchangeable — picking silently is how two answers to one question end up " +
      "disagreeing.\n\n" +
      "| Question shape | Denominator | Metric |\n" +
      "|---|---|---|\n" +
      "| Headline conversion reported to leadership | sessions (resolves to `application_started`) | `metric:conversion_rate` |\n" +
      "| Funnel / drop-off analysis | users who started an application | `metric:funnel_conversion` |\n" +
      "| Standard checkout performance | `pay_now_clicked` applications | `metric:standard_checkout_conversion_rate` |\n" +
      "| Express reach — of everyone offered it | `express_checkout_shown` | `metric:express_checkout_conversion_rate` |\n" +
      "| **Express vs standard, like for like** | `express_checkout_selected` vs `pay_now_clicked` | `metric:express_payment_completion_rate` vs `metric:standard_checkout_conversion_rate` |\n\n" +
      "**Both sides of a comparison must sit at the same funnel stage** — comparing " +
      "shown→paid against pay-now→paid charges express for its adoption gap and understates " +
      "it. Use the like-for-like row for that.\n\n" +
      "**Never satisfy that by redefining a named metric.** A metric's denominator is fixed " +
      "by its definition. If a comparison needs a different stage, use the metric that is " +
      "already defined at that stage, and call it by ITS name — reporting 83.0% as 'express " +
      "checkout conversion' when that name is defined as 50.7% is a wrong answer even though " +
      "the arithmetic is right. When both framings are informative, report both and label each.\n\n" +
      "**State the denominator you used in the task question**, so the SQL step cannot drift " +
      "from the plan. If a figure for this quantity was already reported earlier in the " +
      "conversation, recompute it the same way — a follow-up that quietly changes basis " +
      "contradicts what the reader was already told, and they cannot tell which was right.",
  },
];

const force = process.argv.includes("--force");

const existing = await query<{ n: string }>(
  `SELECT toString(count()) AS n FROM context_store WHERE source_spec = {s:String}`,
  { s: SOURCE },
);
if (Number(existing[0]?.n ?? 0) > 0) {
  if (!force) {
    console.error(
      `${existing[0]!.n} rows from ${SOURCE} already present — re-run with --force to replace them.`,
    );
    await closeDb();
    process.exit(1);
  }
  await command(`ALTER TABLE context_store DELETE WHERE source_spec = {s:String}`, { s: SOURCE });
  console.log(`removed prior ${SOURCE} rows`);
}

const rows = [];
for (const e of ENTRIES) {
  const v = await query<{ v: string }>(
    `SELECT toString(max(version)) AS v FROM context_store WHERE entity = {e:String}`,
    { e: e.entity },
  );
  const next = Number(v[0]?.v ?? 0) + 1;
  rows.push({
    entity: e.entity,
    definition_md: e.definition_md,
    version: next,
    source_spec: SOURCE,
    change_note: e.change_note,
    updated_at: new Date().toISOString().replace("T", " ").replace("Z", ""),
  });
  console.log(`  ${e.entity} v${next}`);
}
await insert("context_store", rows);
console.log(`\n✓ wrote ${rows.length} baseline definitions (source ${SOURCE}, survives reset)`);
await closeDb();
