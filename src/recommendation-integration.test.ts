import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import fusionExtension from "./index.ts";
import { compactExecutorHistory } from "./compaction.ts";
import { handoffTaskText } from "./prompts.ts";
import { WorkerRuntime, type WorkerRecord } from "./runtime.ts";
import { RECOMMENDATION_LEAD_GUIDANCE } from "./recommendations.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-fusion-recommendation-"));
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalList = WorkerRuntime.prototype.list;
const handlers = new Map<string, (...args: any[]) => any>();
const commands = new Map<string, any>();
const registeredTools = new Map<string, any>();
const notifications: string[] = [];
const emitted: Array<[{ customType: string; content: string; display: boolean }, { deliverAs?: string; triggerTurn?: boolean }]> = [];
const notices: Array<{ customType: string; data: { text: string } }> = [];
const renderers = new Map<string, (...args: any[]) => any>();
const defaultTools = ["fusion_spawn", "fusion_followup", "ask_advisor"];
let activeTools = [...defaultTools];
let workers: WorkerRecord[] = [];
let runtime: WorkerRuntime | undefined;
let now = 1_000;
let maximumHookMs = 0;
let idle = false;
const requests: Array<{ signal: AbortSignal; evidence: any; messages: any[]; settled: boolean; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
const advisorRequests: Array<{ question: string; signal: AbortSignal; settled: boolean; resolve: (response: any) => void; reject: (error: Error) => void }> = [];
const model = { provider: "test", id: "advisor", api: "openai-completions", input: ["text"], maxTokens: 8192, contextWindow: 128_000, reasoning: false };
const context: any = {
  cwd: directory, mode: "tui", hasUI: false,
  isProjectTrusted: () => false,
  isIdle: () => idle,
  ui: { notify: (text: string) => notifications.push(text) },
  getSystemPrompt: () => "Review only public evidence.",
  modelRegistry: {
    getAll: () => [model], getAvailable: () => [model], hasConfiguredAuth: () => true,
    streamSimple: (requestedModel: typeof model, input: any, options: any) => {
      assert.equal(requestedModel, model);
      const promise = new Promise<any>((resolve, reject) => {
        const request = {
          question: input.messages.at(-1).content, signal: options.signal, settled: false,
          resolve: (response: any) => { request.settled = true; resolve(response); },
          reject: (error: Error) => { request.settled = true; reject(error); },
        };
        advisorRequests.push(request);
        options.signal.addEventListener("abort", () => request.reject(options.signal.reason), { once: true });
      });
      return { result: () => promise };
    },
  },
  sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => undefined, getSessionId: () => "recommendation-test" },
};
const messages: any[] = [
  { role: "user", content: "Investigate the lock contention and implement the independent API and UI fixes.", timestamp: 1 },
  { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "Second attempt failed: deadlock" }], isError: true, timestamp: 2 },
];
const answer = (advisor = "yes", worker = "yes") => Response.json({
  model: "local", usage: { prompt_tokens: 120, completion_tokens: 40 },
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ reason: "Both unresolved diagnosis and scoped implementation remain.", advisor, worker }) } }],
});
const assertWakeup = (call = emitted.at(-1)!) => {
  assert.deepEqual(call, [{ customType: "pi-fusion-recommendation-wakeup", content: "", display: false }, { deliverAs: "followUp" }]);
  assert.equal(Object.hasOwn(call[1], "triggerTurn"), false, "native follow-up requires triggerTurn to remain omitted");
  assert.doesNotMatch(JSON.stringify(call), /rationale|advisor=yes|worker=yes/, "the stored wake-up marker carries no recommendation payload");
  return { role: "custom", ...call[0], timestamp: now };
};
const assertFilteredOnly = (result: any, expected: any[]) => {
  assert.deepEqual(result?.messages, expected, "wake-up markers are removed without adding stale advice");
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const terminal = (message: any = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The requested work is ready." }] }) =>
  handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0, message, toolResults: [], timestamp: now }, context);
