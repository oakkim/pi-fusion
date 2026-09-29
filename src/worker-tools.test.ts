/** Native extension hooks and isolated worker contexts; no models or network. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, createExtensionRuntime, DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager,
  type AgentToolUpdateCallback, type Extension, type ExtensionContext,
  type ToolCallEvent, type ToolDefinition, type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { isMutatingSelection, resolveToolDefs, selectionLabel, selectionToNames } from "./tools.ts";
import { isWorkerToolContext, workerToolRunner } from "./worker-tool-runtime.ts";

function fixture(names: string[]) {
  const active = [...names];
  const tools: Extension["tools"] = new Map();
  const calls: Array<{ event: ToolCallEvent; ctx: ExtensionContext }> = [];
  const results: Array<{ event: ToolResultEvent; ctx: ExtensionContext }> = [];
  let before: ((event: ToolCallEvent, ctx: ExtensionContext) => any) | undefined;
  let after: ((event: ToolResultEvent, ctx: ExtensionContext) => any) | undefined;
  const extension = {
    path: "worker-tools-fixture", tools,
    handlers: new Map([
      ["tool_call", [(event: ToolCallEvent, ctx: ExtensionContext) => { calls.push({ event, ctx }); return before?.(event, ctx); }]],
      ["tool_result", [(event: ToolResultEvent, ctx: ExtensionContext) => { results.push({ event, ctx }); return after?.(event, ctx); }]],
    ]),
  } as unknown as Extension;
  const runtime = createExtensionRuntime();
  runtime.getActiveTools = () => [...active];
  const leadController = new AbortController();
  const runner = new ExtensionRunner([extension], runtime, "/lead", SessionManager.inMemory("/lead"), {} as never);
  runner.bindCore(runtime, {
    getModel: () => undefined, getScopedModels: () => [], getSignal: () => leadController.signal,
    abort: () => leadController.abort(), isIdle: () => true, isProjectTrusted: () => true,
    hasPendingMessages: () => false, shutdown: () => {}, getContextUsage: () => undefined,
    compact: () => {}, getSystemPrompt: () => "fixture",
  });
  const ctx = runner.createContext();
  const register = (definition: ToolDefinition<any, any>) => tools.set(definition.name, { definition, sourceInfo: {} as never });
  return {
    active, tools, calls, results, runner, ctx, register, leadController,
    before: (handler: typeof before) => { before = handler; },
    after: (handler: typeof after) => { after = handler; },
  };
}
const emptyTool = (name: string): ToolDefinition => ({
  name, label: name, description: "fixture", parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
});
const countSchema = Type.Object({ count: Type.Integer({ minimum: 0 }) });
const usage = { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
const dir = mkdtempSync(join(tmpdir(), "fusion-worker-tools-unit-"));
try {
  // Config must retain case-sensitive extension names before registry resolution.
  writeFileSync(join(dir, "fusion.json"), JSON.stringify({ executorTools: ["mcp__Foo__Bar", " read ", "mcp__Foo__Bar", null] }));
  assert.deepEqual(loadConfig(dir, false, dir).executorTools, ["mcp__Foo__Bar", "read"]);
  assert.deepEqual(selectionToNames(["mcp__Foo__Bar", "read", "mcp__Foo__Bar", "fusion_spawn"]), ["mcp__Foo__Bar", "read"]);
  assert.equal(selectionLabel(["mcp__Foo__Bar"]), "mcp__Foo__Bar");
  for (const mode of ["all", ["read"], ["mcp__Foo__Bar"]] as const) assert.equal(isMutatingSelection(mode as any), true);
  for (const mode of ["readonly", "none", [], undefined] as const) assert.equal(isMutatingSelection(mode as any), false);
  assert.deepEqual(resolveToolDefs("none", dir, {}), []);
  assert.deepEqual(resolveToolDefs([], dir, {}), []);
  assert.throws(() => resolveToolDefs("all", dir, {}), /current Pi extension context/);
  assert.throws(() => resolveToolDefs("all", dir, undefined), /current Pi extension context/);

  const f = fixture(["read", "mcp", "ask_advisor", "fusion_spawn"]);
  f.register(emptyTool("ask_advisor"));
  f.register(emptyTool("fusion_spawn"));
  f.register({ ...emptyTool("mcp"), execute: async () => {
    f.register(emptyTool("mcp__Foo__Bar")); f.active.push("mcp__Foo__Bar");
    return { content: [{ type: "text", text: "Activated mcp__Foo__Bar" }], details: {} };
  } });
  f.register({ ...emptyTool("read"), description: "extension read override" });
  assert.equal(workerToolRunner(f.runner.createCommandContext()), f.runner, "command contexts preserve the nonenumerable owner");
  assert.equal(isWorkerToolContext(f.ctx), false);
  assert.equal(Object.keys(f.ctx).some((key) => key.includes("runner")), false);
  const controller = new AbortController();
  const options = { abort: () => controller.abort() };
  const all = () => resolveToolDefs("all", dir, f.ctx, options);
  assert.deepEqual(all().map((tool) => tool.name), ["read", "mcp", "ask_advisor"]);
  assert.equal(all().find((tool) => tool.name === "read")!.description, "extension read override");
  await all().find((tool) => tool.name === "mcp")!.execute("discover", {}, controller.signal, undefined, f.ctx);
  assert.ok(all().some((tool) => tool.name === "mcp__Foo__Bar"), "newly activated tools appear on the next resolution");
  assert.deepEqual(resolveToolDefs(["mcp__foo__bar", "mcp__Foo__Bar", "missing", "fusion_spawn", "mcp__Foo__Bar"], dir, f.ctx, options).map((tool) => tool.name), ["mcp__Foo__Bar"]);
  writeFileSync(join(dir, "read.txt"), "REAL-WORKER-FILE");
  const readOnly = resolveToolDefs("readonly", dir, f.ctx, options);
  assert.deepEqual(readOnly.map((tool) => tool.name), ["read"]);
  const readResult = await readOnly[0]!.execute("read-only", { path: "read.txt" }, controller.signal, undefined, f.ctx);
  assert.match(JSON.stringify(readResult.content), /REAL-WORKER-FILE/);
  assert.equal(f.calls.at(-1)!.ctx.cwd, dir);
  assert.equal(f.results.at(-1)!.ctx.signal, controller.signal);
  assert.equal(f.ctx.cwd, "/lead");
  assert.equal(f.ctx.signal, f.leadController.signal);
  f.active.push("unavailable_definition");
  assert.throws(all, /no accessible definition/);
  f.active.pop();
  f.active.push("bash");
  assert.throws(all, /no accessible definition/, "hostless fixtures cannot silently regenerate configured builtin tools");
  f.active.pop();

  // Use a real SDK host so configured builtin shell options survive forwarding.
  const agentDir = join(dir, "isolated-agent");
  mkdirSync(agentDir);
  const settingsManager = SettingsManager.inMemory({ packages: [], shellCommandPrefix: "export FUSION_TOOL_PREFIX=preserved" });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir), tools: ["bash", "read", "powershell"] });
  try {
    const hostCtx = session.extensionRunner.createContext();
    const workerDir = join(dir, "configured-shell-worker");
    mkdirSync(workerDir);
    const hostTools = resolveToolDefs("all", workerDir, hostCtx, options);
    assert.ok(hostTools.some((entry) => entry.name === "powershell"), "active PowerShell builtin is available too");
    const bash = hostTools.find((entry) => entry.name === "bash")!;
    const shellResult = await bash.execute("configured-bash", { command: 'printf "%s\\n" "$FUSION_TOOL_PREFIX"; pwd' }, controller.signal, undefined, hostCtx);
    assert.match(JSON.stringify(shellResult.content), /preserved/);
    assert.match(JSON.stringify(shellResult.content), /configured-shell-worker/);
  } finally { session.dispose(); }

  const g = fixture(["fixture_count"]);
  let executions = 0;
  let retainedUpdate: AgentToolUpdateCallback | undefined;
  g.register({
    ...emptyTool("fixture_count"), parameters: countSchema,
    promptSnippet: "Fixture count", promptGuidelines: ["Preserve fixture count."], constrainedSampling: false,
    prepareArguments: (args: any) => args.legacy === undefined ? args : { count: args.legacy },
    async execute(_id, args: any, _signal, update) {
      executions++; retainedUpdate = update;
      update?.({ content: [{ type: "text", text: "partial" }], details: {} });
      if (args.count === 9) throw new Error("fixture execution failed");
      return { content: [{ type: "text", text: String(args.count) }], details: { original: true }, usage, terminate: true };
    },
  });
  const tool = resolveToolDefs("all", dir, g.ctx, options)[0]!;
  assert.deepEqual(tool.promptGuidelines, ["Preserve fixture count."]);
  assert.equal(tool.constrainedSampling, false);
  assert.equal(tool.promptSnippet, "Fixture count");
  g.before((event, ctx) => {
    assert.equal(isWorkerToolContext(ctx), true);
    assert.equal((event.input as Record<string, unknown>).count, 2, "native validation coerces prepared arguments before hooks");
    (event.input as Record<string, unknown>).count = 3;
  });
  g.after((event) => ({ content: [{ type: "text", text: `filtered:${JSON.stringify(event.content)}` }] }));
  let updates = 0;
  const raw = { legacy: "2" };
  const result = await tool.execute("coerce", raw, controller.signal, () => { updates++; }, g.ctx);
  assert.deepEqual(raw, { legacy: "2" }, "validation and hook edits do not mutate raw model arguments");
  assert.match(JSON.stringify(result.content), /3/);
  assert.equal(result.usage, usage);
  assert.deepEqual(result.details, { original: true });
  assert.equal(result.terminate, true);
  retainedUpdate?.({ content: [], details: {} });
  assert.equal(updates, 1, "late streaming updates are ignored after execution settles");
  g.before(undefined);
  const beforeCount = g.calls.length;
  await assert.rejects(tool.execute("invalid", { count: "bad" }, undefined, undefined, g.ctx), /Validation failed|must be|Expected/);
  assert.equal(g.calls.length, beforeCount, "schema errors do not reach permission or result hooks");
  assert.equal(executions, 1);
  const resultCount = g.results.length;
  g.before(() => ({ block: true, reason: "permission denied", terminate: true }));
  const denied = await tool.execute("denied", { count: 1 }, undefined, undefined, g.ctx);
  assert.deepEqual(denied, { content: [{ type: "text", text: "permission denied" }], details: {}, isError: true, terminate: true });
  assert.equal(g.results.length, resultCount, "blocked calls are not executed or sent through result hooks");
  g.before(() => { throw new Error("permission lookup failed"); });
  await assert.rejects(tool.execute("throw", { count: 1 }, undefined, undefined, g.ctx), /permission lookup failed/);
  assert.equal(executions, 1);
  assert.equal(g.results.length, resultCount);
  g.before(undefined);
  g.after((event) => {
    assert.match(JSON.stringify(event.content), /fixture execution failed/);
    return { content: [{ type: "text", text: "redacted failure" }], details: { filtered: true }, usage: { ...usage, totalTokens: 6 }, isError: event.isError };
  });
  const failed = await tool.execute("failed", { count: 9 }, undefined, undefined, g.ctx);
  assert.equal(failed.isError, true);
  assert.equal(failed.usage?.totalTokens, 6);
  assert.deepEqual(failed.content, [{ type: "text", text: "redacted failure" }]);

  // Revocation is checked both before hooks and after asynchronous permissions.
  g.active.length = 0;
  await assert.rejects(tool.execute("revoked", { count: 1 }, undefined, undefined, g.ctx), /no longer active/);
  g.active.push("fixture_count");
  g.before(async () => { await Promise.resolve(); g.active.length = 0; });
  await assert.rejects(tool.execute("revoked-in-hook", { count: 1 }, undefined, undefined, g.ctx), /no longer active/);
  g.active.push("fixture_count");
  g.before(undefined);
  g.register(emptyTool("fixture_count"));
  await assert.rejects(tool.execute("changed", { count: 1 }, undefined, undefined, g.ctx), /definition changed/);

  // A tool or hook can start a Lead follow-up through the same native runner.
  // That new run must keep Lead context and still hit the Lead mutation policy.
  const reentry = fixture(["fixture_reentry"]);
  const reentryController = new AbortController();
  const leadChecks: string[] = [];
  const workerContexts: ExtensionContext[] = [];
  const checkLead = async (from: string) => {
    const leadCtx = await Promise.resolve().then(() => reentry.runner.createContext());
    assert.equal(leadCtx.cwd, "/lead");
    assert.equal(leadCtx.signal, reentry.leadController.signal);
    assert.equal(isWorkerToolContext(leadCtx), false, `${from} must not leak worker context to a Lead follow-up`);
    const permission = await reentry.runner.emitToolCall({ type: "tool_call", toolCallId: `lead:${from}`, toolName: "write", input: { path: "never", content: "never" } });
    assert.equal(permission?.block, true, "Lead mutations remain subject to the Lead-only permission hook");
    leadChecks.push(from);
  };
  reentry.before(async (event, ctx) => {
    if (event.toolCallId.startsWith("lead:")) {
      if (!isWorkerToolContext(ctx)) return { block: true, reason: "Delegate Lead mutations" };
      return;
    }
    workerContexts.push(ctx);
    await checkLead("before hook");
  });
  reentry.after(async (_event, ctx) => { workerContexts.push(ctx); await checkLead("result hook"); });
  reentry.register({ ...emptyTool("fixture_reentry"), async execute(_id, _args, _signal, _update, ctx) {
    workerContexts.push(ctx);
    await checkLead("tool body");
    return { content: [{ type: "text", text: "worker completed" }], details: {} };
  } });
  const reentrantTool = resolveToolDefs("all", dir, reentry.ctx, { abort: () => reentryController.abort() })[0]!;
  const reentrantResult = await reentrantTool.execute("worker", {}, reentryController.signal, undefined, reentry.ctx);
  assert.equal(reentrantResult.isError, false);
  assert.deepEqual(leadChecks, ["before hook", "tool body", "result hook"]);
  assert.equal(workerContexts.length, 3);
  for (const ctx of workerContexts) {
    assert.equal(isWorkerToolContext(ctx), true, "retained worker contexts remain scoped after reentry");
    assert.equal(ctx.cwd, dir);
    assert.equal(ctx.signal, reentryController.signal);
  }

  // Concurrent workers and native hooks see their own cwd and cancellation scope.
  const h = fixture(["fixture_scope"]);
  const retained: ExtensionContext[] = [];
  h.register({ ...emptyTool("fixture_scope"), async execute(id, _args, signal, _update, ctx) {
    retained.push(ctx);
    await new Promise((resolve) => setTimeout(resolve, id === "one" ? 12 : 1));
    assert.equal(ctx.cwd, join(dir, id));
    assert.equal(ctx.signal, signal);
    assert.equal(isWorkerToolContext(ctx), true);
    if (id === "one") ctx.abort();
    return { content: [{ type: "text", text: id }], details: {} };
  } });
  const one = new AbortController();
  const two = new AbortController();
  await Promise.all([["one", one], ["two", two]].map(async ([id, aborter]) => {
    const controller = aborter as AbortController;
    const workerTool = resolveToolDefs("all", join(dir, String(id)), h.ctx, { abort: () => controller.abort() })[0]!;
    await workerTool.execute(String(id), {}, controller.signal, undefined, h.ctx);
  }));
  assert.equal(one.signal.aborted, true);
  assert.equal(two.signal.aborted, false);
  assert.equal(h.leadController.signal.aborted, false, "worker ctx.abort never aborts Lead");
  assert.deepEqual(h.calls.map(({ event, ctx }) => [event.toolCallId, ctx.cwd, ctx.signal === (event.toolCallId === "one" ? one : two).signal]), [["one", join(dir, "one"), true], ["two", join(dir, "two"), true]]);
  assert.equal(h.results.every(({ ctx }) => isWorkerToolContext(ctx)), true);
  assert.equal(h.runner.createContext().cwd, "/lead");
  assert.equal(isWorkerToolContext(h.runner.createContext()), false);
  const current = resolveToolDefs("all", dir, h.ctx, options)[0]!;
  const initialCalls = h.calls.length;
  await assert.rejects(current.execute("already-aborted", {}, one.signal, undefined, h.ctx), /abort/i);
  assert.equal(h.calls.length, initialCalls);
  const duringHook = new AbortController();
  h.before((_event, ctx) => ctx.abort());
  const abortInHook = resolveToolDefs("all", dir, h.ctx, { abort: () => duringHook.abort() })[0]!;
  const initialExecuted = retained.length;
  await assert.rejects(abortInHook.execute("abort-in-hook", {}, duringHook.signal, undefined, h.ctx), /abort/i);
  assert.equal(retained.length, initialExecuted);
  h.runner.invalidate("fixture runner replaced");
  assert.throws(() => retained[0]!.cwd, /fixture runner replaced/);
  assert.throws(() => retained[0]!.signal, /fixture runner replaced/);
  assert.throws(() => retained[0]!.abort(), /fixture runner replaced/);
  assert.throws(() => retained[0]!.model, /fixture runner replaced/);
  assert.throws(() => resolveToolDefs("all", dir, h.ctx, options), /fixture runner replaced/);
  await assert.rejects(current.execute("stale", {}, undefined, undefined, h.ctx), /fixture runner replaced/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("Worker tools: native registry, validation, permissions, results, cancellation and context isolation passed");
