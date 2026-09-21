/**
 * Config loading. Minimal port of pi-devin-fusion's config.ts.
 * Reads .pi/fusion.json (trusted projects) then global agent dir fallback.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FusionConfig, ResolvedFusionConfig, ToolSelection } from "./types.ts";

export const DEFAULT_MAX_TOKENS = 4096;
export const MAX_TOKENS = 65_536;
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_MAX_TOOL_CALLS = 1024;
export const MIN_TOOL_CALLS = 1;
export const MAX_TOOL_CALLS = 1024;
export const DEFAULT_MAX_HISTORY = 40;
export const DEFAULT_MAX_ESCALATIONS = 2;
export const MIN_ESCALATIONS = 0;
export const MAX_ESCALATIONS = 5;
export const TOOL_OUTPUT_MAX_BYTES = 12_000;

const TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
const TOOL_MODES = ["none", "readonly", "all"] as const;
export const FUSION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

export function loadConfig(cwd: string, projectTrusted: boolean): FusionConfig {
  const paths: string[] = [];
  if (projectTrusted) paths.push(join(cwd, ".pi", "fusion.json"));
  paths.push(join(getAgentDir(), "fusion.json"));
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      return normalizeConfig(JSON.parse(readFileSync(p, "utf8")));
    } catch (err) {
      console.error(`[pi-fusion] failed to parse ${p}:`, err);
    }
  }
  return {};
}

function normalizeConfig(raw: unknown): FusionConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const out: FusionConfig = {};
  if (typeof input.executor === "string") out.executor = input.executor;
  const tools = normalizeToolSelection(input.executorTools);
  if (tools !== undefined) out.executorTools = tools;
  if (typeof input.maxToolCalls === "number" && Number.isFinite(input.maxToolCalls)) {
    out.maxToolCalls = Math.max(MIN_TOOL_CALLS, Math.min(MAX_TOOL_CALLS, Math.floor(input.maxToolCalls)));
  }
  if (typeof input.maxExecutorOutputTokens === "number" && input.maxExecutorOutputTokens > 0) {
    out.maxExecutorOutputTokens = Math.min(Math.floor(input.maxExecutorOutputTokens), MAX_TOKENS);
  }
  if (typeof input.temperature === "number" && input.temperature >= 0 && input.temperature <= 2) {
    out.temperature = input.temperature;
  }
  if (isFusionThinkingLevel(input.thinkingLevel)) out.thinkingLevel = input.thinkingLevel;
  if (typeof input.fastMode === "boolean") out.fastMode = input.fastMode;
  if (typeof input.executorToolsConsent === "boolean") out.executorToolsConsent = input.executorToolsConsent;
  if (typeof input.maxHistoryMessages === "number" && input.maxHistoryMessages >= 4) {
    out.maxHistoryMessages = Math.min(200, Math.floor(input.maxHistoryMessages));
  }
  const fallbacks = normalizeStringList(input.fallbackExecutors);
  if (fallbacks !== undefined) out.fallbackExecutors = fallbacks;
  if (typeof input.maxEscalations === "number" && Number.isFinite(input.maxEscalations)) {
    out.maxEscalations = Math.max(MIN_ESCALATIONS, Math.min(MAX_ESCALATIONS, Math.floor(input.maxEscalations)));
  }
  if (input.leadMutations === "allow" || input.leadMutations === "delegate") {
    out.leadMutations = input.leadMutations;
  }
  return out;
}

export function isFusionThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (FUSION_THINKING_LEVELS as readonly string[]).includes(value);
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

function normalizeToolSelection(value: unknown): ToolSelection | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (TOOL_MODES as readonly string[]).includes(value)) {
    return value as ToolSelection;
  }
  if (!Array.isArray(value)) return "none";
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.toLowerCase();
    if ((TOOL_NAMES as readonly string[]).includes(name) && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Session override from /fusion-model. `auto` ignores the configured executor. */
export interface ExecutorOverride {
  executor?: string;
  auto?: boolean;
}

export interface ThinkingOverride {
  thinkingLevel?: ModelThinkingLevel;
}

/** Session override from /fusion-fast. */
export interface FastModeOverride {
  fastMode?: boolean;
}

/** Session override from /fusion-consent. */
export interface ConsentOverride {
  executorToolsConsent?: boolean;
}

/** Pure overlay: session override wins over file config (unit-tested). */
export function applyOverride(base: FusionConfig, override: ExecutorOverride | undefined): FusionConfig {
  if (!override) return base;
  if (override.auto) return { ...base, executor: undefined };
  if (override.executor) return { ...base, executor: override.executor };
  return base;
}

export function applyThinkingOverride(base: FusionConfig, override: ThinkingOverride | undefined): FusionConfig {
  if (!override?.thinkingLevel) return base;
  return { ...base, thinkingLevel: override.thinkingLevel };
}

/** Session fast-mode choice wins over file config, including an explicit false. */
export function applyFastModeOverride(base: FusionConfig, override: FastModeOverride | undefined): FusionConfig {
  if (!override || typeof override.fastMode !== "boolean") return base;
  return { ...base, fastMode: override.fastMode };
}

/** Session consent wins over file config, including an explicit false. */
export function applyConsentOverride(base: FusionConfig, override: ConsentOverride | undefined): FusionConfig {
  if (!override || typeof override.executorToolsConsent !== "boolean") return base;
  return { ...base, executorToolsConsent: override.executorToolsConsent };
}

export function applyDefaults(config: FusionConfig): ResolvedFusionConfig {
  const n = normalizeConfig(config);
  return {
    executor: n.executor,
    executorTools: n.executorTools ?? "all",
    maxToolCalls: n.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    maxExecutorOutputTokens: n.maxExecutorOutputTokens ?? DEFAULT_MAX_TOKENS,
    temperature: n.temperature ?? DEFAULT_TEMPERATURE,
    thinkingLevel: n.thinkingLevel ?? "off",
    fastMode: n.fastMode ?? false,
    executorToolsConsent: n.executorToolsConsent ?? false,
    maxHistoryMessages: n.maxHistoryMessages ?? DEFAULT_MAX_HISTORY,
    fallbackExecutors: n.fallbackExecutors ?? [],
    maxEscalations: n.maxEscalations ?? DEFAULT_MAX_ESCALATIONS,
    leadMutations: n.leadMutations ?? "allow",
  };
}
