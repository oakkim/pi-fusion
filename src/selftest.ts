/** v0 self-test: no LLM calls. Verifies the persistence core. */
import { WorkerRuntime } from "../src/runtime.ts";
import { InquiryRuntime } from "../src/inquiry.ts";
import { AdaptiveRoutingPolicy } from "../src/routing.ts";
import { handoffTaskText } from "../src/prompts.ts";
import { applyDefaults } from "../src/config.ts";
import { buildRecentContext, latestUserText } from "../src/utils.ts";
import fusionExtension, { deriveWorkerContextTelemetry, executorUsesSubscription, formatElapsedDuration, formatLiveStatusAction, formatToolStatusAction } from "../src/index.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { extractHandoffTask, formatPaneHistory, formatPaneTranscript, FusionPaneController, renderWorkerPane, type LiveActivity, type LiveProgress } from "../src/pane.ts";
import { buildMonitorLaunchPlan, FusionMonitorPublisher, isMonitorOwnerAlive, parseMonitorSnapshot, renderMonitorScreen, sanitizeMonitorText, shouldTerminateMonitor, type MonitorSnapshot } from "../src/monitor.ts";

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

// --- 1b. read-only inquiry threads stay separate from worker history ---
const inquiryRuntime = new InquiryRuntime();
const inquiryThread = inquiryRuntime.create(worker.id);
const inquiryQuestion = { role: "user", content: "what are you doing?", timestamp: 20 } as never;
const inquiryTurn = inquiryRuntime.start(inquiryThread.id, inquiryQuestion, { workerGeneration: 5, workerTurnId: "trn_live", capturedAt: 21 });
eq("inquiry ids and snapshot", [inquiryThread.id.startsWith("inq_"), inquiryTurn.id.startsWith("iqt_"), inquiryTurn.workerGeneration, inquiryTurn.workerTurnId], [true, true, 5, "trn_live"]);
let inquiryBusyError = "";
try { inquiryRuntime.start(inquiryThread.id, inquiryQuestion, { workerGeneration: 5, workerTurnId: "trn_live" }); }
catch (err) { inquiryBusyError = err instanceof Error ? err.message : String(err); }
eq("inquiry rejects overlapping question", inquiryBusyError.includes("busy"), true);
inquiryRuntime.finish(inquiryTurn.id, "editing the status line", { role: "assistant", content: "editing the status line", timestamp: 22 } as never);
eq("inquiry history is sidecar only", [inquiryThread.history.length, worker.history.includes(inquiryQuestion), inquiryThread.activeTurnId], [2, false, null]);
const inquiryNext = inquiryRuntime.start(inquiryThread.id, { role: "user", content: "what remains?", timestamp: 23 } as never, { workerGeneration: 6, workerTurnId: null });
const inquirySnapshot = inquiryRuntime.snapshot(inquiryThread.id)[0]!;
const restoredInquiries = new InquiryRuntime();
restoredInquiries.restore([{ type: "custom", customType: "fusion-inquiry", data: inquirySnapshot }]);
eq("inquiry restore interrupts active side query", [restoredInquiries.getThread(inquiryThread.id)?.activeTurnId, restoredInquiries.getTurn(inquiryNext.id)?.status, restoredInquiries.getThread(inquiryThread.id)?.history.length], [null, "interrupted", 2]);

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
w2Tools.telemetry = { cumulative: zeroUsage(), context: { known: true, tokens: 100, window: 1_000 }, automaticCompaction: true };
rt2.compactHistory(w2Tools, 4);
eq("compaction marks context unknown", w2Tools.telemetry.context, { known: false, window: 1_000 });
const legacyRuntime = new WorkerRuntime();
legacyRuntime.restore([
  { type: "custom", customType: "fusion-cost", data: { worker_id: "wrk_legacy", executor: "provider/legacy", usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16, cost: { total: 0.5 } } } },
  { type: "custom", customType: "fusion-cost", data: { worker_id: "wrk_legacy", executor: "provider/legacy", usage: { input: 4, output: 1, totalTokens: 5, cost: { total: 0.25 } } } },
  { type: "custom", customType: "fusion-worker", data: { worker: { id: "wrk_legacy", label: "legacy", executorModelId: "provider/legacy", history: [{ role: "user", content: "old", timestamp: 1 }, { role: "assistant", content: "old done", usage: { input: 1, cacheRead: 99, totalTokens: 100, cost: { total: 0.01 } }, stopReason: "stop", timestamp: 2 }], generation: 1, status: "idle", activeTurnId: null, failures: 0, createdAt: 1 }, turns: [] } },
]);
eq("legacy telemetry restored from cost entries", [legacyRuntime.getWorker("wrk_legacy")?.telemetry?.cumulative, legacyRuntime.getWorker("wrk_legacy")?.telemetry?.latestExecutor, legacyRuntime.getWorker("wrk_legacy")?.telemetry?.latest], [{ input: 14, output: 3, cacheRead: 3, cacheWrite: 1, totalTokens: 21, cost: 0.75 }, "provider/legacy", { input: 1, output: 0, cacheRead: 99, cacheWrite: 0, totalTokens: 100, cost: 0.01 }]);

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
const localizedHandoff = handoffTaskText(1, "inspect", undefined, undefined, "지금 <상태>를 보여줘");
eq("handoff carries latest user language sample", [localizedHandoff.includes("지금 &lt;상태&gt;를 보여줘"), localizedHandoff.includes("same natural language")], [true, true]);

// --- 5. config defaults ---
const cfg = applyDefaults({});
eq("defaults", [cfg.executorTools, cfg.maxToolCalls, cfg.maxExecutorOutputTokens, cfg.temperature, cfg.thinkingLevel, cfg.fastMode, cfg.maxHistoryMessages], ["all", 1024, 4096, 0.2, "off", false, 40]);

// --- 6. recent context builder ---
const entries = [
  { type: "message", message: { role: "user", content: "hello" } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
];
eq("recent ctx", buildRecentContext(entries, 4)?.includes("hello"), true);
eq("empty ctx", buildRecentContext([], 4), undefined);
eq("latest user language sample", latestUserText([...entries, { type: "message", message: { role: "user", content: "한국어로 답해줘" } }], "fallback"), "한국어로 답해줘");

// --- 7. worktree cycle in a temp git repo ---
import { execFile as _execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as _join } from "node:path";
import { promisify as _promisify } from "node:util";
import { createWorktree, execDirOf, mergeWorktree, removeWorktree, validateWorktreeName } from "../src/worktree.ts";
import { clampMaxToolCalls, resolveToolDefs } from "../src/tools.ts";
eq("tool budget default and clamp", [clampMaxToolCalls(undefined), clampMaxToolCalls(2048), clampMaxToolCalls(0)], [1024, 1024, 1]);

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
const cfg2 = applyDefaults({ fallbackExecutors: ["p/pro", "p/pro", ""], maxEscalations: 99, fastMode: true });
eq("config ladder and fast mode", [cfg2.fallbackExecutors, cfg2.maxEscalations, cfg2.fastMode], [["p/pro"], 5, true]);

// --- 9b. config override ---
import { applyConsentOverride, applyFastModeOverride, applyOverride, applyThinkingOverride, applyDefaults as _ad, loadGlobalConfig } from "../src/config.ts";
eq("leadMutations default", _ad({}).leadMutations, "allow");
eq("leadMutations delegate", _ad({ leadMutations: "delegate" }).leadMutations, "delegate");
eq("leadMutations bogus", _ad({ leadMutations: "sometimes" as unknown as "allow" }).leadMutations, "allow");
eq("override executor", applyOverride({ executor: "a/x" }, { executor: "b/y" }), { executor: "b/y" });
eq("override auto", applyOverride({ executor: "a/x" }, { auto: true }), {});
eq("override empty", applyOverride({ executor: "a/x" }, {}), { executor: "a/x" });
eq("override none", applyOverride({ executor: "a/x" }, undefined), { executor: "a/x" });
eq("thinking config", [_ad({ thinkingLevel: "high" }).thinkingLevel, _ad({ thinkingLevel: "bogus" as never }).thinkingLevel], ["high", "off"]);
eq("thinking override", applyThinkingOverride({ thinkingLevel: "low" }, { thinkingLevel: "xhigh" }), { thinkingLevel: "xhigh" });
eq("thinking override clear", applyThinkingOverride({ thinkingLevel: "low" }, {}), { thinkingLevel: "low" });
eq("fast override on", applyFastModeOverride({ fastMode: false }, { fastMode: true }), { fastMode: true });
eq("fast override off", applyFastModeOverride({ fastMode: true }, { fastMode: false }), { fastMode: false });
eq("fast override clear", applyFastModeOverride({ fastMode: true }, {}), { fastMode: true });
eq("consent override allow", applyConsentOverride({ executorToolsConsent: false }, { executorToolsConsent: true }), { executorToolsConsent: true });
eq("consent override ask", applyConsentOverride({ executorToolsConsent: true }, { executorToolsConsent: false }), { executorToolsConsent: false });
eq("consent override clear", applyConsentOverride({ executorToolsConsent: true }, {}), { executorToolsConsent: true });

// --- 8b. cost accounting ---
import { addUsage, formatCompactTokens, formatUsageFooter, zeroUsage } from "../src/cost.ts";
const c0 = zeroUsage();
const c1 = addUsage(c0, { input: 10, output: 5, totalTokens: 15, cost: { total: 1 } });
const c2 = addUsage(c1, { input: 3, cost: { total: 2 } });
const c3 = addUsage(c2, undefined);
eq("usage sum", c3, { input: 13, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 3 });
eq("Pi compact token formatter", [
  formatCompactTokens(999), formatCompactTokens(1_000), formatCompactTokens(9_999),
  formatCompactTokens(10_000), formatCompactTokens(1_000_000), formatCompactTokens(10_000_000),
], ["999", "1.0k", "10.0k", "10k", "1.0M", "10M"]);
eq("Pi usage footer semantics", formatUsageFooter({
  input: 3_500_000, output: 449_000, cacheRead: 117_000_000, cacheWrite: 272_000,
  totalTokens: 0, cost: 89.7, latest: { input: 3, cacheRead: 997, cacheWrite: 0 },
  contextTokens: 82_416, contextWindow: 272_000, contextKnown: true,
  subscription: true, automaticCompaction: true,
}), "↑3.5M ↓449k R117M W272k CH99.7% $89.700 (sub) 30.3%/272k (auto)");
eq("unknown usage footer", formatUsageFooter({ ...zeroUsage(), automaticCompaction: true }), "?/? (auto)");
const contextFromUsage = deriveWorkerContextTelemetry([
  { role: "user", content: "task", timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total: 0 } }, stopReason: "stop", timestamp: 2 },
  { role: "user", content: "trailing context", timestamp: 3 },
] as never, 272_000);
const ignoredErrorContext = deriveWorkerContextTelemetry([
  { role: "assistant", content: [{ type: "text", text: "failed" }], usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 1_998, cost: { total: 0 } }, stopReason: "error", timestamp: 4 },
] as never, 272_000);
eq("context derives usage plus trailing estimates", [contextFromUsage.known, contextFromUsage.tokens! > 125, contextFromUsage.window], [true, true, 272_000]);
eq("context skips failed provider usage", ignoredErrorContext, { known: false, window: 272_000 });
const subscriptionModel = { provider: "dual-provider", id: "model", input: ["text"] };
const subscriptionRegistry = {
  getAll: () => [subscriptionModel],
  isUsingOAuth: () => false,
  getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
};
const oauthSubscriptionRegistry = { ...subscriptionRegistry, isUsingOAuth: () => true };
const kimiRegistry = { getAll: () => [{ provider: "kimi-coding", id: "kimi", input: ["text"] }], isUsingOAuth: () => false, getProvider: () => undefined };
eq("subscription marker follows auth source", [
  executorUsesSubscription(subscriptionRegistry as never, "dual-provider/model"),
  executorUsesSubscription(oauthSubscriptionRegistry as never, "dual-provider/model"),
  executorUsesSubscription(kimiRegistry as never, "kimi-coding/kimi"),
], [false, true, true]);

