import { query } from "@anthropic-ai/claude-agent-sdk"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { loadPrompt } from "./src/core/llm.js"
import { getContext, reconcileWithLive } from "./src/agents/context.js"
import { profileRecords, profileSummary } from "./src/core/profiler.js"

// Rebuild the exact ddl prompt the failing run used.
const dir = path.resolve("../specs/02_group_family")
const spec = await readFile(path.join(dir, "spec.md"), "utf8")
const rows = (await readFile(path.join(dir, "events.ndjson"), "utf8")).split("\n").filter(l => l.trim()).map(l => JSON.parse(l) as Record<string, unknown>)
const groups = new Map<string, Record<string, unknown>[]>()
for (const r of rows) { const e = String(r["event"]); groups.set(e, [...(groups.get(e) ?? []), r]) }
const profile = [...groups].map(([e, recs]) => `### event: ${e} (${recs.length} rows)\n${profileSummary(profileRecords(recs, e))}`).join("\n\n")
const bundle = await getContext({ include: ["table"] })
const recon = await reconcileWithLive()
const prompt = await loadPrompt("ddl", {
  context: bundle.markdown, live_tables: recon.liveTables.join(", "), reconciliation_notes: "",
  spec, profile, new_fields: "(none)", feedback: "",
})
console.log(`prompt: ${prompt.length} chars ≈ ${Math.ceil(prompt.length / 4)} tokens (context ${bundle.markdown.length}, profile ${profile.length}, spec ${spec.length})\n`)

async function run(label: string, options: Record<string, unknown>) {
  const t0 = Date.now()
  let think = 0, text = 0, model = "?", turns = 0
  const marks: string[] = []
  const stream = query({ prompt, options: { model: "claude-sonnet-5", allowedTools: [], maxTurns: 8, ...options } as never })
  for await (const m of stream as AsyncIterable<any>) {
    const at = ((Date.now() - t0) / 1000).toFixed(0)
    if (m.type === "system" && m.subtype === "init") { model = m.model ?? m.slash_commands ? (m.model ?? "?") : "?"; marks.push(`init@${at}s`) }
    if (m.type === "assistant") {
      turns++
      for (const b of m.message?.content ?? []) {
        if (b.type === "thinking") think += (b.thinking ?? "").length
        if (b.type === "text") text += (b.text ?? "").length
      }
      marks.push(`assistant@${at}s`)
    }
    if (m.type === "result") marks.push(`result:${m.subtype}@${at}s`)
  }
  console.log(`${label}\n  total ${((Date.now() - t0) / 1000).toFixed(1)}s | turns ${turns} | thinking ${think} chars (~${Math.ceil(think / 4)} tok) | answer ${text} chars (~${Math.ceil(text / 4)} tok) | model ${model}`)
  console.log(`  ${marks.join(" ")}\n`)
}

await run("A · as the pipeline calls it today (user settings loaded → effortLevel xhigh)", {})
await run("B · settingSources: [] (SDK isolation, default effort)", { settingSources: [] })
