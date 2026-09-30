/** Real runtimes and in-memory append callbacks only; no model or session files. */
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai/compat";
import { zeroUsage } from "./cost.ts";
import { InquiryRuntime } from "./inquiry.ts";
import { WorkerRuntime } from "./runtime.ts";

type Entry = { type: "custom"; customType: string; data: any };
const journal = () => {
  const entries: Entry[] = [];
  return { entries, append: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); } };
};
const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 2 } as Message);
const spawn = (runtime: WorkerRuntime) => runtime.spawn({ label: "Fixture", executorModelId: "local/fixture", firstMessage: user("Complete the requested work") });
const restore = (entries: Entry[]) => { const runtime = new WorkerRuntime(); runtime.restore(entries); return runtime; };

// A long-running single turn writes each tool output once instead of repeating
// all previous outputs at every checkpoint.
const growth = new WorkerRuntime();
const growing = spawn(growth);
const growthLog = journal();
growth.persist(growing.worker.id, growthLog.append);
let fullBytes = 0;
let halfBytes = 0;
for (let i = 0; i < 80; i++) {
  const history = [...growing.worker.history, assistant(`Progress ${i}: ${"x".repeat(2_000)}`)];
  const usage = { ...zeroUsage(), input: i + 1, output: i + 1, totalTokens: (i + 1) * 2, cost: (i + 1) / 10 };
  growth.checkpointTurn(growing.turn.id, history, usage, { latestExecutor: "local/fixture", context: { known: true, tokens: i + 1, window: 8_192 } });
  assert.equal(growth.persist(growing.worker.id, growthLog.append), true);
  fullBytes += JSON.stringify(growth.snapshotWorker(growing.worker.id)).length;
  if (i === 39) halfBytes = JSON.stringify(growthLog.entries).length;
}
const incrementalBytes = JSON.stringify(growthLog.entries).length;
assert.ok(incrementalBytes < fullBytes / 10, "journal size is proportional to new history, not the repeated full history");
assert.ok(incrementalBytes < halfBytes * 2.1, "doubling checkpoints produces approximately linear journal growth");
assert.equal(growthLog.entries.filter((entry) => entry.customType === "fusion-worker").length, 1);
assert.ok(growthLog.entries.slice(1).every((entry) => entry.customType === "fusion-worker-delta" && entry.data.history.messages.length === 1 && entry.data.turns.length === 1));
const grown = restore(growthLog.entries);
assert.deepEqual(grown.getWorker(growing.worker.id)!.history, growing.worker.history);
assert.deepEqual(grown.getWorker(growing.worker.id)!.telemetry, growing.worker.telemetry);
assert.deepEqual(grown.getTurn(growing.turn.id)!.usage, growing.turn.usage);
assert.equal(grown.getTurn(growing.turn.id)!.status, "interrupted");
assert.equal(grown.getWorker(growing.worker.id)!.activeTurnId, null);
assert.equal(growth.persist(growing.worker.id, () => assert.fail("no-op must not append")), false);
assert.equal(growth.persist("missing", growthLog.append), false);

// Results arriving after an assistant tool-call checkpoint must prevent repair
// from inventing errors in the middle of an otherwise complete batch.
const batch = new WorkerRuntime();
const current = spawn(batch);
const batchLog = journal();
batch.persist(current.worker.id, batchLog.append);
const calls = { role: "assistant", content: [
  { type: "toolCall", id: "a", name: "write", arguments: { path: "a" } },
  { type: "toolCall", id: "b", name: "write", arguments: { path: "b" } },
], stopReason: "toolUse", timestamp: 2 } as unknown as Message;
const result = (id: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "write", content: [{ type: "text", text: `Saved ${id}` }], isError: false, timestamp: 3 });
current.worker.history.push(calls);
batch.persist(current.worker.id, batchLog.append);
current.worker.history.push(result("a"));
batch.persist(current.worker.id, batchLog.append);
current.worker.history.push(result("b"));
batch.persist(current.worker.id, batchLog.append);
const completeBatch = restore(batchLog.entries).getWorker(current.worker.id)!.history;
assert.deepEqual(completeBatch, current.worker.history, "apply all deltas before repairing the batch");
const crashedBatch = restore(batchLog.entries.slice(0, 3)).getWorker(current.worker.id)!.history;
assert.equal(crashedBatch.length, 4);
assert.deepEqual(crashedBatch[2], result("a"));
assert.match(JSON.stringify(crashedBatch[3]), /outcome and possible side effects are unknown/);
batch.finishTurn(current.turn.id, "All writes finished", []);
batch.persist(current.worker.id, batchLog.append);
assert.equal(batchLog.entries.at(-1)!.data.history, undefined, "status-only changes do not repeat history");
assert.equal(restore(batchLog.entries).getTurn(current.turn.id)!.status, "completed", "running normalization happens only after final turn updates");

