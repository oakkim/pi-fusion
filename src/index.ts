/**
 * pi-fusion entry: persistent Lead/Sidekick tools for pi.
 *
 * Tools (planner calls these; executor never sees them):
 * - fusion_spawn   : start a persistent worker turn asynchronously (wrk_... + trn_...)
 * - fusion_followup: continue the SAME worker; steer, queue, or interrupt when busy
 * - fusion_ask     : ask a read-only sidecar rooted in a worker's context
 * - fusion_status  : inspect worker, turn, inquiry, or inquiry turn without blocking
 * - fusion_interrupt: stop the active turn, keep the worker (no failure recorded)
 * - fusion_close   : retire a worker (interrupts active turn)
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  applyConsentOverride,
  applyDefaults,
  applyFastModeOverride,
  applyOverride,
  applyThinkingOverride,
  FUSION_THINKING_LEVELS,
  isFusionThinkingLevel,
  loadConfig,
  loadGlobalConfig,
  persistGlobalFastMode,
  persistGlobalPreference,
  type ConsentOverride,
  type ExecutorOverride,
  type FastModeOverride,
  type ThinkingOverride,
} from "./config.ts";
import { buildRecentContext, latestUserText } from "./utils.ts";
import { AVAILABLE_LEAD_GUIDANCE, SIDEKICK_INQUIRY_SYSTEM_PROMPT, SIDEKICK_SYSTEM_PROMPT, handoffTaskText } from "./prompts.ts";
import { FusionPaneController, extractHandoffTask, formatPaneTranscript, type PaneState } from "./pane.ts";
import {
  FusionMonitorPublisher,
  formatDuration,
  launchMonitorWindow,
  manualMonitorCommand,
  MONITOR_SCHEMA_VERSION,
  sanitizeMonitorText,
  type MonitorSnapshotPayload,
} from "./monitor.ts";
import { getTextContent, runExecutorTurn, supportsOpenAIFastMode, type ExecutorCheckpoint } from "./llm.ts";
import { addUsage, recordNativeUsage, zeroUsage, type UsageLike } from "./cost.ts";
import { modelDisplay, resolveExecutorModel, resolveLadder, resolveModelIdentifier, rungFor } from "./models.ts";
import { clampMaxToolCalls, isMutatingSelection, resolveToolDefs } from "./tools.ts";
import { isWorkerToolContext } from "./worker-tool-runtime.ts";
import { WorkerRuntime, type WorkerContextTelemetry, type WorkerRecord } from "./runtime.ts";
import { InquiryRuntime, type InquiryThread, type InquiryTurn } from "./inquiry.ts";
import { isForcePrompt, forceFusionPrompt, modeLabel, normalizeMode, type FusionMode } from "./mode.ts";
import { createWorktree, execDirOf, mergeWorktree, removeWorktree } from "./worktree.ts";
import { runSerialized } from "./mutation-queue.ts";
import { registerAdvisor } from "./advisor.ts";
import { fusionCallArgument, fusionCallMetadata, renderFusionRequestCall } from "./tool-call.ts";
import { modelCompletions, selectModel } from "./model-picker.ts";
import { registerCommandGroup, type Subcommand } from "./commands.ts";
import { requestRecommendation, recommendationEvidence, formatRecommendation, formatRecommendationStatus, type Recommendation } from "./recommendations.ts";

const ContextMode = Type.Union([Type.Literal("none"), Type.Literal("recent")], { default: "none" });

const SpawnParams = Type.Object({
  task: Type.String({ description: "Precise spec for the sidekick: outcome, files, constraints, what to verify and report back." }),
  label: Type.Optional(Type.String({ description: "Display label for the worker." })),
  worktree: Type.Optional(Type.String({ description: "Isolated git worktree name ([a-zA-Z0-9-_]). The worker gets its own checkout+branch; use for write work that must not touch the shared checkout. Merge later with fusion_merge." })),
  context_mode: Type.Optional(ContextMode),
  context_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 4 })),
});

const FollowupBusyStrategy = Type.Union([Type.Literal("steer"), Type.Literal("queue"), Type.Literal("interrupt")], {
  default: "steer",
  description: "Behavior when busy: steer related updates into the active turn at its next safe checkpoint (default), queue a separate turn, or interrupt and restart after cleanup.",
});

type FollowupBusyStrategy = "steer" | "queue" | "interrupt";
type DeferredFollowupStrategy = Exclude<FollowupBusyStrategy, "steer">;

interface PendingFollowup {
  id: string;
  message: string;
  languageSample: string;
  strategy: DeferredFollowupStrategy;
  interruptedTurnId?: string;
  enqueuedAt: number;
}

interface SteeringInstruction {
  id: string; // str_...
  workerId: string;
  turnId: string;
  message: string;
  status: "pending" | "injected";
  enqueuedAt: number;
}

const FollowupParams = Type.Object({
  worker_id: Type.String({ description: "Worker ID (wrk_...) returned by fusion_spawn." }),
  message: Type.String({ description: "Follow-up instruction for the SAME persistent worker." }),
  when_busy: Type.Optional(FollowupBusyStrategy),
});

const AskParams = Type.Object({
  question: Type.String({ description: "Question about the worker's observable context or current activity." }),
  worker_id: Type.Optional(Type.String({ description: "Worker ID for a new side inquiry (wrk_...)." })),
  thread_id: Type.Optional(Type.String({ description: "Existing inquiry thread ID (inq_...) for a follow-up question." })),
});

const StatusParams = Type.Object({
  id: Type.String({ description: "Worker/turn/inquiry ID (wrk_..., trn_..., inq_..., or iqt_...)." }),
});

const CloseParams = Type.Object({
  worker_id: Type.String({ description: "Worker ID (wrk_...) to retire." }),
  remove: Type.Optional(Type.Boolean({ description: "Also delete the worker's git worktree checkout and branch. Default false (preserved)." })),
});

const MergeParams = Type.Object({
  worker_id: Type.String({ description: "Worker ID (wrk_...) whose worktree branch to merge into the project branch." }),
});

const InterruptParams = Type.Object({
  worker_id: Type.String({ description: "Worker ID (wrk_...) whose active turn to stop. The worker stays open; no failure is recorded." }),
  cancel_queued: Type.Optional(Type.Boolean({ description: "Also cancel pending steering updates and queued follow-ups. Default true." })),
});

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function userMsg(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() } as Message;
}

function inquirySafeMessages(messages: Message[]): Message[] {
  return messages.map((message) => {
    const value = message as unknown as { role?: string; content?: unknown; thinking?: unknown; [key: string]: unknown };
    if (value.role !== "assistant") return message;
    const clone = { ...value };
    if (Array.isArray(value.content)) {
      clone.content = value.content.filter((part) => {
        return !part || typeof part !== "object" || (part as { type?: unknown }).type !== "thinking";
      });
    }
    delete clone.thinking;
    return clone as unknown as Message;
  });
}

function statusText(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clipStatus(value: string, max: number): string {
  const text = statusText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Derive the current context only from a valid provider usage block and the
 * messages appended after it. Before a provider response (and after Fusion
 * compaction) the result deliberately has no token count.
 */
export function deriveWorkerContextTelemetry(messages: Message[], contextWindow?: number): WorkerContextTelemetry {
  const window = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as Message & { usage?: UsageLike; stopReason?: string };
    if (message.role !== "assistant" || !message.usage || message.stopReason === "error" || message.stopReason === "aborted") continue;
    if (messages.slice(0, index).some((prefix) => prefix.timestamp > message.timestamp)) continue;
    let usageTokens = 0;
    try {
      usageTokens = calculateContextTokens(message.usage as never);
    } catch {
      usageTokens = 0;
    }
    if (!Number.isFinite(usageTokens) || usageTokens <= 0) continue;
    let trailingTokens = 0;
    for (let trailing = index + 1; trailing < messages.length; trailing++) {
      try {
        trailingTokens += Math.max(0, estimateTokens(messages[trailing] as never));
      } catch {
        // A future compat message shape must not fabricate a context value.
      }
    }
    return { known: true, tokens: usageTokens + trailingTokens, ...(window ? { window } : {}) };
  }
  return { known: false, ...(window ? { window } : {}) };
}

