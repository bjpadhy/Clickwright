import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import type { Ctx } from "./tracing.js";

let anthropic: Anthropic | null = null;

function client(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: env.llm.apiKey! });
  return anthropic;
}

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
      model: env.llm.model,
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
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    template,
  );
}

export type CompleteOptions = {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Set false to skip the shared system prompt (prompts/system.txt). */
  useSystemPrompt?: boolean;
};

let systemPrompt: string | null = null;
async function sharedSystem(): Promise<string> {
  systemPrompt ??= await readFile(path.join(PROMPT_DIR, "system.txt"), "utf8");
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
  const model = env.llm.model;
  if (options.useSystemPrompt !== false && !options.system) {
    options = { ...options, system: await sharedSystem() };
  }
  const generation = parent.generation({
    name,
    model,
    input: prompt,
    ...(options.system ? { metadata: { system: options.system } } : {}),
  });

  try {
    let text: string;
    let usage: { input: number; output: number };
    let usageEstimated = false;

    if (env.llm.apiKey) {
      const response = await client().messages.create({
        model,
        max_tokens: options.maxTokens ?? 8000,
        temperature: options.temperature ?? 0,
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

    generation.end({
      output: text,
      usage,
      ...(usageEstimated
        ? { metadata: { usage_source: "estimated ~4 chars/token (subscription auth reports no usage)" } }
        : {}),
    });
    return text;
  } catch (error) {
    generation.end({
      level: "ERROR",
      statusMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
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