// Replacing/compacting history and mutating an existing message are not appends.
current.worker.history = [user("Compacted state"), assistant("Relevant progress retained")];
batch.persist(current.worker.id, batchLog.append);
assert.equal(batchLog.entries.at(-1)!.data.history.type, "replace");
(current.worker.history[1] as any).content[0].text = "Corrected retained progress";
batch.persist(current.worker.id, batchLog.append);
assert.equal(batchLog.entries.at(-1)!.data.history.type, "replace", "the cursor compares values, not shared Message references");
assert.deepEqual(restore(batchLog.entries).getWorker(current.worker.id)!.history, current.worker.history);
const earlierFull = JSON.stringify(batchLog.entries[0]);
const restoredBatch = restore(batchLog.entries);
(restoredBatch.getWorker(current.worker.id)!.history[1] as any).content[0].text = "Runtime mutation";
assert.doesNotMatch(JSON.stringify(batchLog.entries), /Runtime mutation/);
assert.equal(JSON.stringify(batchLog.entries[0]), earlierFull, "restore and runtime changes do not mutate retained journal objects");

// Every generation retains its final turn details, while only updated turns
// appear in the next delta. Usage is absolute and must never be re-added.
const next = batch.followup(current.worker.id, user("Follow-up task"));
batch.persist(current.worker.id, batchLog.append);
assert.deepEqual(batchLog.entries.at(-1)!.data.turns.map((turn: any) => turn.id), [next.id]);
const usage = { ...zeroUsage(), input: 10, output: 5, totalTokens: 15, cost: 0.25 };
batch.checkpointTurn(next.id, current.worker.history, usage);
batch.failTurn(next.id, "A retryable failure");
batch.persist(current.worker.id, batchLog.append);
const replayed = restore(batchLog.entries);
assert.equal(replayed.getWorker(current.worker.id)!.generation, 2);
assert.equal(replayed.getWorker(current.worker.id)!.failures, 1);
assert.deepEqual(replayed.getWorker(current.worker.id)!.telemetry!.cumulative, usage);
assert.equal(replayed.getTurn(current.turn.id)!.text, "All writes finished");
assert.equal(replayed.getTurn(next.id)!.error, "A retryable failure");
assert.deepEqual(replayed.getTurn(next.id)!.usage, usage);

// Missing, foreign, or malformed prior state cannot receive a delta. A fork
// from a selected prefix re-anchors on its first write and is self-contained.
const branch = new WorkerRuntime();
const forked = spawn(branch);
const branchLog = journal();
branch.persist(forked.worker.id, branchLog.append);
forked.worker.history.push(assistant("First checkpoint"));
branch.persist(forked.worker.id, branchLog.append);
forked.worker.history.push(assistant("Second checkpoint"));
branch.persist(forked.worker.id, branchLog.append);
assert.equal(restore([branchLog.entries[2]!]).list().length, 0);
assert.equal(restore([branchLog.entries[0]!, branchLog.entries[2]!]).getWorker(forked.worker.id)!.history.length, 1);
const other = new WorkerRuntime();
other.restore([branchLog.entries[0]!]);
const otherLog = journal();
other.persist(forked.worker.id, otherLog.append);
assert.equal(otherLog.entries[0]!.customType, "fusion-worker");
assert.equal(restore([otherLog.entries[0]!, branchLog.entries[1]!]).getWorker(forked.worker.id)!.history.length, 1, "a different base revision blocks a sibling branch's delta");
branch.restore(branchLog.entries.slice(0, 2));
const forkLog = journal();
branch.persist(forked.worker.id, forkLog.append);
assert.equal(forkLog.entries[0]!.customType, "fusion-worker");
assert.equal(restore(forkLog.entries).getWorker(forked.worker.id)!.history.length, 2);
assert.equal(branch.persist(forked.worker.id, forkLog.append), false);

for (const corrupt of [
  (data: any) => { data.version = 2; },
  (data: any) => { data.base = "wrong-base"; },
  (data: any) => { data.revision = data.base; },
  (data: any) => { data.id = "different-worker"; },
  (data: any) => { data.record.id = "different-worker"; },
  (data: any) => { data.record.history = []; },
  (data: any) => { data.record.status = "unknown"; },
  (data: any) => { data.history.offset = 999; },
  (data: any) => { data.history.messages = [null]; },
  (data: any) => { data.history.messages = [{ role: "assistant", content: [null] }]; },
  (data: any) => { data.turns = [{ ...forked.turn, workerId: "foreign-worker" }]; },
]) {
  const bad = structuredClone(branchLog.entries[1]!);
  corrupt(bad.data);
  const restored = restore([branchLog.entries[0]!, bad, branchLog.entries[2]!]);
  assert.equal(restored.getWorker(forked.worker.id)!.history.length, 1, "reject the invalid delta and subsequent dependents");
}

// An append may throw after the SDK has retained the entry. Retry a full anchor
// whether the failed delta was retained or not; never advance its writer cursor.
for (const retained of [false, true]) {
  const runtime = new WorkerRuntime();
  const active = spawn(runtime);
  const log = journal();
  runtime.persist(active.worker.id, log.append);
  active.worker.history.push(assistant("Durable after retry"));
  assert.throws(() => runtime.persist(active.worker.id, (type, data) => {
    if (retained) log.append(type, data);
    throw new Error("Disk full");
  }), /Disk full/);
  runtime.persist(active.worker.id, log.append);
  assert.equal(log.entries.at(-1)!.customType, "fusion-worker");
  assert.deepEqual(restore(log.entries).getWorker(active.worker.id)!.history, active.worker.history);
  assert.equal(runtime.persist(active.worker.id, log.append), false);
}

