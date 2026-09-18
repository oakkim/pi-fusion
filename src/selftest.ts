/** v0 self-test: no LLM calls. Verifies the persistence core. */
import { WorkerRuntime } from "../src/runtime.ts";
import { AdaptiveRoutingPolicy } from "../src/routing.ts";
import { handoffTaskText } from "../src/prompts.ts";
import { applyDefaults } from "../src/config.ts";
import { buildRecentContext } from "../src/utils.ts";
import fusionExtension from "../src/index.ts";

let pass = 0;
let fail = 0;
function eq(name: string, a: unknown, b: unknown): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa === sb) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}\n  got:      ${sa}\n  expected: ${sb}`); }
}

// --- 1. spawn -> finish -> followup keeps same worker/history ---
const rt = new WorkerRuntime();
const u1 = { role: "user", content: "investigate repo", timestamp: 1 } as never;
const { worker, turn } = rt.spawn({ label: "recon", executorModelId: "openai/gpt-4.1-mini", firstMessage: u1 as never });
eq("spawn ids", [worker.id.startsWith("wrk_"), turn.id.startsWith("trn_")], [true, true]);
eq("spawn gen", [worker.generation, turn.generation], [1, 1]);
eq("spawn history", worker.history.length, 1);

rt.finishTurn(turn.id, "found auth in src/auth.ts", [
  { role: "assistant", content: "found auth in src/auth.ts", timestamp: 2 },
] as never);
eq("after finish idle", rt.getWorker(worker.id)?.status, "idle");
eq("history grew", rt.getWorker(worker.id)?.history.length, 2);

// followup on SAME worker
const t2 = rt.followup(worker.id, { role: "user", content: "fix it", timestamp: 3 } as never);
eq("followup same worker", t2.workerId, worker.id);
eq("followup gen bump", [t2.generation, rt.getWorker(worker.id)?.generation], [2, 2]);
eq("followup history appended", rt.getWorker(worker.id)?.history.length, 3);
eq("active turn set", rt.getWorker(worker.id)?.activeTurnId, t2.id);

rt.finishTurn(t2.id, "fixed", [{ role: "assistant", content: "fixed", timestamp: 4 }] as never);
eq("second finish history", rt.getWorker(worker.id)?.history.length, 4);

// busy guard
const t3 = rt.followup(worker.id, { role: "user", content: "more", timestamp: 5 } as never);
let busyErr = "";
try {
  rt.followup(worker.id, { role: "user", content: "should fail", timestamp: 6 } as never);
} catch (e) { busyErr = (e as Error).message; }
eq("busy rejected", busyErr.includes("busy"), true);
rt.finishTurn(t3.id, "done", [{ role: "assistant", content: "done", timestamp: 7 }] as never);

// interrupt + close
const t4 = rt.followup(worker.id, { role: "user", content: "x", timestamp: 8 } as never);
const interrupted = rt.interrupt(worker.id);
eq("interrupt returns turn", interrupted, t4.id);
eq("turn interrupted", rt.getTurn(t4.id)?.status, "interrupted");
const historyAfterInterrupt = worker.history.length;
const lateFinish = rt.finishTurn(t4.id, "late", [{ role: "assistant", content: "late", timestamp: 9 }] as never);
eq("late finish keeps interruption", [lateFinish, rt.getTurn(t4.id)?.status, worker.status, worker.history.length], [false, "interrupted", "idle", historyAfterInterrupt]);
const t5 = rt.followup(worker.id, { role: "user", content: "newer", timestamp: 10 } as never);
rt.failTurn(t4.id, "late failure");
eq("stale failure keeps newer turn", [rt.getTurn(t4.id)?.status, worker.activeTurnId, worker.failures], ["interrupted", t5.id, 0]);
rt.close(worker.id);
eq("closed", rt.getWorker(worker.id)?.status, "closed");
const lateClosedFinish = rt.finishTurn(t5.id, "late after close", [{ role: "assistant", content: "late", timestamp: 11 }] as never);
eq("late finish keeps closed", [lateClosedFinish, rt.getTurn(t5.id)?.status, worker.status, worker.history.length], [false, "interrupted", "closed", historyAfterInterrupt + 1]);
let closedErr = "";
try { rt.followup(worker.id, { role: "user", content: "y", timestamp: 12 } as never); }
catch (e) { closedErr = (e as Error).message; }
eq("closed rejected", closedErr.includes("closed"), true);

// restore replaces the active branch state, including turns and controllers
const rtRestore = new WorkerRuntime();
const old = rtRestore.spawn({ label: "old", executorModelId: "m", firstMessage: u1 });
const oldController = new AbortController();
rtRestore.trackController(old.turn.id, oldController);
rtRestore.restore([{
  type: "custom",
  customType: "fusion-worker",
  data: {
    worker: { ...old.worker, id: "wrk_restored", status: "closed", activeTurnId: old.turn.id },
    turns: [{ ...old.turn, id: "trn_restored", workerId: "wrk_restored" }],
  },
}]);
eq("restore aborts active controllers", oldController.signal.aborted, true);
eq("restore removes old branch workers", rtRestore.getWorker(old.worker.id), undefined);
eq("restore keeps closed worker", rtRestore.getWorker("wrk_restored")?.status, "closed");
eq("restore keeps turn and interrupts running", rtRestore.getTurn("trn_restored")?.status, "interrupted");

// --- 2. independent compaction ---
const rt2 = new WorkerRuntime();
const w2 = rt2.spawn({ label: undefined, executorModelId: "m", firstMessage: { role: "user", content: "t0", timestamp: 0 } as never }).worker;
for (let i = 0; i < 50; i++) {
  w2.history.push({ role: "assistant", content: `m${i}`, timestamp: i } as never);
}
const didCompact = rt2.compactHistory(w2, 40);
eq("compacted", didCompact, true);
eq("compact keeps first+39", [w2.history.length, (w2.history[0] as {content:string}).content], [40, "t0"]);

const w2Tools = rt2.spawn({ label: undefined, executorModelId: "m", firstMessage: { role: "user", content: "task", timestamp: 0 } as never }).worker;
w2Tools.history.push(
  { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: {} }], timestamp: 1 } as never,
  { role: "toolResult", toolCallId: "old", toolName: "read", content: [{ type: "text", text: "old" }], isError: false, timestamp: 2 } as never,
  { role: "assistant", content: [{ type: "text", text: "old done" }], timestamp: 3 } as never,
  { role: "user", content: "next", timestamp: 4 } as never,
  { role: "assistant", content: [{ type: "toolCall", id: "new", name: "read", arguments: {} }], timestamp: 5 } as never,
  { role: "toolResult", toolCallId: "new", toolName: "read", content: [{ type: "text", text: "new" }], isError: false, timestamp: 6 } as never,
  { role: "assistant", content: [{ type: "text", text: "new done" }], timestamp: 7 } as never,
);
rt2.compactHistory(w2Tools, 7);
eq("compact starts at user handoff", w2Tools.history.map((message) => message.role), ["user", "user", "assistant", "toolResult", "assistant"]);
eq("compact keeps tool pair", (w2Tools.history[3] as { toolCallId: string }).toolCallId, "new");

// --- 3. routing: turn keeps, compaction reconsiders ---
const policy = new AdaptiveRoutingPolicy(
  ["lead:opus", "lead:sonnet"],
  ["exec:mini", "exec:full"],
);
const prev = { main: "lead:opus", sidekick: "exec:mini" };
eq("turn stable", policy.select({ complexity: 0.2, previous: prev, reason: "turn" }), prev);
eq("compaction downgrade cheap", policy.select({ complexity: 0.2, previous: prev, reason: "compaction" }), { main: "lead:sonnet", sidekick: "exec:mini" });
eq("compaction keep on hard", policy.select({ complexity: 0.95, previous: prev, reason: "compaction" }), prev);
eq("failure escalates sidekick", policy.select({ complexity: 0.95, previous: prev, reason: "compaction", sidekickFailures: 2 }), { main: "lead:opus", sidekick: "exec:full" });

// --- 4. handoff framing ---
const h = handoffTaskText(2, "fix auth", "recent ctx");
eq("handoff gen+task", h.includes('generation="2"') && h.includes("fix auth") && h.includes("recent ctx"), true);

// --- 5. config defaults ---
const cfg = applyDefaults({});
eq("defaults", [cfg.executorTools, cfg.maxToolCalls, cfg.maxExecutorOutputTokens, cfg.temperature, cfg.maxHistoryMessages], ["all", 16, 4096, 0.2, 40]);

// --- 6. recent context builder ---
const entries = [
  { type: "message", message: { role: "user", content: "hello" } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
];
eq("recent ctx", buildRecentContext(entries, 4)?.includes("hello"), true);
eq("empty ctx", buildRecentContext([], 4), undefined);

// --- 7. worktree cycle in a temp git repo ---
import { execFile as _execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as _join } from "node:path";
import { promisify as _promisify } from "node:util";
import { createWorktree, execDirOf, mergeWorktree, removeWorktree, validateWorktreeName } from "../src/worktree.ts";
import { resolveToolDefs } from "../src/tools.ts";

const sh = _promisify(_execFile);
async function tgit(cwd: string, args: string[]): Promise<void> {
  await sh("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
}

const shared = mkdtempSync(_join(tmpdir(), "fusion-shared-"));
const isolated = mkdtempSync(_join(tmpdir(), "fusion-isolated-"));
try {
  const tools = resolveToolDefs(["write", "bash"], isolated);
  let sessionReads = 0;
  let sessionCalls = 0;
  const sessionManager = {
    getSessionId: () => { sessionCalls++; return undefined; },
    getSessionFile: () => { sessionCalls++; return undefined; },
  };
  const ctx = {
    get cwd() { return shared; },
    get sessionManager() { sessionReads++; return sessionManager; },
  };
  await tools.find((tool) => tool.name === "write")!.execute("write-cwd", { path: "write-cwd.txt", content: "isolated\n" }, undefined, undefined, ctx);
  await tools.find((tool) => tool.name === "bash")!.execute("bash-cwd", { command: "pwd > bash-cwd.txt" }, undefined, undefined, ctx);
  eq("tools use bound cwd", [readFileSync(_join(isolated, "write-cwd.txt"), "utf8"), readFileSync(_join(isolated, "bash-cwd.txt"), "utf8").trim()], ["isolated\n", realpathSync(isolated)]);
  eq("tool context remains accessible", [sessionReads > 0, sessionCalls > 0], [true, true]);
} finally {
  rmSync(shared, { recursive: true, force: true });
  rmSync(isolated, { recursive: true, force: true });
}

let badName = "";
try { validateWorktreeName("no spaces!"); } catch (e) { badName = (e as Error).message; }
eq("bad worktree name rejected", badName.includes("Invalid"), true);

const repo = mkdtempSync(_join(tmpdir(), "fusion-wt-"));
try {
  await sh("git", ["init", "-b", "main", repo]);
  writeFileSync(_join(repo, "a.txt"), "v1\n");
  await tgit(repo, ["add", "-A"]);
  await tgit(repo, ["commit", "-m", "init"]);
  const wt = await createWorktree(repo, "fix1");
  eq("wt branch", wt.branch, "pi-fusion/fix1");
  eq("wt exec dir", execDirOf(wt), wt.path);
  writeFileSync(_join(execDirOf(wt), "b.txt"), "from-sidekick\n");
  const m = await mergeWorktree(wt, "test");
  eq("merge committed", m.committed, true);
  eq("merged file visible", readFileSync(_join(repo, "b.txt"), "utf8"), "from-sidekick\n");
  // second merge with no changes
  const m2 = await mergeWorktree(wt, "test");
  eq("noop merge", m2.committed, false);
  await removeWorktree(wt);
  const branches = (await sh("git", ["branch", "--list", "pi-fusion/fix1"], { cwd: repo })).stdout.trim();
  eq("branch removed", branches, "");

  const detached = await createWorktree(repo, "detached");
  writeFileSync(_join(detached.path, "detached.txt"), "must-not-commit\n");
  await tgit(detached.path, ["checkout", "--detach"]);
  let detachedErr = "";
  try { await mergeWorktree(detached, "test"); } catch (e) { detachedErr = (e as Error).message; }
  const detachedStatus = (await sh("git", ["status", "--porcelain"], { cwd: detached.path })).stdout.trim();
  eq("detached worktree rejected before staging", [detachedErr.includes("expected"), detachedStatus], [true, "?? detached.txt"]);
  await removeWorktree(detached);

  const pending = await createWorktree(repo, "pending");
  await tgit(pending.path, ["commit", "--allow-empty", "-m", "pending side"]);
  writeFileSync(_join(pending.path, "pending.txt"), "must-not-stage\n");
  await tgit(repo, ["commit", "--allow-empty", "-m", "pending project"]);
  await tgit(repo, ["merge", "--no-ff", "--no-commit", pending.branch]);
  const pendingMergeHead = (await sh("git", ["rev-parse", "MERGE_HEAD"], { cwd: repo })).stdout.trim();
  let pendingErr = "";
  try { await mergeWorktree(pending, "test"); } catch (e) { pendingErr = (e as Error).message; }
  const pendingMergeHeadAfter = (await sh("git", ["rev-parse", "MERGE_HEAD"], { cwd: repo })).stdout.trim();
  const pendingStatus = (await sh("git", ["status", "--porcelain"], { cwd: pending.path })).stdout.trim();
  eq("existing merge preserved", [pendingErr.includes("already has a merge"), pendingMergeHeadAfter, pendingStatus], [true, pendingMergeHead, "?? pending.txt"]);
  await tgit(repo, ["merge", "--abort"]);
  await removeWorktree(pending);

  const race = await createWorktree(repo, "race");
  await tgit(race.path, ["commit", "--allow-empty", "-m", "race side"]);
  const raceHead = (await sh("git", ["rev-parse", race.branch], { cwd: repo })).stdout.trim();
  await tgit(repo, ["commit", "--allow-empty", "-m", "race project"]);
  const realGit = (await sh("sh", ["-c", "command -v git"])).stdout.trim();
  const fakeBin = mkdtempSync(_join(tmpdir(), "fusion-git-"));
  writeFileSync(_join(fakeBin, "git"), `#!/bin/sh