// --- 8c. executor dispatches through the configured model registry ---
import { getSupportsTemperature, runExecutorTurn, supportsOpenAIFastMode } from "../src/llm.ts";
eq("temperature compatibility", [
  getSupportsTemperature({ api: "openai-codex-responses", reasoning: false } as never),
  getSupportsTemperature({ api: "openai-responses", reasoning: true } as never),
  getSupportsTemperature({ api: "openai-responses", reasoning: false } as never),
  getSupportsTemperature({ api: "anthropic-messages", reasoning: false, compat: { supportsTemperature: false } } as never),
], [false, false, true, false]);
eq("OpenAI fast-mode support", [
  supportsOpenAIFastMode({ provider: "openai-codex", api: "openai-codex-responses" } as never),
  supportsOpenAIFastMode({ provider: "openai", api: "openai-responses" } as never),
  supportsOpenAIFastMode({ provider: "github-copilot", api: "openai-responses" } as never),
  supportsOpenAIFastMode({ provider: "openai", api: "openai-completions" } as never),
], [true, true, false, false]);
const resultStream = (result: unknown | Promise<unknown>) => ({ result: () => Promise.resolve(result) });
let registryCompleteCalls = 0;
let registryCall: { model?: unknown; options?: Record<string, unknown> } = {};
const registryModel = { provider: "opencode-go", id: "registered", api: "openai-codex-responses", input: ["text"], reasoning: true };
const registrySignal = new AbortController().signal;
const registryResult = await runExecutorTurn(
  {
    streamSimple: (model: unknown, _context: unknown, options: Record<string, unknown>) => {
      registryCompleteCalls++;
      registryCall = { model, options };
      return resultStream({
        role: "assistant",
        content: [{ type: "text", text: "registry ok" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
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
  "high",
  undefined,
  undefined,
  true,
);
eq("registry streamSimple dispatch", [
  registryCompleteCalls,
  registryCall.model === registryModel,
  registryCall.options?.signal === registrySignal,
  registryCall.options?.maxTokens,
  registryCall.options?.temperature,
  registryCall.options?.reasoning,
  registryCall.options?.serviceTier === undefined,
  registryCall.options?.headers,
  registryResult.message.content,
], [1, true, true, 128, undefined, "high", true, {
  "x-opencode-session": "session-test",
  "x-opencode-client": "pi",
}, [{ type: "text", text: "registry ok" }]]);

let fastStreamCalls = 0;
let fastSimpleCalls = 0;
let fastRequestOptions: Record<string, unknown> = {};
let fastRequestContext: { tools?: Array<{ name: string }> } = {};
const fastModel = { provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-codex-responses", input: ["text"], reasoning: true };
const fastResult = await runExecutorTurn(
  {
    stream: (_model: unknown, completeContext: { tools?: Array<{ name: string }> }, options: Record<string, unknown>) => {
      fastStreamCalls++;
      fastRequestContext = completeContext;
      fastRequestOptions = options;
      return resultStream({
        role: "assistant",
        content: [{ type: "text", text: "fast response" }],
        stopReason: "stop",
        timestamp: Date.now(),
      });
    },
    streamSimple: () => {
      fastSimpleCalls++;
      throw new Error("fast mode must use the full provider stream");
    },
  } as never,
  fastModel as never,
  "system",
  [{ role: "user", content: "task", timestamp: 0 }] as never,
  128,
  0.2,
  registrySignal,
  [{ name: "probe", description: "probe", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "unused" }] }) }] as never,
  1,
  { sessionManager: { getSessionId: () => undefined } } as never,
  "high",
  undefined,
  undefined,
  true,
);
eq("fast mode uses OpenAI priority stream", [
  fastStreamCalls,
  fastSimpleCalls,
  fastRequestOptions.serviceTier,
  fastRequestOptions.reasoningEffort,
  fastRequestOptions.reasoning,
  fastRequestContext.tools?.map((tool) => tool.name),
  fastResult.message.content,
], [1, 0, "priority", "high", "high", ["probe"], [{ type: "text", text: "fast response" }]]);

let fastCompleteOptions: Record<string, unknown> = {};
await runExecutorTurn(
  {
    complete: async (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
      fastCompleteOptions = options;
      return {
        role: "assistant",
        content: [{ type: "text", text: "legacy fast response" }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
  } as never,
  fastModel as never,
  "system",
  [{ role: "user", content: "task", timestamp: 0 }] as never,
  128,
  0.2,
  registrySignal,
  [],
  1,
  { sessionManager: { getSessionId: () => undefined } } as never,
  "high",
  undefined,
  undefined,
  true,
);
eq("fast mode complete fallback keeps provider options", [fastCompleteOptions.serviceTier, fastCompleteOptions.reasoningEffort], ["priority", "high"]);

const streamAssistant = (content: unknown[], stopReason = "pending") => ({
  role: "assistant",
  content,
  stopReason,
  timestamp: Date.now(),
} as never);
const pushedStream = (events: unknown[]) => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) stream.push(event as never);
  });
  return stream;
};
const streamProgress: LiveProgress[] = [];
const streamPartial = streamAssistant([{ type: "thinking", thinking: "private chain of thought" }, { type: "text", text: "" }]);
const streamedResult = await runExecutorTurn(
  {
    streamSimple: () => pushedStream([
      { type: "start", partial: streamPartial },
      { type: "thinking_start", contentIndex: 0, partial: streamPartial },
      { type: "thinking_delta", contentIndex: 0, delta: "private chain of thought", partial: streamPartial },
      { type: "thinking_end", contentIndex: 0, content: "private chain of thought", partial: streamPartial },
      { type: "text_start", contentIndex: 1, partial: streamPartial },
      { type: "text_delta", contentIndex: 1, delta: "visible answer", partial: streamAssistant([{ type: "thinking", thinking: "private chain of thought" }, { type: "text", text: "visible answer" }]) },
      { type: "text_end", contentIndex: 1, content: "visible answer", partial: streamAssistant([{ type: "thinking", thinking: "private chain of thought" }, { type: "text", text: "visible answer" }]) },
      { type: "done", reason: "stop", message: streamAssistant([{ type: "thinking", thinking: "private chain of thought" }, { type: "text", text: "visible answer" }], "stop") },
    ]),
  } as never,
  registryModel as never,
  "system",
  [{ role: "user", content: "task", timestamp: 0 }] as never,
  128,
  0.2,
  registrySignal,
  [],
  1,
  { sessionManager: { getSessionId: () => undefined } } as never,
  "high",
  (progress) => streamProgress.push(progress),
);
const streamProgressJson = JSON.stringify(streamProgress);
eq("stream progress events", [
  streamProgress.some((progress) => progress.kind === "phase" && progress.phase === "thinking"),
  streamProgress.some((progress) => progress.kind === "phase" && progress.phase === "responding" && progress.text?.includes("visible answer")),
  streamedResult.message.content,
], [true, true, [{ type: "thinking", thinking: "private chain of thought" }, { type: "text", text: "visible answer" }]]);
eq("stream thinking hidden", [streamProgressJson.includes("private chain of thought"), streamProgressJson.includes("visible answer")], [false, true]);

let toolStreamCalls = 0;
const toolProgress: LiveProgress[] = [];
const toolResult = await runExecutorTurn(
  {
    streamSimple: () => {
      toolStreamCalls++;
      if (toolStreamCalls === 1) {
        const partial = streamAssistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }]);
        return pushedStream([
          { type: "start", partial },
          { type: "toolcall_start", contentIndex: 0, partial },
          { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"echo hi"}', partial: streamAssistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } }]) },
          { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } }, partial },
          { type: "done", reason: "toolUse", message: streamAssistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } }], "toolUse") },
        ]);
      }
      return pushedStream([
        { type: "start", partial: streamAssistant([]) },
        { type: "text_start", contentIndex: 0, partial: streamAssistant([{ type: "text", text: "" }]) },
        { type: "text_delta", contentIndex: 0, delta: "finished", partial: streamAssistant([{ type: "text", text: "finished" }]) },
        { type: "done", reason: "stop", message: streamAssistant([{ type: "text", text: "finished" }], "stop") },
      ]);
    },
  } as never,
  registryModel as never,
  "system",
  [{ role: "user", content: "task", timestamp: 0 }] as never,
  128,
  0.2,
  registrySignal,
  [{
    name: "bash", description: "bash", parameters: {},
    execute: async (_id, _args, _signal, onUpdate) => {
      onUpdate?.({ content: [{ type: "text", text: "partial output" }], details: undefined });
      return { content: [{ type: "text", text: "final output" }], isError: false };
    },
  }],
  2,
  { sessionManager: { getSessionId: () => undefined } } as never,
  "off",
  (progress) => toolProgress.push(progress),
);
const nonemptyStreamedToolArgs = toolProgress
  .filter((progress): progress is Extract<LiveProgress, { kind: "tool_start" }> => progress.kind === "tool_start" && progress.arguments.length > 0)
  .map((progress) => progress.arguments);
