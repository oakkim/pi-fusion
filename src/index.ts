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
  type ConsentOverride,
  type ExecutorOverride,
  type FastModeOverride,
  type ThinkingOverride,
} from "./config.ts";
import { buildRecentContext, latestUserText } from "./utils.ts";
import { SIDEKICK_INQUIRY_SYSTEM_PROMPT, SIDEKICK_SYSTEM_PROMPT, handoffTaskText } from "./prompts.ts";
import { FusionPaneController, formatPaneTranscript, type LiveActivity, type LiveToolActivity, type PaneState } from "./pane.ts";
import {
  FusionMonitorPublisher,
  launchMonitorWindow,
  manualMonitorCommand,
  MONITOR_SCHEMA_VERSION,
  sanitizeMonitorText,
  type MonitorSnapshotPayload,
} from "./monitor.ts";
import { getTextContent, runExecutorTurn, supportsOpenAIFastMode } from "./llm.ts";
import type { UsageLike } from "./cost.ts";
import { modelDisplay, resolveExecutorModel, resolveLadder, resolveModelIdentifier, rungFor } from "./models.ts";
import { clampMaxToolCalls, isMutatingSelection, resolveToolDefs } from "./tools.ts";
import { WorkerRuntime, type WorkerContextTelemetry, type WorkerRecord } from "./runtime.ts";
import { InquiryRuntime, type InquiryThread, type InquiryTurn } from "./inquiry.ts";
import { fusionArgumentCompletions, isForcePrompt, forceFusionPrompt, modeLabel, normalizeMode, parseFusionCommand, type FusionMode } from "./mode.ts";
import { createWorktree, execDirOf, mergeWorktree, removeWorktree } from "./worktree.ts";

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

/** Serialize mutating executor runs to avoid clobbered writes (port of pi-devin-fusion). */
let mutationQueue: Promise<unknown> = Promise.resolve();
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

function runSerialized<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.then(() => undefined, () => undefined);
  return raceWithAbort(run, signal);
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

function clipStatus(value: string, max: number, tail = false): string {
  const text = statusText(value);
  if (text.length <= max) return text;
  return tail ? `…${text.slice(-(max - 1))}` : `${text.slice(0, max - 1)}…`;
}

export function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1_000)) : 0;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const secondText = String(seconds).padStart(2, "0");
  if (totalMinutes < 60) return `${minutes}m ${secondText}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${secondText}s`;
}

function parseStatusArguments(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function compactStatusPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = statusText(value);
  if (path.length <= 40) return path;
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? `…/${parts.slice(-2).join("/")}` : clipStatus(path, 40, true);
}

function quotedStatusValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(clipStatus(value, 34)) : "";
}

function toolStatusDetail(tool: LiveToolActivity): string {
  const args = parseStatusArguments(tool.arguments);
  if (!args) {
    const raw = statusText(tool.arguments);
    return raw && !raw.startsWith("{") ? clipStatus(raw, 56) : "";
  }
  switch (tool.name) {
    case "bash":
      return typeof args.command === "string" ? clipStatus(args.command, 56) : "";
    case "read": {
      const path = compactStatusPath(args.path);
      const offset = typeof args.offset === "number" ? `:${args.offset}` : "";
      return `${path}${offset}`;
    }
    case "write":
      return compactStatusPath(args.path);
    case "edit": {
      const path = compactStatusPath(args.path);
      const count = Array.isArray(args.edits) ? args.edits.length : 0;
      return `${path}${count ? ` · ${count} edit${count === 1 ? "" : "s"}` : ""}`;
    }
    case "grep": {
      const pattern = quotedStatusValue(args.pattern);
      const path = compactStatusPath(args.path);
      return [pattern, path].filter(Boolean).join(" · ");
    }
    case "find": {
      const pattern = quotedStatusValue(args.pattern);
      const path = compactStatusPath(args.path);
      return [pattern, path].filter(Boolean).join(" · ");
    }
    case "ls":
      return compactStatusPath(args.path) || ".";
    default: {
      const details = Object.entries(args)
        .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        .slice(0, 2)
        .map(([key, value]) => `${key}=${clipStatus(String(value), 24)}`);
      return details.join(" · ");
    }
  }
}

