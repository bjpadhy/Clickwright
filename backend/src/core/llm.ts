import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { emitRunEvent, type Ctx } from "./tracing.js";

let anthropic: Anthropic | null = null;

function client(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: env.llm.apiKey! });
  return anthropic;
}

/**
 * Reasoning effort is pinned, never inherited.
 *
 * The Agent SDK loads the machine's ~/.claude settings by default, so whatever
 * `effortLevel` the developer runs Claude Code at silently became the pipeline's
 * effort too — measured at xhigh: ~5 minutes and ~10 output tokens/sec for a
 * 2.8k-token DDL proposal, with the ~8s of process startup lost in the noise.
 * These prompts are tightly specified and schema-validated, so medium is the
 * right trade, and pinning it keeps runs comparable across machines.
 */
const EFFORT: Effort = "medium";

/** Reasoning-effort levels accepted by both backends. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * No API key → company Claude Code plan: call through the Claude Agent SDK,
 * which authenticates with the machine's Claude Code OAuth login. Single-turn,
 * no tools — behaves like a plain completion.
 */
async function completeViaAgentSdk(
  prompt: string,
  options: CompleteOptions,
): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const stream = query({
    prompt,
    options: {
      model: options.model ?? env.llm.model,
      effort: options.effort ?? EFFORT,
      // No tools are allowed, but the CLI can split long responses across
      // assistant turns — maxTurns: 1 intermittently dies with
      // error_max_turns on big prompts (seen in trace pipeline:01_express_checkout).
      maxTurns: 8,
      allowedTools: [],
      ...(options.system ? { customSystemPrompt: options.system } : {}),
    },
  });
  for await (const message of stream) {
    if (message.type === "result") {
      if (message.subtype !== "success") {
        throw new Error(`Agent SDK call failed: ${message.subtype}`);
      }
      // Subscription (OAuth) auth doesn't meter tokens — usage comes back as
      // zeros or per-turn fragments. Prefer reported numbers when sane
      // (includes cache reads/writes); otherwise estimate at ~4 chars/token so
      // Langfuse dashboards stay meaningful. Estimates are labeled as such.
      const u = message.usage as {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
      const reportedIn =
        u.input_tokens +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);
      const estIn = Math.ceil(prompt.length / 4);
      const estOut = Math.ceil(message.result.length / 4);
      const estimated = reportedIn < estIn * 0.2 || u.output_tokens < estOut * 0.2;
      return {
        text: message.result,
        inputTokens: estimated ? estIn : reportedIn,
        outputTokens: estimated ? estOut : u.output_tokens,
        estimated,
      };
    }
  }
  throw new Error("Agent SDK stream ended without a result message");
}

const PROMPT_DIR = fileURLToPath(new URL("../../prompts", import.meta.url));
const promptCache = new Map<string, string>();

/** Prompts live in prompts/*.txt so tuning never means editing TypeScript. */
export async function loadPrompt(
  name: string,
  vars: Record<string, string> = {},
): Promise<string> {
  let template = promptCache.get(name);
  if (template === undefined) {
    template = await readFile(path.join(PROMPT_DIR, `${name}.txt`), "utf8");
    promptCache.set(name, template);
  }
  const rendered = Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    template,
  );
  // An unfilled placeholder means the prompt and its call site have drifted apart;
  // sending "{{spec}}" to the model would degrade output invisibly.
  const leftover = [...new Set(rendered.match(/\{\{\w+\}\}/g) ?? [])];
  if (leftover.length > 0) {
    throw new Error(
      `prompt ${name} has unfilled placeholders: ${leftover.join(", ")} — the call site is missing these variables`,
    );
  }
  return rendered;
}

export type CompleteOptions = {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Set false to skip the shared system prompt (prompts/system.txt). */
  useSystemPrompt?: boolean;
  /** Override the pipeline model for one call — the judge runs on a stronger
   *  model than the agent it grades. Defaults to env.llm.model. */
  model?: string;
  /** Override the pinned reasoning effort for one call. */
  effort?: Effort;
};