eq("live tool lifecycle", [
  toolResult.message.content,
  nonemptyStreamedToolArgs.length > 0 && nonemptyStreamedToolArgs.every((args) => args === '{"command":"echo hi"}'),
  toolProgress.some((progress) => progress.kind === "tool_update" && progress.output === "partial output"),
  toolProgress.some((progress) => progress.kind === "tool_end" && progress.toolId === "call-1" && progress.ok && progress.output === "final output"),
], [[{ type: "text", text: "finished" }], true, true, true]);

let steeringToolRan = false;
let steeringDelivered = false;
let steeringModelCalls = 0;
let steeringSeenByModel = false;
const steeringResult = await runExecutorTurn(
  {
    streamSimple: (_model: unknown, context: unknown) => {
      steeringModelCalls++;
      if (steeringModelCalls === 1) {
        return resultStream(streamAssistant([{ type: "toolCall", id: "steer-tool", name: "probe", arguments: {} }], "toolUse"));
      }
      steeringSeenByModel = JSON.stringify(context).includes("change target to bravo");
      return resultStream(streamAssistant([{ type: "text", text: "integrated update" }], "stop"));
    },
  } as never,
  registryModel as never,
  "system",
  [{ role: "user", content: "initial task", timestamp: 0 }] as never,
  128,
  0.2,
  registrySignal,
  [{
    name: "probe", description: "probe", parameters: {},
    execute: async () => {
      steeringToolRan = true;
      return { content: [{ type: "text", text: "probe done" }], isError: false };
    },
  }] as never,
  2,
  { sessionManager: { getSessionId: () => undefined } } as never,
  "off",
  undefined,
  () => {
    if (!steeringToolRan || steeringDelivered) return [];
    steeringDelivered = true;
    return [{ role: "user", content: "change target to bravo", timestamp: Date.now() }] as never;
  },
);
eq("steering injects after tool batch", [
  steeringModelCalls,
  steeringSeenByModel,
  steeringResult.added.map((message) => message.role),
  steeringResult.message.content,
], [2, true, ["assistant", "toolResult", "user", "assistant"], [{ type: "text", text: "integrated update" }]]);

let lateSteeringCalls = 0;
let firstFinalReturned = false;
let lateSteeringDelivered = false;
let lateSteeringSeen = false;
const lateSteeringResult = await runExecutorTurn(
  {
    streamSimple: (_model: unknown, context: unknown) => {
      lateSteeringCalls++;
      if (lateSteeringCalls === 1) {
        firstFinalReturned = true;
        return resultStream(streamAssistant([{ type: "text", text: "old final" }], "stop"));
      }
      lateSteeringSeen = JSON.stringify(context).includes("add regression test");
      return resultStream(streamAssistant([{ type: "text", text: "revised final" }], "stop"));
    },
  } as never,
  registryModel as never,
  "system",
  [{ role: "user", content: "initial task", timestamp: 0 }] as never,
  128,
  0.2,
  registrySignal,
  [],
  2,
  { sessionManager: { getSessionId: () => undefined } } as never,
  "off",
  undefined,
  () => {
    if (!firstFinalReturned || lateSteeringDelivered) return [];
    lateSteeringDelivered = true;
    return [{ role: "user", content: "add regression test", timestamp: Date.now() }] as never;
  },
);
eq("steering revises a just-finished response", [
  lateSteeringCalls,
  lateSteeringSeen,
  lateSteeringResult.added.map((message) => message.role),
  lateSteeringResult.message.content,
], [2, true, ["assistant", "user", "assistant"], [{ type: "text", text: "revised final" }]]);