// Legacy entries remain readable and can be followed by a new complete anchor
// and deltas. Public snapshots are detached and one-worker reads are isolated.
const legacy = new WorkerRuntime();
const legacyWorker = spawn(legacy);
legacy.finishTurn(legacyWorker.turn.id, "Legacy completion", [assistant("Legacy completion")]);
const legacyEntry: Entry = { type: "custom", customType: "fusion-worker", data: legacy.snapshotWorker(legacyWorker.worker.id) };
const resumed = restore([legacyEntry]);
const resumedLog = journal();
resumed.persist(legacyWorker.worker.id, resumedLog.append);
resumed.followup(legacyWorker.worker.id, user("Modern follow-up"));
resumed.persist(legacyWorker.worker.id, resumedLog.append);
assert.equal(restore([legacyEntry, ...resumedLog.entries]).getWorker(legacyWorker.worker.id)!.history.length, 3);
assert.equal(restore([legacyEntry, ...resumedLog.entries]).getTurn(legacyWorker.turn.id)!.text, "Legacy completion");
const detached = resumed.snapshotWorker(legacyWorker.worker.id)!;
detached.worker.history[0] = user("Snapshot-only change");
detached.worker.telemetry!.cumulative.cost = 999;
assert.doesNotMatch(JSON.stringify(resumed.getWorker(legacyWorker.worker.id)), /Snapshot-only change|999/);
const unrelated = spawn(resumed);
Object.defineProperty(unrelated.worker, "history", { get: () => { throw new Error("Unrelated worker was cloned"); } });
assert.equal(resumed.snapshotWorker(legacyWorker.worker.id)!.worker.id, legacyWorker.worker.id);
assert.equal(resumed.persist(legacyWorker.worker.id, resumedLog.append), false);

// Inquiry windows roll over, but all turn answers and ownership observations
// remain durable. The same writer handles changed-turn-only and replacement.
const inquiries = new InquiryRuntime();
const thread = inquiries.create("wrk_observed");
const inquiryLog = journal();
inquiries.persist(thread.id, inquiryLog.append);
const inquiryIds: string[] = [];
for (let i = 0; i < 5; i++) {
  const turn = inquiries.start(thread.id, user(`Question ${i}`), { workerGeneration: i + 1, workerTurnId: `trn_observed_${i}`, capturedAt: i });
  inquiryIds.push(turn.id);
  inquiries.persist(thread.id, inquiryLog.append);
  assert.deepEqual(inquiryLog.entries.at(-1)!.data.turns.map((item: any) => item.id), [turn.id]);
  inquiries.finish(turn.id, `Answer ${i}`, assistant(`Answer ${i}`), 4);
  inquiries.persist(thread.id, inquiryLog.append);
  assert.equal(inquiryLog.entries.at(-1)!.data.history.type, i < 2 ? "append" : "replace");
}
assert.equal(inquiries.persist(thread.id, inquiryLog.append), false);
const restoredInquiries = new InquiryRuntime();
restoredInquiries.restore(inquiryLog.entries);
assert.deepEqual(restoredInquiries.snapshot(thread.id), inquiries.snapshot(thread.id));
assert.equal(restoredInquiries.getThread(thread.id)!.history.length, 4);
assert.equal(restoredInquiries.getTurn(inquiryIds[0]!)!.answer, "Answer 0");
assert.equal(restoredInquiries.getTurn(inquiryIds[4]!)!.workerGeneration, 5);
const pending = inquiries.start(thread.id, user("Pending query"), { workerGeneration: 6, workerTurnId: null });
inquiries.persist(thread.id, inquiryLog.append);
restoredInquiries.restore(inquiryLog.entries);
assert.equal(restoredInquiries.getTurn(pending.id)!.status, "interrupted");
assert.equal(restoredInquiries.getThread(thread.id)!.activeTurnId, null);
const originalEntry = JSON.stringify(inquiryLog.entries);
restoredInquiries.getTurn(inquiryIds[0]!)!.answer = "Altered runtime answer";
assert.equal(JSON.stringify(inquiryLog.entries), originalEntry);
const inquiryLegacy: Entry = { type: "custom", customType: "fusion-inquiry", data: inquiries.snapshot(thread.id)[0] };
restoredInquiries.restore([inquiryLegacy]);
const inquiryAnchor = journal();
restoredInquiries.persist(thread.id, inquiryAnchor.append);
assert.equal(inquiryAnchor.entries[0]!.customType, "fusion-inquiry");
assert.equal(inquiryAnchor.entries[0]!.data.turns.length, 6);

console.log(`ok   incremental journals: ${incrementalBytes} bytes vs ${fullBytes} repeated-full bytes; replay, repair, branches, retry, and inquiry windows`);
