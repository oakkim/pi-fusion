/**
 * pi-fusion entry: persistent Lead/Sidekick tools for pi.
 *
 * Tools (planner calls these; executor never sees them):
 * - fusion_spawn   : new persistent worker (wrk_...) + first turn (trn_...)
 * - fusion_followup: continue the SAME worker (persistent context)
 * - fusion_status  : inspect worker or turn without blocking
 * - fusion_interrupt: stop the active turn, keep the worker (no failure recorded)
 * - fusion_close   : retire a worker (interrupts active turn)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import {
  applyConsentOverride,
  applyDefaults,
  applyOverride,
  applyThinkingOverride,
  FUSION_THINKING_LEVELS,
  isFusionThinkingLevel,
  loadConfig,
  type ConsentOverride,
  type ExecutorOverride,
  type ThinkingOverride,
} from "./config.ts";
import { buildRecentContext } from "./utils.ts";
import { SIDEKICK_SYSTEM_PROMPT, handoffTaskText } from "./prompts.ts";
import { FusionPaneController, type PaneState } from "./pane.ts";
import { getTextContent, runExecutorTurn } from "./llm.ts";
import { modelDisplay, resolveExecutorModel, resolveLadder, resolveModelIdentifier, rungFor } from "./models.ts";
import { clampMaxToolCalls, isMutatingSelection, resolveToolDefs, selectionLabel } from "./tools.ts";
import { WorkerRuntime, type WorkerRecord } from "./runtime.ts";
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

const FollowupParams = Type.Object({
  worker_id: Type.String({ description: "Worker ID (wrk_...) returned by fusion_spawn." }),
  message: Type.String({ description: "Follow-up instruction for the SAME persistent worker." }),
});

const StatusParams = Type.Object({
  id: Type.String({ description: "Worker ID (wrk_...) or Turn ID (trn_...)." }),
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

export default function (pi: ExtensionAPI) {
  const runtime = new WorkerRuntime();
  const pane = new FusionPaneController((id) => runtime.getWorker(id));

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
          const data = e.data as { visible?: unknown; workerId?: unknown };
          return {
            visible: data.visible === true,
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
      (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-pane", { ...pane.state, timestamp: Date.now() });
    } catch {
      // journal is best-effort
    }
  }

  function latestWorkerId(): string | undefined {
    const workers = runtime.list();
    return [...workers].reverse().find((worker) => worker.status === "running")?.id ?? workers.at(-1)?.id;
  }

  function restorePane(ctx: ExtensionContext): void {
    const state = restorePaneState(ctx);
    const workerId = state.workerId && runtime.getWorker(state.workerId) ? state.workerId : latestWorkerId();
    pane.restore({ ...state, ...(workerId ? { workerId } : {}) });
    if (state.visible) pane.open(ctx, workerId);
    else pane.close();
    pane.refresh();
  }

  function openPaneForWorker(ctx: ExtensionContext, workerId: string): void {
    if (ctx.mode !== "tui") return;
    pane.open(ctx, workerId);
    persistPaneState();
    pane.refresh();
  }

  /** Session command overrides win over fusion.json. */
  function effectiveConfig(ctx: ExtensionContext) {
    const modelConfig = applyOverride(loadConfig(ctx.cwd, ctx.isProjectTrusted()), restoreExecutorOverride(ctx));
    const thinkingConfig = applyThinkingOverride(modelConfig, restoreThinkingOverride(ctx));
    return applyDefaults(applyConsentOverride(thinkingConfig, restoreConsentOverride(ctx)));
  }

  function refreshStatus(ctx: ExtensionContext): void {
    try {
      if (!ctx.hasUI) return;
      const mode = restoreMode(ctx);
      const warnings: string[] = [];
      const cfg = effectiveConfig(ctx);
      const resolved = resolveExecutorModel(ctx.modelRegistry, ctx.model, cfg.executor, warnings);
      const execLabel = resolved ? modelDisplay(resolved) : "unset";
      const thinkingLevel = resolved ? clampThinkingLevel(resolved, cfg.thinkingLevel) : "off";
      ctx.ui.setStatus("fusion", `${modeLabel(mode)} • executor ${execLabel} • thinking ${thinkingLevel}`);
    } catch {
      // status is cosmetic
    }
  }

  function restoreRuntime(ctx: ExtensionContext): void {
    try {
      runtime.restore(ctx.sessionManager.getBranch() as unknown[]);
    } catch {
      // restore is best-effort; a fresh runtime is fine
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreRuntime(ctx);
    restorePane(ctx);
    refreshStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreRuntime(ctx);
    restorePane(ctx);
    refreshStatus(ctx);
  });
  pi.on("session_shutdown", async () => pane.close());
  pi.on("model_select", async (_event, ctx) => refreshStatus(ctx));

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
    hostSignal?: AbortSignal,
    onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void,
  ): Promise<{ text: string; details: Record<string, unknown> }> {
    const worker = runtime.getWorker(workerId)!;
    const turn = runtime.getTurn(turnId)!;
    pane.select(workerId);
    pane.refresh();
    const controller = new AbortController();
    runtime.trackController(turnId, controller);
    const signal = hostSignal ? AbortSignal.any([controller.signal, hostSignal]) : controller.signal;
    let liveToken: number | undefined;
    const clearLive = () => {
      if (liveToken !== undefined) pane.clearLive(workerId, liveToken);
    };
    const interruptedResult = () => {
      if (runtime.getTurn(turnId)?.status === "running") runtime.interrupt(workerId);
      runtime.untrackController(turnId);
      clearLive();
      persist(ctx, workerId);
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
      pane.refresh();
      return { text: JSON.stringify({ status: "error", error }, null, 2), details: { status: "error", error } };
    }
    // Escalation: one rung per consecutive failure, auto-de-escalates on success
    // (finishTurn resets failures to 0). Evaluated every turn, not only at
    // compaction boundaries: a failing cheap model burns more than a cache miss.
    const rung = rungFor(worker.failures, ladder.length);
    const executor = ladder[rung]!;
    const thinkingLevel = clampThinkingLevel(executor, cfg.thinkingLevel);

    const execCwd = worker.worktree ? execDirOf(worker.worktree) : ctx.cwd;
    const toolDefs = resolveToolDefs(cfg.executorTools, execCwd);

    liveToken = pane.beginLive(workerId);
    onUpdate?.({
      content: [{ type: "text", text: `Sidekick ${modelDisplay(executor)} | thinking ${thinkingLevel} | ${worker.id} g${turn.generation}${worker.worktree ? ` | worktree ${worker.worktree.name}` : ""} | tools: ${selectionLabel(cfg.executorTools)}` }],
      details: { phase: "executing", workerId, turnId },
    });
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
      );
    };

    try {
      const mutating = isMutatingSelection(cfg.executorTools);
      const result = mutating ? await runSerialized(exec, signal) : await exec();
      signal.throwIfAborted();
      const output = getTextContent(result.message);
      if (!runtime.finishTurn(turnId, output, result.added)) {
        const status = worker.status === "closed"
          ? "closed"
          : runtime.getTurn(turnId)?.status === "interrupted" ? "interrupted" : "stale";
        persist(ctx, workerId);
        return {
          text: JSON.stringify({ status, worker_id: workerId, turn_id: turnId }, null, 2),
          details: { status, worker_id: workerId, turn_id: turnId },
        };
      }
      // Independent compaction per worker (fusion-ref): the ladder rung is
      // re-evaluated from failures every turn, so a compaction boundary also
      // re-routes for free.
      const compacted = runtime.compactHistory(worker, cfg.maxHistoryMessages);
      persist(ctx, workerId);
      pane.refresh();
      try {
        (pi as unknown as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.("fusion-cost", {
          worker_id: workerId,
          turn_id: turnId,
          generation: turn.generation,
          executor: modelDisplay(executor),
          thinking_level: thinkingLevel,
          rung,
          usage: result.usage,
          turns: result.turns,
          tool_calls: result.toolCalls.length,
          timestamp: Date.now(),
        });
      } catch {
        // cost journal is best-effort
      }
      const header = `[fusion ${worker.id} | turn ${turnId} | generation ${turn.generation} | executor ${modelDisplay(executor)} | thinking ${thinkingLevel}${rung > 0 ? ` | escalated rung ${rung}` : ""}]`;
      return {
        text: `${header}\n\n${output}`,
        details: {
          status: "ok",
          worker_id: workerId,
          turn_id: turnId,
          generation: turn.generation,
          executor_model: modelDisplay(executor),
          thinking_level: thinkingLevel,
          rung,
          escalated: rung > 0,
          ladder: ladder.map(modelDisplay),
          usage: result.usage,
          turns: result.turns,
          tool_calls: result.toolCalls,
          capped: result.cappedOut,
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
      persist(ctx, workerId);
      pane.refresh();
      return {
        text: JSON.stringify({ status: "error", worker_id: workerId, turn_id: turnId, error: message, consecutive_failures: worker.failures, next_rung: rungFor(worker.failures, ladder.length) }, null, 2),
        details: { status: "error", worker_id: workerId, turn_id: turnId, error: message },
      };
    } finally {
      runtime.untrackController(turnId);
      clearLive();
      pane.refresh();
    }
  }

  pi.registerTool({
    name: "fusion_spawn",
    label: "Fusion Spawn",
    description: [
      "Spawn a PERSISTENT sidekick worker (cheap executor, own session).",
      "Returns worker_id (wrk_...) + turn_id (trn_...). Use fusion_followup with the SAME worker_id for corrections — it keeps context.",
      "Use for implementation, refactors, test fixes, and repo exploration with a precise spec.",
      "Pass worktree for write work: the sidekick gets an isolated checkout+branch (pi-fusion/<name>), merged later with fusion_merge.",
    ].join(" "),
    promptGuidelines: [
      "Use fusion_spawn for well-specified mechanical work: exact files, exact changes, constraints, verification to run.",
      "After spawn, review the result; send corrections via fusion_followup on the same worker_id, not by editing yourself.",
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
      const contextText =
        (params.context_mode ?? "none") === "recent"
          ? buildRecentContext(ctx.sessionManager.getBranch() as unknown[], params.context_turns)
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
      const taskText = handoffTaskText(1, params.task, contextText, params.label);
      const { worker, turn } = runtime.spawn({ label: params.label, executorModelId: modelDisplay(executor), firstMessage: userMsg(taskText), worktree });
      persist(ctx, worker.id);
      openPaneForWorker(ctx, worker.id);
      const out = await runTurn(ctx, worker.id, turn.id, signal, onUpdate);
      return { content: [{ type: "text", text: out.text }], details: out.details };
    },
  });

  pi.registerTool({
    name: "fusion_followup",
    label: "Fusion Followup",
    description: [
      "Continue the SAME persistent sidekick worker (wrk_...).",
      "The worker keeps its session history; the follow-up is appended as the next handoff generation.",
    ].join(" "),
    promptGuidelines: [
      "Prefer fusion_followup over fusion_spawn when correcting or extending a worker's previous result.",
      "Include what was wrong and the exact correction; the worker already knows the prior context.",
      "Provider failures auto-escalate the worker one rung up the fallback ladder (and de-escalate on success) — retry via followup before giving up on a worker.",
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
      if (worker.activeTurnId) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.worker_id} is busy (turn ${worker.activeTurnId}).` }, null, 2) }], details: { status: "error" } };
      }
      const taskText = handoffTaskText(worker.generation + 1, params.message, undefined, worker.label);
      let turn;
      try {
        turn = runtime.followup(worker.id, userMsg(taskText));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: message }, null, 2) }], details: { status: "error", error: message } };
      }
      persist(ctx, worker.id);
      openPaneForWorker(ctx, worker.id);
      const out = await runTurn(ctx, worker.id, turn.id, signal, onUpdate);
      return { content: [{ type: "text", text: out.text }], details: out.details };
    },
  });

  pi.registerTool({
    name: "fusion_status",
    label: "Fusion Status",
    description: "Inspect a worker (wrk_...) or turn (trn_...) without blocking. Returns status, generation, history size.",
    parameters: StatusParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (params.id.startsWith("wrk_")) {
        const w = runtime.getWorker(params.id);
        if (!w) return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.id} was not found.` }) }], details: { status: "error" } };
        return {
          content: [{ type: "text", text: JSON.stringify({ type: "worker", worker_id: w.id, status: w.status, active_turn: w.activeTurnId, generation: w.generation, history_messages: w.history.length, consecutive_failures: w.failures, label: w.label, executor: w.executorModelId, worktree: w.worktree ? { name: w.worktree.name, branch: w.worktree.branch, path: w.worktree.path } : undefined }, null, 2) }],
          details: { status: w.status },
        };
      }
      if (params.id.startsWith("trn_")) {
        const t = runtime.getTurn(params.id);
        if (!t) return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Turn ${params.id} was not found.` }) }], details: { status: "error" } };
        return {
          content: [{ type: "text", text: JSON.stringify({ type: "turn", turn_id: t.id, worker_id: t.workerId, status: t.status, generation: t.generation, text: t.text?.slice(0, 4000), error: t.error }, null, 2) }],
          details: { status: t.status },
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Expected wrk_... or trn_...; got ${params.id}` }) }], details: { status: "error" } };
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
      runtime.close(params.worker_id);
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
        content: [{ type: "text", text: JSON.stringify({ worker_id: params.worker_id, status: "closed", worktree_removed: worktreeRemoved, ...(removeError ? { remove_error: removeError } : {}) }) }],
        details: { status: "closed" },
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
      if (w.activeTurnId) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.worker_id} is busy (turn ${w.activeTurnId}); merge only idle workers.` }) }], details: { status: "error" } };
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
    description: "Stop a worker's active turn but keep the worker open. No failure is recorded (no false escalation).",
    parameters: InterruptParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const w = runtime.getWorker(params.worker_id);
      if (!w) return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: `Worker ${params.worker_id} was not found.` }) }], details: { status: "error" } };
      const interruptedTurnId = runtime.interrupt(params.worker_id);
      pane.clearLive(params.worker_id);
      persist(ctx, params.worker_id);
      pane.refresh();
      return {
        content: [{ type: "text", text: JSON.stringify({ worker_id: w.id, status: w.status, interrupted_turn: interruptedTurnId ?? null }) }],
        details: { status: w.status },
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
          const fileCfg = applyDefaults(loadConfig(ctx.cwd, ctx.isProjectTrusted()));
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
      const fileConfig = loadConfig(ctx.cwd, ctx.isProjectTrusted());
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

  pi.registerCommand("fusion-pane", {
    description: "Show sidekick history: /fusion-pane [open|close|toggle|wrk_...]",
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
      const fileConfig = loadConfig(ctx.cwd, ctx.isProjectTrusted());
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
    description: "List persistent sidekick workers (id, status, generation, history size)",
    handler: async (_args, ctx) => {
      const workers = runtime.list();
      const cfg = effectiveConfig(ctx);
      const warnings: string[] = [];
      const exec = resolveExecutorModel(ctx.modelRegistry, ctx.model, cfg.executor, warnings);
      const thinkingLevel = exec ? clampThinkingLevel(exec, cfg.thinkingLevel) : "off";
      const head = `${modeLabel(restoreMode(ctx))} • executor ${exec ? modelDisplay(exec) : "unset"} • thinking ${thinkingLevel}${cfg.fallbackExecutors.length ? ` • fallbacks ${cfg.fallbackExecutors.join(",")}` : ""}`;
      const body = workers.length
        ? workers.map((w) => `${w.id} [${w.status}] g${w.generation} msgs=${w.history.length}${w.worktree ? ` wt=${w.worktree.name}:${w.worktree.branch}` : ""} ${w.label ?? ""} (${w.executorModelId})`).join("\n")
        : "No fusion workers yet. The lead can spawn one with fusion_spawn.";
      const text = `${head}\n${body}`;
      if (ctx.mode === "print") console.log(text);
      else ctx.ui.notify(text, "info");
    },
  });
}
