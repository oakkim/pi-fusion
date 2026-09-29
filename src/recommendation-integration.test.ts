import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import fusionExtension from "./index.ts";
import { WorkerRuntime, type WorkerRecord } from "./runtime.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-fusion-recommendation-"));
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalList = WorkerRuntime.prototype.list;
const handlers = new Map<string, (...args: any[]) => any>();
const commands = new Map<string, any>();
const notifications: string[] = [];
const emitted: unknown[] = [];
const notices: Array<{ customType: string; data: { text: string } }> = [];
const renderers = new Map<string, (...args: any[]) => any>();
const defaultTools = ["fusion_spawn", "fusion_followup", "ask_advisor"];
let activeTools = [...defaultTools];
let workers: WorkerRecord[] = [];
let now = 1_000;
let maximumHookMs = 0;
const requests: Array<{ signal: AbortSignal; evidence: any; settled: boolean; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
const model = { provider: "test", id: "advisor", input: ["text"] };
const context: any = {
  cwd: directory, mode: "tui", hasUI: false,
  isProjectTrusted: () => false,
  ui: { notify: (text: string) => notifications.push(text) },
  modelRegistry: { getAll: () => [model], getAvailable: () => [model], hasConfiguredAuth: () => true },
  sessionManager: { getBranch: () => [], getSessionId: () => "recommendation-test" },
};
const messages: any[] = [
  { role: "user", content: "Investigate the lock contention and implement the independent API and UI fixes.", timestamp: 1 },
  { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "Second attempt failed: deadlock" }], isError: true, timestamp: 2 },
];
const answer = () => Response.json({
  model: "local", usage: { prompt_tokens: 120, completion_tokens: 40 },
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ reason: "Both unresolved diagnosis and scoped implementation remain.", advisor: "yes", worker: "yes" }) } }],
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const checkpoint = (input = messages) => {
  const started = performance.now();
  const result = handlers.get("context")!({ messages: input }, context);
  maximumHookMs = Math.max(maximumHookMs, performance.now() - started);
  assert.ok(!result || typeof result.then !== "function", "the context hook must return synchronously, even when fetch never resolves");
  return result;
};
const finish = async (request = requests.at(-1)!, response = answer()) => { request.resolve(response); await flush(); };
const start = (input = messages) => {
  const before = requests.length;
  assert.equal(checkpoint(input), undefined);
  assert.equal(requests.length, before + 1);
  return requests.at(-1)!;
};
const reset = async () => {
  await commands.get("fusion").handler("recommend on", context);
  for (const request of requests) if (!request.settled) request.reject(new Error("Test reset"));
  await flush();
  activeTools = [...defaultTools];
  workers = [];
  now = 1_000;
  delete context.signal;
  handlers.get("turn_start")!({ turnIndex: 0 });
};

