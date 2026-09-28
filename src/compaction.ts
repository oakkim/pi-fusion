/** Worker-only semantic compaction, using Pi's summary prompt and token estimator. */
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTokens, generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";

const SUMMARY_PREFIX = "<fusion_context_summary>\n";
export type ExecutorContext = { systemPrompt: string; messages: Message[]; tools?: Tool[] };

export function contextTokens(context: ExecutorContext): number {
  // Use SDK root exports: Pi's extension loader aliases pi-ai to a file, so
  // pi-ai subpath imports cannot load in the installed host.
  let estimated = estimateTokens({ role: "user", content: context.systemPrompt, timestamp: 0 });
  if (context.tools?.length) estimated += estimateTokens({ role: "user", content: JSON.stringify(context.tools), timestamp: 0 });
  let reported = 0;
  let prefixTimestamp = -Infinity;
  for (const message of context.messages) {
    const tokens = estimateTokens(message);
    estimated += tokens;
    if (reported > 0) reported += tokens;
    if (message.role === "assistant" && message.usage && message.stopReason !== "error" && message.stopReason !== "aborted"
      && message.timestamp >= prefixTimestamp) {
      const usageTokens = calculateContextTokens(message.usage);
      if (usageTokens > 0) reported = usageTokens;
    }
    prefixTimestamp = Math.max(prefixTimestamp, message.timestamp);
  }
  // Include full text/system/tools even if an old response's usage is smaller.
  return Math.max(estimated, reported);
}

export function contextBudget(model: Model<Api>, outputTokens: number): number {
  // ponytail: Pi estimates text tokens; reserve a safety margin, use provider
  // tokenization if measured context overflows still occur with this margin.
  return model.contextWindow - outputTokens - Math.min(2048, Math.ceil(model.contextWindow * 0.1));
}

export async function compactExecutorHistory(
  context: ExecutorContext,
  model: Model<Api>,
  outputTokens: number,
  maxMessages: number,
  signal: AbortSignal | undefined,
  complete: (context: ExecutorContext, maxTokens: number) => Promise<AssistantMessage>,
): Promise<Message[] | undefined> {
  const budget = contextBudget(model, outputTokens);
  const tokens = contextTokens(context);
  if (tokens <= budget * 0.8 && context.messages.length <= maxMessages) return;
  const history = context.messages;
  const previous = history[1];
  const previousSummary = previous?.role === "user" && typeof previous.content === "string" && previous.content.startsWith(SUMMARY_PREFIX)
    ? previous.content.slice(SUMMARY_PREFIX.length) : undefined;
  const start = previousSummary === undefined ? 1 : 2;
  const keepMessages = Math.max(2, Math.min(12, Math.floor(maxMessages / 2)));
  let cut = history.length;
  let recentTokens = 0;
  while (cut > start) {
    recentTokens += estimateTokens(history[--cut]!);
    if (history.length - cut >= keepMessages || recentTokens >= Math.max(1, budget * 0.25)) break;
  }
  // Keep entire tool batches: a result must never lose its assistant tool call.
  while (cut > start && history[cut]?.role === "toolResult") cut--;
  if (cut <= start) {
    if (tokens > budget) throw new Error("Fusion context exceeds the model limit; the original handoff or recent tool batch is too large to compact safely.");
    return;
  }
  let latestUserIndex = history.length - 1;
  while (latestUserIndex > 0 && (history[latestUserIndex]?.role !== "user" || (previousSummary !== undefined && latestUserIndex === 1))) latestUserIndex--;
  const latestInstruction = latestUserIndex > 0 && latestUserIndex < cut ? history[latestUserIndex] : undefined;
  const summaryTokens = Math.min(2048, Math.max(128, Math.floor(model.contextWindow * 0.05)), model.maxTokens || Infinity);
  const toSummarize = [history[0]!, ...history.slice(start, cut)]
    .filter((message) => message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted"))
    .map((message) => message.role === "assistant"
    ? { ...message, content: message.content.filter((block) => block.type !== "thinking") }
    : message);
  signal?.throwIfAborted();
  const summary = await generateSummaryWithUsage(
    toSummarize, model, Math.ceil(summaryTokens / 0.8), undefined, undefined, signal,
    "Preserve all user constraints, decisions, completed edits and verification evidence, unresolved work, file paths, and tool outcomes whose side effects are uncertain. Do not invent success or rollback. Keep it concise.",
    previousSummary, "off",
    ((_model: unknown, summaryContext: ExecutorContext, options: { maxTokens: number }) => ({
      result: async () => {
        if (contextTokens(summaryContext) > contextBudget(model, options.maxTokens)) {
          throw new Error("Fusion summary input exceeds the model context limit; history was preserved.");
        }
        return complete(summaryContext, options.maxTokens);
      },
    })) as never,
  );
  signal?.throwIfAborted();
  if (!summary.text.trim()) throw new Error("Fusion summary was empty; history was preserved.");
  const compacted: Message[] = [
    history[0]!,
    { role: "user", content: `${SUMMARY_PREFIX}${summary.text}`, timestamp: Math.max(Date.now(), ...history.map((message) => message.timestamp + 1)) },
    ...(latestInstruction ? [latestInstruction] : []),
    ...history.slice(cut),
  ];
  const compactedTokens = contextTokens({ ...context, messages: compacted });
  if (compactedTokens > budget) {
    throw new Error("Fusion context still exceeds the model limit after summarization; history was preserved.");
  }
  // A useless summary must not trigger an endless summary loop.
  if (compactedTokens >= tokens && compacted.length >= history.length) {
    throw new Error("Fusion summary did not reduce context; history was preserved.");
  }
  return compacted;
}
