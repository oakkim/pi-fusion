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
import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentToolUpdateCallback, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { LiveProgress } from "./pane.ts";
import { TOOL_OUTPUT_MAX_BYTES } from "./config.ts";
import type { ExecutorToolDef } from "./tools.ts";
import { addUsage, zeroUsage, type UsageSummary } from "./cost.ts";
import { truncateToBytes } from "./utils.ts";

type ToolContent = ToolResultMessage["content"];

interface CompleteOptions {
  headers?: Record<string, string | null>;
  maxTokens: number;
  temperature?: number;
  reasoning?: ThinkingLevel;
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
  thinkingLevel: ModelThinkingLevel,
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
  if (thinkingLevel !== "off") options.reasoning = thinkingLevel;
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
  thinkingLevel: ModelThinkingLevel = "off",
  onProgress?: (progress: LiveProgress) => void,
): Promise<ToolLoopResult> {
  const options = buildCompleteOptions(model, maxTokens, temperature, thinkingLevel, signal, ctx);
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
    const resp = await runComplete(registry, model, { systemPrompt, messages, tools }, options, onProgress);
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
        const reason = forceFinalize ? "stopped: repeated or failing tool calls" : "tool-call budget exhausted";
        onProgress?.({ kind: "tool_start", toolId: tc.id, name: tc.name, arguments: formatToolArguments(tc.arguments) });
        const syn = syntheticResult(tc, reason);
        messages.push(syn);
        added.push(syn);
        onProgress?.({ kind: "tool_end", toolId: tc.id, ok: false, output: reason });
        toolCalls.push({ name: tc.name, ok: false });
        continue;
      }
      const ok = await executeToolCall(tc, byName.get(tc.name), signal, ctx, messages, added, onProgress);
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
      const finalMsg = await runComplete(registry, model, { systemPrompt: finalSystem, messages }, options, onProgress);
      turns++;
      usage = addUsage(usage, finalMsg.usage);
      added.push(finalMsg);
      return { message: finalMsg, added, turns, toolCalls, cappedOut: true, usage };
    }
  }
}

type ResultOnlyStream = { result(): Promise<AssistantMessage> };
type CompatibleStream = AssistantMessageEventStream | ResultOnlyStream;
type StreamContext = { systemPrompt: string; messages: Message[]; tools?: Tool[] };
type PendingToolProgress = { id?: string; name?: string; arguments: string };

async function runComplete(
  registry: ModelRegistry,
  model: Model<Api>,
  context: StreamContext,
  options: CompleteOptions,
  onProgress?: (progress: LiveProgress) => void,
): Promise<AssistantMessage> {
  options.signal?.throwIfAborted();
  const compatibleRegistry = registry as unknown as {
    streamSimple?: (model: Model<Api>, context: StreamContext, options: CompleteOptions) => CompatibleStream;
  };
  if (options.reasoning && !compatibleRegistry.streamSimple) {
    throw new Error("Fusion thinking requires pi 0.86 or newer.");
  }

  onProgress?.({ kind: "phase", phase: "waiting", replaceText: true });
  let resp: AssistantMessage;
  if (!compatibleRegistry.streamSimple) {
    resp = await registry.complete(model, context, options);
  } else {
    const stream = compatibleRegistry.streamSimple(model, context, options);
    if (isAsyncEventStream(stream)) {
      const pendingTools = new Map<number, PendingToolProgress>();
      for await (const event of stream) {
        consumeStreamEvent(event, pendingTools, onProgress);
      }
    }
    // result() is retained for end(result) streams and old registry adapters
    // that expose only the result promise.
    resp = await stream.result();
  }

  if (resp.stopReason === "error" || resp.stopReason === "aborted") {
    throw new Error(resp.errorMessage ?? `Model stopped with reason: ${resp.stopReason}`);
  }
  return resp;
}

function isAsyncEventStream(stream: CompatibleStream): stream is AssistantMessageEventStream {
  return typeof (stream as Partial<AsyncIterable<AssistantMessageEvent>>)[Symbol.asyncIterator] === "function";
}

