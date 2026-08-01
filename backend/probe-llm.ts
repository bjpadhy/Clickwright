import { query } from "@anthropic-ai/claude-agent-sdk"

const PROMPT = "Reply with exactly this JSON and nothing else: {\"ok\":true}"

async function run(label: string, options: Record<string, unknown>) {
  const t0 = Date.now()
  let first = 0
  const seen: string[] = []
  let turns = 0
  let result = ""
  const stream = query({ prompt: PROMPT, options: { model: "claude-sonnet-5", allowedTools: [], maxTurns: 8, ...options } as never })
  for await (const m of stream as AsyncIterable<{ type: string; subtype?: string; result?: string }>) {
    if (!first) first = Date.now()
    seen.push(`${m.type}${m.subtype ? ":" + m.subtype : ""}@${((Date.now() - t0) / 1000).toFixed(1)}s`)
    if (m.type === "assistant") turns++
    if (m.type === "result") result = m.result ?? ""
  }
  console.log(`\n${label}`)
  console.log(`  total ${((Date.now() - t0) / 1000).toFixed(1)}s | first msg ${((first - t0) / 1000).toFixed(1)}s | assistant turns ${turns}`)
  console.log(`  messages: ${seen.join(" ")}`)
  console.log(`  result: ${JSON.stringify(result.slice(0, 60))}`)
}

await run("A · as the code calls it today (settingSources omitted → loads user+project+local)", {})
await run("B · SDK isolation (settingSources: [])", { settingSources: [] })
await run("C · isolation + no partial-turn budget (maxTurns: 1)", { settingSources: [], maxTurns: 1 })
