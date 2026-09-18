/**
 * Executor tool loop. Port of pi-devin-fusion's llm.ts, generalized to
 * continue from a persistent worker history instead of a single prompt.
 */

import {
  type AssistantMessage,
  type Message,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { TOOL_OUTPUT_MAX_BYTES } from "./config.ts";
import type { ExecutorToolDef } from "./tools.ts";
import { addUsage, zeroUsage, type UsageSummary } from "./cost.ts";
import { truncateToBytes } from "./utils.ts";

type ToolContent = ToolResultMessage["content"];

interface CompleteOptions {
  headers?: Record<string, string | null>;
  maxTokens: number;
  temperature?: number;
  signal: AbortSignal | undefined;
}

/**
 * Mirror pi core's provider-attribution: opencode-family providers require
 * x-opencode-session / x-opencode-client headers, which the normal agent loop
 * adds for us. Executor calls bypass that loop, so they must add the headers
 * manually or the provider rejects with 400 MissingSessionID.
 */
function opencodeSessionHeaders(model: Model<Api>, sessionId: string | undefined): Record<string, string> | undefined {
  if (!sessionId) return undefined;
  const baseUrl = (model as unknown as { baseUrl?: string }).baseUrl ?? "";
  let host = "";
  try { host = new URL(baseUrl).hostname; } catch { /* relative or empty */ }
  if (model.provider !== "opencode" && model.provider !== "opencode-go" && host !== "opencode.ai") {
    return undefined;
  }
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

function buildCompleteOptions(
  model: Model<Api>,
  maxTokens: number,
  temperature: number,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): CompleteOptions {
  const sessionId = (ctx.sessionManager as unknown as { getSessionId?: () => string | undefined }).getSessionId?.();
  const options: CompleteOptions = {
    headers: opencodeSessionHeaders(model, sessionId),
    signal,
    maxTokens,
  };
  if (getSupportsTemperature(model)) options.temperature = temperature;
  return options;
}

export interface ToolLoopResult {
  message: AssistantMessage;
  added: Message[]; // everything appended to history this turn (assistant + toolResults + final)
  turns: number;
  toolCalls: Array<{ name: string; ok: boolean }>;
  cappedOut: boolean;
  /** Summed provider usage across every complete() call in this turn. */
  usage: UsageSummary;
}

export async function runExecutorTurn(
  registry: ModelRegistry,
  model: Model<Api>,
  systemPrompt: string,
  history: Message[],
  maxTokens: number,
  temperature: number,
  signal: AbortSignal | undefined,
  toolDefs: ExecutorToolDef[],
  maxToolCalls: number,
  ctx: ExtensionContext,
): Promise<ToolLoopResult> {
  const options = buildCompleteOptions(model, maxTokens, temperature, signal, ctx);
  const tools: Tool[] = toolDefs.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));
  const byName = new Map(toolDefs.map((d) => [d.name, d]));

  const messages: Message[] = [...history];
  const added: Message[] = [];
  const toolCalls: Array<{ name: string; ok: boolean }> = [];
  let usage = zeroUsage();
  let turns = 0;
  let used = 0;
  let lastKey: string | undefined;
  let repeatRun = 0;
  let errorStreak = 0;

  while (true) {
    const resp = await runComplete(registry, model, { systemPrompt, messages, tools }, options);
    turns++;
    usage = addUsage(usage, resp.usage);
    const calls = resp.content.filter((c): c is ToolCall => c.type === "toolCall");
    if (resp.stopReason !== "toolUse" || calls.length === 0) {
      added.push(resp);
      return { message: resp, added, turns, toolCalls, cappedOut: false, usage };
    }

    messages.push(resp);
    added.push(resp);
    let forceFinalize = false;

    for (const tc of calls) {
      signal?.throwIfAborted();
      if (forceFinalize || used >= maxToolCalls) {
        const syn = syntheticResult(tc, forceFinalize ? "stopped: repeated or failing tool calls" : "tool-call budget exhausted");
        messages.push(syn);
        added.push(syn);
        toolCalls.push({ name: tc.name, ok: false });
        continue;
      }
      const ok = await executeToolCall(tc, byName.get(tc.name), signal, ctx, messages, added);
      used++;
      toolCalls.push({ name: tc.name, ok });
      const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
      repeatRun = key === lastKey ? repeatRun + 1 : 1;
      lastKey = key;
      errorStreak = ok ? 0 : errorStreak + 1;
      if (repeatRun >= 3 || errorStreak >= 3) forceFinalize = true;
    }

    if (forceFinalize || used >= maxToolCalls) {
      const finalSystem = `${systemPrompt}\n\nYou have reached the tool-call limit. Write your complete final answer now using only what you have already gathered — do not request any more tools.`;
      const finalMsg = await runComplete(registry, model, { systemPrompt: finalSystem, messages }, options);
      turns++;
      usage = addUsage(usage, finalMsg.usage);
      added.push(finalMsg);
      return { message: finalMsg, added, turns, toolCalls, cappedOut: true, usage };
    }
  }
}

async function runComplete(
  registry: ModelRegistry,
  model: Model<Api>,
  context: { systemPrompt: string; messages: Message[]; tools?: Tool[] },
  options: CompleteOptions,
): Promise<AssistantMessage> {
  const resp = await registry.complete(model, context, options);
  if (resp.stopReason === "error" || resp.stopReason === "aborted") {
    throw new Error(resp.errorMessage ?? `Model stopped with reason: ${resp.stopReason}`);
  }
  return resp;
}

async function executeToolCall(
  tc: ToolCall,
  def: ExecutorToolDef | undefined,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  messages: Message[],
  added: Message[],
): Promise<boolean> {
  try {
    if (!def) throw new Error(`unknown tool: ${tc.name}`);
    const out = await def.execute(tc.id, tc.arguments as Record<string, unknown>, signal, undefined, ctx);
    const msg: Message = {
      role: "toolResult",
      toolCallId: tc.id,
      toolName: tc.name,
      content: truncateToolContent(sanitizeToolContent(out.content, out.isError)),
      isError: out.isError,
      timestamp: Date.now(),
    };
    messages.push(msg);
    added.push(msg);
    return !out.isError;
  } catch (err) {
    const text = sanitizeError(err instanceof Error ? err.message : String(err));
    const msg: Message = {
      role: "toolResult",
      toolCallId: tc.id,
      toolName: tc.name,
      content: [{ type: "text", text: `Error: ${text}` }],
      isError: true,
      timestamp: Date.now(),
    };
    messages.push(msg);
    added.push(msg);
    return false;
  }
}

function syntheticResult(tc: ToolCall, text: string): ToolResultMessage {
  return { role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: [{ type: "text", text }], isError: true, timestamp: Date.now() };
}

export function sanitizeToolContent(content: ToolContent, isError: boolean): ToolContent {
  if (!isError) return content;
  return content.map((part) => {
    if (part.type !== "text") return part;
    return { type: "text", text: sanitizeError(part.text) };
  });
}

function truncateToolContent(content: ToolContent): ToolContent {
  return content.map((part) => {
    if (part.type !== "text") return part;
    const truncated = truncateToBytes(part.text, TOOL_OUTPUT_MAX_BYTES, "\n…[truncated]");
    return truncated === part.text ? part : { type: "text", text: truncated };
  });
}

export function sanitizeError(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,)]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key=)[^\s&]+/gi, "$1[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]");
}

export function getSupportsTemperature(model: Model<Api>): boolean {
  const meta = model as unknown as { supportsTemperature?: boolean };
  return meta.supportsTemperature !== false;
}

export function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}
