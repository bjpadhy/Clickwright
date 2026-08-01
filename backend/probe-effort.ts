import { query } from "@anthropic-ai/claude-agent-sdk"
import { loadPrompt } from "./src/core/llm.js"

// A realistic generation: schema-constrained JSON of roughly the size the
// ddl step produces, so throughput is measured on the shape that was slow.
const PROMPT = await loadPrompt("ddl", {
  context: "## Tables\n- application_started (funnel entry)\n- purchase_completed (revenue)\n",
  live_tables: "application_started, purchase_completed",
  reconciliation_notes: "",
  spec: "# Group booking\nUsers add co-travellers to one application and submit together.\nEvents: group_started, traveller_added, group_submitted.",
  profile: "### event: group_started (900 rows)\nid String, timestamp DateTime64(3), user_id UInt64, application_id UInt64, group_size UInt8, device_type String\n\n### event: traveller_added (1800 rows)\nid String, timestamp DateTime64(3), user_id UInt64, application_id UInt64, traveller_index UInt8, citizenship String\n\n### event: group_submitted (700 rows)\nid String, timestamp DateTime64(3), user_id UInt64, application_id UInt64, total_travellers UInt8, amount_usd Float64",
  new_fields: "group_size, traveller_index, total_travellers, amount_usd",
  feedback: "",
})

async function run(label: string, options: Record<string, unknown>) {
  const t0 = Date.now()
  let text = ""
  for await (const m of query({ prompt: PROMPT, options: { model: "claude-sonnet-5", allowedTools: [], maxTurns: 8, ...options } as never }) as AsyncIterable<{ type: string; subtype?: string; result?: string }>) {
    if (m.type === "result") { if (m.subtype !== "success") throw new Error(m.subtype); text = m.result ?? "" }
  }
  const s = (Date.now() - t0) / 1000
  const out = Math.ceil(text.length / 4)
  console.log(`${label.padEnd(34)} ${s.toFixed(1).padStart(6)}s   ~${String(out).padStart(5)} out-tok   ${(out / s).toFixed(1).padStart(5)} tok/s`)
}

console.log(`prompt: ~${Math.ceil(PROMPT.length / 4)} input tokens\n`)
await run("inherited effort (xhigh, before)", {})
await run("pinned effort: medium (after)", { effort: "medium" })