/** Pi's subscription marker: Kimi Coding is special even with API-key auth. */
export function executorUsesSubscription(registry: ExtensionContext["modelRegistry"], modelId: string | undefined): boolean {
  if (!modelId) return false;
  const model = resolveModelIdentifier(registry, modelId);
  if (!model) return false;
  if (model.provider === "kimi-coding") return true;
  try {
    if (typeof registry.isUsingOAuth !== "function" || !registry.isUsingOAuth(model)) return false;
    return registry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI, options: { agentDir?: string } = {}) {
  const advisor = registerAdvisor(pi, options.agentDir, (ctx) => refreshStatus(ctx));
  const runtime = new WorkerRuntime();
  const inquiries = new InquiryRuntime();
  const backgroundTurns = new Map<string, Promise<void>>();
  const backgroundInquiries = new Map<string, Promise<void>>();
  const pendingFollowups = new Map<string, PendingFollowup[]>();
  const steeringInstructions = new Map<string, SteeringInstruction[]>();
  // Close acceptance atomically at the final checkpoint so a late steer is
  // queued instead of being acknowledged and then lost during finishTurn().
  const closedSteeringTurns = new Set<string>();
  let activeContext: ExtensionContext | undefined;
  let sessionActive = true;
  let sessionEpoch = 0;
  type RecommendationCheck = { controller: AbortController; signal: AbortSignal; epoch: number; turn: number; startedAt: number; key: string };
  let recommendationRequest: RecommendationCheck | undefined;
  let pendingRecommendation: { check: RecommendationCheck; value: Recommendation; isFresh: () => boolean } | undefined;
  let recommendationTurn = 0;
  let lastRecommendationTurn = -Infinity;
  let recommendationKey = "";
  let lastRecommendation: Recommendation | undefined;
  let recommendationError: string | undefined;
  let monitor!: FusionMonitorPublisher;
  const pane = new FusionPaneController(
    (id) => runtime.getWorker(id),
    () => {
      if (sessionActive && activeContext) refreshStatus(activeContext);
    },
  );
  monitor = new FusionMonitorPublisher(() => buildMonitorPayload());

  pi.registerEntryRenderer<{ text: string }>("pi-fusion-recommendation-notice", (entry, _options, theme) => {
    if (typeof entry.data?.text !== "string") return;
    // Render existing saved entries compactly too; keep full details in /fusion status.
    const parts = entry.data.text.split(" · ");
    const elapsed = parts.slice(2).find((part) => /^\d+(?:\.\d+)?ms$/.test(part));
    if (!elapsed) return;
    const seconds = (Math.floor(Number.parseFloat(elapsed) / 100) / 10).toFixed(1);
    const summary = sanitizeMonitorText(parts.slice(0, 2).join(" · "), 160);
    return new Text(theme.fg("accent", theme.bold(`Fusion Recommendation - ${summary} · ${seconds}s`)), 0, 0);
  });

  // Only a global opt-in can enable local context screening, never project config.
  function recommendationSettings() {
    const config = loadGlobalConfig(options.agentDir);
    return { enabled: config.recommendations === true, endpoint: config.recommendationEndpoint ?? "http://127.0.0.1:8788" };
  }

  function discardRecommendations(): void {
    recommendationRequest?.controller.abort();
    // Keep the slot occupied until cancellation settles, even if a transport is slow to abort.
    pendingRecommendation = undefined;
    lastRecommendationTurn = -Infinity;
    lastRecommendation = undefined;
    recommendationError = undefined;
  }

  function resetRecommendations(): void {
    discardRecommendations();
    recommendationTurn = 0;
    recommendationKey = "";
  }

  function recommendationStatus(): string {
    if (!recommendationSettings().enabled) return "Local recommendations: off";
    if (recommendationError) return `Local recommendations: unavailable (${recommendationError}); Lead decides as usual`;
    if (recommendationRequest && !recommendationRequest.signal.aborted) return "Local recommendations: screening in background; Lead continues";
    if (!lastRecommendation) return "Local recommendations: on (local); awaiting a checkpoint";
    return `Local recommendations: on (local)\nLast: ${formatRecommendationStatus(lastRecommendation)}`;
  }

  function restoreMode(ctx: ExtensionContext): FusionMode {
    try {
      const branch = ctx.sessionManager.getBranch() as unknown[];
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
        if (e?.type === "custom" && e?.customType === "fusion-mode" && e.data && typeof e.data === "object") {
          return normalizeMode((e.data as { mode?: unknown }).mode);
        }
      }
    } catch {
      // fall through to default
    }
    return "available";
  }

  function persistMode(mode: FusionMode): void {
    try {
      (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-mode", { mode, timestamp: Date.now() });
    } catch {
      // journal is best-effort
    }
  }

  function restoreExecutorOverride(ctx: ExtensionContext): ExecutorOverride | undefined {
    try {
      const branch = ctx.sessionManager.getBranch() as unknown[];
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
        if (e?.type === "custom" && e?.customType === "fusion-executor" && e.data && typeof e.data === "object") {
          const d = e.data as { executor?: unknown; auto?: unknown };
          return {
            ...(typeof d.executor === "string" ? { executor: d.executor } : {}),
            ...(d.auto === true ? { auto: true as const } : {}),
          };
        }
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  function persistExecutorOverride(override: ExecutorOverride): void {
    try {
      (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-executor", { ...override, timestamp: Date.now() });
    } catch {
      // journal is best-effort
    }
  }

  function restoreThinkingOverride(ctx: ExtensionContext): ThinkingOverride | undefined {
    try {
      const branch = ctx.sessionManager.getBranch() as unknown[];
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
        if (e?.type === "custom" && e?.customType === "fusion-thinking" && e.data && typeof e.data === "object") {
          const thinkingLevel = (e.data as { thinkingLevel?: unknown }).thinkingLevel;
          return isFusionThinkingLevel(thinkingLevel) ? { thinkingLevel } : {};
        }
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  function persistThinkingOverride(override: ThinkingOverride): void {
    try {
      (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-thinking", { ...override, timestamp: Date.now() });
    } catch {
      // journal is best-effort
    }
  }

  function restoreFastModeOverride(ctx: ExtensionContext): FastModeOverride | undefined {
    try {
      const branch = ctx.sessionManager.getBranch() as unknown[];
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
        if (e?.type === "custom" && e?.customType === "fusion-fast" && e.data && typeof e.data === "object") {
          const fastMode = (e.data as { fastMode?: unknown }).fastMode;
          return typeof fastMode === "boolean" ? { fastMode } : {};
        }
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  function persistFastModeOverride(override: FastModeOverride): boolean {
    try {
      const appendEntry = (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry;
      if (!appendEntry) return false;
      appendEntry("fusion-fast", { ...override, timestamp: Date.now() });
      return true;
    } catch {
      return false;
    }
  }

  function restoreConsentOverride(ctx: ExtensionContext): ConsentOverride | undefined {
    try {
      const branch = ctx.sessionManager.getBranch() as unknown[];
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
        if (e?.type === "custom" && e?.customType === "fusion-consent" && e.data && typeof e.data === "object") {
          const value = (e.data as { executorToolsConsent?: unknown }).executorToolsConsent;
          return typeof value === "boolean" ? { executorToolsConsent: value } : {};
        }
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  function persistConsentOverride(override: ConsentOverride): void {
    try {
      (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-consent", { ...override, timestamp: Date.now() });
    } catch {
      // journal is best-effort
    }
  }

  function restorePaneState(ctx: ExtensionContext): PaneState {
    try {
      const branch = ctx.sessionManager.getBranch() as unknown[];
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i] as { type?: unknown; customType?: unknown; data?: unknown };
        if (e?.type === "custom" && e?.customType === "fusion-pane" && e.data && typeof e.data === "object") {
          const data = e.data as { visible?: unknown; workerId?: unknown; manual?: unknown };
          return {
            // Before v0.11, spawn auto-opened and journaled the overlay. Require
            // an explicit command marker so those old entries restore closed.
            visible: data.manual === true && data.visible === true,
            ...(typeof data.workerId === "string" ? { workerId: data.workerId } : {}),
          };
        }
      }
    } catch {
      // fall through
    }
    return { visible: false };
  }

  function persistPaneState(): void {
    try {
      (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-pane", { ...pane.state, manual: true, timestamp: Date.now() });
    } catch {
      // journal is best-effort
    }
  }

  function latestWorkerId(): string | undefined {
    const workers = runtime.list();
    return [...workers].reverse().find((worker) => worker.status === "running")?.id ?? workers.at(-1)?.id;
  }

  function buildMonitorPayload(): MonitorSnapshotPayload {
    const ctx = activeContext;
    if (!ctx) throw new Error("Fusion session is not active.");
    const sessionId = ctx.sessionManager.getSessionId() ?? `ephemeral-${process.pid}-${sessionEpoch}`;
    const themeName = typeof ctx.ui?.theme?.name === "string" ? ctx.ui.theme.name : undefined;
    return {
      schemaVersion: MONITOR_SCHEMA_VERSION,
      sessionId,
      cwd: ctx.cwd,
      ...(themeName ? { themeName } : {}),
      selectedWorkerId: pane.state.workerId,
      workers: runtime.list().map((worker) => {
        const live = pane.getLive(worker.id);
        const allSteering = steeringFor(worker.id);
        const allQueue = pendingFollowups.get(worker.id) ?? [];
        const steering = allSteering.slice(-12).map((entry) => ({
          id: sanitizeMonitorText(entry.id, 120),
          turnId: sanitizeMonitorText(entry.turnId, 120),
          status: entry.status,
          preview: sanitizeMonitorText(entry.message, 180).replace(/\n+/g, " "),
          enqueuedAt: entry.enqueuedAt,
        }));
        const queue = allQueue.slice(0, 12).map((entry) => ({
          id: sanitizeMonitorText(entry.id, 120),
          status: "queued" as const,
          strategy: entry.strategy,
          preview: sanitizeMonitorText(entry.message, 180).replace(/\n+/g, " "),
          enqueuedAt: entry.enqueuedAt,
          ...(entry.interruptedTurnId ? { interruptedTurnId: sanitizeMonitorText(entry.interruptedTurnId, 120) } : {}),
        }));
        const telemetry = worker.telemetry;
        const context = telemetry?.context?.known
          ? deriveWorkerContextTelemetry(worker.history, telemetry.context.window)
          : telemetry?.context;
        const latestExecutor = telemetry?.latestExecutor ?? worker.executorModelId;
        const transcript = formatPaneTranscript(worker.history).slice(-120).map((item) => {
          if (item.kind === "tool") {
            return {
              kind: "tool" as const,
              role: "TOOL" as const,
              id: sanitizeMonitorText(item.id, 200),
              name: sanitizeMonitorText(item.name, 200),
              arguments: sanitizeMonitorText(item.arguments, 2_000),
              ...(item.output !== undefined ? { output: sanitizeMonitorText(item.output, 4_000) } : {}),
              status: item.status,
            };
          }
          if (item.kind === "user") {
            return { kind: "user" as const, role: "LEAD" as const, text: sanitizeMonitorText(item.text) };
          }
          return { kind: "assistant" as const, role: "SIDEKICK" as const, text: sanitizeMonitorText(item.text) };
        });
        return {
          id: worker.id,
          label: worker.label,
          status: worker.status,
          generation: worker.generation,
          executor: worker.executorModelId,
          activeTurnId: worker.activeTurnId ?? undefined,
          createdAt: worker.createdAt,
          worktree: worker.worktree ? { branch: worker.worktree.branch, path: worker.worktree.path } : undefined,
          queuedFollowups: allQueue.length,
          steeringUpdates: allSteering.length,
          coordination: { steering, queue },
          history: transcript,
          telemetry: {
            usage: telemetry?.cumulative,
            latestUsage: telemetry?.latest,
            latestExecutor,
            contextTokens: context?.tokens,
            contextWindow: context?.window,
            contextKnown: context?.known === true,
            subscription: executorUsesSubscription(ctx.modelRegistry, latestExecutor),
            automaticCompaction: telemetry?.automaticCompaction !== false,
          },
          live: live ? {
            ...live,
            text: sanitizeMonitorText(live.text, 4_000),
            tools: live.tools.map((tool) => ({
              ...tool,
              name: sanitizeMonitorText(tool.name, 200),
              arguments: sanitizeMonitorText(tool.arguments, 2_000),
              output: sanitizeMonitorText(tool.output, 4_000),
            })),
          } : undefined,
        };
      }),
    };
  }

  function restorePane(ctx: ExtensionContext): void {
    const state = restorePaneState(ctx);
    const workerId = state.workerId && runtime.getWorker(state.workerId) ? state.workerId : latestWorkerId();
    pane.restore({ ...state, ...(workerId ? { workerId } : {}) });
    if (state.visible) pane.open(ctx, workerId);
    else pane.close();
    pane.refresh();
  }

  function selectWorkerForActivity(ctx: ExtensionContext, workerId: string): void {
    activeContext = ctx;
    pane.select(workerId);
    refreshStatus(ctx);
  }

  /** Session command overrides win over fusion.json. */
  function effectiveConfig(ctx: ExtensionContext) {
    const modelConfig = applyOverride(loadConfig(ctx.cwd, ctx.isProjectTrusted(), options.agentDir), restoreExecutorOverride(ctx));
    const thinkingConfig = applyThinkingOverride(modelConfig, restoreThinkingOverride(ctx));
    const globalFastMode = loadGlobalConfig(options.agentDir).fastMode;
    const persistedFastConfig = typeof globalFastMode === "boolean"
      ? { ...thinkingConfig, fastMode: globalFastMode }
      : thinkingConfig;
    const fastConfig = applyFastModeOverride(persistedFastConfig, restoreFastModeOverride(ctx));
    return applyDefaults(applyConsentOverride(fastConfig, restoreConsentOverride(ctx)));
  }

  function steeringFor(workerId: string, turnId?: string): SteeringInstruction[] {
    const entries = steeringInstructions.get(workerId) ?? [];
    return turnId ? entries.filter((entry) => entry.turnId === turnId) : entries;
  }

  function drainSteeringMessages(workerId: string, turnId: string, finalCheckpoint = false): Message[] {
    const pending = steeringFor(workerId, turnId).filter((entry) => entry.status === "pending");
    if (pending.length === 0) {
      if (finalCheckpoint) closedSteeringTurns.add(turnId);
      return [];
    }
    closedSteeringTurns.delete(turnId);
    for (const entry of pending) entry.status = "injected";
    return [userMsg([
      `<fusion_steer turn="${turnId}">`,
      "The Lead supplied these related updates while this turn was running. Incorporate them into the current work before final validation and reporting. Later instructions take precedence when they conflict.",
      JSON.stringify(pending.map((entry) => ({ steer_id: entry.id, instruction: entry.message })), null, 2),
      "</fusion_steer>",
    ].join("\n"))];
  }

  function clearSteering(workerId: string, turnId?: string): SteeringInstruction[] {
    const entries = steeringInstructions.get(workerId) ?? [];
    const removed = turnId ? entries.filter((entry) => entry.turnId === turnId) : entries;
    const keep = turnId ? entries.filter((entry) => entry.turnId !== turnId) : [];
    if (keep.length > 0) steeringInstructions.set(workerId, keep);
    else steeringInstructions.delete(workerId);
    if (turnId) closedSteeringTurns.delete(turnId);
    else {
      const activeTurnId = runtime.getWorker(workerId)?.activeTurnId;
      const settlingTurnId = unsettledTurnId(workerId);
      if (activeTurnId) closedSteeringTurns.delete(activeTurnId);
      if (settlingTurnId) closedSteeringTurns.delete(settlingTurnId);
      for (const entry of removed) closedSteeringTurns.delete(entry.turnId);
    }
    return removed;
  }

  function absorbSteering(workerId: string, turnId: string | undefined, interruptMessage: string): { message: string; count: number } {
    const accepted = clearSteering(workerId, turnId);
    if (accepted.length === 0) return { message: interruptMessage, count: 0 };
    return {
      message: [
        "The previous turn accepted the following related updates before it was interrupted. Inspect current state because some may already be partially applied, then satisfy all non-conflicting updates. The latest interrupting instruction takes precedence on conflict.",
        JSON.stringify(accepted.map((entry) => ({ steer_id: entry.id, instruction: entry.message })), null, 2),
        "",
        "Latest interrupting instruction:",
        interruptMessage,
      ].join("\n"),
      count: accepted.length,
    };
  }

  function promoteSteeringToQueue(workerId: string, turnId: string, reason: string): number {
    const accepted = clearSteering(workerId, turnId);
    if (accepted.length === 0) return 0;
    const queue = pendingFollowups.get(workerId) ?? [];
    if (!pendingFollowups.has(workerId)) pendingFollowups.set(workerId, queue);
    queue.unshift({
      id: `qfu_${crypto.randomUUID()}`,
      message: [
        `The previous turn ended before its live updates were durably completed (${reason}). Inspect current state, then apply these accepted updates:`,
        JSON.stringify(accepted.map((entry) => ({ steer_id: entry.id, instruction: entry.message })), null, 2),
      ].join("\n"),
      languageSample: accepted.at(-1)?.message ?? "",
      strategy: "queue",
      enqueuedAt: Date.now(),
    });
    return accepted.length;
  }

  function refreshStatus(ctx: ExtensionContext): void {
    monitor.refresh();
    try {
      if (!ctx.hasUI) return;
      const advisorStatus = advisor.status(ctx);
      const advisorLabel = advisorStatus ? ` • ${advisorStatus}` : "";
      const running = runtime.list().filter((worker) => worker.status === "running");
      if (running.length) {
        const worker = running.find((item) => item.id === pane.state.workerId) ?? running.at(-1)!;
        const activity = pane.getLive(worker.id);
        const label = clipStatus(worker.label || worker.id.slice(4, 12), 24);
        const elapsed = formatDuration(activity ? Date.now() - activity.startedAt : 0);
        const count = running.length > 1 ? ` (${running.length})` : "";
        ctx.ui.setStatus("fusion", `Fusion • Running${count} • ${label} • ${elapsed}${advisorLabel}`);
        return;
      }
      const mode = restoreMode(ctx);
      if (mode === "off") { ctx.ui.setStatus("fusion", `${modeLabel(mode)}${advisorLabel}`); return; }
      const warnings: string[] = [];
      const cfg = effectiveConfig(ctx);
      const resolved = resolveExecutorModel(ctx.modelRegistry, ctx.model, cfg.executor, warnings);
      const execLabel = clipStatus(resolved?.id ?? "unset", 24);
      const thinkingLevel = resolved ? clampThinkingLevel(resolved, cfg.thinkingLevel) : "off";
      const fastLabel = cfg.fastMode && resolved && supportsOpenAIFastMode(resolved) ? " • fast" : "";
      ctx.ui.setStatus("fusion", `${modeLabel(mode)} • ${execLabel} (${thinkingLevel})${fastLabel}${advisorLabel}`);
    } catch {
      // status is cosmetic
    }
  }

  function restoreRuntime(ctx: ExtensionContext): void {
    try {
      const branch = ctx.sessionManager.getBranch() as unknown[];
      runtime.restore(branch);
      inquiries.restore(branch);
    } catch {
      // restore is best-effort; fresh runtimes are fine
    }
  }

  async function stopBackgroundTurns(): Promise<void> {
    runtime.interruptAll();
    inquiries.interruptAll();
    const pending = [...backgroundTurns.values(), ...backgroundInquiries.values()];
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async function suspendSession(): Promise<void> {
    resetRecommendations();
    if (sessionActive) {
      sessionActive = false;
      sessionEpoch += 1;
      pendingFollowups.clear();
      steeringInstructions.clear();
      closedSteeringTurns.clear();
      await monitor.close("Pi session ended.").catch(() => undefined);
      pane.shutdown();
    }
    await stopBackgroundTurns();
  }

  pi.on("session_start", async (_event, ctx) => {
    resetRecommendations();
    advisor.start(ctx);
    sessionEpoch += 1;
    sessionActive = true;
    activeContext = ctx;
    restoreRuntime(ctx);
    restorePane(ctx);
    refreshStatus(ctx);
  });

  // Stop workers while the old branch is still current so their final state
  // cannot be journaled or delivered into the branch selected by /tree.
  pi.on("session_before_tree", async () => {
    await suspendSession();
  });
  pi.on("session_tree", async (_event, ctx) => {
    advisor.stop();
    // Defensive for hosts that emit only the post-tree event.
    await suspendSession();
    restoreRuntime(ctx);
    advisor.start(ctx);
    sessionActive = true;
    activeContext = ctx;
    restorePane(ctx);
    refreshStatus(ctx);
  });
  pi.on("session_shutdown", async () => {
    advisor.stop();
    await suspendSession();
    activeContext = undefined;
  });
  pi.on("model_select", async (_event, ctx) => {
    activeContext = ctx;
    refreshStatus(ctx);
  });

  // Off mode: fusion tools are mechanically disabled, not just discouraged.
  // Delegate enforcement (opencode-fusion style): when leadMutations is
  // "delegate", the lead's own bash/edit/write are blocked so implementation
  // can only flow through the sidekick. Reads and fusion_* are never blocked
  // (review needs reads; blocking fusion_* would deadlock). Workers also pass
  // through tool hooks, but this particular policy applies only to the Lead.
  const LEAD_BLOCKED_MUTATORS = ["bash", "edit", "write"];
  pi.on("tool_call", async (event, ctx) => {
    if (isWorkerToolContext(ctx)) return;
    if (event.toolName.startsWith("fusion_")) {
      if (restoreMode(ctx) === "off") {
        return { block: true, reason: "Fusion is off for this session. Use /fusion available or /fusion on to re-enable." };
      }
      return;
    }
    if (LEAD_BLOCKED_MUTATORS.includes(event.toolName) && effectiveConfig(ctx).leadMutations === "delegate") {
      return {
        block: true,
        reason: "Lead mutations are delegated in this session (leadMutations=delegate). Hand the work to the sidekick via fusion_spawn/fusion_followup instead of running it yourself. Set leadMutations=allow in fusion.json to lift this.",
      };
    }
  });

  // Forced mode: every normal prompt goes through the planner/sidekick split.
  pi.on("input", async (event, ctx) => {
    // A queued user steer supersedes the snapshot before the next context hook runs.
    discardRecommendations();
    if (event.source === "extension") return { action: "continue" };
    if (event.text.trim().startsWith("/")) return { action: "continue" };
    if (isForcePrompt(event.text.trim())) return { action: "continue" };
    if (restoreMode(ctx) !== "forced") return { action: "continue" };
    return { action: "transform", text: forceFusionPrompt(event.text), images: event.images };
  });

  // Available mode gets a short routing rule, without rewriting user messages
  // or forcing every conversational request through a worker. Pi 0.87+ patches
  // structured sections; older Pi requires a per-turn system-prompt return.
  pi.on("before_agent_start", (event, ctx) => {
    resetRecommendations();
    const systemPrompt = advisor.preparePrompt(event.systemPromptOptions, event.systemPrompt, ctx);
    const enabled = restoreMode(ctx) === "available"
      && event.systemPromptOptions.selectedTools?.includes("fusion_spawn")
      && !isForcePrompt(event.prompt);
    const sections = (event.systemPromptOptions as typeof event.systemPromptOptions & {
      sections?: Record<string, string>;
    }).sections;
    if (sections) {
      if (enabled) sections.pi_fusion_routing = AVAILABLE_LEAD_GUIDANCE;
      else delete sections.pi_fusion_routing;
      return;
    } else if (enabled && !systemPrompt.includes("<pi_fusion_routing>")) {
      return { systemPrompt: `${systemPrompt}\n\n<pi_fusion_routing>\n${AVAILABLE_LEAD_GUIDANCE}\n</pi_fusion_routing>` };
    }
    if (systemPrompt !== event.systemPrompt) return { systemPrompt };
  });

  pi.on("turn_start", (event) => { recommendationTurn = event.turnIndex; });
  pi.on("turn_end", (event, ctx) => {
    if (event.message.role !== "assistant" || event.message.stopReason !== "stop"
      || event.message.content.some((part) => part.type === "toolCall")
      || !pendingRecommendation?.isFresh() || ctx.isIdle()) return;
    try {
      // Natural tool-loop checkpoints consume hints first. Only an otherwise
      // final response needs a follow-up; queued user steering takes priority.
      // Omit triggerTurn: enqueue during a run, but never restart an idle Lead.
      pi.sendMessage({ customType: "pi-fusion-recommendation-wakeup", content: "", display: false }, { deliverAs: "followUp" });
    } catch { /* A later natural checkpoint can still consume the hint. */ }
  });
  pi.on("agent_end", () => {
    recommendationRequest?.controller.abort();
    pendingRecommendation = undefined;
    // Keep the last outcome available to /fusion recommend status after the Lead finishes.
  });
  pi.on("context", (event, ctx) => {
    // A follow-up marker requests a checkpoint, but never carries advice into
    // history. Strip it even when recommendations were disabled or cancelled.
    const messages = event.messages.filter((message) => message.role !== "custom" || message.customType !== "pi-fusion-recommendation-wakeup");
    const cleaned = messages.length !== event.messages.length ? { messages } : undefined;
    const settings = recommendationSettings();
    if (!settings.enabled || !sessionActive) { resetRecommendations(); return cleaned; }
    const capabilities = () => {
      const tools = pi.getActiveTools?.() ?? [];
      return {
        advisorAvailable: tools.includes("ask_advisor") && !!advisor.status(ctx),
        fusionAvailable: tools.includes("fusion_spawn") && restoreMode(ctx) !== "off",
      };
    };
    const { advisorAvailable, fusionAvailable } = capabilities();
    if (!advisorAvailable && !fusionAvailable) { resetRecommendations(); return cleaned; }
    const checkpoint = [...messages].reverse().find((message) => message.role === "user"
      || (message.role === "custom" && message.customType === "pi-fusion-worker-result"));
    const checkpointKey = checkpoint ? JSON.stringify([checkpoint.role, checkpoint.timestamp, recommendationEvidence([checkpoint])]) : "";
    const stateKey = () => {
      const activity = advisor.activity();
      return JSON.stringify([
        checkpointKey, recommendationSettings().endpoint, capabilities(),
        activity.running.map(({ id }) => id), activity.last && [activity.last.id, activity.last.status],
        runtime.list().map(({ id, label, status, generation, activeTurnId }) => [id, label, status, generation, activeTurnId,
          (pendingFollowups.get(id) ?? []).map((entry) => entry.id), steeringFor(id).map((entry) => entry.id)]),
      ]);
    };
    const key = stateKey();
    if (key !== recommendationKey) {
      discardRecommendations();
      recommendationKey = key;
    }
    const fresh = (check: RecommendationCheck) => sessionActive && sessionEpoch === check.epoch
      && !check.signal.aborted && recommendationSettings().enabled
      && check.key === recommendationKey && stateKey() === check.key
      && recommendationTurn >= check.turn && recommendationTurn - check.turn < 4
      && Date.now() - check.startedAt < 30_000;
    if (recommendationRequest && !fresh(recommendationRequest)) discardRecommendations();
    if (pendingRecommendation && !fresh(pendingRecommendation.check)) discardRecommendations();
    const ready = pendingRecommendation;
    pendingRecommendation = undefined;
    // Advice remains transient and is rechecked at the delivery checkpoint.
    const result = ready ? { messages: [...messages, {
      role: "custom" as const,
      customType: "pi-fusion-recommendation",
      content: `This optional recommendation reflects an earlier checkpoint. Ignore it if newer evidence has resolved or changed the task. ${formatRecommendation(ready.value)}`,
      display: false,
      timestamp: Date.now(),
    }] } : cleaned;
    if (recommendationRequest || recommendationTurn - lastRecommendationTurn < 4) return result;
    const controller = new AbortController();
    const check: RecommendationCheck = {
      controller, signal: ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal,
      epoch: sessionEpoch, turn: recommendationTurn, startedAt: Date.now(), key,
    };
    recommendationRequest = check;
    lastRecommendationTurn = recommendationTurn;
    const input = {
      ...recommendationEvidence(messages), advisorAvailable, fusionAvailable,
      advisor: advisor.activity(),
      workers: runtime.list().filter((worker) => worker.status !== "closed").map((worker) => {
        const handoff = [...worker.history].reverse().find((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith(`<fusion_handoff generation="${worker.generation}">`));
        // Compaction preserves the first handoff, which may belong to an older
        // generation. Use the current summary and latest update if ours is gone.
        const summary = worker.history.find((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("<fusion_context_summary>"));
        const latest = handoff ? "" : recommendationEvidence(worker.history.filter((message) => !(message.role === "user" && typeof message.content === "string" && message.content.startsWith("<fusion_handoff ")))).prompt;
        return {
          id: worker.id, label: worker.label ?? "", status: worker.status,
          task: handoff && typeof handoff.content === "string" ? extractHandoffTask(handoff.content)
            : [...new Set([summary && typeof summary.content === "string" ? summary.content : "", latest].filter(Boolean))].join("\n") || "Current task unavailable",
          queuedTasks: (pendingFollowups.get(worker.id) ?? []).map((entry) => entry.message),
          steering: steeringFor(worker.id).map((entry) => entry.message),
        };
      }),
    };
    void (async () => {
      try {
        const recommendation = await requestRecommendation(input, { endpoint: settings.endpoint, signal: check.signal });
        if (!fresh(check)) return;
        lastRecommendation = recommendation;
        recommendationError = undefined;
        const positive = Object.values(recommendation.decisions).includes("yes");
        pendingRecommendation = positive ? { check, value: recommendation, isFresh: () => fresh(check) } : undefined;
        try {
          // Native custom entries render in chat without steering or entering model context.
          pi.appendEntry("pi-fusion-recommendation-notice", { text: formatRecommendationStatus(recommendation) });
        } catch { /* A display failure must not discard the pending hint. */ }
      } catch (error) {
        if (fresh(check)) {
          lastRecommendation = undefined;
          recommendationError = clipStatus(error instanceof Error ? error.message : String(error), 160);
        }
        // Background screening never holds up or restarts an idle Lead.
      } finally {
        if (recommendationRequest === check) recommendationRequest = undefined;
      }
    })();
    return result;
  });

  function persist(ctx: ExtensionContext, workerId: string): void {
    const snapshot = runtime.snapshot().find(({ worker }) => worker.id === workerId);
    if (!snapshot) return;
    try {
      (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-worker", snapshot);
    } catch {
      // journal is best-effort
    }
    void ctx;
  }

  function persistInquiry(ctx: ExtensionContext, inquiryId: string): void {
    const snapshot = inquiries.snapshot(inquiryId)[0];
    if (!snapshot) return;
    try {
      (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-inquiry", snapshot);
    } catch {
      // journal is best-effort
    }
    void ctx;
  }

  async function ensureConsent(
    ctx: ExtensionContext,
    mutating: boolean,
    trusted: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!mutating) return { ok: true };
    if (!trusted) return { ok: false, error: "executor mutating tools require a trusted project" };
    const cfg = effectiveConfig(ctx);
    if (cfg.executorToolsConsent) return { ok: true };
    if (ctx.hasUI) {
      const ok = await ctx.ui.confirm(
        "Enable sidekick mutating tools?",
        "The persistent sidekick can use the selected tools, including active MCP and extension tools. Runs that may change data are serialized per checkout. Existing tool permissions still apply. Continue?",
      );
      return ok ? { ok: true } : { ok: false, error: "executor mutating tools require consent" };
    }
    return { ok: false, error: "executor mutating tools require consent" };
  }

  async function runTurn(
    ctx: ExtensionContext,
    workerId: string,
    turnId: string,
    epoch: number,
  ): Promise<{ text: string; details: Record<string, unknown> }> {
    const worker = runtime.getWorker(workerId)!;
    const turn = runtime.getTurn(turnId)!;
    const persistCurrent = () => {
      if (sessionActive && sessionEpoch === epoch) persist(ctx, workerId);
    };
    pane.select(workerId);
    pane.refresh();
    const controller = new AbortController();
    runtime.trackController(turnId, controller);
    // The worker is detached from the lead tool-call signal. Once accepted,
    // fusion_interrupt/session shutdown exclusively own cancellation.
    const signal = controller.signal;
    let liveToken: number | undefined;
    const clearLive = () => {
      if (liveToken !== undefined) pane.clearLive(workerId, liveToken);
    };
    const interruptedResult = () => {
      if (runtime.getTurn(turnId)?.status === "running") runtime.interrupt(workerId);
      clearSteering(workerId, turnId);
      runtime.untrackController(turnId);
      clearLive();
      persistCurrent();
      pane.refresh();
      return {
        text: JSON.stringify({ status: "interrupted", worker_id: workerId, turn_id: turnId }, null, 2),
        details: { status: "interrupted", worker_id: workerId, turn_id: turnId },
      };
    };
    if (signal.aborted) return interruptedResult();

    const cfg = effectiveConfig(ctx);
    const warnings: string[] = [];
    const ladder = resolveLadder(ctx.modelRegistry, ctx.model, cfg.executor, cfg.fallbackExecutors, cfg.maxEscalations, warnings);
    if (ladder.length === 0) {
      const error = "no authed text executor model available";
      runtime.failTurn(turnId, error);
      clearLive();
      persistCurrent();
      pane.refresh();
      return { text: JSON.stringify({ status: "error", error }, null, 2), details: { status: "error", error } };
    }
    // Escalation: one rung per consecutive failure, auto-de-escalates on success
    // (finishTurn resets failures to 0). Evaluated every turn, not only at
    // compaction boundaries: a failing cheap model burns more than a cache miss.
    const rung = rungFor(worker.failures, ladder.length);
    const executor = ladder[rung]!;
    const thinkingLevel = clampThinkingLevel(executor, cfg.thinkingLevel);
    const fastMode = cfg.fastMode && supportsOpenAIFastMode(executor);

    const execCwd = worker.worktree ? execDirOf(worker.worktree) : ctx.cwd;
    const toolDefs = () => resolveToolDefs(cfg.executorTools, execCwd, ctx, { abort: () => controller.abort() });

    liveToken = pane.beginLive(workerId);
    pane.refresh();

    let checkpoint: ExecutorCheckpoint | undefined;
    let steeredInstructions = 0;
    const exec = () => {
      signal.throwIfAborted();
      return runExecutorTurn(
        ctx.modelRegistry,
        executor,
        `${SIDEKICK_SYSTEM_PROMPT}\n\nWorking directory: ${execCwd}`,
        [...worker.history],
        cfg.maxExecutorOutputTokens,
        cfg.temperature,
        signal,
        toolDefs,
        clampMaxToolCalls(cfg.maxToolCalls),
        ctx,
        thinkingLevel,
        (progress) => pane.updateLive(workerId, progress, liveToken),
        (finalCheckpoint) => drainSteeringMessages(workerId, turnId, finalCheckpoint),
        fastMode,
        {
          maxHistoryMessages: cfg.maxHistoryMessages,
          checkpoint: (state) => {
            if (!sessionActive || sessionEpoch !== epoch) return;
            if (!runtime.checkpointTurn(turnId, state.history, state.usage, {
              latestExecutor: modelDisplay(executor),
              context: deriveWorkerContextTelemetry(state.history, executor.contextWindow),
            })) return;
            checkpoint = state;
            persistCurrent();
            recordNativeUsage(ctx, turnId, executor, state.usage);
          },
        },
      );
    };

    try {
      const mutating = isMutatingSelection(cfg.executorTools);
      const mutationScope = worker.worktree?.path ?? ctx.cwd;
      const result = mutating
        ? await runSerialized(mutationScope, exec, signal, {
          onQueued: () => pane.updateLive(workerId, { kind: "phase", phase: "queued", replaceText: true }, liveToken),
          onStart: () => pane.updateLive(workerId, { kind: "phase", phase: "waiting", replaceText: true }, liveToken),
        })
        : await exec();
      signal.throwIfAborted();
      const output = getTextContent(result.message);
      if (!sessionActive || sessionEpoch !== epoch || !runtime.finishTurn(turnId, output, [])) {
        const status = worker.status === "closed"
          ? "closed"
          : runtime.getTurn(turnId)?.status === "interrupted" ? "interrupted" : "stale";
        clearSteering(workerId, turnId);
        persistCurrent();
        return {
          text: JSON.stringify({ status, worker_id: workerId, turn_id: turnId }, null, 2),
          details: { status, worker_id: workerId, turn_id: turnId },
        };
      }
      steeredInstructions = clearSteering(workerId, turnId).length;
      const compacted = checkpoint?.compacted ?? false;
      persistCurrent();
      pane.refresh();
      const header = `[fusion ${worker.id} | turn ${turnId} | generation ${turn.generation} | executor ${modelDisplay(executor)} | thinking ${thinkingLevel}${fastMode ? " | fast priority" : ""}${rung > 0 ? ` | escalated rung ${rung}` : ""}${steeredInstructions > 0 ? ` | steered ${steeredInstructions}` : ""}]`;
      return {
        text: `${header}\n\n${output}`,
        details: {
          status: "ok",
          worker_id: workerId,
          turn_id: turnId,
          generation: turn.generation,
          executor_model: modelDisplay(executor),
          thinking_level: thinkingLevel,
          fast_mode: fastMode,
          service_tier: fastMode ? "priority" : "default",
          rung,
          escalated: rung > 0,
          ladder: ladder.map(modelDisplay),
          usage: result.usage,
          turns: result.turns,
          tool_calls: result.toolCalls,
          capped: result.cappedOut,
          steered_instructions: steeredInstructions,
          compacted,
          warnings,
        },
      };
    } catch (err) {
      // Settled by fusion_interrupt while awaiting: keep it interrupted,
      // don't record a failure (no false escalation).
      const cur = runtime.getTurn(turnId);
      if (cur?.status === "interrupted" || signal.aborted) {
        return interruptedResult();
      }
      const message = err instanceof Error ? err.message : String(err);
      runtime.failTurn(turnId, message);
      const promotedSteers = promoteSteeringToQueue(workerId, turnId, message);
      persistCurrent();
      pane.refresh();
      return {
        text: JSON.stringify({ status: "error", worker_id: workerId, turn_id: turnId, error: message, consecutive_failures: worker.failures, next_rung: rungFor(worker.failures, ladder.length), promoted_steers: promotedSteers }, null, 2),
        details: { status: "error", worker_id: workerId, turn_id: turnId, error: message, promoted_steers: promotedSteers },
      };
    } finally {
      // One cost entry per settled turn preserves the existing cost consumers.
      // Intermediate usage is already durable in fusion-worker checkpoints.
      if (checkpoint && sessionActive && sessionEpoch === epoch && worker.generation === turn.generation) {
        try {
          (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-cost", {
            worker_id: workerId, turn_id: turnId, generation: turn.generation,
            executor: modelDisplay(executor), thinking_level: thinkingLevel,
            fast_mode: fastMode, service_tier: fastMode ? "priority" : "default", rung,
            usage: checkpoint.usage, turns: checkpoint.turns, tool_calls: checkpoint.toolCalls,
            steered_instructions: steeredInstructions, compacted: checkpoint.compacted,
            status: runtime.getTurn(turnId)?.status, timestamp: Date.now(),
          });
        } catch { /* cost journal is best-effort */ }
      }
      runtime.untrackController(turnId);
      clearLive();
      pane.refresh();
    }
  }

  function enqueueTurnResult(
    ctx: ExtensionContext,
    workerId: string,
    turnId: string,
    epoch: number,
    outcome: { text: string; details: Record<string, unknown> },
    next?: { queueId: string; turnId: string },
  ): void {
    if (!sessionActive || sessionEpoch !== epoch) return;
    const turn = runtime.getTurn(turnId);
    const status = turn?.status ?? String(outcome.details.status ?? "unknown");
    const maxContextChars = 12_000;
    const bounded = outcome.text.length > maxContextChars
      ? `${outcome.text.slice(0, maxContextChars)}\n...[result truncated; use fusion_status for the stored turn]`
      : outcome.text;
    const continuation = next
      ? `A queued follow-up started automatically: ${next.turnId} (queue ${next.queueId}). Do not resend it or treat the current worker state as final.`
      : undefined;
    const content = [
      `Fusion background turn finished (${status}): ${workerId} / ${turnId}.`,
      "The sidekick result follows. The Lead must personally inspect the actual diff and relevant code before approval or merge.",
      ...(continuation ? [continuation] : []),
      "",
      bounded,
    ].join("\n");
    try {
      pi.sendMessage(
        {
          // Legacy Fusion renderers claim "fusion-result" with a different details schema.
          customType: "pi-fusion-worker-result",
          content,
          display: true,
          details: { worker_id: workerId, turn_id: turnId, status, ...(next ? { next_turn_id: next.turnId, queue_id: next.queueId } : {}) },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    } catch {
      // The extension runtime may have been invalidated during session replacement.
    }
    try {
      if (ctx.hasUI) ctx.ui.notify(`Fusion ${workerId} ${status} (${turnId})`, status === "failed" ? "error" : "info");
    } catch {
      // Notification is cosmetic and the session message/status remain available.
    }
  }

  function unsettledTurnId(workerId: string): string | undefined {
    return [...backgroundTurns.keys()].find(
      (candidateTurnId) => runtime.getTurn(candidateTurnId)?.workerId === workerId,
    );
  }

  function startNextQueuedFollowup(
    ctx: ExtensionContext,
    workerId: string,
    epoch: number,
  ): { queueId: string; turnId: string } | undefined {
    if (!sessionActive || sessionEpoch !== epoch) return undefined;
    const worker = runtime.getWorker(workerId);
    if (!worker || worker.status === "closed" || worker.activeTurnId || unsettledTurnId(workerId)) return undefined;
    const queue = pendingFollowups.get(workerId);
    const pending = queue?.shift();
    if (!pending) return undefined;
    if (queue?.length === 0) pendingFollowups.delete(workerId);

    const message = pending.interruptedTurnId
      ? `The previous turn ${pending.interruptedTurnId} was interrupted to apply this instruction immediately. Partial filesystem or command side effects may remain; inspect the current state before editing or rerunning commands.\n\n${pending.message}`
      : pending.message;
    const taskText = handoffTaskText(worker.generation + 1, message, undefined, worker.label, pending.languageSample);
    let turn;
    try {
      turn = runtime.followup(workerId, userMsg(taskText));
    } catch {
      // The worker may have been closed between completion and queue dispatch.
      refreshStatus(ctx);
      return undefined;
    }
    persist(ctx, workerId);
    selectWorkerForActivity(ctx, workerId);
    launchTurn(ctx, workerId, turn.id);
    return { queueId: pending.id, turnId: turn.id };
  }

  function launchTurn(ctx: ExtensionContext, workerId: string, turnId: string): void {
    const epoch = sessionEpoch;
    const task = (async () => {
      let outcome: { text: string; details: Record<string, unknown> };
      try {
        outcome = await runTurn(ctx, workerId, turnId, epoch);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (runtime.getTurn(turnId)?.status === "running") runtime.failTurn(turnId, message);
        const promotedSteers = promoteSteeringToQueue(workerId, turnId, message);
        pane.clearLive(workerId);
        if (sessionActive && sessionEpoch === epoch) persist(ctx, workerId);
        outcome = {
          text: JSON.stringify({ status: "error", worker_id: workerId, turn_id: turnId, error: message, promoted_steers: promotedSteers }, null, 2),
          details: { status: "error", worker_id: workerId, turn_id: turnId, error: message, promoted_steers: promotedSteers },
        };
      }
      // Remove the settled task before dispatching the next queued turn. This
      // prevents overlap while still allowing a fast next turn to drain more
      // queued work without being blocked by this task's cleanup callback.
      backgroundTurns.delete(turnId);
      const next = startNextQueuedFollowup(ctx, workerId, epoch);
      enqueueTurnResult(ctx, workerId, turnId, epoch, outcome, next);
    })();
    backgroundTurns.set(turnId, task);
    void task.then(() => backgroundTurns.delete(turnId));
  }

  function inquiryObservation(worker: WorkerRecord, capturedAt: number): string {
    const activity = pane.getLive(worker.id);
    const queued = pendingFollowups.get(worker.id) ?? [];
    const steers = steeringFor(worker.id, worker.activeTurnId ?? undefined);
    return JSON.stringify({
      captured_at: new Date(capturedAt).toISOString(),
      private_thinking_available: false,
      worker: {
        id: worker.id,
        label: worker.label,
        status: worker.status,
        generation: worker.generation,
        active_turn: worker.activeTurnId,
        history_messages: worker.history.length,
        worktree: worker.worktree ? { branch: worker.worktree.branch, path: worker.worktree.path } : undefined,
      },
      live: activity ? {
        phase: activity.phase,
        elapsed_ms: Math.max(0, capturedAt - activity.startedAt),
        visible_response: activity.text.slice(-4_000),
        tools: activity.tools.slice(-8).map((tool) => ({
          name: tool.name,
          status: tool.status,
          arguments: tool.arguments.slice(0, 2_000),
          output: tool.output.slice(-2_000),
        })),
      } : null,
      steering_updates: steers.map((item) => ({
        steer_id: item.id,
        status: item.status,
        message: item.message.slice(0, 2_000),
      })),
      queued_followups: queued.map((item) => ({
        queue_id: item.id,
        strategy: item.strategy,
        message: item.message.slice(0, 2_000),
      })),
    }, null, 2);
  }

  function deliverInquiryResult(
    ctx: ExtensionContext,
    thread: InquiryThread,
    turn: InquiryTurn,
    epoch: number,
    answer: string,
    status: "completed" | "failed" | "interrupted",
    stale: boolean,
  ): void {
    if (!sessionActive || sessionEpoch !== epoch) return;
    const content = [
      `Fusion inquiry finished (${status}): ${thread.id} / ${turn.id} for ${thread.workerId}.`,
      `This was a read-only context snapshot and did not alter the worker. The worker did not see and will not remember this inquiry; use fusion_followup separately if its work must change.${stale ? " The worker advanced after the snapshot; ask again for a fresh view." : ""}`,
      "",
      answer,
    ].join("\n");
    try {
      pi.sendMessage({
        customType: "fusion-inquiry-result",
        content,
        display: true,
        details: {
          inquiry_id: thread.id,
          inquiry_turn_id: turn.id,
          worker_id: thread.workerId,
          status,
          stale,
          worker_remembers_inquiry: false,
          captured_at: turn.capturedAt,
        },
      }, { deliverAs: "steer", triggerTurn: true });
    } catch {
      // The extension runtime may have been invalidated during session replacement.
    }
    try {
      if (ctx.hasUI) ctx.ui.notify(`Fusion inquiry ${thread.id} ${status}`, status === "failed" ? "error" : "info");
    } catch {
      // Cosmetic only.
    }
  }

  function launchInquiry(
    ctx: ExtensionContext,
    thread: InquiryThread,
    turn: InquiryTurn,
    executorId: string,
    messages: Message[],
    workerHistoryLength: number,
  ): void {
    const epoch = sessionEpoch;
    const controller = new AbortController();
    inquiries.trackController(turn.id, controller);
    const task = (async () => {
      const executor = resolveModelIdentifier(ctx.modelRegistry, executorId);
      if (!executor || !executor.input.includes("text") || !ctx.modelRegistry.hasConfiguredAuth(executor)) {
        const error = `Inquiry executor ${executorId} is unavailable.`;
        inquiries.fail(turn.id, error);
        if (sessionActive && sessionEpoch === epoch) persistInquiry(ctx, thread.id);
        deliverInquiryResult(ctx, thread, turn, epoch, error, "failed", false);
        inquiries.untrackController(turn.id);
        return;
      }
      try {
        const cfg = effectiveConfig(ctx);
        const thinkingLevel = clampThinkingLevel(executor, cfg.thinkingLevel);
        const fastMode = cfg.fastMode && supportsOpenAIFastMode(executor);
        const result = await runExecutorTurn(
          ctx.modelRegistry,
          executor,
          SIDEKICK_INQUIRY_SYSTEM_PROMPT,
          messages,
          cfg.maxExecutorOutputTokens,
          cfg.temperature,
          controller.signal,
          [],
          1,
          ctx,
          thinkingLevel,
          undefined,
          undefined,
          fastMode,
        );
        controller.signal.throwIfAborted();
        const answer = getTextContent(result.message).trim() || "No visible answer was returned.";
        const visibleAssistant = { ...result.message, content: [{ type: "text" as const, text: answer }] } as Message;
        if (!inquiries.finish(turn.id, answer, visibleAssistant)) return;
        const currentWorker = runtime.getWorker(thread.workerId);
        const stale = !currentWorker
          || currentWorker.generation !== turn.workerGeneration
          || currentWorker.activeTurnId !== turn.workerTurnId
          || currentWorker.history.length !== workerHistoryLength;
        if (sessionActive && sessionEpoch === epoch) persistInquiry(ctx, thread.id);
        try {
          (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-inquiry-cost", {
            inquiry_id: thread.id,
            inquiry_turn_id: turn.id,
            worker_id: thread.workerId,
            executor: modelDisplay(executor),
            thinking_level: thinkingLevel,
            fast_mode: fastMode,
            service_tier: fastMode ? "priority" : "default",
            usage: result.usage,
            turns: result.turns,
            timestamp: Date.now(),
          });
        } catch {
          // Cost journal is best-effort.
        }
        deliverInquiryResult(ctx, thread, turn, epoch, answer, "completed", stale);
      } catch (err) {
        const current = inquiries.getTurn(turn.id);
        if (controller.signal.aborted || current?.status === "interrupted") {
          if (current?.status === "running") inquiries.interrupt(thread.id);
          if (sessionActive && sessionEpoch === epoch) persistInquiry(ctx, thread.id);
          deliverInquiryResult(ctx, thread, turn, epoch, "Inquiry interrupted.", "interrupted", true);
          return;
        }
        const error = err instanceof Error ? err.message : String(err);
        inquiries.fail(turn.id, error);
        if (sessionActive && sessionEpoch === epoch) persistInquiry(ctx, thread.id);
        deliverInquiryResult(ctx, thread, turn, epoch, error, "failed", false);
      } finally {
        inquiries.untrackController(turn.id);
      }
    })();
    backgroundInquiries.set(turn.id, task);
    void task.then(
      () => backgroundInquiries.delete(turn.id),
      () => backgroundInquiries.delete(turn.id),
    );
  }

  function beginInquiry(
    ctx: ExtensionContext,
    params: { question: string; worker_id?: string; thread_id?: string },
  ): { ok: true; accepted: Record<string, unknown> } | { ok: false; error: string } {
    const question = params.question.trim();
    if (!question) return { ok: false, error: "Inquiry question must not be empty." };
    if (!params.worker_id && !params.thread_id) {
      return { ok: false, error: "Provide worker_id for a new inquiry or thread_id for a follow-up." };
    }

    const existingThread = params.thread_id ? inquiries.getThread(params.thread_id) : undefined;
    if (params.thread_id && !existingThread) return { ok: false, error: `Inquiry ${params.thread_id} was not found.` };
    if (existingThread && params.worker_id && existingThread.workerId !== params.worker_id) {
      return { ok: false, error: `Inquiry ${existingThread.id} belongs to ${existingThread.workerId}, not ${params.worker_id}.` };
    }
    const workerId = existingThread?.workerId ?? params.worker_id!;
    const worker = runtime.getWorker(workerId);
    if (!worker) return { ok: false, error: `Worker ${workerId} was not found.` };
    if (existingThread?.activeTurnId) {
      return { ok: false, error: `Inquiry ${existingThread.id} is busy (turn ${existingThread.activeTurnId}).` };
    }

    const cfg = effectiveConfig(ctx);
    const exact = resolveModelIdentifier(ctx.modelRegistry, worker.executorModelId);
    const warnings: string[] = [];
    const executor = exact && exact.input.includes("text") && ctx.modelRegistry.hasConfiguredAuth(exact)
      ? exact
      : resolveExecutorModel(ctx.modelRegistry, ctx.model, cfg.executor, warnings);
    if (!executor) return { ok: false, error: "No authed text executor model is available for the inquiry." };

    const thread = existingThread ?? inquiries.create(workerId);
    const capturedAt = Date.now();
    const questionMessage = userMsg(question);
    let turn: InquiryTurn;
    try {
      turn = inquiries.start(thread.id, questionMessage, {
        workerGeneration: worker.generation,
        workerTurnId: worker.activeTurnId,
        capturedAt,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const observation = inquiryObservation(worker, capturedAt);
    const messages = [
      ...inquirySafeMessages([...worker.history]),
      ...inquirySafeMessages([...thread.history]),
      userMsg(`The following JSON is a point-in-time, public observation of the worker. Private thinking is intentionally unavailable.\n\n${observation}`),
      questionMessage,
    ];
    persistInquiry(ctx, thread.id);
    launchInquiry(ctx, thread, turn, modelDisplay(executor), messages, worker.history.length);
    const accepted = {
      status: "running",
      asynchronous: true,
      inquiry_id: thread.id,
      inquiry_turn_id: turn.id,
      worker_id: worker.id,
      worker_generation: turn.workerGeneration,
      worker_turn_id: turn.workerTurnId,
      captured_at: turn.capturedAt,
      executor: modelDisplay(executor),
      fast_mode: cfg.fastMode && supportsOpenAIFastMode(executor),
      service_tier: cfg.fastMode && supportsOpenAIFastMode(executor) ? "priority" : "default",
      worker_remembers_inquiry: false,
      message: "Read-only side inquiry continues in the background and will automatically return to the Lead. The main worker cannot see or remember this inquiry."
    };
    return { ok: true, accepted };
  }

  pi.registerTool({
    name: "fusion_spawn",
    label: "Fusion Spawn",
    promptSnippet: "Delegate bounded codebase exploration or multi-step mechanical coding and verification to a persistent background worker",
    description: [
      "Start a PERSISTENT sidekick worker asynchronously (cheap executor, own session).",
      "Returns worker_id (wrk_...) + turn_id (trn_...) immediately while the turn continues in the background.",
      "Completion is handed back automatically: it is steered into an active Lead turn at the next safe checkpoint or wakes an idle Lead. Use fusion_status for an on-demand check, not a polling loop.",
      "Use fusion_followup with the SAME worker_id for corrections — it keeps context.",
      "Pass worktree for write work: the sidekick gets an isolated checkout+branch (pi-fusion/<name>), merged later with fusion_merge.",
    ].join(" "),
    promptGuidelines: [
      "Use fusion_spawn for bounded exploration or multi-step mechanical work: specify outcome, scope, constraints, and validation; include exact paths/edits when known, not guessed.",
      "fusion_spawn is non-blocking: after it returns the IDs, continue the user conversation or other Lead work. Do not busy-poll fusion_status; completion automatically hands control back to the Lead.",
      "When the result arrives, personally inspect the actual diff and relevant code before approval; the sidekick's report is evidence, not a substitute for Lead review.",
      "Send corrections via fusion_followup on the same worker_id instead of silently rewriting delegated work.",
      "Spawn a new worker only for independent work; otherwise follow up on the existing worker.",
      "Give overlapping write workers separate worktrees; never let two workers edit the same checkout.",
      "When lead mutation enforcement is on, the lead cannot run commands for you — write self-sufficient specs with known files or bounded search goals, constraints, and verification commands to run yourself.",
    ],
    parameters: SpawnParams,
    renderCall(args, theme, context) {
      const contextMode = fusionCallArgument(args, "context_mode");
      return renderFusionRequestCall("Fusion Spawn", "task", fusionCallArgument(args, "task"), [
        fusionCallMetadata("label", fusionCallArgument(args, "label")),
        fusionCallMetadata("worktree", fusionCallArgument(args, "worktree")),
        contextMode && contextMode !== "none" ? fusionCallMetadata("context", contextMode) : undefined,
      ], theme, context.expanded);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const cfg = effectiveConfig(ctx);
      const consent = await raceWithAbort(ensureConsent(ctx, isMutatingSelection(cfg.executorTools), ctx.isProjectTrusted()), signal);
      signal?.throwIfAborted();
      if (!consent.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: consent.error }, null, 2) }], details: { status: "error", error: consent.error } };
      }
      const warnings: string[] = [];
      const executor = resolveExecutorModel(ctx.modelRegistry, ctx.model, cfg.executor, warnings);
      if (!executor) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: "no authed text executor model available" }, null, 2) }], details: { status: "error" } };
      }
      const branch = ctx.sessionManager.getBranch() as unknown[];
      const userLanguageSample = latestUserText(branch, params.task);
      const contextText =
        (params.context_mode ?? "none") === "recent"
          ? buildRecentContext(branch, params.context_turns)
          : undefined;
      let worktree: WorkerRecord["worktree"];
      if (params.worktree) {
        try {
          worktree = await createWorktree(ctx.cwd, params.worktree);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: message }, null, 2) }], details: { status: "error", error: message } };
        }
        if (signal?.aborted) {
          await removeWorktree(worktree);
          signal.throwIfAborted();
        }
      }
      const taskText = handoffTaskText(1, params.task, contextText, params.label, userLanguageSample);
      const { worker, turn } = runtime.spawn({ label: params.label, executorModelId: modelDisplay(executor), firstMessage: userMsg(taskText), worktree });
      persist(ctx, worker.id);
      selectWorkerForActivity(ctx, worker.id);
      onUpdate?.({
        content: [{ type: "text", text: `Starting Fusion worker ${worker.id} asynchronously...` }],
        details: { status: "starting", worker_id: worker.id, turn_id: turn.id },
      });
      launchTurn(ctx, worker.id, turn.id);
      const accepted = {
        status: "running",
        asynchronous: true,
        worker_id: worker.id,
        turn_id: turn.id,
        generation: turn.generation,
        executor: worker.executorModelId,
        fast_mode: cfg.fastMode && supportsOpenAIFastMode(executor),
        service_tier: cfg.fastMode && supportsOpenAIFastMode(executor) ? "priority" : "default",
        worktree: worker.worktree ? { name: worker.worktree.name, branch: worker.worktree.branch, path: worker.worktree.path } : undefined,
        message: "Worker continues in the background. Continue the conversation; the Lead will automatically resume when the result arrives.",
      };
      return { content: [{ type: "text", text: JSON.stringify(accepted, null, 2) }], details: accepted };
    },
  });

  pi.registerTool({
    name: "fusion_followup",
    label: "Fusion Followup",
    promptSnippet: "Steer, correct, or continue an existing worker while preserving its context",
    description: [
      "Asynchronously continue the SAME persistent sidekick worker (wrk_...).",
      "If the worker is idle, returns a new turn_id and starts immediately.",
      "If busy, when_busy=steer (default) injects a related update into the active turn at its next safe checkpoint; queue waits for a separate turn; interrupt aborts and restarts after cleanup.",
      "Completion is steered into an active Lead turn at the next safe checkpoint or wakes an idle Lead.",
    ].join(" "),
    promptGuidelines: [
      "Prefer fusion_followup over fusion_spawn when correcting or extending a worker's previous result.",
      "Include what was wrong and the exact correction; the worker already knows the prior context.",
      "Choose when_busy deliberately: use steer (default) for related refinements that should share the active turn's context and final validation; use queue only for work that must begin after the current result as a distinct turn; use interrupt only when the current direction is invalid, unsafe, or wasteful because partial tool side effects are not rolled back.",
      "Examples: adding a test or constraint to the current implementation => steer; benchmarking or follow-on work that requires the completed result => queue; stopping work in the wrong repo or on a destructive path => interrupt.",
      "Steering is cooperative, not mid-call injection: the worker receives updates after the current model response or tool batch completes. A long-running tool must return before the update is visible.",
      "fusion_followup is non-blocking. Continue the conversation instead of polling; personally review the final integrated result when it arrives.",
      "Provider failures auto-escalate the worker one rung up the fallback ladder (and de-escalate on success) — retry via followup before taking over.",
    ],
    parameters: FollowupParams,
    renderCall(args, theme, context) {
      return renderFusionRequestCall("Fusion Followup", "message", fusionCallArgument(args, "message"), [
        fusionCallMetadata("worker", fusionCallArgument(args, "worker_id")),
        fusionCallMetadata("when_busy", fusionCallArgument(args, "when_busy") ?? "steer"),
      ], theme, context.expanded);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const cfg = effectiveConfig(ctx);
      const consent = await raceWithAbort(ensureConsent(ctx, isMutatingSelection(cfg.executorTools), ctx.isProjectTrusted()), signal);
      signal?.throwIfAborted();
      if (!consent.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: consent.error }, null, 2) }], details: { status: "error", error: consent.error } };
      }
      const worker = runtime.getWorker(params.worker_id);
      if (!worker) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.worker_id} was not found.` }, null, 2) }], details: { status: "error" } };
      }
      if (worker.status === "closed") {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.worker_id} is closed.` }, null, 2) }], details: { status: "error" } };
      }
      const userLanguageSample = latestUserText(ctx.sessionManager.getBranch() as unknown[], params.message);
      const existingQueue = pendingFollowups.get(worker.id);
      const settlingTurnId = unsettledTurnId(worker.id);
      if (worker.activeTurnId || settlingTurnId || (existingQueue?.length ?? 0) > 0) {
        const requestedStrategy: FollowupBusyStrategy = params.when_busy ?? "steer";
        const activeTurnId = worker.activeTurnId;

        if (requestedStrategy === "steer" && activeTurnId && !closedSteeringTurns.has(activeTurnId)) {
          const steer: SteeringInstruction = {
            id: `str_${crypto.randomUUID()}`,
            workerId: worker.id,
            turnId: activeTurnId,
            message: params.message,
            status: "pending",
            enqueuedAt: Date.now(),
          };
          const entries = steeringInstructions.get(worker.id) ?? [];
          if (!steeringInstructions.has(worker.id)) steeringInstructions.set(worker.id, entries);
          entries.push(steer);
          pane.refresh();
          refreshStatus(ctx);
          const accepted = {
            status: "steering",
            asynchronous: true,
            worker_id: worker.id,
            active_turn_id: activeTurnId,
            steer_id: steer.id,
            position: entries.filter((entry) => entry.turnId === activeTurnId && entry.status === "pending").length,
            when_busy: "steer",
            message: "The related update will be injected into the active turn at its next safe checkpoint; do not resend it.",
          };
          onUpdate?.({ content: [{ type: "text", text: accepted.message }], details: accepted });
          return { content: [{ type: "text", text: JSON.stringify(accepted, null, 2) }], details: accepted };
        }

        const strategy: DeferredFollowupStrategy = requestedStrategy === "steer" ? "queue" : requestedStrategy;
        const precedingTurnId = activeTurnId ?? settlingTurnId;
        const absorbed = strategy === "interrupt"
          ? absorbSteering(worker.id, precedingTurnId, params.message)
          : { message: params.message, count: 0 };
        const pending: PendingFollowup = {
          id: `qfu_${crypto.randomUUID()}`,
          message: absorbed.message,
          languageSample: userLanguageSample,
          strategy,
          ...(strategy === "interrupt" && precedingTurnId ? { interruptedTurnId: precedingTurnId } : {}),
          enqueuedAt: Date.now(),
        };
        const queue = existingQueue ?? [];
        if (!existingQueue) pendingFollowups.set(worker.id, queue);
        if (strategy === "interrupt") queue.unshift(pending);
        else queue.push(pending);

        let interruptedTurnId: string | undefined;
        if (strategy === "interrupt" && activeTurnId) {
          interruptedTurnId = runtime.interrupt(worker.id);
          persist(ctx, worker.id);
        } else if (strategy === "interrupt" && settlingTurnId) {
          interruptedTurnId = settlingTurnId;
        }
        const started = !worker.activeTurnId && !interruptedTurnId
          ? startNextQueuedFollowup(ctx, worker.id, sessionEpoch)
          : undefined;
        pane.refresh();
        refreshStatus(ctx);
        const position = started?.queueId === pending.id ? 0 : queue.findIndex((item) => item.id === pending.id) + 1;
        const accepted = {
          status: started?.queueId === pending.id ? "running" : interruptedTurnId ? "interrupting" : "queued",
          asynchronous: true,
          worker_id: worker.id,
          queue_id: pending.id,
          position,
          when_busy: requestedStrategy,
          effective_when_busy: strategy,
          absorbed_steers: absorbed.count,
          ...(activeTurnId ? { active_turn_id: activeTurnId } : {}),
          ...(!activeTurnId && settlingTurnId ? { settling_turn_id: settlingTurnId } : {}),
          ...(interruptedTurnId ? { interrupted_turn_id: interruptedTurnId } : {}),
          ...(started ? { started_turn_id: started.turnId } : {}),
          message: started?.queueId === pending.id
            ? "The deferred instruction started in the background."
            : interruptedTurnId
              ? "The active turn was interrupted. This instruction will start automatically after cleanup settles."
              : requestedStrategy === "steer"
                ? "The active turn had already passed its steering boundary, so the instruction was safely queued for the next turn."
                : "The instruction is queued and will start automatically; do not retry or poll.",
        };
        onUpdate?.({ content: [{ type: "text", text: accepted.message }], details: accepted });
        return { content: [{ type: "text", text: JSON.stringify(accepted, null, 2) }], details: accepted };
      }
      const taskText = handoffTaskText(worker.generation + 1, params.message, undefined, worker.label, userLanguageSample);
      let turn;
      try {
        turn = runtime.followup(worker.id, userMsg(taskText));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: message }, null, 2) }], details: { status: "error", error: message } };
      }
      persist(ctx, worker.id);
      selectWorkerForActivity(ctx, worker.id);
      onUpdate?.({
        content: [{ type: "text", text: `Starting Fusion follow-up ${turn.id} asynchronously...` }],
        details: { status: "starting", worker_id: worker.id, turn_id: turn.id },
      });
      launchTurn(ctx, worker.id, turn.id);
      const accepted = {
        status: "running",
        asynchronous: true,
        worker_id: worker.id,
        turn_id: turn.id,
        generation: turn.generation,
        message: "Follow-up continues in the background. Continue the conversation; the Lead will automatically resume when the result arrives.",
      };
      return { content: [{ type: "text", text: JSON.stringify(accepted, null, 2) }], details: accepted };
    },
  });

  pi.registerTool({
    name: "fusion_ask",
    label: "Fusion Ask",
    description: [
      "Open a read-only side inquiry over a Fusion worker's context without interrupting its work.",
      "Use worker_id to create an inquiry thread, then thread_id for follow-up questions in the separate side chat.",
      "The inquiry sees completed worker history plus bounded visible live telemetry, but never private thinking.",
      "The main worker cannot see or remember inquiry questions or answers; use fusion_followup separately to change its work.",
      "Returns immediately and hands the answer back to the Lead when ready.",
    ].join(" "),
    promptGuidelines: [
      "Use fusion_ask when the user asks what an active worker is doing, why an observable action occurred, or what remains, without steering or interrupting it.",
      "Treat inquiry answers as read-only snapshot evidence. The worker does not see or remember them, and private reasoning is unavailable.",
      "If an inquiry reveals that work must change, send a separate fusion_followup: steer related updates into the active turn, queue only distinct sequential work, or interrupt only when continuing is unsafe or wasteful.",
      "Continue a side conversation with thread_id; do not create a new inquiry thread for every follow-up question.",
    ],
    parameters: AskParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const result = beginInquiry(ctx, params);
      if (!result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: result.error }, null, 2) }], details: { status: "error", error: result.error } };
      }
      onUpdate?.({
        content: [{ type: "text", text: String(result.accepted.message) }],
        details: result.accepted,
      });
      return { content: [{ type: "text", text: JSON.stringify(result.accepted, null, 2) }], details: result.accepted };
    },
  });

  pi.registerTool({
    name: "fusion_status",
    label: "Fusion Status",
    description: "Inspect a worker, worker turn, inquiry thread, or inquiry turn without blocking (wrk_..., trn_..., inq_..., iqt_...).",
    parameters: StatusParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.id.startsWith("wrk_")) {
        const w = runtime.getWorker(params.id);
        if (!w) return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.id} was not found.` }) }], details: { status: "error" } };
        const queued = pendingFollowups.get(w.id) ?? [];
        const steers = steeringFor(w.id, w.activeTurnId ?? undefined);
        return {
          content: [{ type: "text", text: JSON.stringify({
            type: "worker",
            worker_id: w.id,
            status: w.status,
            active_turn: w.activeTurnId,
            generation: w.generation,
            history_messages: w.history.length,
            consecutive_failures: w.failures,
            steering_updates: steers.map((item) => ({ steer_id: item.id, turn_id: item.turnId, status: item.status, enqueued_at: item.enqueuedAt })),
            queued_followups: queued.map((item) => ({ queue_id: item.id, strategy: item.strategy, enqueued_at: item.enqueuedAt })),
            label: w.label,
            executor: w.executorModelId,
            worktree: w.worktree ? { name: w.worktree.name, branch: w.worktree.branch, path: w.worktree.path } : undefined,
          }, null, 2) }],
          details: { status: w.status, steering_updates: steers.length, queued_followups: queued.length },
        };
      }
      if (params.id.startsWith("trn_")) {
        const t = runtime.getTurn(params.id);
        if (!t) return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Turn ${params.id} was not found.` }) }], details: { status: "error" } };
        return {
          content: [{ type: "text", text: JSON.stringify({ type: "turn", turn_id: t.id, worker_id: t.workerId, status: t.status, generation: t.generation, text: t.text?.slice(0, 12_000), text_truncated: (t.text?.length ?? 0) > 12_000, error: t.error }, null, 2) }],
          details: { status: t.status },
        };
      }
      if (params.id.startsWith("inq_")) {
        const thread = inquiries.getThread(params.id);
        if (!thread) return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Inquiry ${params.id} was not found.` }) }], details: { status: "error" } };
        return {
          content: [{ type: "text", text: JSON.stringify({
            type: "inquiry",
            inquiry_id: thread.id,
            worker_id: thread.workerId,
            status: thread.activeTurnId ? "running" : "idle",
            active_turn: thread.activeTurnId,
            generation: thread.generation,
            history_messages: thread.history.length,
            worker_remembers_inquiry: false,
            created_at: thread.createdAt,
            updated_at: thread.updatedAt,
          }, null, 2) }],
          details: { status: thread.activeTurnId ? "running" : "idle" },
        };
      }
      if (params.id.startsWith("iqt_")) {
        const turn = inquiries.getTurn(params.id);
        if (!turn) return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Inquiry turn ${params.id} was not found.` }) }], details: { status: "error" } };
        return {
          content: [{ type: "text", text: JSON.stringify({
            type: "inquiry_turn",
            inquiry_turn_id: turn.id,
            inquiry_id: turn.inquiryId,
            worker_id: turn.workerId,
            status: turn.status,
            generation: turn.generation,
            worker_generation: turn.workerGeneration,
            worker_turn_id: turn.workerTurnId,
            captured_at: turn.capturedAt,
            answer: turn.answer,
            error: turn.error,
            worker_remembers_inquiry: false,
          }, null, 2) }],
          details: { status: turn.status },
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Expected wrk_..., trn_..., inq_..., or iqt_...; got ${params.id}` }) }], details: { status: "error" } };
    },
  });

  pi.registerTool({
    name: "fusion_close",
    label: "Fusion Close",
    description: "Retire a persistent sidekick worker. Interrupts its active turn; history is kept for inspection.",
    parameters: CloseParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const w = runtime.getWorker(params.worker_id);
      if (!w) return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.worker_id} was not found.` }) }], details: { status: "error" } };
      const cancelledQueued = pendingFollowups.get(params.worker_id)?.length ?? 0;
      const cancelledSteers = clearSteering(params.worker_id).length;
      runtime.close(params.worker_id);
      pendingFollowups.delete(params.worker_id);
      pane.clearLive(params.worker_id);
      let worktreeRemoved = false;
      let removeError: string | undefined;
      if (params.remove && w.worktree) {
        try {
          await removeWorktree(w.worktree);
          worktreeRemoved = true;
        } catch (err) {
          removeError = err instanceof Error ? err.message : String(err);
        }
      }
      persist(ctx, params.worker_id);
      pane.refresh();
      return {
        content: [{ type: "text", text: JSON.stringify({ worker_id: params.worker_id, status: "closed", steering_updates_cancelled: cancelledSteers, queued_followups_cancelled: cancelledQueued, worktree_removed: worktreeRemoved, ...(removeError ? { remove_error: removeError } : {}) }) }],
        details: { status: "closed", steering_updates_cancelled: cancelledSteers, queued_followups_cancelled: cancelledQueued },
      };
    },
  });

  pi.registerTool({
    name: "fusion_merge",
    label: "Fusion Merge",
    description: [
      "Merge a persistent worker's isolated worktree branch into the project branch.",
      "Commits the worktree changes first, refuses a dirty project checkout.",
      "The worker stays alive for follow-ups after merging.",
    ].join(" "),
    promptGuidelines: [
      "After reviewing a worktree worker's result (diffs + test evidence), call fusion_merge to land it.",
      "If the project checkout is dirty, resolve that first — merge refuses to clobber.",
    ],
    parameters: MergeParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const w: WorkerRecord | undefined = runtime.getWorker(params.worker_id);
      if (!w) return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.worker_id} was not found.` }) }], details: { status: "error" } };
      if (!w.worktree) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.worker_id} has no worktree; nothing to merge.` }) }], details: { status: "error" } };
      }
      const queued = pendingFollowups.get(w.id)?.length ?? 0;
      const settling = unsettledTurnId(w.id);
      if (w.activeTurnId || settling || queued > 0) {
        const reason = w.activeTurnId
          ? `turn ${w.activeTurnId}`
          : settling
            ? `turn ${settling} is still settling`
            : `${queued} queued follow-up${queued === 1 ? "" : "s"}`;
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.worker_id} is busy (${reason}); merge only idle workers.` }) }], details: { status: "error" } };
      }
      try {
        // Reserve the source worktree against new turns and the shared checkout against other mutations/merges.
        const result = await runSerialized(w.worktree.path, () =>
          runSerialized(ctx.cwd, () => mergeWorktree(w.worktree!, w.label))
        );
        return {
          content: [{ type: "text", text: JSON.stringify({ worker_id: w.id, status: "merged", branch: w.worktree.branch, committed: result.committed, merge: result.mergeOutput.slice(0, 2000) }, null, 2) }],
          details: { status: "merged" },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", worker_id: w.id, error: message }, null, 2) }], details: { status: "error", error: message } };
      }
    },
  });

  pi.registerTool({
    name: "fusion_interrupt",
    label: "Fusion Interrupt",
    description: "Stop a worker's active turn but keep the worker open. No failure is recorded. Pending steering updates and queued follow-ups are cancelled by default.",
    parameters: InterruptParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const w = runtime.getWorker(params.worker_id);
      if (!w) return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.worker_id} was not found.` }) }], details: { status: "error" } };
      const activeTurnId = w.activeTurnId;
      const cancelQueued = params.cancel_queued !== false;
      const cancelledQueued = cancelQueued ? pendingFollowups.get(params.worker_id)?.length ?? 0 : 0;
      const cancelledSteers = cancelQueued ? clearSteering(params.worker_id, activeTurnId ?? undefined).length : 0;
      const promotedSteers = !cancelQueued && activeTurnId
        ? promoteSteeringToQueue(params.worker_id, activeTurnId, "interrupted by Lead")
        : 0;
      if (cancelQueued) pendingFollowups.delete(params.worker_id);
      const interruptedTurnId = runtime.interrupt(params.worker_id);
      pane.clearLive(params.worker_id);
      const started = !cancelQueued && !interruptedTurnId
        ? startNextQueuedFollowup(ctx, params.worker_id, sessionEpoch)
        : undefined;
      persist(ctx, params.worker_id);
      pane.refresh();
      refreshStatus(ctx);
      return {
        content: [{ type: "text", text: JSON.stringify({
          worker_id: w.id,
          status: w.status,
          interrupted_turn: interruptedTurnId ?? null,
          steering_updates_cancelled: cancelledSteers,
          steering_updates_promoted: promotedSteers,
          queued_followups_cancelled: cancelledQueued,
          ...(started ? { started_turn: started.turnId } : {}),
        }) }],
        details: { status: w.status, steering_updates_cancelled: cancelledSteers, steering_updates_promoted: promotedSteers, queued_followups_cancelled: cancelledQueued },
      };
    },
  });

  const fusionCommands = new Map<string, Subcommand>();
  for (const [name, mode, description] of [
    ["on", "forced", "Force the planner/sidekick split"],
    ["available", "available", "Let the Lead decide when to delegate"],
    ["off", "off", "Disable Fusion tools for this session"],
  ] as const) {
    fusionCommands.set(name, {
      description, acceptsArguments: false,
      handler: async (_args, ctx) => {
        persistMode(mode);
        refreshStatus(ctx);
        if (ctx.mode === "print" || ctx.mode === "json") console.log(modeLabel(mode));
        else ctx.ui.notify(modeLabel(mode), "info");
      },
    });
  }
  fusionCommands.set("run", {
    description: "Send one task through Fusion: /fusion run <prompt>",
    handler: async (args, ctx) => {
      const tell = (text: string) => {
        if (ctx.mode === "print" || ctx.mode === "json") console.log(text);
        else ctx.ui.notify(text, "warning");
      };
      if (!args.trim()) { tell("Usage: /fusion run <prompt>"); return; }
      if (restoreMode(ctx) === "off") { tell("Fusion is off. Use /fusion available or /fusion on first."); return; }
      if (ctx.mode === "print") { console.log(forceFusionPrompt(args)); return; }
      pi.sendUserMessage(forceFusionPrompt(args));
    },
  });

  fusionCommands.set("ask", {
    description: "Ask a read-only side chat: /fusion ask <wrk_...|inq_...> <question>",
    getArgumentCompletions: (prefix) => {
      if (/\s/.test(prefix)) return null;
      const normalized = prefix.trim().toLowerCase();
      const values = [...runtime.list().map((worker) => worker.id), ...inquiries.list().map((thread) => thread.id)];
      const matches = values.filter((value) => value.toLowerCase().startsWith(normalized)).map((value) => ({ value: `${value} `, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const tell = (text: string, level: "info" | "error" = "info") => {
        if (ctx.mode === "print") console.log(text);
        else ctx.ui.notify(text, level);
      };
      const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
      if (!match) {
        tell("Usage: /fusion ask <wrk_...|inq_...> <question>", "error");
        return;
      }
      if (ctx.mode === "print") {
        tell("/fusion ask requires an interactive session so its asynchronous answer can be delivered.", "error");
        return;
      }
      const [, target, question] = match;
      const result = beginInquiry(ctx, {
        question: question!,
        ...(target!.startsWith("inq_") ? { thread_id: target } : { worker_id: target }),
      });
      if (!result.ok) {
        tell(result.error, "error");
        return;
      }
      tell(`Fusion inquiry ${String(result.accepted.inquiry_id)} started. The worker will not see or remember this side chat.`);
    },
  });

  fusionCommands.set("model", {
    getArgumentCompletions: (prefix) => modelCompletions(activeContext, prefix, [
      { value: "auto", label: "auto", description: "Choose automatically" },
      { value: "clear", label: "clear", description: "Use the configured default" },
    ]),
    description: "Pick the sidekick executor: /fusion model (interactive) | /fusion model <provider/id> | auto | clear",
    handler: async (args, ctx) => {
      const tell = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.mode === "print") console.log(text);
        else ctx.ui.notify(text, level);
      };
      const candidates = ctx.modelRegistry.getAvailable().filter((m) => m.input.includes("text"));
      const current = effectiveConfig(ctx);
      const warnings: string[] = [];
      const resolved = resolveExecutorModel(ctx.modelRegistry, ctx.model, current.executor, warnings);
      const arg = args.trim();

      const apply = (override: ExecutorOverride, label: string) => {
        persistExecutorOverride(override);
        refreshStatus(ctx);
        tell(`Fusion executor: ${label}`);
      };

      if (!arg) {
        if (!ctx.hasUI) {
          const fileCfg = applyDefaults(loadConfig(ctx.cwd, ctx.isProjectTrusted(), options.agentDir));
          const override = restoreExecutorOverride(ctx);
          tell([`Fusion executor: ${resolved ? modelDisplay(resolved) : "unset"}${override?.auto ? " (session: auto)" : override?.executor ? " (session override)" : current.executor ? " (config file)" : " (auto)"}`, `Config file: ${fileCfg.executor ?? "(unset)"}`, "Usage: /fusion model <provider/id> | auto | clear"].join("\n"));
          return;
        }
        const lead = ctx.model ? modelDisplay(ctx.model) : "";
        const items = [{ value: "auto", label: "auto", description: "First authenticated text model other than the Lead" },
          { value: "clear", label: "clear", description: "Use the configured default" },
          ...candidates.map((model) => ({ value: modelDisplay(model), label: modelDisplay(model), description: [model.name, modelDisplay(model) === lead ? "Lead" : ""].filter(Boolean).join(" · ") }))];
        const choice = await selectModel(ctx, "Fusion executor model", items, restoreExecutorOverride(ctx)?.auto ? "auto" : resolved ? modelDisplay(resolved) : "auto");
        if (!choice) {
          tell("Fusion executor unchanged", "warning");
          return;
        }
        if (choice === "auto") {
          apply({ auto: true }, "auto");
          return;
        }
        if (choice === "clear") { apply({}, loadConfig(ctx.cwd, ctx.isProjectTrusted(), options.agentDir).executor ?? "auto"); return; }
        apply({ executor: choice }, choice);
        return;
      }
      const lower = arg.toLowerCase();
      if (lower === "auto") {
        apply({ auto: true }, "auto");
        return;
      }
      if (lower === "clear" || lower === "default") {
        apply({}, current.executor ?? "auto");
        return;
      }
      const m = resolveModelIdentifier(ctx.modelRegistry, arg);
      if (!m || !m.input.includes("text") || !ctx.modelRegistry.hasConfiguredAuth(m)) {
        tell(`Unknown or unauthed text model: ${arg}`, "error");
        return;
      }
      apply({ executor: modelDisplay(m) }, modelDisplay(m));
    },
  });

  fusionCommands.set("thinking", {
    description: "Set sidekick thinking: /fusion thinking [off|minimal|low|medium|high|xhigh|max|clear]",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const cfg = activeContext ? effectiveConfig(activeContext) : undefined;
      const executor = activeContext && cfg ? resolveExecutorModel(activeContext.modelRegistry, activeContext.model, cfg.executor, []) : undefined;
      const values = [...(executor ? getSupportedThinkingLevels(executor) : ["off"]), "clear"];
      const matches = values.filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const tell = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.mode === "print") console.log(text);
        else ctx.ui.notify(text, level);
      };
      const cfg = effectiveConfig(ctx);
      const fileConfig = loadConfig(ctx.cwd, ctx.isProjectTrusted(), options.agentDir);
      const warnings: string[] = [];
      const executor = resolveExecutorModel(ctx.modelRegistry, ctx.model, cfg.executor, warnings);
      const availableLevels = executor ? getSupportedThinkingLevels(executor) : ["off" as const];
      const currentLevel = executor ? clampThinkingLevel(executor, cfg.thinkingLevel) : "off";
      const arg = args.trim().toLowerCase();

      const apply = (override: ThinkingOverride, requestedLevel: typeof cfg.thinkingLevel, source: string) => {
        persistThinkingOverride(override);
        const level = executor ? clampThinkingLevel(executor, requestedLevel) : "off";
        refreshStatus(ctx);
        tell(`Fusion thinking: ${level} (${source})`);
      };

      if (!arg) {
        if (!ctx.hasUI) {
          const override = restoreThinkingOverride(ctx);
          const source = override?.thinkingLevel ? "session override" : fileConfig.thinkingLevel ? "config file" : "default";
          tell(`Fusion thinking: ${currentLevel} (${source})\nUsage: /fusion thinking <${availableLevels.join("|")}> | clear`);
          return;
        }
        const choice = await ctx.ui.select(`Fusion executor thinking (current: ${currentLevel}):`, [
          `default (${fileConfig.thinkingLevel ?? "off"})`,
          ...availableLevels,
        ]);
        if (!choice) {
          tell("Fusion thinking unchanged", "warning");
          return;
        }
        if (choice.startsWith("default")) {
          const configured = fileConfig.thinkingLevel ?? "off";
          apply({}, configured, "config/default");
          return;
        }
        if (isFusionThinkingLevel(choice)) apply({ thinkingLevel: choice }, choice, "session override");
        return;
      }

      if (arg === "clear" || arg === "default") {
        const configured = fileConfig.thinkingLevel ?? "off";
        apply({}, configured, "config/default");
        return;
      }
      if (!isFusionThinkingLevel(arg) || !availableLevels.includes(arg)) {
        tell(`Unknown or unsupported thinking level \"${args.trim()}\". Available levels: ${availableLevels.join(", ")}.`, "error");
        return;
      }
      apply({ thinkingLevel: arg }, arg, "session override");
    },
  });

  fusionCommands.set("fast", {
    description: "Persist OpenAI sidekick priority processing: /fusion fast [on|off|default|status]",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const values = ["on", "off", "default", "status"];
      const matches = values.filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const tell = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.mode === "print" || ctx.mode === "json") console.log(text);
        else ctx.ui.notify(text, level);
      };
      const fileConfig = loadConfig(ctx.cwd, ctx.isProjectTrusted(), options.agentDir);
      const globalConfig = loadGlobalConfig(options.agentDir);
      const override = restoreFastModeOverride(ctx);
      const cfg = effectiveConfig(ctx);
      const warnings: string[] = [];
      const executor = resolveExecutorModel(ctx.modelRegistry, ctx.model, cfg.executor, warnings);
      const supported = executor ? supportsOpenAIFastMode(executor) : false;
      const source = typeof override?.fastMode === "boolean"
        ? "session override"
        : typeof globalConfig.fastMode === "boolean"
          ? "global preference"
          : typeof fileConfig.fastMode === "boolean" ? "config file" : "default";
      const enabledNote = supported
        ? "OpenAI priority service tier; higher cost/plan usage"
        : `not applied to current executor ${executor ? modelDisplay(executor) : "unset"}`;
      const report = () => tell(`Fusion fast mode: ${cfg.fastMode ? "on" : "off"} (${source}) • ${cfg.fastMode ? enabledNote : "default provider service tier"}`);

      const applyPersistent = (next: boolean | undefined) => {
        try {
          persistGlobalFastMode(next, options.agentDir);
        } catch (error) {
          tell(`Could not persist Fusion fast mode: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
        // Clear old session-only entries so the persisted preference takes
        // effect immediately and remains the source for future sessions.
        const journalUpdated = persistFastModeOverride({});
        const remainingOverride = restoreFastModeOverride(ctx);
        const enabled = effectiveConfig(ctx).fastMode;
        refreshStatus(ctx);
        if (typeof override?.fastMode === "boolean") {
          const saved = typeof next === "boolean" ? (next ? "on" : "off") : "default";
          if (typeof remainingOverride?.fastMode === "boolean") {
            tell(`Fusion fast mode was saved globally as ${saved}, but this session still uses its previous ${remainingOverride.fastMode ? "on" : "off"} override because the journal could not be cleared. New sessions will use the persisted preference.`, "warning");
            return;
          }
          if (!journalUpdated) {
            tell(`Fusion fast mode was saved globally as ${saved} and is effective now, but the journal clear could not be recorded. Reopening this session may restore its previous ${override.fastMode ? "on" : "off"} override.`, "warning");
            return;
          }
        }
        const level = enabled && !supported ? "warning" : "info";
        const nextSource = typeof next === "boolean" ? "global preference" : "config/default";
        tell(`Fusion fast mode: ${enabled ? "on" : "off"} (${nextSource}) • ${enabled ? enabledNote : "default provider service tier"}`, level);
      };

      const arg = args.trim().toLowerCase();
      if (!arg) {
        if (ctx.mode !== "tui") {
          report();
          return;
        }
        const choice = await ctx.ui.select(`Fusion fast mode (current: ${cfg.fastMode ? "on" : "off"}):`, [
          "on (persist across sessions; OpenAI priority tier)",
          "off (persist across sessions; provider default)",
          "default (remove persisted preference)",
        ]);
        if (!choice) return;
        if (choice.startsWith("on")) applyPersistent(true);
        else if (choice.startsWith("off")) applyPersistent(false);
        else applyPersistent(undefined);
        return;
      }
      if (arg === "status") {
        report();
        return;
      }
      if (arg === "on" || arg === "fast" || arg === "priority") {
        applyPersistent(true);
        return;
      }
      if (arg === "off") {
        applyPersistent(false);
        return;
      }
      if (arg === "default" || arg === "clear") {
        applyPersistent(undefined);
        return;
      }
      tell(`Unknown fast mode: ${args.trim()}. Use on, off, default, or status.`, "error");
    },
  });

  fusionCommands.set("monitor", {
    description: "Open a read-only Fusion worker monitor in a separate terminal: /fusion monitor [open|close|status]",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const values = ["open", "close", "status"];
      const matches = values.filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const tell = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.mode === "print" || ctx.mode === "json") console.log(text);
        else ctx.ui.notify(text, level);
      };
      const action = args.trim().toLowerCase() || "open";
      if (action === "status") {
        const detail = monitor.path ? ` • ${monitor.path}` : "";
        const error = monitor.lastError ? ` • last error: ${monitor.lastError}` : "";
        tell(`Fusion monitor: ${monitor.active ? "open" : "closed"}${detail}${error}`);
        return;
      }
      if (action === "close") {
        try {
          await monitor.close("Closed by /fusion monitor.");
          tell("Fusion monitor closed.");
        } catch (error) {
          tell(`Could not close Fusion monitor cleanly: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (action !== "open") {
        tell(`Unknown monitor action: ${args.trim()}. Use open, close, or status.`, "error");
        return;
      }
      if (ctx.mode !== "tui") {
        tell("Fusion monitor requires an active TUI session.", "warning");
        return;
      }

      activeContext = ctx;
      const payload = buildMonitorPayload();
      let snapshotPath: string;
      try {
        snapshotPath = await monitor.open(payload.sessionId);
      } catch (error) {
        tell(`Could not start Fusion monitor publisher: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      const scriptPath = fileURLToPath(new URL("./monitor-cli.ts", import.meta.url));
      try {
        const plan = await launchMonitorWindow(scriptPath, snapshotPath);
        tell(`Fusion monitor opened in ${plan.kind === "ghostty" ? "Ghostty" : "Terminal"}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        tell(`${message}\nManual command: ${manualMonitorCommand(scriptPath, snapshotPath)}`, "warning");
      }
    },
  });

  fusionCommands.set("pane", {
    description: "Show optional detailed sidekick pane: /fusion pane [open|close|toggle|wrk_...]",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const values = ["open", "close", "toggle", ...runtime.list().map((worker) => worker.id)];
      const matches = values.filter((value) => value.toLowerCase().startsWith(normalized)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const tell = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.mode === "print" || ctx.mode === "json") console.log(text);
        else ctx.ui.notify(text, level);
      };
      if (ctx.mode !== "tui") {
        tell("Fusion pane requires TUI mode.", "warning");
        return;
      }

      const open = (workerId?: string) => {
        const selected = workerId ?? (pane.state.workerId && runtime.getWorker(pane.state.workerId) ? pane.state.workerId : latestWorkerId());
        if (!selected) {
          tell("No Fusion workers are available to display.", "warning");
          return;
        }
        pane.open(ctx, selected);
        persistPaneState();
        pane.refresh();
        tell(`Fusion pane opened for ${selected}.`);
      };
      const close = () => {
        pane.close();
        persistPaneState();
        tell("Fusion pane closed.");
      };
      const arg = args.trim();
      const lower = arg.toLowerCase();
      if (!arg || lower === "toggle") {
        if (pane.state.visible) close();
        else open();
        return;
      }
      if (lower === "open") {
        open();
        return;
      }
      if (lower === "close") {
        close();
        return;
      }
      if (arg.startsWith("wrk_")) {
        if (!runtime.getWorker(arg)) {
          tell(`Worker ${arg} was not found.`, "error");
          return;
        }
        open(arg);
        return;
      }
      tell(`Unknown pane target: ${arg}. Use open, close, toggle, or a worker id.`, "error");
    },
  });

  fusionCommands.set("consent", {
    description: "Set sidekick mutation consent: /fusion consent [allow|ask|default|status]",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const values = ["allow", "ask", "default", "status"];
      const matches = values.filter((value) => value.startsWith(normalized)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const tell = (text: string, level: "info" | "warning" | "error" = "info") => {
        if (ctx.mode === "print" || ctx.mode === "json") console.log(text);
        else ctx.ui.notify(text, level);
      };
      const fileConfig = loadConfig(ctx.cwd, ctx.isProjectTrusted(), options.agentDir);
      const override = restoreConsentOverride(ctx);
      const source = typeof override?.executorToolsConsent === "boolean"
        ? "session override"
        : typeof fileConfig.executorToolsConsent === "boolean" ? "config file" : "default";
      const current = effectiveConfig(ctx).executorToolsConsent;
      const report = () => tell(`Fusion consent: ${current ? "allow" : "ask"} (${source})`);

      const apply = (next: ConsentOverride, label: "allow" | "ask", nextSource: string) => {
        persistConsentOverride(next);
        tell(`Fusion consent: ${label} (${nextSource})`);
      };
      const setAllow = () => {
        if (!ctx.isProjectTrusted()) {
          tell("Fusion consent cannot be allowed in an untrusted project.", "error");
          return;
        }
        apply({ executorToolsConsent: true }, "allow", "session override");
      };
      const setAsk = () => apply({ executorToolsConsent: false }, "ask", "session override");
      const setDefault = () => {
        const allowed = fileConfig.executorToolsConsent ?? false;
        apply({}, allowed ? "allow" : "ask", "config/default");
      };

      const arg = args.trim().toLowerCase();
      if (!arg) {
        if (ctx.mode !== "tui") {
          report();
          return;
        }
        const choice = await ctx.ui.select(`Fusion consent (current: ${current ? "allow" : "ask"}):`, [
          "allow (session)",
          "ask (session)",
          `default (${fileConfig.executorToolsConsent ? "allow" : "ask"})`,
        ]);
        if (!choice) return;
        if (choice.startsWith("allow")) setAllow();
        else if (choice.startsWith("ask")) setAsk();
        else setDefault();
        return;
      }
      if (arg === "status") {
        report();
        return;
      }
      if (arg === "allow" || arg === "on" || arg === "session") {
        setAllow();
        return;
      }
      if (arg === "ask" || arg === "off") {
        setAsk();
        return;
      }
      if (arg === "default" || arg === "clear") {
        setDefault();
        return;
      }
      tell(`Unknown consent mode: ${args.trim()}. Use allow, ask, default, or status.`, "error");
    },
  });

  fusionCommands.set("recommend", {
    description: "Local advisor and worker recommendations: /fusion recommend [on|off|status]",
    getArgumentCompletions: (prefix) => ["on", "off", "status"].filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase() || "status";
      let text: string;
      let error = false;
      if (!["on", "off", "status"].includes(choice)) {
        text = "Usage: /fusion recommend on|off|status";
        error = true;
      } else {
        try {
          if (choice !== "status") {
            persistGlobalPreference("recommendations", choice === "on", options.agentDir);
            resetRecommendations();
          }
          text = recommendationStatus();
        } catch (cause) {
          text = `Could not save local recommendations: ${clipStatus(String(cause), 160)}`;
          error = true;
        }
      }
      if (ctx.mode === "print" || ctx.mode === "json") console.log(text);
      else ctx.ui.notify(text, error ? "error" : "info");
    },
  });

  fusionCommands.set("status", {
    acceptsArguments: false,
    description: "Show workers, inquiries, and recorded branch costs",
    handler: async (_args, ctx) => {
      const workers = runtime.list();
      const inquiryThreads = inquiries.list();
      const cfg = effectiveConfig(ctx);
      const warnings: string[] = [];
      const exec = resolveExecutorModel(ctx.modelRegistry, ctx.model, cfg.executor, warnings);
      const thinkingLevel = exec ? clampThinkingLevel(exec, cfg.thinkingLevel) : "off";
      const fastLabel = exec && supportsOpenAIFastMode(exec)
        ? ` • fast ${cfg.fastMode ? "on" : "off"}`
        : cfg.fastMode ? " • fast n/a" : "";
      const head = `${modeLabel(restoreMode(ctx))} • executor ${exec ? modelDisplay(exec) : "unset"} • thinking ${thinkingLevel}${fastLabel}${cfg.fallbackExecutors.length ? ` • fallbacks ${cfg.fallbackExecutors.join(",")}` : ""}`;
      const recordedWorkers = new Set(workers.filter((worker) => worker.telemetry?.cumulative).map((worker) => worker.id));
      let workerUsage = workers.reduce((usage, worker) => addUsage(usage, worker.telemetry?.cumulative), zeroUsage());
      let inquiryUsage = zeroUsage();
      let advisorUsage = zeroUsage();
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
        const data = entry.data as { worker_id?: string; usage?: UsageLike; includedInWorkerUsage?: boolean };
        // Live/restored telemetry already includes its worker's cost journal.
        if (entry.customType === "fusion-cost" && (!data.worker_id || !recordedWorkers.has(data.worker_id))) workerUsage = addUsage(workerUsage, data.usage);
        else if (entry.customType === "fusion-inquiry-cost") inquiryUsage = addUsage(inquiryUsage, data.usage);
        else if (entry.customType === "fusion-advisor-cost" && !data.includedInWorkerUsage) advisorUsage = addUsage(advisorUsage, data.usage);
      }
      const totalCost = workerUsage.cost + inquiryUsage.cost + advisorUsage.cost;
      const costLine = `Recorded cost (current branch): $${totalCost.toFixed(4)} • Workers $${workerUsage.cost.toFixed(4)} • Inquiries $${inquiryUsage.cost.toFixed(4)} • Advisor $${advisorUsage.cost.toFixed(4)}`;
      const body = workers.length
        ? workers.map((w) => {
          const steerCount = steeringFor(w.id, w.activeTurnId ?? undefined).length;
          const queuedCount = pendingFollowups.get(w.id)?.length ?? 0;
          const activity = `${w.activeTurnId ? ` active=${w.activeTurnId}` : ""}${steerCount ? ` steer=${steerCount}` : ""}${queuedCount ? ` queued=${queuedCount}` : ""}`;
          return `${w.id} [${w.status}] g${w.generation} msgs=${w.history.length}${activity}${w.worktree ? ` wt=${w.worktree.name}:${w.worktree.branch}` : ""} ${w.label ?? ""} (${w.executorModelId})`;
        }).join("\n")
        : "No fusion workers yet. The lead can spawn one with fusion_spawn.";
      const inquiryBody = inquiryThreads.length
        ? `\nInquiries (worker does not remember these):\n${inquiryThreads.map((thread) => `${thread.id} [${thread.activeTurnId ? "running" : "idle"}] worker=${thread.workerId} g${thread.generation} msgs=${thread.history.length}`).join("\n")}`
        : "";
      const text = `${head}\n${costLine}\n${recommendationStatus()}\n${body}${inquiryBody}`;
      if (ctx.mode === "print" || ctx.mode === "json") console.log(text);
      else ctx.ui.notify(text, "info");
    },
  });
  registerCommandGroup(pi, "fusion", fusionCommands);
}
