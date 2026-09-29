/** Resolve active Lead tools and run them through Pi's existing permission hooks. */
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type AgentToolUpdateCallback,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { validateToolArguments, type ConstrainedSamplingConfig, type ToolResultMessage, type Usage } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { DEFAULT_MAX_TOOL_CALLS, MAX_TOOL_CALLS, MIN_TOOL_CALLS } from "./config.ts";
import type { ToolSelection } from "./types.ts";
import { withWorkerToolContext, workerToolDefinition, workerToolRunner } from "./worker-tool-runtime.ts";

export interface ExecutorToolResult {
  content: ToolResultMessage["content"];
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
  terminate?: boolean;
}

export interface ExecutorToolDef {
  name: string;
  description: string;
  parameters: TSchema;
  promptSnippet?: string;
  promptGuidelines?: string[];
  constrainedSampling?: false | ConstrainedSamplingConfig;
  executionMode?: "sequential" | "parallel";
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: unknown,
  ): Promise<ExecutorToolResult>;
}

export const READONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export const MUTATING_TOOL_NAMES = ["bash", "edit", "write", "powershell"] as const;
export const ALL_TOOL_NAMES = [...READONLY_TOOL_NAMES, ...MUTATING_TOOL_NAMES] as const;

const factories = {
  read: createReadToolDefinition, grep: createGrepToolDefinition,
  find: createFindToolDefinition, ls: createLsToolDefinition,
  bash: createBashToolDefinition, edit: createEditToolDefinition,
  write: createWriteToolDefinition, powershell: createPowerShellToolDefinition,
};
type BuiltinName = keyof typeof factories;
function isBuiltin(name: string): name is BuiltinName { return Object.hasOwn(factories, name); }
function isWorkerTool(name: string): boolean { return !name.startsWith("fusion_"); }

export function selectionToNames(selection: ToolSelection | undefined): string[] {
  if (!selection || selection === "none") return [];
  if (selection === "readonly") return [...READONLY_TOOL_NAMES];
  if (selection === "all") return [...ALL_TOOL_NAMES];
  return Array.isArray(selection) ? [...new Set(selection)].filter(isWorkerTool) : [];
}

/** Two-argument calls are the legacy builtin-only adapter, not a registry fallback. */
export function resolveToolDefs(
  selection: ToolSelection | undefined,
  cwd: string,
  ctx?: unknown,
  options?: { abort: () => void },
): ExecutorToolDef[] {
  if (!selection || selection === "none" || (Array.isArray(selection) && selection.length === 0)) return [];
  if (arguments.length < 3) {
    return selectionToNames(selection).filter(isBuiltin).map((name) => {
      const def = factories[name](cwd);
      return {
        ...def,
        execute: (id, args, signal, onUpdate, context) => def.execute(id, args as never, signal, onUpdate,
          Object.create(context as object, { cwd: { value: cwd, enumerable: true } })),
      };
    });
  }

  const runner = workerToolRunner(ctx);
  const active = new Set(runner.getActiveTools());
  const names = (selection === "all" ? [...active] : selectionToNames(selection))
    .filter((name) => active.has(name) && isWorkerTool(name));
  return names.map((name): ExecutorToolDef => {
    // readonly deliberately uses Pi's known read-only implementations, even if
    // an extension overrides one of those names with a mutating implementation.
    const def: ToolDefinition<any, any> | undefined = selection === "readonly" && isBuiltin(name)
      ? factories[name](cwd) : workerToolDefinition(runner, name);
    if (!def) throw new Error(`Active Lead tool ${name} has no accessible definition for the worker`);
    const assertAvailable = () => {
      if (!runner.getActiveTools().includes(name) ||
          (selection !== "readonly" && workerToolDefinition(runner, name) !== def)) {
        throw new Error(`Worker tool ${name} is no longer active or its definition changed`);
      }
    };
    return {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      promptSnippet: def.promptSnippet,
      promptGuidelines: def.promptGuidelines,
      constrainedSampling: def.constrainedSampling,
      executionMode: def.executionMode,
      execute: async (id, args, signal, onUpdate): Promise<ExecutorToolResult> => {
        signal?.throwIfAborted();
        assertAvailable();
        const scope = { runner, cwd, signal,
          abort: options?.abort ?? (() => { throw new Error("Worker cancellation callback is unavailable"); }),
        };
        const workerCtx = withWorkerToolContext(scope, () => runner.createContext());
        const prepared = def.prepareArguments ? def.prepareArguments(args) : args;
        const input = validateToolArguments(def, { type: "toolCall", id, name, arguments: prepared as Record<string, unknown> });
        const before = await withWorkerToolContext(scope, () => runner.emitToolCall({ type: "tool_call", toolCallId: id, toolName: name, input }));
        signal?.throwIfAborted();
        if (before?.block) return {
          content: [{ type: "text", text: before.reason || "Tool execution was blocked" }],
          details: {}, isError: true, ...(before.terminate === true ? { terminate: true } : {}),
        };
        // A permission hook can await UI or revoke a tool while it is running.
        assertAvailable();
        let result: ExecutorToolResult;
        let acceptingUpdates = true;
        try {
          result = await def.execute(id, input, signal,
            onUpdate ? (partial) => { if (acceptingUpdates) onUpdate(partial); } : undefined, workerCtx);
        } catch (error) {
          result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {}, isError: true };
        } finally {
          acceptingUpdates = false;
        }
        const after = await withWorkerToolContext(scope, () => runner.emitToolResult({
          type: "tool_result", toolCallId: id, toolName: name, input,
          content: result.content ?? [], details: result.details, isError: result.isError ?? false, usage: result.usage,
        }));
        return {
          ...result,
          content: after?.content ?? result.content ?? [],
          details: after?.details ?? result.details,
          usage: after?.usage ?? result.usage,
          isError: after?.isError ?? result.isError ?? false,
        };
      },
    };
  });
}

export function isMutatingSelection(selection: ToolSelection | undefined): boolean {
  if (!selection || selection === "none" || selection === "readonly") return false;
  // Explicit names can be overridden after consent, even read/grep/find/ls.
  return selection === "all" || selectionToNames(selection).length > 0;
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
