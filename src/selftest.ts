/** v0 self-test: no LLM calls. Verifies the persistence core. */
import { WorkerRuntime } from "../src/runtime.ts";
import { AdaptiveRoutingPolicy } from "../src/routing.ts";
import { handoffTaskText } from "../src/prompts.ts";
import { applyDefaults } from "../src/config.ts";
import { buildRecentContext } from "../src/utils.ts";

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
rt.close(worker.id);
eq("closed", rt.getWorker(worker.id)?.status, "closed");
let closedErr = "";
try { rt.followup(worker.id, { role: "user", content: "y", timestamp: 9 } as never); }
catch (e) { closedErr = (e as Error).message; }
eq("closed rejected", closedErr.includes("closed"), true);

// --- 2. independent compaction ---
const rt2 = new WorkerRuntime();
const w2 = rt2.spawn({ label: undefined, executorModelId: "m", firstMessage: { role: "user", content: "t0", timestamp: 0 } as never }).worker;
for (let i = 0; i < 50; i++) {
  w2.history.push({ role: "assistant", content: `m${i}`, timestamp: i } as never);
}
const didCompact = rt2.compactHistory(w2, 40);
eq("compacted", didCompact, true);
eq("compact keeps first+39", [w2.history.length, (w2.history[0] as {content:string}).content], [40, "t0"]);

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
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as _join } from "node:path";
import { promisify as _promisify } from "node:util";
import { createWorktree, execDirOf, mergeWorktree, removeWorktree, validateWorktreeName } from "../src/worktree.ts";

const sh = _promisify(_execFile);
async function tgit(cwd: string, args: string[]): Promise<void> {
  await sh("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
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
