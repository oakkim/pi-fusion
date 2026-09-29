import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRunner, SessionManager, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runExecutorTurn, type ExecutorCheckpoint } from "./llm.ts";
import { resolveToolDefs } from "./tools.ts";
import { isWorkerToolContext } from "./worker-tool-runtime.ts";

// Real native extension dispatch around the real worker loop; only model responses
// and the MCP-like tool bodies are fixtures. No network, shell, or model calls.
const directory = mkdtempSync(join(tmpdir(), "pi-fusion-worker-tools-"));
const workerCwd = join(directory, "worker-checkout");
const signal = new AbortController().signal;
const active = ["mcp", "read", "fixture_denied", "fixture_stop", "fusion_spawn", "ask_advisor"];
const tools = new Map<string, { definition: ToolDefinition; sourceInfo: any }>();
const executed: string[] = [];
const calls: Array<{ name: string; args: unknown; ctx: ExtensionContext }> = [];
const results: Array<{ name: string; ctx: ExtensionContext }> = [];
const sourceInfo = { path: "fixture", source: "fixture", scope: "temporary", origin: "top-level" };
const toolUsage = { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.025 } };
const filteredUsage = { ...toolUsage, input: 24, output: 6, totalTokens: 30, cost: { ...toolUsage.cost, total: 0.03 } };
const advisorUsage = { ...toolUsage, input: 30, output: 4, totalTokens: 34, cost: { ...toolUsage.cost, total: 0.004 } };
const modelUsage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
const register = (definition: ToolDefinition<any, any>) => tools.set(definition.name, { definition, sourceInfo });
const checkContext = (ctx: ExtensionContext, requestSignal: AbortSignal | undefined) => {
  assert.equal(ctx.cwd, workerCwd);
  assert.equal(ctx.signal, signal);
  assert.equal(requestSignal, signal);
  assert.equal(isWorkerToolContext(ctx), true);
};
register({
  name: "mcp", label: "MCP fixture", description: "Activate a fixture tool through the existing extension runtime.",
  parameters: Type.Object({}),
  async execute(_id, _args, requestSignal, _onUpdate, ctx) {
    checkContext(ctx, requestSignal); executed.push("mcp");
    active.push("fixture_dynamic");
    return { content: [{ type: "text", text: "fixture_dynamic is now active" }], details: {} };
  },
});
register({
  name: "read", label: "Overridden read", description: "Fixture extension override, not the native filesystem reader.",
  parameters: Type.Object({ path: Type.String() }),
  async execute(_id, _args, requestSignal, _onUpdate, ctx) {
    checkContext(ctx, requestSignal); executed.push("read-override");
    return { content: [{ type: "text", text: "OVERRIDDEN-READ" }], details: { overridden: true } };
  },
});
register({
  name: "fixture_dynamic", label: "Dynamic tool", description: "A tool activated by discovery.",
  promptGuidelines: ["DYNAMIC-GUIDANCE: use the validated count returned by discovery."],
  parameters: Type.Object({ count: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  prepareArguments: (args: any) => args.legacyCount === undefined ? args : { count: args.legacyCount },
  async execute(_id, args, requestSignal, onUpdate, ctx) {
    checkContext(ctx, requestSignal); executed.push("dynamic");
    assert.deepEqual(args, { count: 7 }, "prepareArguments and native coercion must precede execution");
    onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {}, usage: toolUsage });
    return { content: [{ type: "text", text: "DYNAMIC-RAW" }], details: { original: true }, usage: toolUsage };
  },
});
register({
  name: "ask_advisor", label: "Advisor", description: "An active advice tool with recorded model usage.",
  parameters: Type.Object({ question: Type.String() }),
  async execute(_id, args, requestSignal, _update, ctx) {
    checkContext(ctx, requestSignal); executed.push("ask_advisor");
    assert.equal((args as { question: string }).question, "Review this decision.");
    return { content: [{ type: "text", text: "Fixture advice." }], details: { advisor: true }, usage: advisorUsage };
  },
});
for (const name of ["fixture_denied", "fixture_stop", "fusion_spawn"]) register({
  name, label: name, description: "Must not execute.", parameters: Type.Object({}),
  async execute() { executed.push(name); throw new Error(`${name} must not execute`); },
});
const handlers = new Map<string, any[]>([
  ["tool_call", [(event: any, ctx: ExtensionContext) => {
    checkContext(ctx, signal); calls.push({ name: event.toolName, args: event.input, ctx });
    if (event.toolName === "fixture_denied") return { block: true, reason: "fixture permission denied" };
    if (event.toolName === "fixture_stop") return { block: true, terminate: true, reason: "fixture policy terminates this batch" };
  }]],
  ["tool_result", [(event: any, ctx: ExtensionContext) => {
    checkContext(ctx, signal); results.push({ name: event.toolName, ctx });
    if (event.toolName === "fixture_dynamic") return {
      content: [{ type: "text", text: "DYNAMIC-FILTERED" }], details: { filtered: true }, usage: filteredUsage,
    };
  }]],
]);
const runner = new ExtensionRunner([{ path: "fixture", resolvedPath: "fixture", sourceInfo, tools, handlers }] as never,
  { getActiveTools: () => [...active] } as never, directory, SessionManager.inMemory(directory), {} as never);
const ctx = runner.createContext();
const model = { provider: "fixture", id: "worker", api: "openai-completions", input: ["text"], reasoning: false, contextWindow: 128000 } as never;
const assistant = (content: unknown[], stopReason = "toolUse") => ({ role: "assistant", content, stopReason, usage: modelUsage, timestamp: 1 });
const toolCall = (id: string, name: string, args: unknown = {}) => ({ type: "toolCall", id, name, arguments: args });
const resultStream = (value: unknown) => ({ result: () => Promise.resolve(value) });
const resolve = () => resolveToolDefs("all", workerCwd, ctx);