const checkpoint = (input = messages) => {
  const started = performance.now();
  const result = handlers.get("context")!({ messages: input }, context);
  maximumHookMs = Math.max(maximumHookMs, performance.now() - started);
  assert.ok(!result || typeof result.then !== "function", "the context hook must return synchronously, even when fetch never resolves");
  return result;
};
const finish = async (request = requests.at(-1)!, response = answer()) => { request.resolve(response); await flush(); };
const recommendationNotices = () => notices.filter((entry) => entry.customType === "pi-fusion-recommendation-notice").length;
const beginAdvisor = (question: string) => {
  const controller = new AbortController();
  const count = advisorRequests.length;
  const result = registeredTools.get("ask_advisor").execute(`advisor-${count}`, { question }, controller.signal, undefined, context);
  assert.equal(advisorRequests.length, count + 1, "real ask_advisor reaches only the deferred fixture provider");
  return { controller, result, request: advisorRequests.at(-1)! };
};
const settleAdvisor = async (call: ReturnType<typeof beginAdvisor>, status: "completed" | "failed" | "interrupted" = "completed") => {
  if (status === "interrupted") call.controller.abort(new Error("Fixture advisor interrupted"));
  else if (status === "failed") call.request.reject(new Error("Fixture advisor failed"));
  else call.request.resolve({ role: "assistant", content: [{ type: "text", text: "Public fixture advice." }], stopReason: "stop", timestamp: now,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const result = await call.result;
  assert.equal(result.details.status, status);
  return result;
};
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
  idle = false;
  emitted.length = 0;
  delete context.signal;
  handlers.get("turn_start")!({ turnIndex: 0 });
};

try {
  Date.now = () => now;
  WorkerRuntime.prototype.list = function () { runtime = this; return workers; };
  writeFileSync(join(directory, "fusion.json"), JSON.stringify({ recommendations: true, advisorModel: "test/advisor", executorTools: "none", preserved: "yes" }));
  globalThis.fetch = async (_url, options) => new Promise<Response>((resolve, reject) => {
    assert.equal(requests.filter((request) => !request.settled).length, 0, "never overlap inference requests, including cancelled requests that have not settled");
    const body = JSON.parse(String(options?.body));
    const evidence = JSON.parse(body.messages[1].content);
    for (const message of body.messages.slice(2)) {
      if (message.role !== "user") continue;
      const update = JSON.parse(message.content);
      if (update.state) Object.assign(evidence, update.state);
      if (update.message) evidence.recentContext += `\n${JSON.stringify(update.message)}`;
    }
    const request = {
      signal: options!.signal!, evidence, messages: body.messages, settled: false,
      resolve: (response: Response) => { request.settled = true; resolve(response); },
      reject: (error: Error) => { request.settled = true; reject(error); },
    };
    requests.push(request);
    // Deliberately ignore abort here: the integration must guard late and non-cooperative transports.
  });
  fusionExtension({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => registeredTools.set(tool.name, tool),
    registerEntryRenderer: (name: string, renderer: (...args: any[]) => any) => renderers.set(name, renderer),
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
    appendEntry: (customType: string, data: { text: string }) => notices.push({ customType, data }),
    sendMessage: (...args: unknown[]) => emitted.push(args as typeof emitted[number]),
  } as never, { agentDir: directory });
  await handlers.get("session_start")!({}, context);

  const preparePrompt = (systemPrompt: string, sections?: Record<string, string>, selectedTools = defaultTools) => handlers.get("before_agent_start")!({
    systemPrompt, systemPromptOptions: { selectedTools, ...(sections ? { sections } : {}) }, prompt: "Continue the current task",
  }, context);
  const nativeSections: Record<string, string> = { other_extension: "Preserve this section" };
  assert.equal(preparePrompt("Base system rules", nativeSections), undefined);
  assert.equal(nativeSections.pi_fusion_recommendation_ack, RECOMMENDATION_LEAD_GUIDANCE);
  assert.ok(nativeSections.pi_fusion_routing);
  assert.ok(nativeSections.pi_advisor);
  const routing = nativeSections.pi_fusion_routing;
  const advisorGuidance = nativeSections.pi_advisor;
  preparePrompt("Base system rules", nativeSections);
  assert.equal(nativeSections.pi_fusion_recommendation_ack, RECOMMENDATION_LEAD_GUIDANCE, "native guidance is idempotent");
  const legacyEnabled = preparePrompt("Base system rules").systemPrompt;
  assert.match(legacyEnabled, /<pi_fusion_routing>/);
  assert.match(legacyEnabled, /<pi_advisor>/);
  assert.ok(legacyEnabled.includes(RECOMMENDATION_LEAD_GUIDANCE));
  const legacyRepeated = preparePrompt(legacyEnabled)?.systemPrompt ?? legacyEnabled;
  assert.equal(legacyRepeated, legacyEnabled, "legacy guidance is not duplicated");
  await commands.get("fusion").handler("recommend off", context);
  preparePrompt("Base system rules", nativeSections);
  assert.equal(nativeSections.pi_fusion_recommendation_ack, undefined);
  assert.equal(nativeSections.pi_fusion_routing, routing);
  assert.equal(nativeSections.pi_advisor, advisorGuidance);
  assert.equal(nativeSections.other_extension, "Preserve this section");
  const legacyDisabled = preparePrompt(legacyEnabled).systemPrompt;
  assert.doesNotMatch(legacyDisabled, /pi_fusion_recommendation_ack|acknowledgment is required/);
  assert.match(legacyDisabled, /<pi_fusion_routing>/);
  assert.match(legacyDisabled, /<pi_advisor>/);
  await commands.get("fusion").handler("recommend on", context);
  const getBranch = context.sessionManager.getBranch;
  context.sessionManager.getBranch = () => [{ type: "custom", customType: "fusion-mode", data: { mode: "off" } }];
  try {
    preparePrompt("Base system rules", nativeSections, ["ask_advisor"]);
    assert.equal(nativeSections.pi_fusion_recommendation_ack, RECOMMENDATION_LEAD_GUIDANCE, "Advisor-only recommendations retain the acknowledgment rule with Fusion off");
    assert.equal(nativeSections.pi_fusion_routing, undefined);
    assert.equal(nativeSections.pi_advisor, advisorGuidance);
    const advisorOnly = preparePrompt("Base system rules", undefined, ["ask_advisor"]).systemPrompt;
    assert.ok(advisorOnly.includes(RECOMMENDATION_LEAD_GUIDANCE));
    assert.match(advisorOnly, /<pi_advisor>/);
    assert.doesNotMatch(advisorOnly, /<pi_fusion_routing>/);
  } finally { context.sessionManager.getBranch = getBranch; }

  const first = start();
  assert.match(first.evidence.prompt, /lock contention/);
  assert.match(first.evidence.recentContext, /deadlock/);
  assert.equal(checkpoint(), undefined, "in-flight work cannot block or launch another request");
  assert.equal(requests.length, 1);
  await finish(first);
  assert.equal(messages.length, 2, "completing inference cannot mutate the captured conversation");
  assert.equal(emitted.length, 0, "inference completion only stores pending advice without queueing a message");
  await terminal();
  assert.equal(emitted.length, 1, "pending positive advice requests one checkpoint when the active Lead is about to stop");
  const firstWakeup = assertWakeup();
  assert.equal(notices.length, 1, "a ready recommendation immediately creates one UI-only entry");
  assert.equal(notices[0]!.customType, "pi-fusion-recommendation-notice");
  const renderer = renderers.get(notices[0]!.customType)!;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const rendered = renderer(notices[0], { expanded: false }, theme).render(80).join("\n");
  assert.equal(rendered.trimEnd(), "Fusion Worker, Advisor Recommended · 0.0s");
  const legacyNotice = { data: { text: "Advisor: no · Worker: no · default_model · 7279ms · 4115 local tokens · bounded context" } };
  assert.equal(renderer(legacyNotice, { expanded: false }, theme), undefined, "saved non-positive entries stay hidden too");
  for (const [advisor, worker, expected] of [
    ["no", "yes", "Fusion Worker"], ["yes", "no", "Advisor"],
    ["uncertain", "yes", "Fusion Worker"], ["yes", "uncertain", "Advisor"],
  ]) {
    const saved = { data: { text: `Advisor: ${advisor} · Worker: ${worker} · local · 8399ms · 120 local tokens` } };
    const original = saved.data.text;
    assert.equal(renderer(saved, { expanded: false }, theme).render(100).join("\n").trimEnd(), `${expected} Recommended · 8.3s`);
    assert.equal(saved.data.text, original, "mixed saved entries hide non-positive labels without changing recorded decisions");
  }
  assert.doesNotMatch(rendered, /Both unresolved/, "free-form model rationale is not copied into the English UI");
  assert.equal(renderer({ data: null }, { expanded: false }, theme), undefined, "malformed saved entries cannot crash rendering");
  handlers.get("turn_start")!({ turnIndex: 1 });
  const withWakeup = [...messages, firstWakeup];
  const delivered = checkpoint(withWakeup);
  assert.equal(delivered.messages.length, messages.length + 1);
  assert.equal(withWakeup.length, messages.length + 1, "filtering never mutates the captured conversation");
  assert.ok(!delivered.messages.some((message: any) => message.customType === firstWakeup.customType));
  assert.equal(delivered.messages.at(-1).customType, "pi-fusion-recommendation");
  assert.equal(delivered.messages.at(-1).display, false);
  assert.match(delivered.messages.at(-1).content, /earlier checkpoint/);
  assert.match(delivered.messages.at(-1).content, /Use the current task state to decide whether to accept or decline it/);
  assert.ok(delivered.messages.at(-1).content.includes(RECOMMENDATION_LEAD_GUIDANCE));
  assert.doesNotMatch(delivered.messages.at(-1).content, /Ignore it if|not approval or a requirement/, "freshness and tool autonomy cannot silently waive acknowledgment");
  assert.match(JSON.stringify(convertToLlm(delivered.messages).at(-1)), /advisor=yes, worker=yes/);
  assertFilteredOnly(checkpoint(withWakeup), messages);
  assert.equal(checkpoint(), undefined, "consume the ready hint once");
  await terminal();
  assert.equal(requests.length, 1);
  assert.equal(emitted.length, 1, "consumption and persisted markers cannot create a feedback loop");
  assert.equal(notices.length, 1, "consuming a hint cannot duplicate its visible entry");
  handlers.get("turn_start")!({ turnIndex: 4 });
  assertFilteredOnly(checkpoint(withWakeup), messages);
  assert.equal(requests.length, 2, "the original four-turn cadence remains");
  assert.doesNotMatch(requests.at(-1)!.evidence.recentContext, /pi-fusion-recommendation-wakeup/, "saved markers do not contaminate later screening evidence");

  // A changed checkpoint cancels an in-flight request without overlapping it or awaiting it.
  const cancelled = requests.at(-1)!;
  const steer = { role: "user", content: "Only explain the options now; do not delegate.", timestamp: 3 };
  const steered = [...messages, steer];
  assert.equal(checkpoint(steered), undefined);
  assert.equal(cancelled.signal.aborted, true);
  assert.equal(requests.length, 2);
  const beforeCancelled = notices.length;
  const wakesBeforeCancelled = emitted.length;
  await finish(cancelled);
  assert.equal(notices.length, beforeCancelled, "cancelled completions cannot display stale recommendations");
  await terminal();
  assert.equal(emitted.length, wakesBeforeCancelled, "cancelled completions cannot follow up the Lead");
  const fresh = start(steered);
  assert.equal(fresh.evidence.prompt, steer.content);
  await finish(fresh);
  const beforeNatural: number = emitted.length;
  assert.ok(checkpoint(steered));
  await terminal();
  assert.equal(emitted.length, beforeNatural, "a natural context consumes advice without a queued follow-up");

  // Only actionable positive verdicts need the active Lead to reconsider.
  for (const [advisor, worker] of [["no", "no"], ["uncertain", "uncertain"], ["no", "uncertain"], ["uncertain", "no"]]) {
    await reset();
    const beforeNotice: number = notices.length;
    await finish(start(), answer(advisor, worker));
    assert.equal(notices.length, beforeNotice + 1, "non-positive verdicts remain recorded for inspection");
    assert.equal(renderer(notices.at(-1), { expanded: false }, theme), undefined, "non-positive verdicts stay hidden in chat");
    await terminal();
    assert.equal(emitted.length, 0, `${advisor}/${worker} must not follow up the Lead`);
    assert.equal(checkpoint(), undefined, "non-positive verdicts do not inject a hidden hint");
  }
  for (const [advisor, worker] of [["yes", "no"], ["no", "yes"], ["yes", "uncertain"], ["uncertain", "yes"]]) {
    await reset();
    const request = start();
    await finish(request, answer(advisor, worker));
    assert.ok(renderer(notices.at(-1), { expanded: false }, theme), "either yes verdict remains visible in chat");
    assert.equal(emitted.length, 0);
    await terminal();
    assert.equal(emitted.length, 1);
    const marker = assertWakeup();
    const withMarker = [...messages, marker];
    const hint = checkpoint(withMarker);
    assert.match(hint.messages.at(-1).content, new RegExp(`advisor=${advisor}, worker=${worker}`));
    assertFilteredOnly(checkpoint(withMarker), messages);
    await terminal();
    assert.equal(emitted.length, 1, "one positive result sends one marker");
    assert.equal(requests.at(-1), request, "a marker is not a new screening checkpoint");
  }
  await reset();
  const idleRequest = start();
  idle = true;
  const beforeIdleNotice = notices.length;
  await finish(idleRequest);
  assert.equal(notices.length, beforeIdleNotice + 1, "idle completion can still display the recommendation");
  await terminal();
  assert.equal(emitted.length, 0, "completion must not wake an idle Lead or start a new turn");
  handlers.get("agent_end")!();
  assert.equal(checkpoint(), undefined, "an idle run's completed hint is discarded at agent end");

  for (const message of [
    { role: "user", content: "A user message is not a terminal assistant response." },
    ...["error", "aborted", "length", "toolUse"].map((stopReason) => ({ role: "assistant", stopReason, content: [{ type: "text", text: "Not a clean stop." }] })),
    { role: "assistant", stopReason: "stop", content: [{ type: "toolCall", id: "running-tool", name: "bash", arguments: { command: "npm test" } }] },
  ]) {
    await reset();
    await finish(start());
    await terminal(message);
    assert.equal(emitted.length, 0, `${message.role}/${"stopReason" in message ? message.stopReason : "none"} cannot queue a recommendation follow-up`);
    handlers.get("agent_end")!();
  }

  await reset();
  const queuedSteer = start();
  const beforeSteer = notices.length;
  await handlers.get("input")!({ source: "interactive", text: steer.content, images: [] }, context);
  assert.equal(queuedSteer.signal.aborted, true);
  await finish(queuedSteer);
  assert.equal(notices.length, beforeSteer, "a queued user steer suppresses stale display before another context hook runs");
  assert.equal(emitted.length, 0);
  start(steered);

  // Recheck stale completed hints at delivery, not just when the response arrives.
  const worker = (): WorkerRecord => ({ id: "wrk_test", label: "tests", status: "running", generation: 1, activeTurnId: "trn_first", history: [], failures: 0, executorModelId: "test/worker", createdAt: 0 });
  for (const change of ["steer", "worker-result", "capability", "worker-state", "age", "turn-limit"] as const) {
    await reset();
    if (change === "worker-state") workers = [worker()];
    const request = start();
    await finish(request);
    await terminal();
    const marker = assertWakeup();
    let next = messages;
    if (change === "steer") next = steered;
    if (change === "worker-result") next = [...messages, { role: "custom", customType: "pi-fusion-worker-result", content: "Worker completed and verified", timestamp: 4 }];
    if (change === "capability") activeTools = ["fusion_spawn", "fusion_followup"];
    if (change === "worker-state") { workers[0]!.generation = 2; workers[0]!.activeTurnId = "trn_second"; }
    if (change === "age") now += 30_001;
    if (change === "turn-limit") handlers.get("turn_start")!({ turnIndex: 4 });
    assert.equal(checkpoint(next), undefined, `${change} must discard a completed hint`);
    assertFilteredOnly(checkpoint([...next, marker]), next);
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
    assert.equal(emitted.length, 0, `${change} must suppress a stale wake-up`);
    assert.equal(checkpoint(), undefined, `${change} must discard a late completion`);
  }

  // A ready hint can become stale before a terminal event without another context request.
  for (const change of ["input", "off", "capability", "worker-state", "age", "turn-limit", "aborted", "idle", "agent-end"] as const) {
    await reset();
    const lead = new AbortController();
    context.signal = lead.signal;
    await finish(start());
    if (change === "input") await handlers.get("input")!({ source: "interactive", text: steer.content, images: [] }, context);
    if (change === "off") await commands.get("fusion").handler("recommend off", context);
    if (change === "capability") activeTools = ["fusion_spawn", "fusion_followup"];
    if (change === "worker-state") workers = [worker()];
    if (change === "age") now += 30_001;
    if (change === "turn-limit") handlers.get("turn_start")!({ turnIndex: 4 });
    if (change === "aborted") lead.abort();
    if (change === "idle") idle = true;
    if (change === "agent-end") handlers.get("agent_end")!();
    await terminal();
    assert.equal(emitted.length, 0, `${change} must suppress a terminal follow-up for completed advice`);
  }

  await reset();
  const beforeFailure = notices.length;
  await finish(start(), new Response("offline", { status: 503 }));
  assert.equal(notices.length, beforeFailure, "failed inference must not display a recommendation");
  assert.equal(emitted.length, 0, "failed inference must not wake the Lead");
  handlers.get("agent_end")!();
  await commands.get("fusion").handler("recommend status", context);
  assert.match(notifications.at(-1)!, /unavailable/, "agent_end keeps the last error available in status");

  await reset();
  await finish(start());
  await terminal();
  const disabledMarker = assertWakeup();
  await commands.get("fusion").handler("recommend off", context);
  const saved = JSON.parse(readFileSync(join(directory, "fusion.json"), "utf8"));
  assert.equal(saved.recommendations, false);
  assert.equal(saved.preserved, "yes");
  const beforeOff = requests.length;
  assert.equal(checkpoint(), undefined);
  assertFilteredOnly(checkpoint([...messages, disabledMarker]), messages);
  assert.equal(requests.length, beforeOff);

  await reset();
  const disabled = start();
  const beforeDisabled = notices.length;
  await commands.get("fusion").handler("recommend off", context);
  await finish(disabled);
  assert.equal(notices.length, beforeDisabled, "disabling recommendations suppresses a late visible entry");
  assert.equal(emitted.length, 0);

  await reset();
  await finish(start());
  await terminal();
  const unavailableMarker = assertWakeup();
  activeTools = [];
  const beforeUnavailable = requests.length;
  assertFilteredOnly(checkpoint([...messages, unavailableMarker]), messages);
  assert.equal(requests.length, beforeUnavailable, "unavailable capabilities only clean up the marker");

  await reset();
  await finish(start());
  await terminal();
  const shutdownMarker = assertWakeup();
  await handlers.get("session_shutdown")!({}, context);
  assertFilteredOnly(checkpoint([...messages, shutdownMarker]), messages);
  await handlers.get("session_start")!({}, context);
  assertFilteredOnly(checkpoint([...messages, shutdownMarker]), messages);

  await reset();
  const leadAbort = new AbortController();
  context.signal = leadAbort.signal;
  const escaped = start();
  leadAbort.abort(new Error("User pressed Escape"));
  await finish(escaped);
  assert.equal(checkpoint(), undefined);
  assert.equal(emitted.length, 0, "Lead cancellation suppresses late wake-ups");

  await reset();
  await finish(start());
  await terminal();
  const endedMarker = assertWakeup();
  handlers.get("agent_end")!();
  await commands.get("fusion").handler("recommend status", context);
  assert.match(notifications.at(-1)!, /Advisor: yes.*Worker: yes/, "agent_end keeps the last result available in status");
  assert.equal(checkpoint(), undefined, "agent_end discards a ready hint");
  assertFilteredOnly(checkpoint([...messages, endedMarker]), messages);

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
  assert.equal(emitted.length, 0, "a shutdown request cannot wake the Lead after switching sessions");

  // The actual advisor tool drives activity, while its provider is only a deferred fixture.
  await reset();
  const beforeAdvisor = start();
  assert.deepEqual(beforeAdvisor.evidence.advisor.running, []);
  const question = "Which retry boundary avoids duplicate writes?";
  const consult = beginAdvisor(question);
  const beforeAdvisorNotice = recommendationNotices();
  await finish(beforeAdvisor);
  assert.equal(recommendationNotices(), beforeAdvisorNotice, "starting advice invalidates a screening response based on idle advisor state");
  await terminal();
  assert.equal(emitted.length, 0);
  const whileAdvising = start();
  assert.equal(whileAdvising.evidence.advisor.running.length, 1);
  assert.equal(whileAdvising.evidence.advisor.running[0].question, question);
  const consultationId = whileAdvising.evidence.advisor.running[0].id;
  assert.equal(typeof consultationId, "string");
  assert.ok(consultationId.length > 0);
  await settleAdvisor(consult);
  await finish(whileAdvising);
  assert.equal(recommendationNotices(), beforeAdvisorNotice, "advisor completion invalidates unfinished screening before displaying its result");
  const afterAdvising = start();
  assert.deepEqual(afterAdvising.evidence.advisor.running, []);
  assert.deepEqual(afterAdvising.evidence.advisor.last, { id: consultationId, question, status: "completed" });

  for (const status of ["completed", "failed", "interrupted"] as const) {
    await reset();
    const ongoing = beginAdvisor(`Fixture consultation ending ${status}`);
    const screen = start();
    const activity = screen.evidence.advisor.running[0];
    assert.equal(activity.question, ongoing.request.question);
    const beforeNotice = recommendationNotices();
    await settleAdvisor(ongoing, status);
    await finish(screen);
    assert.equal(recommendationNotices(), beforeNotice, `${status} advisor cannot produce a stale recommendation entry`);
    await terminal();
    assert.equal(emitted.length, 0);
    const current = start();
    assert.deepEqual(current.evidence.advisor.running, []);
    assert.deepEqual(current.evidence.advisor.last, { id: activity.id, question: activity.question, status });
  }

  // Finished advice must also invalidate an already-ready hint without a new context event.
  for (const status of ["completed", "interrupted"] as const) {
    await reset();
    const finishing = beginAdvisor("Review the final retry design.");
    await finish(start());
    await settleAdvisor(finishing, status);
    await terminal();
    assert.equal(emitted.length, 0, `${status} advice invalidates a pending terminal hint immediately`);
    assert.equal(checkpoint(), undefined, `${status} advice cannot inject its stale pending hint`);
  }

  await reset();
  await finish(start());
  const newlyRunning = beginAdvisor("Review the recommendation before applying it.");
  await terminal();
  assert.equal(emitted.length, 0, "a newly running advisor invalidates advice prepared while the advisor was idle");
  assert.equal(checkpoint(), undefined);
  await settleAdvisor(newlyRunning);

  await reset();
  const transient = start();
  const previousAdvisorId = transient.evidence.advisor.last?.id;
  const shortConsult = beginAdvisor("Check the bounded retry decision once.");
  await settleAdvisor(shortConsult);
  const beforeTransientNotice = recommendationNotices();
  await finish(transient);
  assert.equal(recommendationNotices(), beforeTransientNotice, "idle to busy to idle still invalidates the old snapshot via last consultation identity");
  const afterTransient = start();
  assert.deepEqual(afterTransient.evidence.advisor.running, []);
  assert.notEqual(afterTransient.evidence.advisor.last.id, previousAdvisorId);
  assert.equal(afterTransient.evidence.advisor.last.question, shortConsult.request.question);

  // Real follow-up tools populate the private queue and steering maps. The native
  // runtime holds a busy fixture worker, so no worker model turn is launched.
  await reset();
  const oldTask = "Previous task already completed.";
  const currentTask = "Implement retry backoff and retry tests.";
  const spawned = runtime!.spawn({ label: "Retry worker", executorModelId: "test/worker",
    firstMessage: { role: "user", content: handoffTaskText(1, oldTask), timestamp: now } });
  spawned.worker.history.push({ role: "user", content: handoffTaskText(2, currentTask), timestamp: now + 1 });
  spawned.worker.generation = 2;
  workers = [spawned.worker];
  const workerSnapshot = start();
  const workerEvidence = workerSnapshot.evidence.workers[0];
  assert.equal(workerEvidence.id, spawned.worker.id);
  assert.equal(workerEvidence.label, "Retry worker");
  assert.equal(workerEvidence.task, currentTask);
  assert.doesNotMatch(workerEvidence.task, /Previous task|fusion_handoff/);
  assert.deepEqual(workerEvidence.queuedTasks, []);
  assert.deepEqual(workerEvidence.steering, []);
  const followup = (message: string, when_busy: "queue" | "steer") => registeredTools.get("fusion_followup").execute(
    `followup-${when_busy}`, { worker_id: spawned.worker.id, message, when_busy }, undefined, undefined, context);
  const queuedTask = "Benchmark retry latency after implementation.";
  const queued = await followup(queuedTask, "queue");
  assert.equal(queued.details.status, "queued");
  const beforeWorkerNotice = recommendationNotices();
  await finish(workerSnapshot);
  assert.equal(recommendationNotices(), beforeWorkerNotice, "queue changes invalidate screening even when the worker status and active turn stay unchanged");
  const withQueue = start();
  assert.deepEqual(withQueue.evidence.workers[0].queuedTasks, [queuedTask]);
  const steering = "Keep write retries idempotent and add regression coverage.";
  const steeredWorker = await followup(steering, "steer");
  assert.equal(steeredWorker.details.status, "steering");
  await finish(withQueue);
  assert.equal(recommendationNotices(), beforeWorkerNotice, "new steering invalidates in-flight screening");
  const withSteering = start();
  assert.deepEqual(withSteering.evidence.workers[0].queuedTasks, [queuedTask]);
  assert.deepEqual(withSteering.evidence.workers[0].steering, [steering]);
  assert.equal(withSteering.evidence.workers[0].task, currentTask);
  await finish(withSteering);
  const repeatedSteer = await followup(steering, "steer");
  assert.notEqual(repeatedSteer.details.steer_id, steeredWorker.details.steer_id);
  await terminal();
  assert.equal(emitted.length, 0, "a newly accepted steer invalidates pending advice even with the same instruction text");
  assert.equal(checkpoint(), undefined, "steering changes discard ready advice at natural checkpoints too");
  assert.equal(advisorRequests.every((request) => request.settled), true, "no fixture advisor requests remain running");

  // Real compaction preserves the original handoff even after that generation's
  // task completed. A later handoff may survive only in the public summary.
  await reset();
  const completedTask = "Completed old API task";
  const currentUiTask = "Implement CURRENT UI task";
  const latestUiConstraint = "Keep backwards compatibility";
  const user = (content: string, timestamp: number) => ({ role: "user" as const, content, timestamp });
  const assistant = (text: string, timestamp: number) => ({
    role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "stop" as const, timestamp,
    api: "openai-completions" as const, provider: "test", model: "advisor",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const beforeCompaction = [
    user(handoffTaskText(1, completedTask), 1), assistant(`done ${"x".repeat(1_000)}`, 2),
    user(handoffTaskText(2, currentUiTask), 3), assistant(`progress ${"x".repeat(1_000)}`, 4),
    assistant(`progress ${"x".repeat(1_000)}`, 5),
    user(`<fusion_steer turn="t2">${latestUiConstraint}</fusion_steer>`, 6),
    assistant(`more ${"x".repeat(1_000)}`, 7), assistant(`latest ${"x".repeat(1_000)}`, 8),
  ];
  let summaryCalls = 0;
  const compacted = await compactExecutorHistory({ systemPrompt: "Worker fixture", messages: beforeCompaction }, model as never, 1024, 4, undefined, async (summaryContext) => {
    summaryCalls++;
    assert.match(JSON.stringify(summaryContext), /Implement CURRENT UI task/);
    return assistant(`Old API task completed. Current task: ${currentUiTask}. Latest constraint: ${latestUiConstraint}.`, 9);
  });
  assert.equal(summaryCalls, 1);
  assert.ok(compacted);
  const compactedUsers = compacted.filter((message) => message.role === "user").map((message) => message.content);
  assert.ok(compactedUsers.includes(handoffTaskText(1, completedTask)), "actual compaction retains the first generation's original handoff");
  assert.ok(!compactedUsers.includes(handoffTaskText(2, currentUiTask)), "fixture reaches the boundary where the current handoff was summarized away");
  assert.ok(compactedUsers.some((content) => typeof content === "string" && content.startsWith("<fusion_context_summary>")));
  assert.ok(compactedUsers.some((content) => typeof content === "string" && content.startsWith("<fusion_steer ")));
  const compactedWorker = runtime!.spawn({ label: "UI worker", executorModelId: "test/worker", firstMessage: beforeCompaction[0]! });
  compactedWorker.worker.generation = 2;
  compactedWorker.worker.history = compacted;
  workers = [compactedWorker.worker];
  const compactedRequest = start();
  const compactedTask = compactedRequest.evidence.workers[0].task;
  assert.match(compactedTask, /Implement CURRENT UI task/, "recommendations retain the current task from the actual compaction summary");
  assert.match(compactedTask, /Keep backwards compatibility/);
  assert.match(compactedTask, /<fusion_steer /, "the latest public instruction accompanies the compacted task");
  assert.notEqual(compactedTask, completedTask, "the preserved generation-one handoff cannot become the current task again");
  assert.doesNotMatch(compactedTask, /fusion_handoff generation="1"/);

  // Cache input survives natural agent runs, but not branches, opt-out, or failures.
  await reset();
  const historySeed = start();
  await finish(historySeed, answer("no", "no"));
  handlers.get("agent_end")!({}, context);
  handlers.get("before_agent_start")!({ systemPrompt: "", systemPromptOptions: { sections: {} }, prompt: "Continue" }, context);
  const continuedSource = [...messages, { role: "assistant", content: "The API implementation is ready." }, { role: "user", content: "Continue with the UI fix", timestamp: 10 }];
  const continuedHistory = start(continuedSource);
  assert.deepEqual(continuedHistory.messages.slice(0, historySeed.messages.length), historySeed.messages, "new agent runs append to the same session prefix");
  assert.deepEqual(continuedHistory.messages[historySeed.messages.length], { role: "assistant", content: "" });
  assert.match(JSON.stringify(continuedHistory.messages), /The API implementation is ready/);
  assert.equal(continuedHistory.evidence.prompt, "Continue with the UI fix");
  await finish(continuedHistory, answer("no", "no"));
  const branchedSource = [...continuedSource];
  branchedSource[0] = { ...branchedSource[0], content: "Different branch instruction" };
  handlers.get("turn_start")!({ turnIndex: 4 });
  const branchedHistory = start(branchedSource);
  assert.equal(branchedHistory.messages.length, 2, "changed source prefixes cannot retain another branch's cached evidence");
  await finish(branchedHistory, answer("no", "no"));
  handlers.get("turn_start")!({ turnIndex: 8 });
  const compactedSource = [{ role: "compactionSummary", summary: "Only the UI task remains" }, { role: "user", content: "Finish the UI task", timestamp: 11 }];
  const compactedHistory = start(compactedSource);
  assert.equal(compactedHistory.messages.length, 2);
  assert.match(compactedHistory.evidence.recentContext, /Only the UI task remains/);
  await finish(compactedHistory, answer("no", "no"));
  await commands.get("fusion").handler("recommend off", context);
  await commands.get("fusion").handler("recommend on", context);
  const enabledHistory = start(compactedSource);
  assert.equal(enabledHistory.messages.length, 2, "off/on clears cached transcript state");
  await finish(enabledHistory, answer("no", "no"));
  handlers.get("turn_start")!({ turnIndex: 4 });
  const failedHistory = start([...compactedSource, { role: "assistant", content: "A new implementation update" }]);
  failedHistory.reject(new Error("Local transport failed"));
  await flush();
  handlers.get("turn_start")!({ turnIndex: 8 });
  const retryHistory = start([...compactedSource, { role: "assistant", content: "A new implementation update" }]);
  assert.equal(retryHistory.messages.length, 2, "fresh failures recover with a bounded seed instead of a growing uncached request");
  await finish(retryHistory, answer("no", "no"));
  await handlers.get("session_start")!({}, context);
  const reloadedHistory = start(compactedSource);
  assert.equal(reloadedHistory.messages.length, 2, "session reloads clear the append-only history");
  await finish(reloadedHistory, answer("no", "no"));
  console.log(`ok   recommendation integration: nonblocking hook (max ${maximumHookMs.toFixed(2)}ms), terminal-only follow-up, ephemeral advice, advisor activity, worker task/queue/steering and freshness`);
} finally {
  await handlers.get("session_shutdown")?.({}, context);
  for (const request of requests) if (!request.settled) request.reject(new Error("Test cleanup"));
  for (const request of advisorRequests) if (!request.settled) request.reject(new Error("Test cleanup"));
  await flush();
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  WorkerRuntime.prototype.list = originalList;
  rmSync(directory, { recursive: true, force: true });
}
