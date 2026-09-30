/** Exercise the existing pane timer and native extension hooks without model calls. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import fusionExtension from "./index.ts";
import { InquiryRuntime } from "./inquiry.ts";
import { FusionPaneController } from "./pane.ts";
import { WORKER_REVIEW_GUIDANCE } from "./recommendations.ts";
import { WorkerRuntime } from "./runtime.ts";

const directory = mkdtempSync(join(tmpdir(), "fusion-worker-review-"));
const originalFetch = globalThis.fetch;
const originalRuntimeRestore = WorkerRuntime.prototype.restore;
const originalPaneRestore = FusionPaneController.prototype.restore;
const originalInquiryRestore = InquiryRuntime.prototype.restore;
let capturedRuntime: WorkerRuntime;
let capturedPane: FusionPaneController;
let capturedInquiries: InquiryRuntime;
let fetches = 0;
let fixtureCount = 0;
const cleanups: Array<() => Promise<void>> = [];
const source = [{ role: "user", content: "Finish the API work and report progress.", timestamp: 1 }];
const tick = (ms: number) => { mock.timers.tick(ms); mock.timers.tick(60); };

async function fixture(agentDir = join(directory, String(fixtureCount++))) {
  mkdirSync(agentDir, { recursive: true });
  if (!existsSync(join(agentDir, "fusion.json"))) writeFileSync(join(agentDir, "fusion.json"), JSON.stringify({ recommendations: true, preserved: "keep" }));
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const journal: any[] = [];
  const sent: Array<{ message: any; options: any }> = [];
  const notices: string[] = [];
  const state = { idle: false, tools: ["fusion_status"] };
  const context: any = {
    cwd: agentDir, hasUI: false, mode: "tui", signal: new AbortController().signal,
    isIdle: () => state.idle, isProjectTrusted: () => false,
    ui: { notify: (text: string) => notices.push(text) },
    sessionManager: { getBranch: () => journal, getEntries: () => journal, getSessionId: () => agentDir, getLeafId: () => undefined },
    modelRegistry: { getAll: () => [], getAvailable: () => [], hasConfiguredAuth: () => false },
  };
  fusionExtension({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool() {}, registerEntryRenderer() {},
    getActiveTools: () => state.tools,
    appendEntry: (customType: string, data: unknown) => journal.push({ type: "custom", customType, data }),
    sendMessage: (message: any, options: any) => {
      sent.push({ message, options });
      journal.push({ type: "message", message: { role: "custom", ...message } });
    },
  } as never, { agentDir });
  await handlers.get("session_start")!({}, context);
  const runtime = capturedRuntime!;
  const pane = capturedPane!;
  const inquiries = capturedInquiries!;
  const close = async () => { await handlers.get("session_shutdown")!({}, context); };
  cleanups.push(close);
  const start = () => {
    const { worker, turn } = runtime.spawn({ label: "API", executorModelId: "fixture/no-model",
      firstMessage: { role: "user", content: "Fix the slow API query; preserve existing clients.", timestamp: Date.now() } });
    worker.history.push({ role: "assistant", content: [
      { type: "thinking", thinking: "PRIVATE_THOUGHT", signature: "PRIVATE_SIGNATURE" },
      { type: "text", text: "Public progress: checking the failing query." },
      { type: "toolCall", id: "test-call", name: "bash", arguments: { command: "npm test" } },
    ], stopReason: "toolUse", timestamp: Date.now() } as never,
    { role: "toolResult", toolCallId: "test-call", toolName: "bash", content: [{ type: "text", text: "Public test failure: query timeout" }], isError: true, timestamp: Date.now() });
    pane.beginLive(worker.id);
    pane.updateLive(worker.id, { kind: "phase", phase: "responding", text: "Public live progress" });
    pane.updateLive(worker.id, { kind: "tool_start", toolId: "live-call", name: "bash", arguments: "npm test" });
    pane.updateLive(worker.id, { kind: "tool_end", toolId: "live-call", ok: false, output: "Public live failure" });
    assert.equal(pane.liveTimerActive, true, "the existing elapsed timer drives review checks without an open UI");
    return { worker, turn };
  };
  const marker = () => ({ role: "custom", ...sent.at(-1)!.message, timestamp: Date.now() });
  const checkpoint = (messages: any[] = source) => handlers.get("context")!({ messages }, context);
  const review = (messages: any[]) => checkpoint(messages)?.messages.find((message: any) => message.customType === "pi-fusion-worker-review");
  const command = (args: string) => commands.get("fusion").handler(`recommend ${args}`, context);
  return { agentDir, handlers, commands, journal, sent, notices, state, context, runtime, pane, inquiries, start, marker, checkpoint, review, command, close };
}

try {
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000 });
  WorkerRuntime.prototype.restore = function (entries) { capturedRuntime = this; return originalRuntimeRestore.call(this, entries); };
  FusionPaneController.prototype.restore = function (state) { capturedPane = this; return originalPaneRestore.call(this, state); };
  InquiryRuntime.prototype.restore = function (entries) { capturedInquiries = this; return originalInquiryRestore.call(this, entries); };
  globalThis.fetch = (async () => { fetches++; throw new Error("Worker review must not request local inference"); }) as typeof fetch;

  const active = await fixture();
  active.start();
  tick(299_000);
  assert.equal(active.sent.length, 0, "a running worker is not due before five minutes");
  tick(1_000);
  assert.equal(active.sent.length, 1);
  assert.deepEqual(active.sent[0]!.options, { deliverAs: "steer", triggerTurn: true });
  assert.equal(active.sent[0]!.message.content, "");
  assert.equal(active.sent[0]!.message.display, false);
  const firstMarker = active.marker();
  assert.equal(typeof firstMarker.details.reviewId, "string");
  tick(600_000);
  assert.equal(active.sent.length, 1, "many elapsed ticks retain just one pending wake-up marker");
  assert.equal(active.checkpoint(), undefined, "natural checkpoints do not consume a queued review before its marker arrives");
  const oldMarker = { ...firstMarker, details: { reviewId: "old-review" } };
  assert.deepEqual(active.checkpoint([...source, oldMarker])?.messages, source, "an unrelated old marker is filtered without taking the pending review");
  const delivered = active.review([...source, firstMarker]);
  assert.ok(delivered);
  assert.equal(delivered.display, false);
  assert.ok(delivered.content.includes(WORKER_REVIEW_GUIDANCE));
  assert.ok(JSON.stringify(convertToLlm([delivered])).includes(WORKER_REVIEW_GUIDANCE), "Pi's actual message converter preserves the review instructions for the Lead");
  assert.match(delivered.content, /Fix the slow API query|preserve existing clients/);
  assert.match(delivered.content, /Public progress|Public test failure/);
  assert.match(delivered.content, /Public live progress/);
  assert.match(delivered.content, /Public live failure/);
  assert.match(delivered.content, /npm test/);
  assert.doesNotMatch(delivered.content, /PRIVATE_THOUGHT|PRIVATE_SIGNATURE/);
  assert.doesNotMatch(JSON.stringify(active.journal), /Periodic Fusion worker review due|Public live failure/, "only an empty marker, not the gathered snapshot, is journaled");
  assert.deepEqual(active.checkpoint([...source, firstMarker, delivered])?.messages, source, "delivered reviews and duplicate markers cannot become persistent input");
  tick(299_000);
  assert.equal(active.sent.length, 1);
  tick(1_000);
  assert.equal(active.sent.length, 2, "the same active turn becomes due again one interval after review");
  assert.notEqual(active.marker().details.reviewId, firstMarker.details.reviewId);
  const sections: Record<string, string> = {};
  active.handlers.get("before_agent_start")!({ systemPrompt: "Base", systemPromptOptions: { sections, selectedTools: ["fusion_status"] }, prompt: "Continue" }, active.context);
  assert.ok(Object.values(sections).some((text) => text.includes(WORKER_REVIEW_GUIDANCE)));
  await active.close();

  const idle = await fixture();
  idle.state.idle = true;
  delete idle.context.signal;
  idle.start();
  tick(300_000);
  assert.equal(idle.sent.length, 1, "periodic review can wake an idle Lead while its worker runs");
  assert.equal(idle.sent[0]!.options.triggerTurn, true);
  assert.ok(idle.review([...source, idle.marker()]));
  await idle.close();

  const normalTools = await fixture();
  normalTools.state.tools = ["fusion_status", "fusion_spawn"];
  normalTools.state.idle = true;
  normalTools.start();
  tick(300_000);
  assert.ok(normalTools.review([...source, normalTools.marker()]));
  assert.equal(fetches, 0, "a timed review does not also trigger normal inference when Fusion spawning is available");
  await normalTools.close();

  const inquiryReview = await fixture();
  const { worker: inquiryWorker, turn: workerTurn } = inquiryReview.start();
  const oldThread = inquiryReview.inquiries.create(inquiryWorker.id);
  const newerIdle = Array.from({ length: 3 }, () => inquiryReview.inquiries.create(inquiryWorker.id));
  const question = { role: "user" as const, content: "What is blocking this query?", timestamp: Date.now() };
  const observation = { workerGeneration: inquiryWorker.generation, workerTurnId: workerTurn.id };
  const activeInquiry = inquiryReview.inquiries.start(oldThread.id, question, observation);
  tick(300_000);
  const inquiryEvidence = JSON.parse(inquiryReview.review([...source, inquiryReview.marker()]).content.split("\n").at(-1))[0];
  assert.equal(inquiryEvidence.inquiries.length, 3);
  assert.deepEqual(inquiryEvidence.inquiries[0], { id: oldThread.id, active_turn: activeInquiry.id }, "an older reused active inquiry takes priority over newer idle threads");
  assert.equal(inquiryEvidence.running_inquiries, 1);
  assert.equal(inquiryEvidence.omitted_inquiries, 1);
  for (const thread of newerIdle) inquiryReview.inquiries.start(thread.id, question, observation);
  tick(300_000);
  const crowdedInquiryEvidence = JSON.parse(inquiryReview.review([...source, inquiryReview.marker()]).content.split("\n").at(-1))[0];
  assert.equal(crowdedInquiryEvidence.inquiries.length, 3);
  assert.ok(crowdedInquiryEvidence.inquiries.every((thread: any) => thread.active_turn));
  assert.equal(crowdedInquiryEvidence.running_inquiries, 4, "running count includes active inquiries omitted from the bounded list");
  assert.equal(crowdedInquiryEvidence.omitted_inquiries, 1);
  await inquiryReview.close();

  const busyWithoutSignal = await fixture();
  delete busyWithoutSignal.context.signal;
  busyWithoutSignal.start();
  tick(300_000);
  assert.equal(busyWithoutSignal.sent.length, 0, "an active context without a run signal cannot schedule during compaction or setup");
  busyWithoutSignal.context.signal = new AbortController().signal;
  tick(1_000);
  assert.equal(busyWithoutSignal.sent.length, 1, "the elapsed gate still applies when a normal active run resumes");
  await busyWithoutSignal.close();

  const settings = await fixture();
  await settings.command("status");
  assert.match(settings.notices.at(-1)!, /Worker review interval: 5 minutes/);
  assert.ok((await settings.commands.get("fusion").getArgumentCompletions("recommend interval ")).some((item: any) => item.value === "recommend interval 10"));
  await settings.command("interval 10");
  const saved = readFileSync(join(settings.agentDir, "fusion.json"), "utf8");
  assert.equal(JSON.parse(saved).recommendationCheckIntervalMinutes, 10);
  assert.equal(JSON.parse(saved).preserved, "keep");
  for (const invalid of ["0", "-1", "1.5", "1441", "NaN"]) {
    await settings.command(`interval ${invalid}`);
    assert.match(settings.notices.at(-1)!, /Usage:/);
    assert.equal(readFileSync(join(settings.agentDir, "fusion.json"), "utf8"), saved);
  }
  settings.start();
  tick(300_000);
  assert.equal(settings.sent.length, 0, "a configured ten-minute interval supersedes the default");
  await settings.command("interval 1");
  tick(1_000);
  assert.equal(settings.sent.length, 1, "interval changes apply to actual elapsed work");
  await settings.close();
  const registeredAgain = await fixture(settings.agentDir);
  await registeredAgain.command("status");
  assert.match(registeredAgain.notices.at(-1)!, /Worker review interval: 1 minutes/);
  await registeredAgain.close();

  for (const change of ["completed", "interrupted", "closed", "replaced", "off", "fusion-off", "capability"] as const) {
    const f = await fixture();
    const { worker, turn } = f.start();
    tick(300_000);
    const queued = f.marker();
    if (change === "completed") f.runtime.finishTurn(turn.id, "Done", []);
    if (change === "interrupted") f.runtime.interrupt(worker.id);
    if (change === "closed") f.runtime.close(worker.id);
    if (change === "replaced") {
      f.runtime.finishTurn(turn.id, "Done", []);
      f.runtime.followup(worker.id, { role: "user", content: "New independent turn", timestamp: Date.now() });
      f.pane.beginLive(worker.id);
    }
    if (change === "off") {
      await f.command("off");
      assert.match(f.notices.at(-1)!, /Local recommendations: off/);
      assert.match(f.notices.at(-1)!, /Worker review interval: 5 minutes/);
    }
    if (change === "fusion-off") f.journal.push({ type: "custom", customType: "fusion-mode", data: { mode: "off" } });
    if (change === "capability") f.state.tools = [];
    assert.deepEqual(f.checkpoint([...source, queued])?.messages, source, `${change} cannot deliver the old review snapshot`);
    tick(1_000);
    assert.equal(f.sent.length, 1, `${change} does not immediately wake the Lead again`);
    await f.close();
  }

  for (const lifecycle of ["session_start", "session_before_tree", "session_shutdown"] as const) {
    const f = await fixture();
    const { worker } = f.start();
    tick(300_000);
    const queued = f.marker();
    await f.handlers.get(lifecycle)!({}, f.context);
    assert.equal(f.pane.liveTimerActive, false, `${lifecycle} cleans up elapsed timers`);
    assert.deepEqual(f.checkpoint([...source, queued])?.messages, source, `${lifecycle} removes pending review delivery`);
    tick(600_000);
    assert.equal(f.sent.length, 1);
    if (lifecycle !== "session_start") assert.notEqual(f.runtime.getWorker(worker.id)?.status, "running");
    if (lifecycle === "session_before_tree") {
      await f.handlers.get("session_tree")!({}, f.context);
      f.start();
      tick(300_000);
      assert.equal(f.sent.length, 2, "a new branch can schedule its own fresh review");
      assert.ok(f.review([...source, f.marker()]));
    }
    await f.close();
  }

  const settled = await fixture();
  settled.start();
  tick(300_000);
  const abandonedMarker = settled.marker();
  settled.handlers.get("agent_end")!({}, settled.context);
  settled.handlers.get("agent_settled")!({}, settled.context);
  assert.deepEqual(settled.checkpoint([...source, abandonedMarker])?.messages, source);
  tick(299_000);
  assert.equal(settled.sent.length, 1, "a settled or aborted Lead does not immediately loop another wake-up");
  tick(1_000);
  assert.equal(settled.sent.length, 2);
  assert.ok(settled.review([...source, settled.marker()]));
  await settled.close();

  const delayedSettled = await fixture();
  delayedSettled.state.idle = true;
  delayedSettled.start();
  delayedSettled.handlers.get("agent_end")!({}, delayedSettled.context);
  // Another extension may await between this run's end and Fusion's settled hook.
  tick(300_000);
  const deferredMarker = delayedSettled.marker();
  delayedSettled.handlers.get("agent_settled")!({}, delayedSettled.context);
  assert.ok(delayedSettled.review([...source, deferredMarker]), "an older run's settled hook cannot discard a newly scheduled review");
  await delayedSettled.close();
  assert.equal(fetches, 0, "periodic worker reviews never call the local recommender");
  console.log("ok   worker review: actual elapsed timer, marker identity, public evidence, persistence, and lifecycle cleanup");
} finally {
  for (const close of cleanups) await close();
  WorkerRuntime.prototype.restore = originalRuntimeRestore;
  FusionPaneController.prototype.restore = originalPaneRestore;
  InquiryRuntime.prototype.restore = originalInquiryRestore;
  globalThis.fetch = originalFetch;
  mock.timers.reset();
  rmSync(directory, { recursive: true, force: true });
}
