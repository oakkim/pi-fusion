/**
 * Executor tool allowlist. Port of pi-devin-fusion's tools.ts.
 * Built from pi's own tool factories — never from the live registry —
 * so fusion_* tools can never leak into the executor (no recursion).
 */

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_TOOL_CALLS, MAX_TOOL_CALLS, MIN_TOOL_CALLS } from "./config.ts";
import type { ToolSelection } from "./types.ts";

export interface ExecutorToolDef {
  name: string;
  description: string;
  parameters: TSchema;
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    extra: unknown,
    ctx: unknown,
  ): Promise<{ content: ToolResultMessage["content"]; isError: boolean }>;
}

export const READONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export const MUTATING_TOOL_NAMES = ["bash", "edit", "write"] as const;
export const ALL_TOOL_NAMES = [...READONLY_TOOL_NAMES, ...MUTATING_TOOL_NAMES] as const;

type ToolName = (typeof ALL_TOOL_NAMES)[number];

function build(name: ToolName, cwd: string): ExecutorToolDef {
  switch (name) {
    case "read": return createReadToolDefinition(cwd) as unknown as ExecutorToolDef;
    case "grep": return createGrepToolDefinition(cwd) as unknown as ExecutorToolDef;
    case "find": return createFindToolDefinition(cwd) as unknown as ExecutorToolDef;
    case "ls": return createLsToolDefinition(cwd) as unknown as ExecutorToolDef;
    case "bash": return createBashToolDefinition(cwd) as unknown as ExecutorToolDef;
    case "edit": return createEditToolDefinition(cwd) as unknown as ExecutorToolDef;
    case "write": return createWriteToolDefinition(cwd) as unknown as ExecutorToolDef;
  }
}

function isToolName(value: string): value is ToolName {
  return (ALL_TOOL_NAMES as readonly string[]).includes(value);
}

export function selectionToNames(selection: ToolSelection | undefined): ToolName[] {
  if (!selection || selection === "none") return [];
  if (selection === "readonly") return [...READONLY_TOOL_NAMES];
  if (selection === "all") return [...ALL_TOOL_NAMES];
  if (Array.isArray(selection)) {
    const seen = new Set<string>();
    const out: ToolName[] = [];
    for (const raw of selection) {
      const name = String(raw).toLowerCase();
      if (isToolName(name) && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  }
  return [];
}

export function resolveToolDefs(selection: ToolSelection | undefined, cwd: string): ExecutorToolDef[] {
  return selectionToNames(selection).map((n) => build(n, cwd));
}

export function isMutatingSelection(selection: ToolSelection | undefined): boolean {
  return selectionToNames(selection).some((n) => (MUTATING_TOOL_NAMES as readonly string[]).includes(n));
}

export function selectionLabel(selection: ToolSelection | undefined): string {
  if (!selection || selection === "none") return "none";
  if (selection === "readonly" || selection === "all") return selection;
  const names = selectionToNames(selection);
  return names.length ? names.join(",") : "none";
}

export function clampMaxToolCalls(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_TOOL_CALLS;
  return Math.max(MIN_TOOL_CALLS, Math.min(MAX_TOOL_CALLS, Math.floor(value)));
}