export function formatToolStatusAction(tool: LiveToolActivity): string {
  const marker = tool.status === "running" ? "▶" : tool.status === "success" ? "✓" : "✗";
  const detail = toolStatusDetail(tool);
  return clipStatus(`${marker} ${tool.name}${detail ? ` · ${detail}` : ""}`, 72);
}

export function formatLiveStatusAction(activity: LiveActivity | undefined): string {
  if (!activity) return "starting";
  if (activity.phase === "tool") {
    const tool = [...activity.tools].reverse().find((item) => item.status === "running") ?? activity.tools.at(-1);
    return tool ? formatToolStatusAction(tool) : "tool";
  }
  if (activity.phase === "responding") {
    // Show the worker's actual visible words. Its response language therefore
    // appears naturally without translating or summarizing the stream.
    return clipStatus(activity.text, 72, true) || "responding";
  }
  return activity.phase;
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
  let monitor!: FusionMonitorPublisher;
  const pane = new FusionPaneController(
    (id) => runtime.getWorker(id),
    () => {
      if (sessionActive && activeContext) refreshStatus(activeContext);
    },
  );
  monitor = new FusionMonitorPublisher(() => buildMonitorPayload());

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
      const active = runtime.list().filter(
        (worker) => worker.status === "running" || (pendingFollowups.get(worker.id)?.length ?? 0) > 0,
      );
      if (active.length > 0) {
        const selected = pane.state.workerId;
        const worker = active.find((item) => item.id === selected) ?? active.at(-1)!;
        const activity = pane.getLive(worker.id);
        const label = clipStatus(worker.label || worker.id.slice(4, 12), 24);
        const elapsed = formatElapsedDuration(activity ? Date.now() - activity.startedAt : 0);
        const more = active.length > 1 ? ` • +${active.length - 1}` : "";
        const queued = pendingFollowups.get(worker.id)?.length ?? 0;
        const queuedText = queued > 0 ? ` • queued ${queued}` : "";
        const steers = steeringFor(worker.id, worker.activeTurnId ?? undefined);
        const pendingSteers = steers.filter((entry) => entry.status === "pending").length;
        const injectedSteers = steers.length - pendingSteers;
        const steerText = pendingSteers > 0
          ? ` • steer ${pendingSteers}`
          : injectedSteers > 0 ? ` • updates ${injectedSteers}` : "";
        const action = worker.status === "running" ? formatLiveStatusAction(activity) : "settling";
        ctx.ui.setStatus("fusion", `Fusion • ${label} • ${action} • ${elapsed}${steerText}${queuedText}${more}`);
        return;
      }
      const mode = restoreMode(ctx);
      const warnings: string[] = [];
      const cfg = effectiveConfig(ctx);
      const resolved = resolveExecutorModel(ctx.modelRegistry, ctx.model, cfg.executor, warnings);
      const execLabel = resolved ? modelDisplay(resolved) : "unset";
      const thinkingLevel = resolved ? clampThinkingLevel(resolved, cfg.thinkingLevel) : "off";
      const fastLabel = resolved && supportsOpenAIFastMode(resolved)
        ? ` • fast ${cfg.fastMode ? "on" : "off"}`
        : cfg.fastMode ? " • fast n/a" : "";
      ctx.ui.setStatus("fusion", `${modeLabel(mode)} • executor ${execLabel} • thinking ${thinkingLevel}${fastLabel}`);
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
    // Defensive for hosts that emit only the post-tree event.
    await suspendSession();
    restoreRuntime(ctx);
    sessionActive = true;
    activeContext = ctx;
    restorePane(ctx);
    refreshStatus(ctx);
  });
  pi.on("session_shutdown", async () => {
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
  // (review needs reads; blocking fusion_* would deadlock). The executor loop
  // calls models directly, so this hook only ever sees lead calls.
  const LEAD_BLOCKED_MUTATORS = ["bash", "edit", "write"];
  pi.on("tool_call", async (event, ctx) => {
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
    if (event.source === "extension") return { action: "continue" };
    if (event.text.trim().startsWith("/")) return { action: "continue" };
    if (isForcePrompt(event.text.trim())) return { action: "continue" };
    if (restoreMode(ctx) !== "forced") return { action: "continue" };
    return { action: "transform", text: forceFusionPrompt(event.text), images: event.images };
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
        "The persistent sidekick will be able to run bash and edit/write files. Mutating runs are serialized. Continue?",
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
    const toolDefs = resolveToolDefs(cfg.executorTools, execCwd);

    liveToken = pane.beginLive(workerId);
    pane.refresh();

    const exec = () => {
      signal.throwIfAborted();
      return runExecutorTurn(
        ctx.modelRegistry,
        executor,
        SIDEKICK_SYSTEM_PROMPT,
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
      );
    };

    try {
      const mutating = isMutatingSelection(cfg.executorTools);
      const result = mutating ? await runSerialized(exec, signal) : await exec();
      signal.throwIfAborted();
      const output = getTextContent(result.message);
      const responseContext = deriveWorkerContextTelemetry(
        [...worker.history, ...result.added],
        executor.contextWindow,
      );
      if (!runtime.finishTurn(turnId, output, result.added, {
        usage: result.usage,
        latestUsage: result.message.usage,
        latestExecutor: modelDisplay(executor),
        context: responseContext,
      })) {
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
      const steeredInstructions = clearSteering(workerId, turnId).length;
      // Independent compaction per worker (fusion-ref): the ladder rung is
      // re-evaluated from failures every turn, so a compaction boundary also
      // re-routes for free.
      const compacted = runtime.compactHistory(worker, cfg.maxHistoryMessages);
      persistCurrent();
      pane.refresh();
      try {
        (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-cost", {
          worker_id: workerId,
          turn_id: turnId,
          generation: turn.generation,
          executor: modelDisplay(executor),
          thinking_level: thinkingLevel,
          fast_mode: fastMode,
          service_tier: fastMode ? "priority" : "default",
          rung,
          usage: result.usage,
          turns: result.turns,
          tool_calls: result.toolCalls.length,
          steered_instructions: steeredInstructions,
          compacted,
          timestamp: Date.now(),
        });
      } catch {
        // cost journal is best-effort
      }
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
          customType: "fusion-result",
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
    description: [
      "Start a PERSISTENT sidekick worker asynchronously (cheap executor, own session).",
      "Returns worker_id (wrk_...) + turn_id (trn_...) immediately while the turn continues in the background.",
      "Completion is handed back automatically: it is steered into an active Lead turn at the next safe checkpoint or wakes an idle Lead. Use fusion_status for an on-demand check, not a polling loop.",
      "Use fusion_followup with the SAME worker_id for corrections — it keeps context.",
      "Pass worktree for write work: the sidekick gets an isolated checkout+branch (pi-fusion/<name>), merged later with fusion_merge.",
    ].join(" "),
    promptGuidelines: [
      "Use fusion_spawn for well-specified mechanical work: exact files, exact changes, constraints, verification to run.",
      "fusion_spawn is non-blocking: after it returns the IDs, continue the user conversation or other Lead work. Do not busy-poll fusion_status; completion automatically hands control back to the Lead.",
      "When the result arrives, personally inspect the actual diff and relevant code before approval; the sidekick's report is evidence, not a substitute for Lead review.",
      "Send corrections via fusion_followup on the same worker_id instead of silently rewriting delegated work.",
      "Spawn a new worker only for independent work; otherwise follow up on the existing worker.",
      "Give overlapping write workers separate worktrees; never let two workers edit the same checkout.",
      "When lead mutation enforcement is on, the lead cannot run commands for you — write specs that are fully self-sufficient (files, exact changes, verification commands to run yourself).",
    ],
    parameters: SpawnParams,
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
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
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
        const result = await runSerialized(() => mergeWorktree(w.worktree!, w.label));
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

  pi.registerCommand("fusion", {
    description: "Fusion mode: /fusion on | available | off (no arg toggles; /fusion <prompt> sends once through the planner/sidekick split)",
    getArgumentCompletions: fusionArgumentCompletions,
    handler: async (args, ctx) => {
      const parsed = parseFusionCommand(args);
      const tell = (text: string, level: "info" | "warning" = "info") => {
        if (ctx.mode === "print") console.log(text);
        else ctx.ui.notify(text, level);
      };
      if (parsed.kind === "set" || parsed.kind === "toggle") {
        const next = parsed.kind === "set" ? parsed.mode : (restoreMode(ctx) === "forced" ? "available" : "forced");
        persistMode(next);
        refreshStatus(ctx);
        tell(modeLabel(next));
        return;
      }
      if (restoreMode(ctx) === "off") {
        tell("Fusion is off. Use /fusion available or /fusion on first.", "warning");
        return;
      }
      if (ctx.mode === "print") {
        console.log(forceFusionPrompt(parsed.prompt));
        return;
      }
      pi.sendUserMessage(forceFusionPrompt(parsed.prompt));
    },
  });

  pi.registerCommand("fusion-ask", {
    description: "Ask a read-only side chat: /fusion-ask <wrk_...|inq_...> <question>",
    getArgumentCompletions: (prefix) => {
      if (/\s/.test(prefix)) return null;
      const normalized = prefix.trim().toLowerCase();
      const values = [...runtime.list().map((worker) => worker.id), ...inquiries.list().map((thread) => thread.id)];
      const matches = values.filter((value) => value.toLowerCase().startsWith(normalized)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const tell = (text: string, level: "info" | "error" = "info") => {
        if (ctx.mode === "print") console.log(text);
        else ctx.ui.notify(text, level);
      };
      const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
      if (!match) {
        tell("Usage: /fusion-ask <wrk_...|inq_...> <question>", "error");
        return;
      }
      if (ctx.mode === "print") {
        tell("/fusion-ask requires an interactive session so its asynchronous answer can be delivered.", "error");
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

  pi.registerCommand("fusion-model", {
    description: "Pick the sidekick executor: /fusion-model (interactive) | /fusion-model <provider/id> | auto | clear",
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
          tell([`Fusion executor: ${resolved ? modelDisplay(resolved) : "unset"}${override?.auto ? " (session: auto)" : override?.executor ? " (session override)" : current.executor ? " (config file)" : " (auto)"}`, `Config file: ${fileCfg.executor ?? "(unset)"}`, "Usage: /fusion-model <provider/id> | auto | clear"].join("\n"));
          return;
        }
        const lead = ctx.model ? modelDisplay(ctx.model) : "";
        const items = ["auto (first non-lead authed text model)", ...candidates.map((m) => modelDisplay(m) + (modelDisplay(m) === lead ? "  [lead]" : ""))];
        const choice = await ctx.ui.select("Fusion executor model:", items);
        if (!choice) {
          tell("Fusion executor unchanged", "warning");
          return;
        }
        if (choice.startsWith("auto")) {
          apply({ auto: true }, "auto");
          return;
        }
        apply({ executor: choice.split(/\s+/)[0]! }, choice);
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

  pi.registerCommand("fusion-thinking", {
    description: "Set sidekick thinking: /fusion-thinking [off|minimal|low|medium|high|xhigh|max|clear]",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const values = [...FUSION_THINKING_LEVELS, "clear"];
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
          tell(`Fusion thinking: ${currentLevel} (${source})\nUsage: /fusion-thinking <${availableLevels.join("|")}> | clear`);
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

  pi.registerCommand("fusion-fast", {
    description: "Persist OpenAI sidekick priority processing: /fusion-fast [on|off|default|status]",
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

  pi.registerCommand("fusion-monitor", {
    description: "Open a read-only Fusion worker monitor in a separate terminal: /fusion-monitor [open|close|status]",
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
          await monitor.close("Closed by /fusion-monitor.");
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

  pi.registerCommand("fusion-pane", {
    description: "Show optional detailed sidekick pane: /fusion-pane [open|close|toggle|wrk_...]",
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

  pi.registerCommand("fusion-consent", {
    description: "Set sidekick mutation consent: /fusion-consent [allow|ask|default|status]",
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

  pi.registerCommand("fusion-status", {
    description: "List persistent sidekick workers and read-only inquiry threads",
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
      const text = `${head}\n${body}${inquiryBody}`;
      if (ctx.mode === "print") console.log(text);
      else ctx.ui.notify(text, "info");
    },
  });
}
