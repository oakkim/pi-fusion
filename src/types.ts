/**
 * pi-fusion: persistent Lead/Sidekick for pi.
 *
 * Lineage:
 * - pi-devin-fusion: pi extension idioms (consent gate, tool allowlist, tool loop)
 * - opencode-agent: wrk_/trn_ durable worker protocol (spawn/followup/wait/interrupt/close)
 * - fusion-ref (Kylejeong2/fusion): AdaptiveRoutingPolicy at compaction boundary
 */

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export type { Api, Model };

export type ToolMode = "none" | "readonly" | "all";
export type ToolSelection = ToolMode | string[];

export interface FusionConfig {
  /** Explicit executor model, e.g. "openai/gpt-4.1-mini". Unset = auto (first non-planner text model). */
  executor?: string;
  /** Executor tool access: "none" | "readonly" | "all" | explicit list. Default "all". */
  executorTools?: ToolSelection;
  /** Emergency ceiling for tool calls per sidekick turn. Default 1024, clamp 1-1024. */
  maxToolCalls?: number;
  /** Max output tokens per sidekick turn. Default 4096. */
  maxExecutorOutputTokens?: number;
  /** Sampling temperature. Default 0.2. */
  temperature?: number;
  /** Sidekick reasoning effort. Default "off". */
  thinkingLevel?: ModelThinkingLevel;
  /** Skip consent prompt for mutating tools (trusted projects only). Default false. */
  executorToolsConsent?: boolean;
  /** Max turns of sidekick history kept before compaction. Default 40 messages. */
  maxHistoryMessages?: number;
  /** Escalation ladder: stronger executor models tried as consecutive failures mount. */
  fallbackExecutors?: string[];
  /** Max rungs above the base executor (0-5). Default 2. */
  maxEscalations?: number;
  /**
   * Lead mutation policy: "allow" (default, lead may use bash/edit/write) or
   * "delegate" (lead bash/edit/write are mechanically blocked at the tool_call
   * hook — the opencode-fusion approach; delegation becomes structural).
   * Reads and fusion_* tools are never blocked.
   */
  leadMutations?: "allow" | "delegate";
}

export interface ResolvedFusionConfig {
  executor?: string;
  executorTools: ToolSelection;
  maxToolCalls: number;
  maxExecutorOutputTokens: number;
  temperature: number;
  thinkingLevel: ModelThinkingLevel;
  executorToolsConsent: boolean;
  maxHistoryMessages: number;
  fallbackExecutors: string[];
  maxEscalations: number;
  leadMutations: "allow" | "delegate";
}

export type WorkerStatus = "running" | "idle" | "closed";
export type TurnStatus = "running" | "completed" | "failed" | "interrupted";

/** Isolated git checkout bound to a worker (mirrors opencode-agent's managed worktrees). */
export interface WorktreeInfo {
  name: string;
  branch: string; // pi-fusion/<name>
  path: string; // worktree checkout root (absolute)
  projectRoot: string; // repo toplevel the worktree was forked from
  relDir: string; // cwd relative to toplevel ("." if toplevel)
  projectBranch: string; // branch the project was on at spawn (merge target)
}

export interface TurnRecord {
  id: string; // trn_...
  workerId: string; // wrk_...
  status: TurnStatus;
  text?: string;
  error?: string;
  generation: number;
}
