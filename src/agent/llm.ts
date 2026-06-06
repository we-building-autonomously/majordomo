// Thin wrapper over the Anthropic SDK (lazy-loaded). Used by the IT-agent brain
// and the browser-signup driver. Centralizes model choice + tool-call extraction.
import { anthropicKey } from "../config.ts";

export const MODEL = process.env.MAJORDOMO_MODEL || "claude-opus-4-8";

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };

export type ClaudeResult = {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string | null;
};

type AnyClient = {
  messages: { create: (args: Record<string, unknown>) => Promise<any> };
};

let cached: AnyClient | undefined;

async function client(): Promise<AnyClient> {
  if (cached) return cached;
  if (!anthropicKey()) throw new Error("ANTHROPIC_API_KEY is not set");
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = (mod.default ?? (mod as any).Anthropic) as new (o: { apiKey: string }) => AnyClient;
  cached = new Anthropic({ apiKey: anthropicKey()! });
  return cached;
}

export async function callClaudeTools(opts: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  tools: ToolDef[];
  toolChoice?: { type: "tool"; name: string } | { type: "auto" } | { type: "any" };
  maxTokens?: number;
}): Promise<ClaudeResult> {
  const c = await client();
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    tools: opts.tools,
    tool_choice: opts.toolChoice ?? { type: "auto" },
    messages: opts.messages,
  });

  const toolCalls: ToolCall[] = [];
  let text = "";
  for (const block of resp.content ?? []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
  }
  return { text, toolCalls, stopReason: resp.stop_reason ?? null };
}

export function haveLLM(): boolean {
  return !!anthropicKey();
}

export type ToolExecResult = { result: string; stop?: boolean; final?: unknown };

/**
 * Run an agentic tool-use loop. `execute` is called for each tool the model
 * requests and returns a string result (fed back) plus an optional `stop`/`final`
 * to end the loop (used by a "finish" tool). Returns the final payload + transcript.
 */
export async function runToolLoop(opts: {
  system: string;
  userPrompt: string;
  tools: ToolDef[];
  execute: (name: string, input: Record<string, unknown>) => Promise<ToolExecResult>;
  maxSteps?: number;
  maxTokens?: number;
  onStep?: (name: string, input: Record<string, unknown>) => void;
}): Promise<{ final: unknown; text: string; steps: number }> {
  const c = await client();
  const messages: { role: "user" | "assistant"; content: unknown }[] = [
    { role: "user", content: opts.userPrompt },
  ];
  let lastText = "";
  const maxSteps = opts.maxSteps ?? 16;

  for (let step = 0; step < maxSteps; step++) {
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: opts.maxTokens ?? 1500,
      system: opts.system,
      tools: opts.tools,
      tool_choice: { type: "auto" },
      messages,
    });

    messages.push({ role: "assistant", content: resp.content });
    const toolUses: ToolCall[] = [];
    for (const block of resp.content ?? []) {
      if (block.type === "text") lastText += block.text;
      else if (block.type === "tool_use") toolUses.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }

    if (toolUses.length === 0) return { final: undefined, text: lastText, steps: step + 1 };

    const toolResults: unknown[] = [];
    for (const tc of toolUses) {
      opts.onStep?.(tc.name, tc.input);
      const r = await opts.execute(tc.name, tc.input);
      toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: r.result });
      if (r.stop) return { final: r.final, text: lastText, steps: step + 1 };
    }
    messages.push({ role: "user", content: toolResults });
  }
  return { final: undefined, text: lastText, steps: maxSteps };
}