try {
  Date.now = () => now;
  WorkerRuntime.prototype.list = () => workers;
  writeFileSync(join(directory, "fusion.json"), JSON.stringify({ recommendations: true, advisorModel: "test/advisor", preserved: "yes" }));
  globalThis.fetch = async (_url, options) => new Promise<Response>((resolve, reject) => {
    assert.equal(requests.filter((request) => !request.settled).length, 0, "never overlap inference requests, including cancelled requests that have not settled");
    const body = JSON.parse(String(options?.body));
    const request = {
      signal: options!.signal!, evidence: JSON.parse(body.messages[1].content), settled: false,
      resolve: (response: Response) => { request.settled = true; resolve(response); },
      reject: (error: Error) => { request.settled = true; reject(error); },
    };
    requests.push(request);
    // Deliberately ignore abort here: the integration must guard late and non-cooperative transports.
  });
  fusionExtension({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: () => {},
    registerEntryRenderer: (name: string, renderer: (...args: any[]) => any) => renderers.set(name, renderer),
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
    appendEntry: (customType: string, data: { text: string }) => notices.push({ customType, data }),
    sendMessage: (...args: unknown[]) => emitted.push(args),
  } as never, { agentDir: directory });
  await handlers.get("session_start")!({}, context);

  const first = start();
  assert.match(first.evidence.prompt, /lock contention/);
  assert.match(first.evidence.recentContext, /deadlock/);
  assert.equal(checkpoint(), undefined, "in-flight work cannot block or launch another request");
  assert.equal(requests.length, 1);
  await finish(first);
  assert.equal(messages.length, 2, "completing inference cannot mutate the captured conversation");
  assert.equal(emitted.length, 0, "completion cannot send a model message or start a turn");
  assert.equal(notices.length, 1, "a ready recommendation immediately creates one UI-only entry");
  assert.equal(notices[0]!.customType, "pi-fusion-recommendation-notice");
  const renderer = renderers.get(notices[0]!.customType)!;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const rendered = renderer(notices[0], { expanded: false }, theme).render(80).join("\n");
  assert.equal(rendered.trimEnd(), "Fusion Recommendation - Advisor: yes · Worker: yes · 0.0s");
  const legacyNotice = { data: { text: "Advisor: no · Worker: no · default_model · 7279ms · 4115 local tokens · bounded context" } };
  assert.equal(renderer(legacyNotice, { expanded: false }, theme).render(80).join("\n").trimEnd(), "Fusion Recommendation - Advisor: no · Worker: no · 7.2s");
  assert.doesNotMatch(rendered, /Both unresolved/, "free-form model rationale is not copied into the English UI");
  assert.equal(renderer({ data: null }, { expanded: false }, theme), undefined, "malformed saved entries cannot crash rendering");
  handlers.get("turn_start")!({ turnIndex: 1 });
  const delivered = checkpoint();
  assert.equal(delivered.messages.length, messages.length + 1);
  assert.equal(delivered.messages.at(-1).customType, "pi-fusion-recommendation");
  assert.equal(delivered.messages.at(-1).display, false);
  assert.match(delivered.messages.at(-1).content, /earlier checkpoint/);
  assert.match(delivered.messages.at(-1).content, /Ignore it if newer evidence/);
  assert.match(JSON.stringify(convertToLlm(delivered.messages).at(-1)), /advisor=yes, worker=yes/);
  assert.equal(checkpoint(), undefined, "consume the ready hint once");
  assert.equal(requests.length, 1);
  assert.equal(notices.length, 1, "consuming a hint cannot duplicate its visible entry");
  handlers.get("turn_start")!({ turnIndex: 4 });
  start();
  assert.equal(requests.length, 2, "the original four-turn cadence remains");

  // A changed checkpoint cancels an in-flight request without overlapping it or awaiting it.
  const cancelled = requests.at(-1)!;
  const steer = { role: "user", content: "Only explain the options now; do not delegate.", timestamp: 3 };
  const steered = [...messages, steer];
  assert.equal(checkpoint(steered), undefined);
  assert.equal(cancelled.signal.aborted, true);
  assert.equal(requests.length, 2);
  const beforeCancelled = notices.length;
  await finish(cancelled);
  assert.equal(notices.length, beforeCancelled, "cancelled completions cannot display stale recommendations");
  const fresh = start(steered);
  assert.equal(fresh.evidence.prompt, steer.content);
  await finish(fresh);
  assert.ok(checkpoint(steered));

  await reset();
  const queuedSteer = start();
  const beforeSteer = notices.length;
  await handlers.get("input")!({ source: "interactive", text: steer.content, images: [] }, context);
  assert.equal(queuedSteer.signal.aborted, true);
  await finish(queuedSteer);
  assert.equal(notices.length, beforeSteer, "a queued user steer suppresses stale display before another context hook runs");
  start(steered);

  // Recheck stale completed hints at delivery, not just when the response arrives.
  const worker = (): WorkerRecord => ({ id: "wrk_test", label: "tests", status: "running", generation: 1, activeTurnId: "trn_first", history: [], failures: 0, executorModelId: "test/worker", createdAt: 0 });
  for (const change of ["steer", "worker-result", "capability", "worker-state", "age", "turn-limit"] as const) {
    await reset();
    if (change === "worker-state") workers = [worker()];
    const request = start();
    await finish(request);
    let next = messages;
    if (change === "steer") next = steered;
    if (change === "worker-result") next = [...messages, { role: "custom", customType: "pi-fusion-worker-result", content: "Worker completed and verified", timestamp: 4 }];
    if (change === "capability") activeTools = ["fusion_spawn", "fusion_followup"];
    if (change === "worker-state") { workers[0]!.generation = 2; workers[0]!.activeTurnId = "trn_second"; }
    if (change === "age") now += 30_001;
    if (change === "turn-limit") handlers.get("turn_start")!({ turnIndex: 4 });
    assert.equal(checkpoint(next), undefined, `${change} must discard a completed hint`);
    assert.equal(requests.length, requests.indexOf(request) + 2, `${change} permits a fresh background request`);
    if (change === "capability") assert.equal(requests.at(-1)!.evidence.advisorAvailable, false);
  }

  // Completion itself must recheck capabilities and workers even without an intervening context hook.
  for (const change of ["capability", "worker-state", "age", "turn-limit"] as const) {
    await reset();
    const request = start();
    if (change === "capability") activeTools = ["fusion_spawn", "fusion_followup"];
    if (change === "worker-state") workers = [worker()];
    if (change === "age") now += 30_001;
    if (change === "turn-limit") handlers.get("turn_start")!({ turnIndex: 4 });
    const beforeCompletion: number = notices.length;
    await finish(request);
    assert.equal(notices.length, beforeCompletion, `${change} must suppress a stale chat entry`);
    assert.equal(checkpoint(), undefined, `${change} must discard a late completion`);
  }

  await reset();
  const beforeFailure = notices.length;
  await finish(start(), new Response("offline", { status: 503 }));
  assert.equal(notices.length, beforeFailure, "failed inference must not display a recommendation");
  handlers.get("agent_end")!();
  await commands.get("fusion").handler("recommend status", context);
  assert.match(notifications.at(-1)!, /unavailable/, "agent_end keeps the last error available in status");

  await reset();
  await finish(start());
  await commands.get("fusion").handler("recommend off", context);
  const saved = JSON.parse(readFileSync(join(directory, "fusion.json"), "utf8"));
  assert.equal(saved.recommendations, false);
  assert.equal(saved.preserved, "yes");
  const beforeOff = requests.length;
  assert.equal(checkpoint(), undefined);
  assert.equal(requests.length, beforeOff);

  await reset();
  const disabled = start();
  const beforeDisabled = notices.length;
  await commands.get("fusion").handler("recommend off", context);
  await finish(disabled);
  assert.equal(notices.length, beforeDisabled, "disabling recommendations suppresses a late visible entry");

  await reset();
  const leadAbort = new AbortController();
  context.signal = leadAbort.signal;
  const escaped = start();
  leadAbort.abort(new Error("User pressed Escape"));
  await finish(escaped);
  assert.equal(checkpoint(), undefined);

  await reset();
  await finish(start());
  handlers.get("agent_end")!();
  await commands.get("fusion").handler("recommend status", context);
  assert.match(notifications.at(-1)!, /Advisor: yes.*Worker: yes/, "agent_end keeps the last result available in status");
  assert.equal(checkpoint(), undefined, "agent_end discards a ready hint");

  await reset();
  const previousRun = start();
  handlers.get("agent_end")!();
  assert.equal(previousRun.signal.aborted, true);
  handlers.get("before_agent_start")!({ systemPrompt: "", systemPromptOptions: { sections: {} }, prompt: "New task" }, context);
  await finish(previousRun, new Response("late failure", { status: 503 }));
  await commands.get("fusion").handler("recommend status", context);
  assert.match(notifications.at(-1)!, /awaiting a checkpoint/, "an aborted previous run cannot overwrite the next run's status");
  const nextRun = start(steered);
  await finish(nextRun);
  assert.ok(checkpoint(steered));

  await reset();
  const shutdown = start();
  await handlers.get("session_shutdown")!({}, context);
  assert.equal(shutdown.signal.aborted, true);
  await finish(shutdown);
  assert.equal(checkpoint(), undefined);
  await handlers.get("session_start")!({}, context);
  assert.equal(checkpoint(), undefined, "a new session cannot receive an old result");
  assert.equal(emitted.length, 0, "chat entries never send model messages or restart the Lead");
  console.log(`ok   recommendation integration: nonblocking hook (max ${maximumHookMs.toFixed(2)}ms), one in-flight request, single hint and chat entry, freshness, cancellation, no model messages`);
} finally {
  await handlers.get("session_shutdown")?.({}, context);
  for (const request of requests) if (!request.settled) request.reject(new Error("Test cleanup"));
  await flush();
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  WorkerRuntime.prototype.list = originalList;
  rmSync(directory, { recursive: true, force: true });
}