const toolAbort = new AbortController();
let secondToolRuns = 0;
let toolAbortEscaped = false;
try {
  await runExecutorTurn(
    {
      streamSimple: () => resultStream({
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
      streamSimple: () => {
        modelRequestsAfterAbort++;
        return resultStream({
          role: "assistant",
          content: [{ type: "toolCall", id: "only", name: "only", arguments: {} }],
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
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

// --- 8d. registered tools launch detached background turns safely ---
const fusionDir = mkdtempSync(_join(tmpdir(), "fusion-cancel-"));
try {
  mkdirSync(_join(fusionDir, ".pi"));
  writeFileSync(_join(fusionDir, ".pi", "fusion.json"), JSON.stringify({ executorTools: "none" }));
  writeFileSync(_join(fusionDir, "README.md"), "fixture\n");
  await sh("git", ["init", "-b", "main", fusionDir]);
  await tgit(fusionDir, ["add", "-A"]);
  await tgit(fusionDir, ["commit", "-m", "init"]);
  const registered = new Map<string, { execute: (...args: any[]) => Promise<any>; renderCall?: (...args: any[]) => any }>();
  const lifecycleHandlers = new Map<string, (...args: any[]) => Promise<void>>();
  const journalEntries: string[] = [];
  const completionMessages: Array<{ message: any; options: any }> = [];
  fusionExtension({
    on: (event: string, handler: (...args: any[]) => Promise<void>) => lifecycleHandlers.set(event, handler),
    registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any>; renderCall?: (...args: any[]) => any }) => registered.set(tool.name, tool),
    registerCommand: () => {},
    appendEntry: (type: string) => journalEntries.push(type),
    sendMessage: (message: any, options: any) => completionMessages.push({ message, options }),
  } as never);

  const executorModel = { provider: "test", id: "executor", input: ["text"] };
  const availableModels = [executorModel];
  let confirmCalls = 0;
  let customCalls = 0;
  let fusionStatusLine = "";
  let confirmImpl: () => Promise<boolean> = async () => true;
  let completeImpl: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => Promise<any> = async () => ({
    role: "assistant",
    content: [{ type: "thinking", thinking: "private worker reasoning" }, { type: "text", text: "done" }],
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const context = {
    cwd: fusionDir,
    mode: "tui",
    hasUI: true,
    ui: {
      confirm: () => { confirmCalls++; return confirmImpl(); },
      custom: () => { customCalls++; return Promise.resolve(); },
      setStatus: (_key: string, text: string) => { fusionStatusLine = text; },
    },
    isProjectTrusted: () => true,
    model: undefined,
    modelRegistry: {
      getAll: () => [executorModel],
      getAvailable: () => availableModels,
      hasConfiguredAuth: () => true,
      streamSimple: (model: unknown, completeContext: unknown, options: { signal?: AbortSignal }) => resultStream(completeImpl(model, completeContext, options)),
    },
    sessionManager: { getBranch: () => [], getSessionId: () => undefined },
  };
  await lifecycleHandlers.get("session_start")?.({}, context);
  const spawn = registered.get("fusion_spawn")!;
  const followup = registered.get("fusion_followup")!;
  const ask = registered.get("fusion_ask")!;
  const status = registered.get("fusion_status")!;
  const interrupt = registered.get("fusion_interrupt")!;
  const plainTheme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  };
  const renderCallText = (tool: { renderCall?: (...args: any[]) => any }, args: unknown, expanded = false) => {
    const component = tool.renderCall?.(args, plainTheme, { expanded });
    return component?.render(200).map((line: string) => line.trimEnd()).join("\n") ?? "";
  };
  const spawnCallText = renderCallText(spawn, {
    task: "Add the request renderer\nand run npm test",
    label: "call UI",
    worktree: "render-call",
    context_mode: "recent",
  });
  const followupCallText = renderCallText(followup, {
    worker_id: "wrk_visible",
    message: "Also cover the collapsed view",
    when_busy: "queue",
  });
  const expandedSpawnCallText = renderCallText(spawn, { task: "first line\nsecond line" }, true);
  const sanitizedFollowupCallText = renderCallText(followup, {
    worker_id: "wrk_safe",
    message: "visible\u001b]2;INJECTED\u0007 request",
  });
  const partialSpawnCallText = renderCallText(spawn, null);
  const partialFollowupCallText = renderCallText(followup, { worker_id: "wrk_partial" });
  const clippedSpawnCallText = renderCallText(spawn, { task: "x".repeat(300) });
  const clippedExpandedSpawnCallText = renderCallText(spawn, { task: "y".repeat(8_100) }, true);
  eq("spawn call renderer shows request and routing metadata", [
    spawnCallText.includes("Fusion Spawn"),
    spawnCallText.includes("task: Add the request renderer and run npm test"),
    spawnCallText.includes("label=call UI"),
    spawnCallText.includes("worktree=render-call"),
    spawnCallText.includes("context=recent"),
  ], [true, true, true, true, true]);
  eq("followup call renderer shows message and delivery mode", [
    followupCallText.includes("Fusion Followup"),
    followupCallText.includes("message: Also cover the collapsed view"),
    followupCallText.includes("worker=wrk_visible"),
    followupCallText.includes("when_busy=queue"),
  ], [true, true, true, true]);
  eq("expanded spawn call preserves multiline request", expandedSpawnCallText.includes("first line\nsecond line"), true);
  eq("call renderer strips terminal controls", [sanitizedFollowupCallText.includes("\u001b]"), sanitizedFollowupCallText.includes("INJECTED")], [false, false]);
  eq("call renderers tolerate partial streamed arguments", [
    partialSpawnCallText.includes("task: …"),
    partialFollowupCallText.includes("message: …"),
    partialFollowupCallText.includes("worker=wrk_partial"),
    partialFollowupCallText.includes("when_busy=steer"),
  ], [true, true, true, true]);
  eq("call renderer bounds collapsed and expanded requests", [
    clippedSpawnCallText.includes("…"),
    clippedSpawnCallText.includes("x".repeat(300)),
    clippedExpandedSpawnCallText.includes("… [truncated]"),
    clippedExpandedSpawnCallText.includes("y".repeat(8_100)),
  ], [true, false, true, false]);
  const readStatus = async (id: string) => {
    const result = await status.execute("status", { id }, undefined, undefined, context);
    return JSON.parse(result.content[0].text);
  };
  const waitForStatus = async (id: string, expected: string) => {
    for (let i = 0; i < 200; i++) {
      const current = await readStatus(id);
      if (current.status === expected) return current;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${id} to become ${expected}`);
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
  await waitForStatus(initial.details.turn_id as string, "completed");
  for (let i = 0; i < 50 && completionMessages.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  eq("spawn returns before background result", [initial.details.status, initial.details.asynchronous], ["running", true]);
  eq("completion automatically resumes Lead", [
    completionMessages[0]?.message.customType,
    completionMessages[0]?.message.content.includes("done"),
    completionMessages[0]?.options.deliverAs,
    completionMessages[0]?.options.triggerTurn,
  ], ["fusion-result", true, "steer", true]);

  let releaseSteerFirst!: (message: unknown) => void;
  let releaseSteerSecond!: (message: unknown) => void;
  let markSteerFirstStarted!: () => void;
  let markSteerSecondStarted!: () => void;
  const steerFirstStarted = new Promise<void>((resolve) => { markSteerFirstStarted = resolve; });
  const steerSecondStarted = new Promise<void>((resolve) => { markSteerSecondStarted = resolve; });
  let steerProviderCalls = 0;
  let steeredContext = "";
  completeImpl = async (_model, completeContext) => {
    steerProviderCalls++;
    if (steerProviderCalls === 1) {
      markSteerFirstStarted();
      return new Promise((resolve) => { releaseSteerFirst = resolve; });
    }
    steeredContext = JSON.stringify(completeContext);
    markSteerSecondStarted();
    return new Promise((resolve) => { releaseSteerSecond = resolve; });
  };
  const activeBeforeSteer = await followup.execute("steer-active", { worker_id: workerId, message: "prepare the current draft" }, undefined, undefined, context);
  await steerFirstStarted;
  const steeredCorrection = await followup.execute("steer-correction", { worker_id: workerId, message: "also add the regression test" }, undefined, undefined, context);
  const steeredCorrection2 = await followup.execute("steer-correction-2", { worker_id: workerId, message: "keep the public API unchanged" }, undefined, undefined, context);
  const pendingSteerStatus = await readStatus(workerId);
  eq("busy followups steer and batch by default", [
    steeredCorrection.details.status,
    steeredCorrection.details.when_busy,
    steeredCorrection.details.active_turn_id,
    steeredCorrection.details.position,
    steeredCorrection2.details.position,
    pendingSteerStatus.steering_updates.map((entry: { status: string }) => entry.status),
    pendingSteerStatus.queued_followups.length,
    fusionStatusLine.includes("steer 2"),
  ], ["steering", "steer", activeBeforeSteer.details.turn_id, 1, 2, ["pending", "pending"], 0, true]);
  releaseSteerFirst({ role: "assistant", content: [{ type: "text", text: "old draft" }], stopReason: "stop", timestamp: Date.now() });
  await steerSecondStarted;
  const injectedSteerStatus = await readStatus(workerId);
  eq("steering stays in the active turn", [
    injectedSteerStatus.active_turn,
    injectedSteerStatus.generation,
    injectedSteerStatus.steering_updates[0]?.status,
    steeredContext.includes("<fusion_steer"),
    steeredContext.includes("also add the regression test"),
    steeredContext.includes("keep the public API unchanged"),
    steerProviderCalls,
  ], [activeBeforeSteer.details.turn_id, activeBeforeSteer.details.generation, "injected", true, true, true, 2]);
  releaseSteerSecond({ role: "assistant", content: [{ type: "text", text: "integrated draft" }], stopReason: "stop", timestamp: Date.now() });
  await waitForStatus(activeBeforeSteer.details.turn_id as string, "completed");
  const steeredCompletion = completionMessages.find((item) => item.message.details?.turn_id === activeBeforeSteer.details.turn_id);
  eq("steering is durable worker history", [
    steeredCompletion?.message.content.includes("steered 2"),
    (await readStatus(workerId)).steering_updates.length,
  ], [true, 0]);

  let releaseQueuedFirst!: (message: unknown) => void;
  let releaseQueuedSecond!: (message: unknown) => void;
  let markQueuedFirstStarted!: () => void;
  let markQueuedSecondStarted!: () => void;
  const queuedFirstStarted = new Promise<void>((resolve) => { markQueuedFirstStarted = resolve; });
  const queuedSecondStarted = new Promise<void>((resolve) => { markQueuedSecondStarted = resolve; });
  let queuedProviderCalls = 0;
  let queuedFirstContext = "";
  completeImpl = async (_model, completeContext) => {
    queuedProviderCalls++;
    if (queuedProviderCalls === 1) {
      queuedFirstContext = JSON.stringify(completeContext);
      markQueuedFirstStarted();
      return new Promise((resolve) => { releaseQueuedFirst = resolve; });
    }
    markQueuedSecondStarted();
    return new Promise((resolve) => { releaseQueuedSecond = resolve; });
  };
  const activeBeforeQueue = await followup.execute("queue-active", { worker_id: workerId, message: "continue current work" }, undefined, undefined, context);
  await queuedFirstStarted;
  const queuedCorrection = await followup.execute("queue-correction", { worker_id: workerId, message: "change attendees to 2", when_busy: "queue" }, undefined, undefined, context);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const queuedWorkerStatus = await readStatus(workerId);
  eq("busy followup queues without interrupting", [
    queuedCorrection.details.status,
    queuedCorrection.details.when_busy,
    queuedCorrection.details.position,
    queuedWorkerStatus.active_turn,
    queuedWorkerStatus.queued_followups.length,
    fusionStatusLine.includes("queued 1"),
    queuedFirstContext.includes("also add the regression test"),
    queuedFirstContext.includes("keep the public API unchanged"),
  ], ["queued", "queue", 1, activeBeforeQueue.details.turn_id, 1, true, true, true]);
  releaseQueuedFirst({ role: "assistant", content: [{ type: "text", text: "first done" }], stopReason: "stop", timestamp: Date.now() });
  await queuedSecondStarted;
  const runningQueuedFollowup = await readStatus(workerId);
  const queuedFollowupTurnId = runningQueuedFollowup.active_turn as string;
  const firstCompletion = completionMessages.find((item) => item.message.details?.turn_id === activeBeforeQueue.details.turn_id);
  eq("queued followup starts automatically", [
    runningQueuedFollowup.generation,
    runningQueuedFollowup.queued_followups.length,
    firstCompletion?.message.details?.next_turn_id,
    firstCompletion?.message.content.includes("Do not resend it"),
  ], [(activeBeforeQueue.details.generation as number) + 1, 0, queuedFollowupTurnId, true]);
  releaseQueuedSecond({ role: "assistant", content: [{ type: "text", text: "second done" }], stopReason: "stop", timestamp: Date.now() });
  await waitForStatus(queuedFollowupTurnId, "completed");

  let rejectSteeredFailure!: (reason?: unknown) => void;
  let releasePromotedRetry!: (message: unknown) => void;
  let markSteeredFailureStarted!: () => void;
  let markPromotedRetryStarted!: () => void;
  const steeredFailureStarted = new Promise<void>((resolve) => { markSteeredFailureStarted = resolve; });
  const promotedRetryStarted = new Promise<void>((resolve) => { markPromotedRetryStarted = resolve; });
  let failureProviderCalls = 0;
  let promotedRetryContext = "";
  completeImpl = async (_model, completeContext) => {
    failureProviderCalls++;
    if (failureProviderCalls === 1) {
      markSteeredFailureStarted();
      return new Promise((_resolve, reject) => { rejectSteeredFailure = reject; });
    }
    promotedRetryContext = JSON.stringify(completeContext);
    markPromotedRetryStarted();
    return new Promise((resolve) => { releasePromotedRetry = resolve; });
  };
  const failureActive = await followup.execute("failure-active", { worker_id: workerId, message: "work that will hit a provider error" }, undefined, undefined, context);
  await steeredFailureStarted;
  const steerBeforeFailure = await followup.execute("failure-steer", { worker_id: workerId, message: "retain this accepted update" }, undefined, undefined, context);
  rejectSteeredFailure(new Error("simulated provider failure"));
  await promotedRetryStarted;
  const promotedRetryStatus = await readStatus(workerId);
  const promotedRetryTurnId = promotedRetryStatus.active_turn as string;
  const failedCompletion = completionMessages.find((item) => item.message.details?.turn_id === failureActive.details.turn_id);
  eq("provider failure promotes accepted steering update", [
    steerBeforeFailure.details.status,
    (await readStatus(failureActive.details.turn_id)).status,
    promotedRetryTurnId !== failureActive.details.turn_id,
    promotedRetryStatus.queued_followups.length,
    promotedRetryContext.includes("retain this accepted update"),
    promotedRetryContext.includes("ended before its live updates were durably completed"),
    failedCompletion?.message.details?.next_turn_id,
  ], ["steering", "failed", true, 0, true, true, promotedRetryTurnId]);
  releasePromotedRetry({ role: "assistant", content: [{ type: "text", text: "promoted update done" }], stopReason: "stop", timestamp: Date.now() });
  await waitForStatus(promotedRetryTurnId, "completed");

  let immediateSignal: AbortSignal | undefined;
  let rejectInterruptedCleanup!: (reason?: unknown) => void;
  let releaseImmediate!: (message: unknown) => void;
  let releaseAfterCleanup!: (message: unknown) => void;
  let markInterruptibleStarted!: () => void;
  let markImmediateStarted!: () => void;
  let markAfterCleanupStarted!: () => void;
  const interruptibleStarted = new Promise<void>((resolve) => { markInterruptibleStarted = resolve; });
  const immediateStarted = new Promise<void>((resolve) => { markImmediateStarted = resolve; });
  const afterCleanupStarted = new Promise<void>((resolve) => { markAfterCleanupStarted = resolve; });
  let immediateProviderCalls = 0;
  let immediateContext = "";
  completeImpl = async (_model, completeContext, options) => {
    immediateProviderCalls++;
    if (immediateProviderCalls === 1) {
      immediateSignal = options.signal;
      markInterruptibleStarted();
      return new Promise((_resolve, reject) => { rejectInterruptedCleanup = reject; });
    }
    if (immediateProviderCalls === 2) {
      immediateContext = JSON.stringify(completeContext);
      markImmediateStarted();
      return new Promise((resolve) => { releaseImmediate = resolve; });
    }
    markAfterCleanupStarted();
    return new Promise((resolve) => { releaseAfterCleanup = resolve; });
  };
  const interruptible = await followup.execute("interrupt-active", { worker_id: workerId, message: "keep doing the old plan" }, undefined, undefined, context);
  await interruptibleStarted;
  const steerBeforeInterrupt = await followup.execute(
    "steer-before-interrupt",
    { worker_id: workerId, message: "preserve the existing public API" },
    undefined,
    undefined,
    context,
  );
  const immediateCorrection = await followup.execute(
    "interrupt-correction",
    { worker_id: workerId, message: "stop and use 2 attendees", when_busy: "interrupt" },
    undefined,
    undefined,
    context,
  );
  const queuedDuringCleanup = await followup.execute(
    "queue-during-cleanup",
    { worker_id: workerId, message: "then verify the attendee count" },
    undefined,
    undefined,
    context,
  );
  const duringCleanupStatus = await readStatus(workerId);
  eq("interrupted cleanup blocks overlapping followups", [
    queuedDuringCleanup.details.status,
    queuedDuringCleanup.details.position,
    duringCleanupStatus.queued_followups.length,
    immediateProviderCalls,
    immediateSignal?.aborted,
  ], ["queued", 2, 2, 1, true]);
  rejectInterruptedCleanup(immediateSignal?.reason);
  await immediateStarted;
  const afterImmediateStart = await readStatus(workerId);
  const immediateTurnId = afterImmediateStart.active_turn as string;
  eq("interrupting followup aborts and restarts", [
    immediateCorrection.details.status,
    immediateCorrection.details.when_busy,
    immediateCorrection.details.interrupted_turn_id,
    immediateCorrection.details.absorbed_steers,
    steerBeforeInterrupt.details.status,
    (await readStatus(interruptible.details.turn_id)).status,
    immediateTurnId !== interruptible.details.turn_id,
    afterImmediateStart.queued_followups.length,
    immediateContext.includes("Partial filesystem or command side effects may remain"),
    immediateContext.includes("preserve the existing public API"),
    immediateContext.includes("stop and use 2 attendees"),
  ], ["interrupting", "interrupt", interruptible.details.turn_id, 1, "steering", "interrupted", true, 1, true, true, true]);
  releaseImmediate({ role: "assistant", content: [{ type: "text", text: "immediate done" }], stopReason: "stop", timestamp: Date.now() });
  await afterCleanupStarted;
  const afterCleanupStatus = await readStatus(workerId);
  const afterCleanupTurnId = afterCleanupStatus.active_turn as string;
  eq("followup queued during cleanup runs afterward", [afterCleanupStatus.queued_followups.length, afterCleanupTurnId !== immediateTurnId], [0, true]);
  releaseAfterCleanup({ role: "assistant", content: [{ type: "text", text: "verification done" }], stopReason: "stop", timestamp: Date.now() });
  await waitForStatus(afterCleanupTurnId, "completed");

  let executorSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const inquiryContexts: string[] = [];
  completeImpl = async (_model, completeContext, options) => {
    const serializedContext = JSON.stringify(completeContext);
    if (serializedContext.includes("read-only sidecar observer")) {
      inquiryContexts.push(serializedContext);
      return {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private inquiry reasoning" },
          { type: "text", text: "The worker is waiting in its active turn." },
        ],
        stopReason: "stop",
        timestamp: Date.now(),
      };
    }
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
  const deferred = await spawn.execute("deferred", { task: "wait", label: "status-test" }, hostController.signal, undefined, context);
  const deferredTurnId = deferred.details.turn_id as string;
  const deferredWorkerId = deferred.details.worker_id as string;
  await started;
  await new Promise((resolve) => setTimeout(resolve, 80));
  eq("background activity uses status line without auto-opening pane", [customCalls, fusionStatusLine.includes("status-test"), fusionStatusLine.includes("waiting")], [0, true, true]);

  const workerBeforeInquiry = await readStatus(deferredWorkerId);
  const inquiryAccepted = await ask.execute(
    "ask-active",
    { worker_id: deferredWorkerId, question: "What is the worker doing?" },
    undefined,
    undefined,
    context,
  );
  const inquiryId = inquiryAccepted.details.inquiry_id as string;
  const inquiryTurnId = inquiryAccepted.details.inquiry_turn_id as string;
  const completedInquiry = await waitForStatus(inquiryTurnId, "completed");
  const workerAfterInquiry = await readStatus(deferredWorkerId);
  const inquiryCompletion = completionMessages.find((item) => item.message.details?.inquiry_turn_id === inquiryTurnId);
  eq("Lead can ask active worker without affecting it", [
    inquiryAccepted.details.status,
    inquiryId.startsWith("inq_"),
    inquiryTurnId.startsWith("iqt_"),
    completedInquiry.answer,
    workerAfterInquiry.active_turn,
    workerAfterInquiry.generation,
    workerAfterInquiry.history_messages,
    inquiryAccepted.details.worker_remembers_inquiry,
    executorSignal?.aborted,
    inquiryCompletion?.message.customType,
    inquiryCompletion?.options.deliverAs,
    inquiryCompletion?.options.triggerTurn,
    inquiryCompletion?.message.details?.worker_remembers_inquiry,
    inquiryCompletion?.message.content.includes("will not remember this inquiry"),
  ], ["running", true, true, "The worker is waiting in its active turn.", workerBeforeInquiry.active_turn, workerBeforeInquiry.generation, workerBeforeInquiry.history_messages, false, false, "fusion-inquiry-result", "steer", true, false, true]);
  eq("inquiry receives safe public snapshot", [
    inquiryContexts[0]?.includes("What is the worker doing?"),
    inquiryContexts[0]?.includes("private_thinking_available"),
    inquiryContexts[0]?.includes("private worker reasoning"),
    inquiryContexts[0]?.includes("private inquiry reasoning"),
  ], [true, true, false, false]);

  const inquiryFollowup = await ask.execute(
    "ask-followup",
    { thread_id: inquiryId, question: "What remains?" },
    undefined,
    undefined,
    context,
  );
  await waitForStatus(inquiryFollowup.details.inquiry_turn_id as string, "completed");
  const inquiryThreadStatus = await readStatus(inquiryId);
  eq("inquiry thread keeps separate chat context", [
    inquiryFollowup.details.inquiry_id,
    inquiryThreadStatus.history_messages,
    inquiryThreadStatus.worker_remembers_inquiry,
    inquiryContexts[1]?.includes("The worker is waiting in its active turn."),
    inquiryContexts[1]?.includes("private inquiry reasoning"),
  ], [inquiryId, 4, false, true, false]);

  const steerToCancel = await followup.execute(
    "steer-before-standalone-interrupt",
    { worker_id: deferredWorkerId, message: "this pending update will be cancelled" },
    undefined,
    undefined,
    context,
  );
  hostController.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const detachedTurn = await readStatus(deferredTurnId);
  const detachedWorker = await readStatus(deferredWorkerId);
  eq("accepted turn is detached from lead tool abort", [
    deferred.details.status,
    deferred.details.asynchronous,
    detachedTurn.status,
    detachedWorker.active_turn,
    detachedWorker.consecutive_failures,
    executorSignal?.aborted,
  ], ["running", true, "running", deferredTurnId, 0, false]);
  const standaloneInterrupt = await interrupt.execute("interrupt", { worker_id: deferredWorkerId }, undefined, undefined, context);
  const deferredTurn = await waitForStatus(deferredTurnId, "interrupted");
  const deferredWorker = await readStatus(deferredWorkerId);
  await new Promise((resolve) => setTimeout(resolve, 80));
  eq("explicit interrupt stops detached turn", [
    steerToCancel.details.status,
    standaloneInterrupt.details.steering_updates_cancelled,
    deferredTurn.status,
    deferredWorker.active_turn,
    deferredWorker.steering_updates.length,
    executorSignal?.aborted,
    fusionStatusLine.includes("Fusion available"),
  ], ["steering", 1, "interrupted", null, 0, true, true]);

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
  const firstMutating = await spawn.execute("queue-first", { task: "hold queue" }, undefined, undefined, context);
  await firstStarted;

  const queuedController = new AbortController();
  const queuedResult = await spawn.execute(
    "queue-second",
    { task: "stay queued after lead turn ends" },
    queuedController.signal,
    undefined,
    context,
  );
  queuedController.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const queuedTurnId = queuedResult.details.turn_id as string;
  const queuedWorkerId = queuedResult.details.worker_id as string;
  const queuedTurn = await readStatus(queuedTurnId);
  const queuedWorker = await readStatus(queuedWorkerId);
  eq("queued mutating turn returns immediately and stays detached", [
    firstMutating.details.status,
    queuedResult.details.status,
    queuedResult.details.asynchronous,
    queuedTurn.status,
    queuedWorker.active_turn,
    queuedWorker.consecutive_failures,
    providerCallsWhileQueued,
  ], ["running", "running", true, "running", queuedTurnId, 0, 1]);
  finishFirst(completedMessage);
  await waitForStatus(firstMutating.details.turn_id as string, "completed");
  await waitForStatus(queuedTurnId, "completed");
  eq("serialized background turn runs after queue releases", providerCallsWhileQueued, 2);

  let shutdownSignal: AbortSignal | undefined;
  let markShutdownStarted!: () => void;
  const shutdownStarted = new Promise<void>((resolve) => { markShutdownStarted = resolve; });
  completeImpl = async (_model, _completeContext, options) => {
    shutdownSignal = options.signal;
    markShutdownStarted();
    return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
  };
  const shutdownRun = await spawn.execute("shutdown", { task: "stop with session" }, undefined, undefined, context);
  await shutdownStarted;
  const shutdownSteer = await followup.execute("shutdown-steer", { worker_id: shutdownRun.details.worker_id, message: "apply before shutdown" }, undefined, undefined, context);
  const messagesBeforeShutdown = completionMessages.length;
  await lifecycleHandlers.get("session_shutdown")?.({}, context);
  const shutdownTurn = await readStatus(shutdownRun.details.turn_id as string);
  const shutdownWorker = await readStatus(shutdownRun.details.worker_id as string);
  eq("session shutdown interrupts without stale completion", [
    shutdownSteer.details.status,
    shutdownTurn.status,
    shutdownSignal?.aborted,
    shutdownWorker.steering_updates.length,
    completionMessages.length,
  ], ["steering", "interrupted", true, 0, messagesBeforeShutdown]);
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

// --- 10. Fusion augments the built-in footer instead of replacing it ---
const sessionStartHandlers: Array<(event: unknown, ctx: any) => Promise<void>> = [];
fusionExtension({
  on: (event: string, handler: (event: unknown, ctx: any) => Promise<void>) => {
    if (event === "session_start") sessionStartHandlers.push(handler);
  },
  registerTool: () => {},
  registerCommand: () => {},
} as never);
let statusCall: [string, string] | undefined;
let customFooterCalls = 0;
await sessionStartHandlers[0]?.({}, {
  hasUI: true,
  ui: {
    setStatus: (key: string, text: string) => { statusCall = [key, text]; },
    setFooter: () => { customFooterCalls++; },
  },
  sessionManager: { getBranch: () => [] },
  isProjectTrusted: () => false,
  model: undefined,
  modelRegistry: { getAll: () => [], getAvailable: () => [] },
});
eq("fusion preserves built-in footer", [statusCall?.[0], statusCall?.[1].includes("Fusion available"), customFooterCalls], ["fusion", true, 0]);

// --- 11. /fusion-thinking persists a session override ---
const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
const thinkingBranch: unknown[] = [];
let thinkingNotice = "";
fusionExtension({
  on: () => {},
  registerTool: () => {},
  registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, command),
  appendEntry: (customType: string, data: unknown) => thinkingBranch.push({ type: "custom", customType, data }),
} as never);
const thinkingModel = { provider: "test", id: "reasoner", input: ["text"], reasoning: true };
await commands.get("fusion-thinking")!.handler("high", {
  cwd: "/tmp",
  mode: "tui",
  hasUI: true,
  ui: {
    notify: (text: string) => { thinkingNotice = text; },
    setStatus: () => {},
  },
  sessionManager: { getBranch: () => thinkingBranch },
  isProjectTrusted: () => false,
  model: thinkingModel,
  modelRegistry: {
    getAll: () => [thinkingModel],
    getAvailable: () => [thinkingModel],
    hasConfiguredAuth: () => true,
  },
});
const thinkingEntry = thinkingBranch.at(-1) as { customType: string; data: { thinkingLevel: string } };
eq("fusion thinking command", [thinkingEntry.customType, thinkingEntry.data.thinkingLevel, thinkingNotice], ["fusion-thinking", "high", "Fusion thinking: high (session override)"]);

// --- 12. /fusion-fast persists OpenAI priority processing across sessions ---
const fastFixture = mkdtempSync(_join(tmpdir(), "fusion-fast-config-"));
const fastAgentDir = _join(fastFixture, "agent");
mkdirSync(_join(fastFixture, ".pi"));
mkdirSync(fastAgentDir);
writeFileSync(_join(fastFixture, ".pi", "fusion.json"), JSON.stringify({ executor: "openai-codex/gpt-5.6-luna", fastMode: false }));
writeFileSync(_join(fastAgentDir, "fusion.json"), JSON.stringify({ executorToolsConsent: true, preserved: "yes" }));
const fastCommands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
const fastBranch: unknown[] = [];
let fastNotice = "";
fusionExtension({
  on: () => {},
  registerTool: () => {},
  registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => fastCommands.set(name, command),
  appendEntry: (customType: string, data: unknown) => fastBranch.push({ type: "custom", customType, data }),
} as never, { agentDir: fastAgentDir });
const fastCommandModel = { provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-codex-responses", input: ["text"], reasoning: true };
const fastCommandContext = {
  cwd: fastFixture,
  mode: "tui",
  hasUI: true,
  ui: {
    notify: (text: string) => { fastNotice = text; },
    setStatus: () => {},
  },
  sessionManager: { getBranch: () => fastBranch },
  isProjectTrusted: () => true,
  model: undefined,
  modelRegistry: {
    getAll: () => [fastCommandModel],
    getAvailable: () => [fastCommandModel],
    hasConfiguredAuth: () => true,
  },
};
await fastCommands.get("fusion-fast")!.handler("status", fastCommandContext);
eq("fusion fast off status", fastNotice, "Fusion fast mode: off (config file) • default provider service tier");
fastBranch.push({ type: "custom", customType: "fusion-fast", data: { fastMode: false, timestamp: Date.now() } });
await fastCommands.get("fusion-fast")!.handler("on", fastCommandContext);
const fastOnEntry = fastBranch.at(-1) as { customType: string; data: { fastMode?: boolean } };
const persistedOnRaw = JSON.parse(readFileSync(_join(fastAgentDir, "fusion.json"), "utf8"));
eq("fusion fast on persists globally", [
  fastOnEntry.customType,
  "fastMode" in fastOnEntry.data,
  loadGlobalConfig(fastAgentDir).fastMode,
  persistedOnRaw.preserved,
  statSync(_join(fastAgentDir, "fusion.json")).mode & 0o777,
  fastNotice.includes("on (global preference)"),
  fastNotice.includes("priority"),
], ["fusion-fast", false, true, "yes", 0o600, true, true]);
const futureFastCommands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
let futureFastNotice = "";
fusionExtension({
  on: () => {},
  registerTool: () => {},
  registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => futureFastCommands.set(name, command),
  appendEntry: () => {},
} as never, { agentDir: fastAgentDir });
await futureFastCommands.get("fusion-fast")!.handler("status", {
  ...fastCommandContext,
  ui: { ...fastCommandContext.ui, notify: (text: string) => { futureFastNotice = text; } },
  sessionManager: { getBranch: () => [] },
});
eq("fusion fast survives a new session", futureFastNotice, "Fusion fast mode: on (global preference) • OpenAI priority service tier; higher cost/plan usage");
await fastCommands.get("fusion-fast")!.handler("off", fastCommandContext);
const fastOffEntry = fastBranch.at(-1) as { customType: string; data: { fastMode?: boolean } };
eq("fusion fast off persists globally", [fastOffEntry.customType, "fastMode" in fastOffEntry.data, loadGlobalConfig(fastAgentDir).fastMode, fastNotice], ["fusion-fast", false, false, "Fusion fast mode: off (global preference) • default provider service tier"]);
await fastCommands.get("fusion-fast")!.handler("default", fastCommandContext);
const fastDefaultEntry = fastBranch.at(-1) as { customType: string; data: { fastMode?: boolean } };
const persistedDefaultRaw = JSON.parse(readFileSync(_join(fastAgentDir, "fusion.json"), "utf8"));
eq("fusion fast default clears global preference", [fastDefaultEntry.customType, "fastMode" in fastDefaultEntry.data, "fastMode" in persistedDefaultRaw, persistedDefaultRaw.preserved, fastNotice], ["fusion-fast", false, false, "yes", "Fusion fast mode: off (config/default) • default provider service tier"]);
const failedJournalCommands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
const failedJournalBranch = [{ type: "custom", customType: "fusion-fast", data: { fastMode: false, timestamp: Date.now() } }];
let failedJournalNotice = "";
fusionExtension({
  on: () => {},
  registerTool: () => {},
  registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => failedJournalCommands.set(name, command),
  appendEntry: () => { throw new Error("journal unavailable"); },
} as never, { agentDir: fastAgentDir });
await failedJournalCommands.get("fusion-fast")!.handler("on", {
  ...fastCommandContext,
  ui: { ...fastCommandContext.ui, notify: (text: string) => { failedJournalNotice = text; } },
  sessionManager: { getBranch: () => failedJournalBranch },
});
eq("fusion fast reports uncleared session override", [
  loadGlobalConfig(fastAgentDir).fastMode,
  failedJournalNotice,
], [
  true,
  "Fusion fast mode was saved globally as on, but this session still uses its previous off override because the journal could not be cleared. New sessions will use the persisted preference.",
]);
rmSync(fastFixture, { recursive: true, force: true });

// --- 13. /fusion-consent persists allow, ask, and clear overrides ---
const consentFixture = mkdtempSync(_join(tmpdir(), "fusion-consent-config-"));
mkdirSync(_join(consentFixture, ".pi"));
writeFileSync(_join(consentFixture, ".pi", "fusion.json"), JSON.stringify({ executorToolsConsent: false }));
let consentNotice = "";
const consentContext = {
  cwd: consentFixture,
  mode: "tui",
  hasUI: true,
  ui: {
    notify: (text: string) => { consentNotice = text; },
    setStatus: () => {},
  },
  sessionManager: { getBranch: () => thinkingBranch },
  isProjectTrusted: () => true,
  model: thinkingModel,
  modelRegistry: {
    getAll: () => [thinkingModel],
    getAvailable: () => [thinkingModel],
    hasConfiguredAuth: () => true,
  },
};
await commands.get("fusion-consent")!.handler("allow", consentContext);
const allowEntry = thinkingBranch.at(-1) as { customType: string; data: { executorToolsConsent?: boolean } };
eq("fusion consent allow", [allowEntry.customType, allowEntry.data.executorToolsConsent, consentNotice], ["fusion-consent", true, "Fusion consent: allow (session override)"]);
await commands.get("fusion-consent")!.handler("ask", consentContext);
const askEntry = thinkingBranch.at(-1) as { customType: string; data: { executorToolsConsent?: boolean } };
eq("fusion consent ask", [askEntry.customType, askEntry.data.executorToolsConsent, consentNotice], ["fusion-consent", false, "Fusion consent: ask (session override)"]);
await commands.get("fusion-consent")!.handler("default", consentContext);
const defaultEntry = thinkingBranch.at(-1) as { customType: string; data: { executorToolsConsent?: boolean } };
eq("fusion consent default", [defaultEntry.customType, defaultEntry.data.executorToolsConsent, consentNotice], ["fusion-consent", undefined, "Fusion consent: ask (config/default)"]);
await commands.get("fusion-consent")!.handler("status", consentContext);
eq("fusion consent status", consentNotice, "Fusion consent: ask (config file)");
await commands.get("fusion-consent")!.handler("allow", { ...consentContext, isProjectTrusted: () => false });
eq("fusion consent rejects untrusted", consentNotice, "Fusion consent cannot be allowed in an untrusted project.");
rmSync(consentFixture, { recursive: true, force: true });

// --- 13. worker pane keeps visible history bounded and excludes thinking ---
const paneHistory = [
  { role: "user", content: '<fusion_handoff generation="1"><task>Fix the parser</task></fusion_handoff>', timestamp: 1 },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private chain of thought" },
      { type: "text", text: "Inspecting files" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/parser.ts" } },
    ],
    timestamp: 2,
  },
  { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 3 },
  { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 4 },
] as never;
const paneItems = formatPaneHistory(paneHistory);
eq("pane task extraction", extractHandoffTask((paneHistory[0] as { content: string }).content), "Fix the parser");
eq("pane roles", paneItems.map((item) => item.role), ["LEAD", "SIDEKICK", "TOOL", "TOOL", "SIDEKICK"]);
eq("pane excludes thinking", paneItems.some((item) => item.text.includes("private chain")), false);
eq("pane shows tool call", paneItems[2], { role: "TOOL", text: 'call read {"path":"src/parser.ts"}' });
eq("pane shows tool result", paneItems[3], { role: "TOOL", text: "read result: file contents" });
const structuredItems = formatPaneTranscript(paneHistory);
eq("structured transcript pairs tool call/result", [structuredItems.map((item) => item.kind), structuredItems.find((item) => item.kind === "tool")], [
  ["user", "assistant", "tool", "assistant"],
  { kind: "tool", role: "TOOL", id: "call-1", name: "read", arguments: '{"path":"src/parser.ts"}', status: "success", output: "file contents" },
]);
eq("structured transcript excludes thinking", structuredItems.some((item) => "text" in item && item.text.includes("private chain")), false);
const paneWorker = {
  id: "wrk_test",
  label: "parser",
  executorModelId: "openai-codex/gpt-test",
  history: paneHistory,
  generation: 1,
  status: "idle",
  activeTurnId: null,
  failures: 0,
  createdAt: 1,
} as never;
const renderedPane = renderWorkerPane(paneWorker, 42, 2);
eq("pane width bound", renderedPane.every((line) => visibleWidth(line) <= 42), true);
eq("pane keeps newest output", renderedPane.some((line) => line.includes("Done")), true);
eq("pane drops old output", renderedPane.some((line) => line.includes("Fix the parser")), false);
const expandedWorker = {
  ...(paneWorker as object),
  history: Array.from({ length: 60 }, (_, i) => ({
    role: "assistant",
    content: [{ type: "text", text: `history-${i}` }],
    timestamp: i,
  })),
} as never;
const expandedPane = renderWorkerPane(expandedWorker, 42, 100);
eq("pane uses expanded line capacity", [expandedPane.some((line) => line.includes("history-0")), expandedPane.some((line) => line.includes("history-59")), expandedPane.every((line) => visibleWidth(line) <= 42)], [true, true, true]);
const thinkingActivity: LiveActivity = { phase: "thinking", startedAt: Date.now() - 2_000, text: "", tools: [] };
const thinkingPane = renderWorkerPane(paneWorker, 42, 20, thinkingActivity);
eq("live thinking phase without private text", [thinkingPane.some((line) => line.includes("thinking")), thinkingPane.some((line) => line.includes("private chain of thought"))], [true, false]);
eq("status line passes through visible worker activity", [
  formatLiveStatusAction({ phase: "responding", startedAt: 0, text: "한국어로 작업 결과를 설명 중", tools: [] }),
  formatLiveStatusAction({ phase: "tool", startedAt: 0, text: "", tools: [{ id: "1", name: "bash", arguments: '{"command":"git status"}', output: "", status: "running" }] }),
  formatLiveStatusAction(thinkingActivity),
], ["한국어로 작업 결과를 설명 중", "▶ bash · git status", "thinking"]);
eq("status line formats tool calls cleanly", [
  formatToolStatusAction({ id: "1", name: "read", arguments: '{"path":"src/index.ts","offset":10}', output: "", status: "running" }),
  formatToolStatusAction({ id: "2", name: "edit", arguments: '{"path":"src/index.ts","edits":[{},{}]}', output: "", status: "success" }),
  formatToolStatusAction({ id: "3", name: "grep", arguments: '{"pattern":"needle","path":"src"}', output: "", status: "error" }),
  formatToolStatusAction({ id: "4", name: "bash", arguments: '{"command":"npm test"}', output: "", status: "success" }),
], [
  "▶ read · src/index.ts:10",
  "✓ edit · src/index.ts · 2 edits",
  '✗ grep · "needle" · src',
  "✓ bash · npm test",
]);
eq("status elapsed uses h/m/s", [
  formatElapsedDuration(0),
  formatElapsedDuration(59_999),
  formatElapsedDuration(60_000),
  formatElapsedDuration(65_000),
  formatElapsedDuration(3_661_000),
], ["0s", "59s", "1m 00s", "1m 05s", "1h 01m 01s"]);
const crowdedActivity: LiveActivity = {
  phase: "tool",
  startedAt: Date.now() - 2_000,
  text: "streaming ".repeat(100),
  tools: Array.from({ length: 8 }, (_, i) => ({ id: `tool-${i}`, name: "bash", arguments: `arg-${i}`, output: `output-${i} `.repeat(30), status: "running" as const })),
};
const crowdedPane = renderWorkerPane(paneWorker, 42, 10, crowdedActivity);
eq("live pane respects available height", [crowdedPane.length <= 17, crowdedPane.some((line) => line.includes("[LIVE] tool"))], [true, true]);
const paneController = new FusionPaneController((id) => id === "wrk_test" ? paneWorker : undefined);
paneController.restore({ visible: true, workerId: "wrk_test" });
const liveToken = paneController.beginLive("wrk_test", Date.now() - 3_000);
paneController.updateLive("wrk_test", { kind: "phase", phase: "thinking", replaceText: true }, liveToken);
paneController.updateLive("wrk_test", { kind: "tool_start", toolId: "call-1", name: "bash", arguments: '{"command":"echo hi"}' }, liveToken);
paneController.updateLive("wrk_test", { kind: "tool_update", toolId: "call-1", output: "partial output" }, liveToken);
paneController.updateLive("wrk_test", { kind: "tool_end", toolId: "call-1", ok: true, output: "final output" }, liveToken);
paneController.updateLive("wrk_test", { kind: "tool_start", toolId: "call-2", name: "read", arguments: '{"path":"missing"}' }, liveToken);
paneController.updateLive("wrk_test", { kind: "tool_end", toolId: "call-2", ok: false, output: "failed" }, liveToken);
const liveActivity = paneController.getLive("wrk_test");
eq("pane live activity lifecycle", [liveActivity?.phase, liveActivity?.tools[0]?.name, liveActivity?.tools[0]?.output, liveActivity?.tools[0]?.status, liveActivity?.tools[1]?.status], ["tool", "bash", "final output", "success", "error"]);
eq("pane live state is transient", [paneController.getLive("wrk_test") !== undefined, paneController.liveTimerActive], [true, true]);
paneController.clearLive("wrk_test", liveToken);
eq("pane live state clears", [paneController.getLive("wrk_test"), paneController.liveTimerActive], [undefined, false]);
eq("pane restores state", paneController.state, { visible: true, workerId: "wrk_test" });
const hiddenToken = paneController.beginLive("wrk_test");
paneController.updateLive("wrk_test", { kind: "phase", phase: "responding", text: `${"old".repeat(1500)}LATEST` }, hiddenToken);
paneController.updateLive("wrk_test", { kind: "tool_start", toolId: "tail", name: "bash", arguments: "{}" }, hiddenToken);
paneController.updateLive("wrk_test", { kind: "tool_update", toolId: "tail", output: `${"old".repeat(1500)}OUTPUT-LATEST` }, hiddenToken);
const boundedLive = paneController.getLive("wrk_test");
eq("pane streaming bounds keep newest output", [boundedLive?.text.startsWith("..."), boundedLive?.text.endsWith("LATEST"), boundedLive?.tools[0]?.output.endsWith("OUTPUT-LATEST")], [true, true, true]);
paneController.close();
eq("pane close preserves in-flight state", [paneController.state, paneController.getLive("wrk_test")?.phase, paneController.liveTimerActive, paneController.renderTimerActive], [{ visible: false, workerId: "wrk_test" }, "tool", false, false]);
paneController.shutdown();
eq("pane shutdown clears transient state", paneController.getLive("wrk_test"), undefined);
let paneNotice = "";
await commands.get("fusion-pane")!.handler("open", {
  ...consentContext,
  mode: "rpc",
  ui: { ...consentContext.ui, notify: (text: string) => { paneNotice = text; } },
});
eq("pane rejects non-tui", paneNotice, "Fusion pane requires TUI mode.");

// --- 14. read-only monitor sidecar renders and publishes safe live snapshots ---
const monitorSnapshot: MonitorSnapshot = {
  schemaVersion: 1,
  sessionId: "session-test",
  cwd: "/tmp/project",
  selectedWorkerId: "wrk_monitor",
  updatedAt: Date.now() - 2_000,
  connected: true,
  ownerPid: process.pid,
  workers: [{
    id: "wrk_monitor",
    label: "한국어 monitor",
    status: "running",
    generation: 2,
    executor: "openai-codex/gpt-test",
    activeTurnId: "trn_monitor",
    createdAt: Date.now() - 10_000,
    queuedFollowups: 1,
    steeringUpdates: 2,
    history: Array.from({ length: 24 }, (_, index) => ({
      role: index % 3 === 0 ? "LEAD" as const : index % 3 === 1 ? "SIDEKICK" as const : "TOOL" as const,
      text: `visible history ${index}`,
    })),
    live: {
      phase: "tool",
      startedAt: Date.now() - 5_000,
      text: "보이는 응답",
      tools: [{ id: "tool-1", name: "bash", arguments: '{"command":"npm test"}', output: "all good\u001b]2;INJECTED\u0007", status: "running" }],
    },
  }],
};
const monitorWide = renderMonitorScreen(monitorSnapshot, 110, 28, { selectedWorkerId: "wrk_monitor", scroll: 0, follow: true });
const monitorNarrow = renderMonitorScreen(monitorSnapshot, 64, 20, { scroll: 0, follow: false });
const monitorNarrowFollowing = renderMonitorScreen(monitorSnapshot, 64, 20, { selectedWorkerId: "wrk_monitor", scroll: 0, follow: true });
eq("monitor screen dimensions", [monitorWide.lines.length, monitorWide.lines.every((line) => visibleWidth(line) <= 110), monitorNarrow.lines.length, monitorNarrow.lines.every((line) => visibleWidth(line) <= 64), monitorNarrowFollowing.lines.length, monitorNarrowFollowing.lines.every((line) => visibleWidth(line) <= 64)], [28, true, 20, true, 20, true]);
eq("monitor narrow keeps transcript beside coordination", monitorNarrowFollowing.lines.some((line) => line.includes("bash")), true);
const shortWideMonitor = renderMonitorScreen(monitorSnapshot, 80, 10, { selectedWorkerId: "wrk_monitor", scroll: 0, follow: true });
const shortNarrowMonitor = renderMonitorScreen(monitorSnapshot, 64, 10, { selectedWorkerId: "wrk_monitor", scroll: 0, follow: true });
eq("monitor short coordination stays visible", [shortWideMonitor.lines.length, shortWideMonitor.lines.every((line) => visibleWidth(line) <= 80), shortWideMonitor.lines.some((line) => line.includes("Steering")), shortWideMonitor.lines.some((line) => line.includes("latest")), shortWideMonitor.lines.some((line) => line.includes("next")), shortNarrowMonitor.lines.length, shortNarrowMonitor.lines.every((line) => visibleWidth(line) <= 64), shortNarrowMonitor.lines.some((line) => line.includes("Steering")), shortNarrowMonitor.lines.some((line) => line.includes("latest")), shortNarrowMonitor.lines.some((line) => line.includes("next"))], [10, true, true, true, true, 10, true, true, true, true]);
initTheme("dark");
const richMonitor = renderMonitorScreen({
  ...monitorSnapshot,
  schemaVersion: 2,
  workers: [{
    ...monitorSnapshot.workers[0]!,
    history: [
      { kind: "user", role: "LEAD", text: "hello\u001b]133;A\u0007" },
      { kind: "assistant", role: "SIDEKICK", text: "**answer**\u009d133;B\u009c" },
    ],
  }],
}, 80, 16, { selectedWorkerId: "wrk_monitor", scroll: 0, follow: true });
const richMonitorText = richMonitor.lines.join("\n");
eq("monitor rich render strips generated OSC", [richMonitorText.includes("\u001b]"), richMonitorText.includes("\u009d"), richMonitorText.includes("\u009c"), richMonitor.lines.every((line) => visibleWidth(line) <= 80)], [false, false, false, true]);
const longLabelMonitor = renderMonitorScreen({ ...monitorSnapshot, workers: [{ ...monitorSnapshot.workers[0]!, label: "very-long-worker-label-".repeat(20) }] }, 110, 28, { selectedWorkerId: "wrk_monitor", scroll: 0, follow: true });
eq("monitor worker badges survive long labels", longLabelMonitor.lines.some((line) => line.includes("S2 Q1")), true);
eq("monitor follows live tail", [monitorWide.selectedWorkerId, monitorWide.scroll, monitorWide.maxScroll, monitorWide.lines.some((line) => line.includes("bash"))], ["wrk_monitor", monitorWide.maxScroll, monitorWide.maxScroll, true]);
eq("monitor keeps coordination fixed while following", [monitorWide.lines.some((line) => line.includes("Steering 2")), monitorWide.lines.some((line) => line.includes("Queue 1")), monitorWide.lines.some((line) => line.includes("latest"))], [true, true, true]);
eq("monitor strips injected terminal controls", [
  sanitizeMonitorText("safe\u001b]2;INJECTED\u0007"),
  sanitizeMonitorText("safe\u009b2JINJECT").includes("\u009b"),
  monitorWide.lines.some((line) => line.includes("INJECTED")),
], ["safe", false, false]);
eq("monitor parser rejects invalid snapshots", [parseMonitorSnapshot("{}"), parseMonitorSnapshot(JSON.stringify(monitorSnapshot))?.workers.length], [undefined, 1]);
const structuredMonitorRaw = JSON.stringify({
  ...monitorSnapshot,
  schemaVersion: 2,
  workers: [{
    ...monitorSnapshot.workers[0],
    queuedFollowups: 13,
    steeringUpdates: 14,
    coordination: {
      steering: Array.from({ length: 40 }, (_, index) => ({ id: `str_${index}`, turnId: "trn_monitor", status: index % 2 ? "injected" : "pending", preview: `preview ${index}`, enqueuedAt: Date.now() - index * 1_000 })),
      queue: Array.from({ length: 40 }, (_, index) => ({ id: `qfu_${index}`, status: "queued", strategy: "queue", preview: `queued ${index}`, enqueuedAt: Date.now() - index * 1_000 })),
    },
    history: [{ kind: "user", role: "LEAD", text: "visible task" }, { kind: "assistant", role: "SIDEKICK", text: "visible answer" }, { kind: "tool", role: "TOOL", id: "tool", name: "read", arguments: "{}", output: "visible result", status: "success" }],
  }],
});
const parsedStructuredMonitor = parseMonitorSnapshot(structuredMonitorRaw)!;
eq("monitor structured schema is bounded", [parsedStructuredMonitor.schemaVersion, parsedStructuredMonitor.workers[0]!.coordination!.steering.length, parsedStructuredMonitor.workers[0]!.coordination!.queue.length, parsedStructuredMonitor.workers[0]!.steeringUpdates, parsedStructuredMonitor.workers[0]!.queuedFollowups], [2, 12, 12, 14, 13]);
eq("monitor detects dead or stale publisher", [
  isMonitorOwnerAlive(process.pid),
  shouldTerminateMonitor(monitorSnapshot),
  shouldTerminateMonitor({ ...monitorSnapshot, ownerPid: 2_147_483_647 }),
  shouldTerminateMonitor({ ...monitorSnapshot, updatedAt: Date.now() - 60_000 }),
  shouldTerminateMonitor({ ...monitorSnapshot, updatedAt: Date.now() - 60_000 }, Date.now(), undefined, Date.now()),
], [true, false, true, true, false]);
const ghosttyPlan = buildMonitorLaunchPlan("/pkg/monitor-cli.ts", "/tmp/snapshot.json", { platform: "darwin", ghostty: true, terminal: false });
eq("monitor Ghostty launch plan", [ghosttyPlan?.kind, ghosttyPlan?.command, ghosttyPlan?.args.includes("-e"), ghosttyPlan?.args.at(-1)], ["ghostty", "/usr/bin/open", true, "/tmp/snapshot.json"]);
eq("monitor has no unsupported launcher", buildMonitorLaunchPlan("script", "snapshot", { platform: "linux", ghostty: false, terminal: false }), undefined);
eq("monitor command registered", commands.has("fusion-monitor"), true);
let monitorNotice = "";
await commands.get("fusion-monitor")!.handler("open", {
  ...consentContext,
  mode: "rpc",
  ui: { ...consentContext.ui, notify: (text: string) => { monitorNotice = text; } },
});
eq("monitor rejects non-tui launch", monitorNotice, "Fusion monitor requires an active TUI session.");

const monitorFixture = mkdtempSync(_join(tmpdir(), "fusion-monitor-test-"));
let publishedPayload = { ...monitorSnapshot, workers: monitorSnapshot.workers };
const publisher = new FusionMonitorPublisher(() => ({
  schemaVersion: 1,
  sessionId: publishedPayload.sessionId,
  cwd: publishedPayload.cwd,
  selectedWorkerId: publishedPayload.selectedWorkerId,
  workers: publishedPayload.workers,
}));
const publishedPath = await publisher.open("session/test", monitorFixture);
const firstPublished = parseMonitorSnapshot(readFileSync(publishedPath, "utf8"));
eq("monitor publisher writes owner-only snapshot", [firstPublished?.connected, firstPublished?.workers.length, statSync(publishedPath).mode & 0o777], [true, 1, 0o600]);
publishedPayload = { ...publishedPayload, workers: [] };
publisher.refresh();
await new Promise((resolve) => setTimeout(resolve, 140));
const refreshedSnapshot = parseMonitorSnapshot(readFileSync(publishedPath, "utf8"));
eq("monitor publisher refreshes atomically", [refreshedSnapshot?.connected, refreshedSnapshot?.workers.length], [true, 0]);
await publisher.close("test complete");
const closedSnapshot = parseMonitorSnapshot(readFileSync(publishedPath, "utf8"));
eq("monitor publisher closes sidecar", [publisher.active, closedSnapshot?.connected, closedSnapshot?.closed, closedSnapshot?.closeReason], [false, false, true, "test complete"]);
const racingOpen = publisher.open("session/test", monitorFixture);
const racingClose = publisher.close("racing close wins");
await Promise.all([racingOpen, racingClose]);
const raceClosedSnapshot = parseMonitorSnapshot(readFileSync(publishedPath, "utf8"));
eq("monitor serializes open then close", [publisher.active, raceClosedSnapshot?.connected, raceClosedSnapshot?.closeReason], [false, false, "racing close wins"]);
const racingCloseFirst = publisher.close("older close");
const racingReopen = publisher.open("session/test", monitorFixture);
await Promise.all([racingCloseFirst, racingReopen]);
const raceOpenSnapshot = parseMonitorSnapshot(readFileSync(publishedPath, "utf8"));
eq("monitor serializes close then open", [publisher.active, raceOpenSnapshot?.connected, raceOpenSnapshot?.closed], [true, true, undefined]);
await publisher.close("race test complete");
let strictPayload: typeof publishedPayload | undefined = { ...publishedPayload, sessionId: "session-A" };
const strictPublisher = new FusionMonitorPublisher(() => {
  if (!strictPayload) throw new Error("payload unavailable");
  return {
    schemaVersion: 1,
    sessionId: strictPayload.sessionId,
    cwd: strictPayload.cwd,
    selectedWorkerId: strictPayload.selectedWorkerId,
    workers: strictPayload.workers,
  };
});
const sessionAPath = await strictPublisher.open("session-A", monitorFixture);
strictPayload = undefined;
let sessionBError = "";
try {
  await strictPublisher.open("session-B", monitorFixture);
} catch (error) {
  sessionBError = error instanceof Error ? error.message : String(error);
}
eq("monitor never reuses prior session payload on open", [
  sessionBError,
  strictPublisher.active,
  strictPublisher.path,
  existsSync(_join(monitorFixture, "session-B.json")),
  parseMonitorSnapshot(readFileSync(sessionAPath, "utf8"))?.sessionId,
], ["payload unavailable", true, sessionAPath, false, "session-A"]);
await strictPublisher.close("strict capture test complete");
eq("monitor leaves no temporary snapshots", readdirSync(monitorFixture).filter((name) => name.endsWith(".tmp")), []);
rmSync(monitorFixture, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
