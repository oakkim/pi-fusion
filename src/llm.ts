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
import { compactExecutorHistory } from "./compaction.ts";
import { repairIncompleteToolCalls } from "./runtime.ts";

type ToolContent = ToolResultMessage["content"];

interface CompleteOptions {
  headers?: Record<string, string | null>;
  maxTokens: number;
  temperature?: number;
  reasoning?: ThinkingLevel;
  /** OpenAI priority service tier (the provider's fast mode). */
  serviceTier?: "priority";
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

export function supportsOpenAIFastMode(model: Model<Api>): boolean {
  return (model.provider === "openai" || model.provider === "openai-codex")
    && (model.api === "openai-responses" || model.api === "openai-codex-responses");
}

function buildCompleteOptions(
  model: Model<Api>,
  maxTokens: number,
  temperature: number,
  thinkingLevel: ModelThinkingLevel,
  fastMode: boolean,
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
  if (fastMode && supportsOpenAIFastMode(model)) options.serviceTier = "priority";
  return options;
}

/** A single tool-free completion, with the same provider/auth path as workers. */
export function runTextRequest(
  registry: ModelRegistry, model: Model<Api>, systemPrompt: string, messages: Message[],
  maxTokens: number, signal: AbortSignal | undefined, ctx: ExtensionContext,
  thinkingLevel: ModelThinkingLevel = "off",
  fastMode = false,
): Promise<AssistantMessage> {
  return runComplete(registry, model, { systemPrompt, messages },
    buildCompleteOptions(model, maxTokens, 0.2, thinkingLevel, fastMode, signal, ctx));
}

export interface ExecutorCheckpoint {
  history: Message[];
  usage: UsageSummary;
  turns: number;
  toolCalls: number;
  compacted: boolean;
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
  takeSteeringMessages?: (finalCheckpoint?: boolean) => Message[],
  fastMode = false,
  persistence?: { maxHistoryMessages: number; checkpoint: (state: ExecutorCheckpoint) => void },
): Promise<ToolLoopResult> {
  const options = buildCompleteOptions(model, maxTokens, temperature, thinkingLevel, fastMode, signal, ctx);
  const tools: Tool[] = toolDefs.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));
  const byName = new Map(toolDefs.map((d) => [d.name, d]));

  const messages: Message[] = repairIncompleteToolCalls(history);
  const added: Message[] = [];
  const toolCalls: Array<{ name: string; ok: boolean }> = [];
  let usage = zeroUsage();
  let turns = 0;
  let used = 0;
  let lastKey: string | undefined;
  let repeatRun = 0;
  let errorStreak = 0;
  let compacted = false;
  const checkpoint = () => persistence?.checkpoint({ history: [...messages], usage, turns, toolCalls: toolCalls.length, compacted });
  const complete = async (context: StreamContext, outputTokens = maxTokens, summarizing = false) => {
    const response = await runComplete(registry, model, context, { ...options, maxTokens: outputTokens, ...(summarizing ? { reasoning: undefined } : {}) }, onProgress);
    usage = addUsage(usage, response.usage);
    turns++;
    if (!summarizing) { messages.push(response); added.push(response); }
    checkpoint();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? `Model stopped with reason: ${response.stopReason}`);
    }
    return response;
  };
  const prepareContext = async (system = systemPrompt, selectedTools?: Tool[]) => {
    signal?.throwIfAborted();
    if (!persistence) return;
    const next = await compactExecutorHistory(
      { systemPrompt: system, messages, tools: selectedTools }, model, maxTokens,
      persistence.maxHistoryMessages, signal, (context, tokens) => complete(context, tokens, true),
    );
    if (next) {
      messages.splice(0, messages.length, ...next);
      compacted = true;
      checkpoint();
    }
  };

  const takeSteering = (finalCheckpoint = false): Message[] => takeSteeringMessages?.(finalCheckpoint) ?? [];
  const appendSteering = (steering: Message[]): void => {
    if (steering.length === 0) return;
    messages.push(...steering);
    added.push(...steering);
    checkpoint();
  };

  try {
    checkpoint();
    while (true) {
      appendSteering(takeSteering());
      await prepareContext(systemPrompt, tools);
      const resp = await complete({ systemPrompt, messages, tools });
      const calls = resp.content.filter((c): c is ToolCall => c.type === "toolCall");
      if (resp.stopReason !== "toolUse" || calls.length === 0) {
        const steering = takeSteering(true);
        if (steering.length > 0) {
          // The response completed while a related update was arriving. Preserve
          // it as an intermediate answer, inject the update, and let the same
          // worker turn revise its work instead of scheduling another turn.
          appendSteering(steering);
          repeatRun = 0;
          errorStreak = 0;
          lastKey = undefined;
          continue;
        }
        return { message: resp, added, turns, toolCalls, cappedOut: false, usage };
      }

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
          checkpoint();
          continue;
        }
        const ok = await executeToolCall(tc, byName.get(tc.name), signal, ctx, messages, added, onProgress);
        used++;
        toolCalls.push({ name: tc.name, ok });
        checkpoint();
        const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
        repeatRun = key === lastKey ? repeatRun + 1 : 1;
        lastKey = key;
        errorStreak = ok ? 0 : errorStreak + 1;
        if (repeatRun >= 3 || errorStreak >= 3) forceFinalize = true;
      }

      const steeringAfterTools = takeSteering();
      appendSteering(steeringAfterTools);
      if (steeringAfterTools.length > 0 && used < maxToolCalls) {
        // A new Lead instruction can legitimately redirect a repeated/failing
        // tool loop. Give the revised plan a fresh cycle while preserving the
        // hard total tool-call budget.
        forceFinalize = false;
        repeatRun = 0;
        errorStreak = 0;
        lastKey = undefined;
      }

      if (forceFinalize || used >= maxToolCalls) {
        // No more tools are available, so close the cooperative steering mailbox
        // before the final no-tools request. A later update is safer as a queued
        // turn than as an instruction the worker cannot execute.
        const preFinalSteering = takeSteering(true);
        appendSteering(preFinalSteering);
        if (preFinalSteering.length > 0) takeSteering(true);
        const finalSystem = `${systemPrompt}\n\nYou have reached the tool-call limit. Write your complete final answer now using only what you have already gathered — do not request any more tools.`;
        while (true) {
          await prepareContext(finalSystem);
          const finalMsg = await complete({ systemPrompt: finalSystem, messages });
          const steering = takeSteering(true);
          if (steering.length === 0) {
            return { message: finalMsg, added, turns, toolCalls, cappedOut: true, usage };
          }
          appendSteering(steering);
        }
      }
    }
  } finally {
    // A provider/tool can fail after side effects. Preserve completed outcomes
    // and explicitly mark missing results as unknown before any follow-up.
    const repaired = repairIncompleteToolCalls(messages);
    messages.splice(0, messages.length, ...repaired);
    checkpoint();
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
    stream?: (model: Model<Api>, context: StreamContext, options: CompleteOptions & { reasoningEffort?: ThinkingLevel }) => CompatibleStream;
    streamSimple?: (model: Model<Api>, context: StreamContext, options: CompleteOptions) => CompatibleStream;
  };
  if (options.reasoning && !compatibleRegistry.streamSimple && !options.serviceTier) {
    throw new Error("Fusion thinking requires pi 0.86 or newer.");
  }

  onProgress?.({ kind: "phase", phase: "waiting", replaceText: true });
  let resp: AssistantMessage | undefined;
  let stream: CompatibleStream | undefined;
  if (options.serviceTier) {
    // streamSimple intentionally exposes only provider-neutral options and
    // drops serviceTier. Use the full OpenAI API path so priority processing,
    // reasoning effort, and provider-side cost accounting all stay intact.
    const providerOptions = { ...options, reasoningEffort: options.reasoning };
    if (compatibleRegistry.stream) stream = compatibleRegistry.stream(model, context, providerOptions);
    else resp = await registry.complete(model, context, providerOptions as never);
  } else if (compatibleRegistry.streamSimple) {
    stream = compatibleRegistry.streamSimple(model, context, options);
  } else {
    resp = await registry.complete(model, context, options);
  }
  if (stream) {
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
  if (!resp) throw new Error("Fusion executor produced no response.");

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
    const errorText = signal?.aborted
      ? `Interrupted: ${text}. The tool outcome and possible side effects are uncertain; inspect the current state before retrying.`
      : `Error: ${text}`;
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