function consumeStreamEvent(
  event: AssistantMessageEvent,
  pendingTools: Map<number, PendingToolProgress>,
  onProgress: ((progress: LiveProgress) => void) | undefined,
): void {
  switch (event.type) {
    case "start":
      onProgress?.({ kind: "phase", phase: "waiting", replaceText: true });
      return;
    case "thinking_start":
      onProgress?.({ kind: "phase", phase: "thinking", replaceText: true });
      return;
    case "thinking_delta":
    case "thinking_end":
      // Deliberately do not inspect or forward thinking text.
      onProgress?.({ kind: "phase", phase: "thinking" });
      return;
    case "text_start":
      onProgress?.({ kind: "phase", phase: "responding", text: "", replaceText: true });
      return;
    case "text_delta":
    case "text_end":
      onProgress?.({ kind: "phase", phase: "responding", text: visibleAssistantText(event.partial), replaceText: true });
      return;
    case "toolcall_start": {
      const call = partialToolCall(event.partial, event.contentIndex);
      const tool: PendingToolProgress = { id: call?.id || undefined, name: call?.name || undefined, arguments: "" };
      pendingTools.set(event.contentIndex, tool);
      onProgress?.({ kind: "phase", phase: "tool" });
      if (tool.id && tool.name) {
        onProgress?.({ kind: "tool_start", toolId: tool.id, name: tool.name, arguments: tool.arguments });
      }
      return;
    }
    case "toolcall_delta": {
      const call = partialToolCall(event.partial, event.contentIndex);
      const previous = pendingTools.get(event.contentIndex);
      // event.delta is the raw argument fragment. event.partial may already
      // contain parsed cumulative arguments, so combining both duplicates text.
      const tool: PendingToolProgress = {
        id: call?.id || previous?.id,
        name: call?.name || previous?.name,
        arguments: `${previous?.arguments ?? ""}${event.delta}`,
      };
      pendingTools.set(event.contentIndex, tool);
      onProgress?.({ kind: "phase", phase: "tool" });
      if (tool.id && tool.name) {
        onProgress?.({ kind: "tool_start", toolId: tool.id, name: tool.name, arguments: tool.arguments });
      }
      return;
    }
    case "toolcall_end": {
      const previous = pendingTools.get(event.contentIndex);
      const tool: PendingToolProgress = {
        id: event.toolCall.id || previous?.id,
        name: event.toolCall.name || previous?.name,
        arguments: formatToolArguments(event.toolCall.arguments),
      };
      pendingTools.set(event.contentIndex, tool);
      onProgress?.({ kind: "phase", phase: "tool" });
      if (tool.id && tool.name) {
        onProgress?.({ kind: "tool_start", toolId: tool.id, name: tool.name, arguments: tool.arguments });
      }
      return;
    }
    case "done":
      return;
    case "error":
      return;
  }
}

function partialToolCall(message: AssistantMessage, contentIndex: number): ToolCall | undefined {
  const block = message.content[contentIndex];
  return block?.type === "toolCall" ? block : undefined;
}

function formatToolArguments(argumentsValue: unknown): string {
  if (argumentsValue === undefined || argumentsValue === null) return "";
  if (typeof argumentsValue === "string") return argumentsValue;
  try {
    return JSON.stringify(argumentsValue);
  } catch {
    return String(argumentsValue);
  }
}

function visibleAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function toolResultText(content: ToolContent): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function executeToolCall(
  tc: ToolCall,
  def: ExecutorToolDef | undefined,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  messages: Message[],
  added: Message[],
  onProgress?: (progress: LiveProgress) => void,
): Promise<boolean> {
  const argumentsText = formatToolArguments(tc.arguments);
  onProgress?.({ kind: "tool_start", toolId: tc.id, name: tc.name, arguments: argumentsText });
  try {
    if (!def) throw new Error(`unknown tool: ${tc.name}`);
    const onUpdate: AgentToolUpdateCallback = (partial) => {
      onProgress?.({ kind: "tool_update", toolId: tc.id, output: toolResultText(partial.content as ToolContent) });
    };
    const out = await def.execute(tc.id, tc.arguments as Record<string, unknown>, signal, onUpdate, ctx);
    const isError = out.isError === true;
    const content = truncateToolContent(sanitizeToolContent(out.content, isError));
    const msg: Message = {
      role: "toolResult",
      toolCallId: tc.id,
      toolName: tc.name,
      content,
      isError,
      timestamp: Date.now(),
    };
    messages.push(msg);
    added.push(msg);
    onProgress?.({ kind: "tool_end", toolId: tc.id, ok: !isError, output: toolResultText(content) });
    return !isError;
  } catch (err) {
    const text = sanitizeError(err instanceof Error ? err.message : String(err));
    const errorText = `Error: ${text}`;
    const msg: Message = {
      role: "toolResult",
      toolCallId: tc.id,
      toolName: tc.name,
      content: [{ type: "text", text: errorText }],
      isError: true,
      timestamp: Date.now(),
    };
    messages.push(msg);
    added.push(msg);
    onProgress?.({ kind: "tool_end", toolId: tc.id, ok: false, output: errorText });
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
  if (model.api === "openai-codex-responses" || model.reasoning) return false;
  const compat = model.compat as { supportsTemperature?: boolean } | undefined;
  return compat?.supportsTemperature !== false;
}

export function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}