let systemPrompt: string | null = null;
async function sharedSystem(): Promise<string> {
  systemPrompt ??= await readFile(path.join(PROMPT_DIR, "shared_system.txt"), "utf8");
  return systemPrompt;
}

/**
 * Single entry point for every LLM call, so model config and tracing stay in one place.
 * The generation is recorded on the trace with prompt, completion, and token usage.
 */
export async function complete(
  parent: Ctx,
  name: string,
  prompt: string,
  options: CompleteOptions = {},
): Promise<string> {
  const model = options.model ?? env.llm.model;
  if (options.useSystemPrompt !== false && !options.system) {
    options = { ...options, system: await sharedSystem() };
  }
  const generation = parent.generation({
    name,
    model,
    input: prompt,
    ...(options.system ? { metadata: { system: options.system } } : {}),
  });

  // A generation can run for a minute with nothing to show. Emit a progress tick
  // so the UI can display "thinking… 12s" instead of an inert spinner.
  const startedAt = Date.now();
  emitRunEvent({
    type: "log",
    name: "llm_start",
    payload: { call: name, promptChars: prompt.length },
  });
  const ticker = setInterval(() => {
    emitRunEvent({
      type: "log",
      name: "llm_progress",
      payload: { call: name, elapsedMs: Date.now() - startedAt },
    });
  }, 3000);

  try {
    let text: string;
    let usage: { input: number; output: number };
    let usageEstimated = false;

    if (env.llm.apiKey) {
      const response = await client().messages.create({
        model,
        max_tokens: options.maxTokens ?? 8000,
        // On claude-opus-5 thinking is ON by default and max_tokens caps
        // thinking + response together, so a judge call needs real headroom.
        output_config: { effort: options.effort ?? EFFORT },
        // `temperature` is NOT sent: on claude-sonnet-5 and every other current
        // model a non-default sampling parameter is rejected with a 400.
        ...(options.system ? { system: options.system } : {}),
        messages: [{ role: "user", content: prompt }],
      });
      text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      usage = {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      };
    } else {
      const result = await completeViaAgentSdk(prompt, options);
      text = result.text;
      usage = { input: result.inputTokens, output: result.outputTokens };
      usageEstimated = result.estimated;
    }

    clearInterval(ticker);
    emitRunEvent({
      type: "log",
      name: "llm_done",
      payload: { call: name, elapsedMs: Date.now() - startedAt, outputChars: text.length },
    });
    generation.end({
      output: text,
      usage,
      ...(usageEstimated
        ? { metadata: { usage_source: "estimated ~4 chars/token (subscription auth reports no usage)" } }
        : {}),
    });
    return text;
  } catch (error) {
    clearInterval(ticker);
    generation.end({
      level: "ERROR",
      statusMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Pull a JSON object out of a model response.
 *
 * `stripFences` only helps when the model actually fenced its output. A reasoning
 * model asked for "ONLY JSON" still sometimes writes a sentence first, or leaves a
 * trailing comma — both of which make JSON.parse fail on text that is otherwise
 * perfectly good. Scan for the first balanced top-level object instead (respecting
 * strings and escapes so a brace inside a reason string doesn't end it early),
 * then drop trailing commas.
 *
 * Throws with a slice of the offending text: a parse failure you cannot see is
 * undiagnosable.
 */
export function extractJson<T = unknown>(raw: string): T {
  const text = stripFences(raw);
  const start = text.indexOf("{");
  if (start === -1) {
    throw new Error(`no JSON object in model output: ${text.slice(0, 300)}`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) {
    throw new Error(`unterminated JSON object in model output: ${text.slice(start, start + 300)}`);
  }

  const candidate = text.slice(start, end).replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(candidate) as T;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} — model output was: ${candidate.slice(0, 400)}`,
    );
  }
}

/** Models like to wrap output in ```sql fences; strip them before executing. */
export function stripFences(text: string): string {
  const fenced = text.match(/```(?:sql|json|markdown|md)?\s*\n([\s\S]*?)```/);
  return (fenced?.[1] ?? text).trim();
}

/** Split a DDL script into individual statements — ClickHouse takes one at a time. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}