try {
  let requests = 0;
  const checkpoints: ExecutorCheckpoint[] = [];
  const result = await runExecutorTurn({ streamSimple: (_model: unknown, context: any) => {
    requests++;
    const names = context.tools.map((tool: any) => tool.name);
    assert(!names.some((name: string) => name.startsWith("fusion_")));
    assert(names.includes("ask_advisor"), "active advisor is inherited with other Lead tools");
    if (requests === 1) {
      assert(!names.includes("fixture_dynamic"));
      assert(!context.systemPrompt.includes("DYNAMIC-GUIDANCE"));
      return resultStream(assistant([toolCall("discover", "mcp")]));
    }
    assert(names.includes("fixture_dynamic"), "discovered tools must reach the next model request");
    assert(context.systemPrompt.includes("DYNAMIC-GUIDANCE"), "newly active prompt guidelines must accompany the schema");
    if (requests === 2) return resultStream(assistant([
      toolCall("read", "read", { path: "intentionally-nonexistent" }),
      toolCall("dynamic", "fixture_dynamic", { legacyCount: "7" }),
      toolCall("advisor", "ask_advisor", { question: "Review this decision." }),
      toolCall("denied", "fixture_denied"),
      toolCall("invalid", "fixture_dynamic", { count: -1 }),
    ]));
    assert.equal(requests, 3);
    const toolResults = context.messages.filter((message: any) => message.role === "toolResult");
    assert.equal(toolResults.find((message: any) => message.toolCallId === "read").content[0].text, "OVERRIDDEN-READ");
    const dynamic = toolResults.find((message: any) => message.toolCallId === "dynamic");
    assert.equal(dynamic.content[0].text, "DYNAMIC-FILTERED");
    assert.deepEqual(dynamic.details, { filtered: true });
    assert.deepEqual(dynamic.usage, filteredUsage);
    assert.match(toolResults.find((message: any) => message.toolCallId === "denied").content[0].text, /fixture permission denied/);
    assert.match(toolResults.find((message: any) => message.toolCallId === "invalid").content[0].text, /Validation failed/);
    return resultStream(assistant([{ type: "text", text: "Finished with the inherited tools." }], "stop"));
  } } as never, model, "Worker test", [{ role: "user", content: "Use the available tools.", timestamp: 0 }],
  1024, 0.2, signal, resolve, 20, ctx, "off", undefined, undefined, false,
  { maxHistoryMessages: 100, checkpoint: (checkpoint) => checkpoints.push(checkpoint) });
  assert.deepEqual(executed, ["mcp", "read-override", "dynamic", "ask_advisor"]);
  assert.deepEqual(calls.map((call) => call.name), ["mcp", "read", "fixture_dynamic", "ask_advisor", "fixture_denied"]);
  assert.deepEqual(calls.find((call) => call.name === "fixture_dynamic")!.args, { count: 7 });
  assert.deepEqual(results.map((entry) => entry.name), ["mcp", "read", "fixture_dynamic", "ask_advisor"]);
  assert.equal(result.usage.totalTokens, 100, "three model responses plus filtered tool and advisor usage exactly once");
  assert.equal(result.usage.input, 84);
  assert.equal(result.usage.output, 16);
  assert(Math.abs(result.usage.cost - 0.037) < 1e-12);
  assert.deepEqual(checkpoints.at(-1)!.usage, result.usage);
  assert.equal(ctx.cwd, directory, "Lead context remains unchanged");
  assert.equal(isWorkerToolContext(ctx), false);

  let mixedRequests = 0;
  await runExecutorTurn({ streamSimple: (_model: unknown, context: any) => {
    mixedRequests++;
    if (mixedRequests === 1) return resultStream(assistant([
      toolCall("stop", "fixture_stop"), toolCall("after-stop", "read", { path: "must-not-read" }),
    ]));
    assert.equal(mixedRequests, 2);
    assert(context.tools.length > 0, "native policy only ends a batch when every result terminates");
    return resultStream(assistant([{ type: "text", text: "Mixed batch completed." }], "stop"));
  } } as never, model, "Worker test", [{ role: "user", content: "Respect policy.", timestamp: 0 }],
  1024, 0.2, signal, resolve, 20, ctx);
  assert.deepEqual(executed, ["mcp", "read-override", "dynamic", "ask_advisor", "read-override"]);

  let finalRequests = 0;
  const terminated = await runExecutorTurn({ streamSimple: (_model: unknown, context: any) => {
    finalRequests++;
    if (finalRequests === 1) return resultStream(assistant([toolCall("stop-only", "fixture_stop")]));
    assert.equal(finalRequests, 2);
    assert.equal(context.tools, undefined, "policy termination produces a tool-free final response");
    return resultStream(assistant([{ type: "text", text: "Stopped by policy." }], "stop"));
  } } as never, model, "Worker test", [{ role: "user", content: "Respect policy.", timestamp: 0 }],
  1024, 0.2, signal, resolve, 20, ctx);
  assert.equal(terminated.cappedOut, true);
  assert.deepEqual(executed, ["mcp", "read-override", "dynamic", "ask_advisor", "read-override"], "denied and invalid calls never execute");
  assert.equal(terminated.usage.totalTokens, 24);
  console.log("  PASS worker tool integration: dynamic registry, permission hooks, validation, override, scoped context, usage, termination");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