if [ "$1" = merge ] && [ "$2" = --no-edit ] && [ "$3" = ${race.branch} ]; then
  "$PI_FUSION_REAL_GIT" merge --no-ff --no-commit ${race.branch} || exit $?
fi
exec "$PI_FUSION_REAL_GIT" "$@"
`);
  chmodSync(_join(fakeBin, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath}`;
  process.env.PI_FUSION_REAL_GIT = realGit;
  let raceErr = "";
  try { await mergeWorktree(race, "test"); } catch (e) { raceErr = (e as Error).message; }
  finally {
    process.env.PATH = oldPath;
    delete process.env.PI_FUSION_REAL_GIT;
    rmSync(fakeBin, { recursive: true, force: true });
  }
  const raceMergeHead = (await sh("git", ["rev-parse", "MERGE_HEAD"], { cwd: repo })).stdout.trim();
  eq("same-branch competing merge preserved", [raceErr.includes("git merge"), raceMergeHead], [true, raceHead]);
  await tgit(repo, ["merge", "--abort"]);
  await removeWorktree(race);

  writeFileSync(_join(repo, "conflict.txt"), "base\n");
  await tgit(repo, ["add", "conflict.txt"]);
  await tgit(repo, ["commit", "-m", "conflict base"]);
  const conflict = await createWorktree(repo, "conflict");
  writeFileSync(_join(conflict.path, "conflict.txt"), "sidekick\n");
  writeFileSync(_join(repo, "conflict.txt"), "project\n");
  await tgit(repo, ["commit", "-am", "project conflict"]);
  let conflictErr = "";
  try { await mergeWorktree(conflict, "test"); } catch (e) { conflictErr = (e as Error).message; }
  const mergeHead = await sh("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: repo }).then(() => true, () => false);
  const conflictStatus = (await sh("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim();
  eq("conflicting merge aborted", [conflictErr.includes("git merge"), mergeHead, conflictStatus, readFileSync(_join(repo, "conflict.txt"), "utf8")], [true, false, "", "project\n"]);
  await removeWorktree(conflict);
} finally {
  rmSync(repo, { recursive: true, force: true });
}

// --- 8. escalation ladder ---
import { resolveLadder, rungFor } from "../src/models.ts";
eq("rung base", [rungFor(0, 1), rungFor(0, 3)], [0, 0]);
eq("rung climbs", [rungFor(1, 3), rungFor(2, 3)], [1, 2]);
eq("rung pinned", rungFor(9, 3), 2);
eq("rung empty ladder", rungFor(5, 0), 0);
eq("rung negative", rungFor(-2, 3), 0);

type FakeModel = { provider: string; id: string; input: string[] };
const fakeModels: FakeModel[] = [
  { provider: "p", id: "lead", input: ["text"] },
  { provider: "p", id: "flash", input: ["text"] },
  { provider: "p", id: "pro", input: ["text"] },
  { provider: "p", id: "img", input: ["image"] },
];
const stubRegistry = {
  getAll: () => fakeModels,
  getAvailable: () => fakeModels,
  hasConfiguredAuth: (m: FakeModel) => m.id !== "pro", // pro unauthed -> skipped
};
const ladder = resolveLadder(stubRegistry as never, fakeModels[0] as never, "p/flash", ["p/pro", "p/img", "p/flash", "p/nope"], 5, []);
eq("ladder skips unauthed/nontext/missing/dupes", ladder.map((m: FakeModel) => m.id), ["flash"]);
const ladder2 = resolveLadder(
  { ...stubRegistry, hasConfiguredAuth: () => true } as never,
  fakeModels[0] as never, "p/flash", ["p/pro", "p/pro"], 1, [],
);
eq("ladder caps + dedupes", ladder2.map((m: FakeModel) => m.id), ["flash", "pro"]);
const ladder3 = resolveLadder(
  { ...stubRegistry, hasConfiguredAuth: () => true } as never,
  fakeModels[0] as never, "p/flash", ["p/missing", "p/pro"], 1, [],
);
eq("unavailable fallback does not consume rung", ladder3.map((m: FakeModel) => m.id), ["flash", "pro"]);

// failures climb, success resets (WorkerRuntime semantics runTurn relies on)
const rt3 = new WorkerRuntime();
const s3 = rt3.spawn({ label: undefined, executorModelId: "m", firstMessage: { role: "user", content: "t", timestamp: 0 } as never });
rt3.failTurn(s3.turn.id, "boom");
rt3.failTurn(rt3.followup(s3.worker.id, { role: "user", content: "t2", timestamp: 1 } as never).id, "boom2");
eq("failures accumulate", rt3.getWorker(s3.worker.id)?.failures, 2);
eq("rung follows failures", rungFor(rt3.getWorker(s3.worker.id)?.failures ?? 0, 3), 2);
rt3.finishTurn(rt3.followup(s3.worker.id, { role: "user", content: "t3", timestamp: 2 } as never).id, "ok", []);
eq("success resets", rt3.getWorker(s3.worker.id)?.failures, 0);

// config new keys
const cfg2 = applyDefaults({ fallbackExecutors: ["p/pro", "p/pro", ""], maxEscalations: 99 });
eq("config ladder", [cfg2.fallbackExecutors, cfg2.maxEscalations], [["p/pro"], 5]);

// --- 9b. config override ---
import { applyOverride, applyDefaults as _ad } from "../src/config.ts";
eq("leadMutations default", _ad({}).leadMutations, "allow");
eq("leadMutations delegate", _ad({ leadMutations: "delegate" }).leadMutations, "delegate");
eq("leadMutations bogus", _ad({ leadMutations: "sometimes" as unknown as "allow" }).leadMutations, "allow");
eq("override executor", applyOverride({ executor: "a/x" }, { executor: "b/y" }), { executor: "b/y" });
eq("override auto", applyOverride({ executor: "a/x" }, { auto: true }), {});
eq("override empty", applyOverride({ executor: "a/x" }, {}), { executor: "a/x" });
eq("override none", applyOverride({ executor: "a/x" }, undefined), { executor: "a/x" });

// --- 8b. cost accounting ---
import { addUsage, zeroUsage } from "../src/cost.ts";
const c0 = zeroUsage();
const c1 = addUsage(c0, { input: 10, output: 5, totalTokens: 15, cost: { total: 1 } });
const c2 = addUsage(c1, { input: 3, cost: { total: 2 } });
const c3 = addUsage(c2, undefined);
eq("usage sum", c3, { input: 13, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 3 });

// --- 8c. executor dispatches through the configured model registry ---
import { runExecutorTurn } from "../src/llm.ts";
let registryCompleteCalls = 0;
let registryCall: { model?: unknown; options?: Record<string, unknown> } = {};
const registryModel = { provider: "opencode-go", id: "registered", input: ["text"] };
const registrySignal = new AbortController().signal;
const registryResult = await runExecutorTurn(
  {
    complete: async (model: unknown, _context: unknown, options: Record<string, unknown>) => {
      registryCompleteCalls++;
      registryCall = { model, options };
      return {
        role: "assistant",
        content: [{ type: "text", text: "registry ok" }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
  } as never,
  registryModel as never,
  "system",
  [{ role: "user", content: "task", timestamp: 0 }] as never,
  128,
  0.2,
  registrySignal,
  [],
  1,
  { sessionManager: { getSessionId: () => "session-test" } } as never,
);
eq("registry complete dispatch", [
  registryCompleteCalls,
  registryCall.model === registryModel,
  registryCall.options?.signal === registrySignal,
  registryCall.options?.maxTokens,
  registryCall.options?.temperature,
  registryCall.options?.headers,
  registryResult.message.content,
], [1, true, true, 128, 0.2, {
  "x-opencode-session": "session-test",
  "x-opencode-client": "pi",
}, [{ type: "text", text: "registry ok" }]]);

const toolAbort = new AbortController();
let secondToolRuns = 0;
let toolAbortEscaped = false;
try {
  await runExecutorTurn(
    {
      complete: async () => ({
        role: "assistant",
        content: [
          { type: "toolCall", id: "first", name: "first", arguments: {} },
          { type: "toolCall", id: "second", name: "second", arguments: {} },
        ],
        stopReason: "toolUse",
        timestamp: Date.now(),
      }),
    } as never,
    registryModel as never,
    "system",
    [{ role: "user", content: "task", timestamp: 0 }] as never,
    128,
    0.2,
    toolAbort.signal,
    [
      {
        name: "first", description: "first", parameters: {},
        execute: async () => {
          toolAbort.abort();
          return { content: [{ type: "text", text: "done" }], isError: false };
        },
      },
      {
        name: "second", description: "second", parameters: {},
        execute: async () => {
          secondToolRuns++;
          return { content: [{ type: "text", text: "must not run" }], isError: false };
        },
      },
    ] as never,
    2,
    { sessionManager: { getSessionId: () => undefined } } as never,
  );
} catch {
  toolAbortEscaped = true;
}
eq("abort stops later tool calls", [toolAbort.signal.aborted, toolAbortEscaped, secondToolRuns], [true, true, 0]);

// --- 8d. registered tools propagate host cancellation through runTurn ---
const fusionDir = mkdtempSync(_join(tmpdir(), "fusion-cancel-"));
try {
  mkdirSync(_join(fusionDir, ".pi"));
  writeFileSync(_join(fusionDir, ".pi", "fusion.json"), JSON.stringify({ executorTools: "none" }));
  const registered = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  fusionExtension({
    on: () => {},
    registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => registered.set(tool.name, tool),
    registerCommand: () => {},
    appendEntry: () => {},
  } as never);

  const executorModel = { provider: "test", id: "executor", input: ["text"] };
  let availableModels = [executorModel];
  let completeImpl: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => Promise<any> = async () => ({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const context = {
    cwd: fusionDir,
    hasUI: false,
    isProjectTrusted: () => true,
    model: undefined,
    modelRegistry: {
      getAll: () => [executorModel],
      getAvailable: () => availableModels,
      hasConfiguredAuth: () => true,
      complete: (model: unknown, completeContext: unknown, options: { signal?: AbortSignal }) => completeImpl(model, completeContext, options),
    },
    sessionManager: { getBranch: () => [], getSessionId: () => undefined },
  };
  const spawn = registered.get("fusion_spawn")!;
  const followup = registered.get("fusion_followup")!;
  const status = registered.get("fusion_status")!;
  const readStatus = async (id: string) => {
    const result = await status.execute("status", { id }, undefined, undefined, context);
    return JSON.parse(result.content[0].text);
  };

  const initial = await spawn.execute("initial", { task: "start" }, undefined, undefined, context);
  const workerId = initial.details.worker_id as string;
  availableModels = [];
  const preAborted = await followup.execute(
    "pre-aborted",
    { worker_id: workerId, message: "cancelled" },
    AbortSignal.abort(),
    undefined,
    context,
  );
  const preTurnId = preAborted.details.turn_id as string;
  const preTurn = await readStatus(preTurnId);
  const preWorker = await readStatus(workerId);
  eq("pre-aborted followup wins over missing executor", [
    preAborted.details.status,
    preTurn.status,
    preWorker.active_turn,
    preWorker.consecutive_failures,
  ], ["interrupted", "interrupted", null, 0]);

  availableModels = [executorModel];
  let executorSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  completeImpl = async (_model, _completeContext, options) => {
    executorSignal = options.signal;
    return new Promise((_resolve, reject) => {
      if (!executorSignal) {
        markStarted();
        reject(new Error("executor signal missing"));
        return;
      }
      executorSignal.addEventListener("abort", () => reject(executorSignal?.reason), { once: true });
      markStarted();
    });
  };
  const hostController = new AbortController();
  const pendingSpawn = spawn.execute("deferred", { task: "wait" }, hostController.signal, undefined, context);
  await started;
  hostController.abort();
  const deferred = await pendingSpawn;
  const deferredTurnId = deferred.details.turn_id as string;
  const deferredWorkerId = deferred.details.worker_id as string;
  const deferredTurn = await readStatus(deferredTurnId);
  const deferredWorker = await readStatus(deferredWorkerId);
  eq("deferred host abort interrupts running turn", [
    deferred.details.status,
    deferredTurn.status,
    deferredWorker.active_turn,
    deferredWorker.consecutive_failures,
    executorSignal?.aborted,
  ], ["interrupted", "interrupted", null, 0, true]);
} finally {
  rmSync(fusionDir, { recursive: true, force: true });
}

// --- 9. forced mode helpers ---
import { forceFusionPrompt, fusionArgumentCompletions, isForcePrompt, modeLabel, normalizeMode, parseFusionCommand } from "../src/mode.ts";
eq("normalizeMode", [normalizeMode("forced"), normalizeMode("bogus"), normalizeMode(undefined)], ["forced", "available", "available"]);
eq("parse set", parseFusionCommand("on"), { kind: "set", mode: "forced" });
eq("parse off alias", parseFusionCommand("disable"), { kind: "set", mode: "off" });
eq("parse toggle", parseFusionCommand("  "), { kind: "toggle" });
eq("parse once", parseFusionCommand("fix it"), { kind: "once", prompt: "fix it" });
const fp = forceFusionPrompt("do X");
eq("force marker roundtrip", isForcePrompt(fp) && fp.includes("do X") && fp.includes("LEAD"), true);
eq("force idempotent-guard", isForcePrompt("just hello"), false);
eq("completions", fusionArgumentCompletions("o")?.map((c) => c.value), ["on", "off"]);
eq("modeLabel", [modeLabel("forced"), modeLabel("off"), modeLabel("available")], ["Fusion forced", "Fusion off", "Fusion available"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
