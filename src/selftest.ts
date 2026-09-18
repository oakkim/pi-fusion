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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

const lastToolAbort = new AbortController();
let modelRequestsAfterAbort = 0;
let lastToolAbortEscaped = false;
try {
  await runExecutorTurn(
    {
      complete: async () => {
        modelRequestsAfterAbort++;
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "only", name: "only", arguments: {} }],
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
      },
    } as never,
    registryModel as never,
    "system",
    [{ role: "user", content: "task", timestamp: 0 }] as never,
    128,
    0.2,
    lastToolAbort.signal,
    [{
      name: "only", description: "only", parameters: {},
      execute: async () => {
        lastToolAbort.abort();
        return { content: [{ type: "text", text: "done" }], isError: false };
      },
    }] as never,
    2,
    { sessionManager: { getSessionId: () => undefined } } as never,
  );
} catch {
  lastToolAbortEscaped = true;
}
eq("abort after last tool skips next model request", [lastToolAbortEscaped, modelRequestsAfterAbort], [true, 1]);

// --- 8d. registered tools propagate host cancellation through runTurn ---
const fusionDir = mkdtempSync(_join(tmpdir(), "fusion-cancel-"));
try {
  mkdirSync(_join(fusionDir, ".pi"));
  writeFileSync(_join(fusionDir, ".pi", "fusion.json"), JSON.stringify({ executorTools: "none" }));
  writeFileSync(_join(fusionDir, "README.md"), "fixture\n");
  await sh("git", ["init", "-b", "main", fusionDir]);
  await tgit(fusionDir, ["add", "-A"]);
  await tgit(fusionDir, ["commit", "-m", "init"]);
  const registered = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const registeredCommands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const registeredEvents = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const journalEntries: string[] = [];
  const statusCalls: Array<{ key: string; text: string | undefined }> = [];
  const widgetCalls: Array<{ key: string; content: string[] | undefined; options?: { placement?: string } }> = [];
  const notifications: Array<{ text: string; level: string }> = [];
  let footerCalls = 0;
  fusionExtension({
    on: (event: string, handler: (event: any, ctx: any) => Promise<any>) => registeredEvents.set(event, handler),
    registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => registered.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => registeredCommands.set(name, command),
    appendEntry: (type: string) => journalEntries.push(type),
  } as never);

  const executorModel = { provider: "test", id: "executor", input: ["text"] };
  const availableModels = [executorModel];
  let confirmCalls = 0;
  let confirmImpl: () => Promise<boolean> = async () => true;
  let completeImpl: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => Promise<any> = async () => ({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const context = {
    cwd: fusionDir,
    hasUI: true,
    mode: "interactive",
    ui: {
      confirm: () => { confirmCalls++; return confirmImpl(); },
      notify: (text: string, level: string) => notifications.push({ text, level }),
      setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
      setFooter: () => { footerCalls++; },
      setWidget: (key: string, content: string[] | undefined, options?: { placement?: string }) => widgetCalls.push({ key, content, options }),
    },
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
  await registeredEvents.get("session_start")!({}, context);
  eq("fusion uses status without replacing footer", [statusCalls.at(-1)?.key, statusCalls.at(-1)?.text?.startsWith("Fusion available"), footerCalls], ["fusion", true, 0]);

  const spawn = registered.get("fusion_spawn")!;
  const followup = registered.get("fusion_followup")!;
  const status = registered.get("fusion_status")!;
  const close = registered.get("fusion_close")!;
  const watch = registeredCommands.get("fusion-watch")!;
  const readStatus = async (id: string) => {
    const result = await status.execute("status", { id }, undefined, undefined, context);
    return JSON.parse(result.content[0].text);
  };
  const settlesPromptly = async (promise: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout>;
    const settled = await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 100); }),
    ]);
    clearTimeout(timer!);
    return settled;
  };

  const initial = await spawn.execute("initial", { task: "start" }, undefined, undefined, context);
  const workerId = initial.details.worker_id as string;
  const widgetsBeforeUnknown = widgetCalls.length;
  await watch.handler("wrk_missing", context);
  eq("watch rejects unknown worker", [notifications.at(-1)?.level, notifications.at(-1)?.text, widgetCalls.length], ["error", "Worker wrk_missing was not found.", widgetsBeforeUnknown]);
  await watch.handler(workerId, context);
  eq("watch shows worker above editor", [
    widgetCalls.at(-1)?.key,
    widgetCalls.at(-1)?.options?.placement,
    widgetCalls.at(-1)?.content?.join("\n").includes("user:"),
    widgetCalls.at(-1)?.content?.join("\n").includes("assistant: done"),
  ], ["fusion-watch", "aboveEditor", true, true]);
  await watch.handler("off", context);
  eq("watch off clears stable widget", [widgetCalls.at(-1)?.key, widgetCalls.at(-1)?.content], ["fusion-watch", undefined]);
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

  const worktreeSuffix = Date.now().toString(36);
  const preWorktree = `pre-cancel-${worktreeSuffix}`;
  const journalBeforeWorktrees = journalEntries.length;
  let preWorktreeRejected = false;
  try {
    await spawn.execute(
      "pre-worktree",
      { task: "must not start", worktree: preWorktree },
      AbortSignal.abort(),
      undefined,
      context,
    );
  } catch {
    preWorktreeRejected = true;
  }
  const preBranch = (await sh("git", ["branch", "--list", `pi-fusion/${preWorktree}`], { cwd: fusionDir })).stdout.trim();
  eq("pre-aborted spawn creates no worktree", [preWorktreeRejected, preBranch, journalEntries.length], [true, "", journalBeforeWorktrees]);

  const duringWorktree = `during-cancel-${worktreeSuffix}`;
  const hookStarted = _join(fusionDir, "hook-started");
  const hookRelease = _join(fusionDir, "hook-release");
  const postCheckout = _join(fusionDir, ".git", "hooks", "post-checkout");
  writeFileSync(postCheckout, `#!/bin/sh\ntouch ${JSON.stringify(hookStarted)}\nwhile [ ! -f ${JSON.stringify(hookRelease)} ]; do sleep 0.01; done\n`);
  chmodSync(postCheckout, 0o755);
  const worktreeController = new AbortController();
  const pendingWorktree = spawn.execute(
    "during-worktree",
    { task: "must be cleaned", worktree: duringWorktree },
    worktreeController.signal,
    undefined,
    context,
  );
  for (let i = 0; i < 1_000 && !existsSync(hookStarted); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const creationWasPending = existsSync(hookStarted);
  worktreeController.abort();
  writeFileSync(hookRelease, "continue\n");
  let duringWorktreeRejected = false;
  try {
    await pendingWorktree;
  } catch {
    duringWorktreeRejected = true;
  }
  const duringBranch = (await sh("git", ["branch", "--list", `pi-fusion/${duringWorktree}`], { cwd: fusionDir })).stdout.trim();
  const worktreeList = (await sh("git", ["worktree", "list", "--porcelain"], { cwd: fusionDir })).stdout;
  eq("abort during worktree creation cleans checkout and branch", [
    creationWasPending,
    duringWorktreeRejected,
    duringBranch,
    worktreeList.includes(duringWorktree),
    journalEntries.length,
  ], [true, true, "", false, journalBeforeWorktrees]);

  const failedCleanupWorktree = `cleanup-fail-${worktreeSuffix}`;
  const lockStarted = _join(fusionDir, "lock-started");
  const lockRelease = _join(fusionDir, "lock-release");
  writeFileSync(postCheckout, `#!/bin/sh\nprintf test > "$(git rev-parse --git-path locked)"\ntouch ${JSON.stringify(lockStarted)}\nwhile [ ! -f ${JSON.stringify(lockRelease)} ]; do sleep 0.01; done\n`);
  const failedCleanupController = new AbortController();
  const pendingFailedCleanup = spawn.execute(
    "cleanup-failure",
    { task: "surface cleanup failure", worktree: failedCleanupWorktree },
    failedCleanupController.signal,
    undefined,
    context,
  );
  for (let i = 0; i < 1_000 && !existsSync(lockStarted); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const lockWasCreated = existsSync(lockStarted);
  failedCleanupController.abort();
  writeFileSync(lockRelease, "continue\n");
  let cleanupFailure = "";
  try {
    await pendingFailedCleanup;
  } catch (err) {
    cleanupFailure = err instanceof Error ? err.message : String(err);
  }
  const failedBranch = (await sh("git", ["branch", "--list", `pi-fusion/${failedCleanupWorktree}`], { cwd: fusionDir })).stdout.trim();
  const failedWorktreeList = (await sh("git", ["worktree", "list", "--porcelain"], { cwd: fusionDir })).stdout;
  const failedBlock = failedWorktreeList.split("\n\n").find((block) => block.includes(`branch refs/heads/pi-fusion/${failedCleanupWorktree}`));
  const failedPath = failedBlock?.match(/^worktree (.+)$/m)?.[1];
  if (failedPath) {
    await sh("git", ["worktree", "unlock", failedPath], { cwd: fusionDir }).catch(() => undefined);
    await sh("git", ["worktree", "remove", "--force", failedPath], { cwd: fusionDir }).catch(() => undefined);
    await sh("git", ["branch", "-D", `pi-fusion/${failedCleanupWorktree}`], { cwd: fusionDir }).catch(() => undefined);
  }
  eq("cleanup failure is surfaced instead of hidden by abort", [
    lockWasCreated,
    cleanupFailure.includes("Could not remove worktree"),
    failedBranch.length > 0,
    failedWorktreeList.includes(failedCleanupWorktree),
    journalEntries.length,
  ], [true, true, true, true, journalBeforeWorktrees]);

  writeFileSync(_join(fusionDir, ".pi", "fusion.json"), JSON.stringify({ executorTools: "all" }));
  const beforeConsentTests = await readStatus(workerId);
  const journalBeforeConsentTests = journalEntries.length;
  let preFollowupAbort = "";
  try {
    await followup.execute(
      "pre-consent",
      { worker_id: workerId, message: "must not prompt" },
      AbortSignal.abort(),
      undefined,
      context,
    );
  } catch (err) {
    preFollowupAbort = err instanceof Error ? err.name : String(err);
  }
  const afterPreConsent = await readStatus(workerId);
  eq("pre-aborted followup stops before consent and mutation", [
    preFollowupAbort,
    confirmCalls,
    afterPreConsent.generation,
    afterPreConsent.history_messages,
    afterPreConsent.active_turn,
    journalEntries.length,
  ], [
    "AbortError",
    0,
    beforeConsentTests.generation,
    beforeConsentTests.history_messages,
    beforeConsentTests.active_turn,
    journalBeforeConsentTests,
  ]);

  let resolveConsent!: (value: boolean) => void;
  let markDialogOpen!: () => void;
  const dialogOpen = new Promise<void>((resolve) => { markDialogOpen = resolve; });
  confirmImpl = () => new Promise<boolean>((resolve) => {
    resolveConsent = resolve;
    markDialogOpen();
  });
  const consentController = new AbortController();
  const pendingConsent = followup.execute(
    "during-consent",
    { worker_id: workerId, message: "must not append" },
    consentController.signal,
    undefined,
    context,
  );
  await dialogOpen;
  consentController.abort();
  const observedConsent = pendingConsent.then(
    () => "completed",
    (err) => err instanceof Error ? err.name : String(err),
  );
  const consentSettledPromptly = await settlesPromptly(observedConsent);
  resolveConsent(false);
  const duringConsentAbort = await observedConsent;
  const afterDuringConsent = await readStatus(workerId);
  eq("abort during consent wins over decline without mutation", [
    consentSettledPromptly,
    duringConsentAbort,
    confirmCalls,
    afterDuringConsent.generation,
    afterDuringConsent.history_messages,
    afterDuringConsent.active_turn,
    journalEntries.length,
  ], [
    true,
    "AbortError",
    1,
    beforeConsentTests.generation,
    beforeConsentTests.history_messages,
    beforeConsentTests.active_turn,
    journalBeforeConsentTests,
  ]);

  confirmImpl = async () => true;
  let finishFirst!: (message: unknown) => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let providerCallsWhileQueued = 0;
  const completedMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    timestamp: Date.now(),
  };
  completeImpl = async () => {
    providerCallsWhileQueued++;
    if (providerCallsWhileQueued > 1) return completedMessage;
    return new Promise((resolve) => {
      finishFirst = resolve;
      markFirstStarted();
    });
  };
  let firstFinished = false;
  const firstMutating = spawn.execute("queue-first", { task: "hold queue" }, undefined, undefined, context)
    .finally(() => { firstFinished = true; });
  await firstStarted;

  let markSecondQueued!: () => void;
  const secondQueued = new Promise<void>((resolve) => { markSecondQueued = resolve; });
  const queuedController = new AbortController();
  const secondMutating = spawn.execute(
    "queue-second",
    { task: "cancel while queued" },
    queuedController.signal,
    () => markSecondQueued(),
    context,
  );
  await secondQueued;
  queuedController.abort();
  const queuedSettledPromptly = await settlesPromptly(secondMutating);
  if (!queuedSettledPromptly) finishFirst(completedMessage);
  const queuedResult = await secondMutating;
  const queuedTurn = await readStatus(queuedResult.details.turn_id as string);
  const queuedWorker = await readStatus(queuedResult.details.worker_id as string);
  eq("queued mutating abort settles before active run", [
    queuedSettledPromptly,
    firstFinished,
    queuedResult.details.status,
    queuedTurn.status,
    queuedWorker.active_turn,
    queuedWorker.consecutive_failures,
    providerCallsWhileQueued,
  ], [true, false, "interrupted", "interrupted", null, 0, 1]);
  finishFirst(completedMessage);
  await firstMutating;

  await watch.handler(workerId, context);
  let watchProviderCalls = 0;
  completeImpl = async () => {
    watchProviderCalls++;
    if (watchProviderCalls === 1) {
      return {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "SECRET_REASONING" },
          { type: "text", text: "watch working" },
          { type: "toolCall", id: "watch-tool", name: "missing_tool", arguments: { path: "x" } },
        ],
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
    }
    return {
      role: "assistant",
      content: [{ type: "text", text: "watch finished" }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
  };
  const liveWidgetStart = widgetCalls.length;
  const watchedFollowup = await followup.execute("watch-live", { worker_id: workerId, message: "show progress" }, undefined, undefined, context);
  const liveWidgetText = widgetCalls.slice(liveWidgetStart).flatMap((call) => call.content ?? []).join("\n");
  eq("watch refreshes for assistant and tool results without thinking", [
    watchedFollowup.details.status,
    liveWidgetText.includes("assistant: watch working"),
    liveWidgetText.includes("tool missing_tool:"),
    liveWidgetText.includes("result missing_tool:"),
    liveWidgetText.includes("assistant: watch finished"),
    liveWidgetText.includes("SECRET_REASONING"),
  ], ["ok", true, true, true, true, false]);

  await close.execute("close-watched", { worker_id: workerId }, undefined, undefined, context);
  eq("closing watched worker clears widget", [widgetCalls.at(-1)?.key, widgetCalls.at(-1)?.content], ["fusion-watch", undefined]);

  await watch.handler(deferredWorkerId, context);
  const widgetsBeforeNonUi = widgetCalls.length;
  await watch.handler("off", { ...context, hasUI: false, mode: "rpc" });
  eq("watch gives non-UI guidance without widget call", [notifications.at(-1)?.text, widgetCalls.length], ["Fusion watch is available only in the interactive UI.", widgetsBeforeNonUi]);

  await registeredEvents.get("session_tree")!({}, { ...context, sessionManager: { getBranch: () => [], getSessionId: () => undefined } });
  eq("session restore clears missing watched worker", [widgetCalls.at(-1)?.key, widgetCalls.at(-1)?.content], ["fusion-watch", undefined]);
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
