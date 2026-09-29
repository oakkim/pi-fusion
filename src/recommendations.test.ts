/** No model calls: schema, public evidence, and loopback transport checks. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { formatRecommendation, formatRecommendationStatus, RecommendationHistory, RECOMMENDATION_LEAD_GUIDANCE, recommendationEvidence, requestRecommendation, type RecommendationInput } from "./recommendations.ts";

const input: RecommendationInput = { prompt: "Implement the scoped task", recentContext: "Tests fail", advisorAvailable: true, fusionAvailable: true, advisor: { running: [] }, workers: [] };
const options = { endpoint: "http://127.0.0.1:8788", timeoutMs: 1_000 };
const response = (content: unknown = { reason: "Unresolved design and independent implementation both need attention.", advisor: "yes", worker: "yes" }) => ({
  model: "openjev", usage: { prompt_tokens: 120, completion_tokens: 40 },
  choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
});
type Call = { url: URL; body: Record<string, any>; init: RequestInit };
async function fakeLocal(reply: (call: Call) => Response | Promise<Response>, test: (calls: Call[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url, init) => {
    const call = { url: new URL(String(url)), body: JSON.parse(String(init?.body)), init: init! };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  try { await test(calls); } finally { globalThis.fetch = original; }
}

await fakeLocal(() => Response.json(response()), async (calls) => {
  const result = await requestRecommendation(input, options);
  assert.equal(result.choice, "both");
  assert.deepEqual(result.decisions, { advisor: "yes", worker: "yes" });
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 40, totalTokens: 160 });
  assert.ok(result.elapsedMs >= 0);
  assert.match(formatRecommendation(result), /Model rationale \(untrusted\): "/);
  assert.ok(formatRecommendation(result).endsWith(RECOMMENDATION_LEAD_GUIDANCE), "delivery and session guidance share the same acknowledgment rule");
  assert.match(formatRecommendation(result), /next user-visible message must explicitly accept or decline each target marked yes/);
  assert.match(formatRecommendation(result), /concrete reason tied to the current task, in the user's conversation language/);
  assert.match(formatRecommendation(result), /Tool use is your choice, but acknowledgment is required/);
  assert.match(formatRecommendation(result), /tool calls, tool arguments, and private reasoning alone are not acknowledgment/);
  assert.match(formatRecommendation(result), /When accepting, state the intended action and use ask_advisor or fusion_followup\/fusion_spawn/);
  assert.match(formatRecommendation(result), /stale, duplicates covered work, or a capability is unavailable/);
  assert.match(formatRecommendation(result), /user and project instructions, Fusion mode, and tool permissions take precedence/);
  assert.match(formatRecommendation(result), /Prefer reusing a related worker; do not duplicate active work or reopen completed work/);
  assert.match(formatRecommendationStatus(result), /160 local tokens/);
  assert.doesNotMatch(formatRecommendationStatus({ ...result, reason: "한국어로 반환된 근거" }), /한국어/, "status keeps fixed English labels instead of model-authored prose");
  assert.equal(calls.length, 1);
  const { body, init, url } = calls[0]!;
  assert.equal(url.pathname, "/v1/chat/completions");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal);
  assert.equal(body.model, undefined, "use the configured local model instead of requesting a new download");
  assert.equal(body.max_tokens, 160);
  assert.equal(body.temperature, 0);
  assert.equal(body.cache_prompt, true);
  assert.equal(body.stream, true);
  assert.equal(body.stream_options.include_usage, true);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.properties.reason.maxLength, 240);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  assert.match(body.messages[0].content, /in English/);
  assert.match(body.messages[0].content, /Return exactly one JSON object/);
  assert.equal(body.logprobs, undefined);
  assert.deepEqual(JSON.parse(body.messages[1].content), input);
});

for (const [advisor, worker, expected] of [
  ["yes", "no", "advisor"], ["no", "yes", "worker"], ["no", "no", "neither"],
  ["yes", "uncertain", "advisor"], ["uncertain", "yes", "worker"], ["no", "uncertain", "uncertain"],
] as const) {
  await fakeLocal(() => Response.json(response({ reason: "Brief evidence-based recommendation.", advisor, worker })), async () => {
    const result = await requestRecommendation(input, options);
    assert.equal(result.choice, expected);
    assert.deepEqual(result.decisions, { advisor, worker });
    assert.ok(formatRecommendation(result).includes(`advisor=${advisor}, worker=${worker}`));
    assert.ok(formatRecommendationStatus(result).includes(`Advisor: ${advisor} · Worker: ${worker}`));
  });
}
for (const [advisorAvailable, fusionAvailable, expected] of [
  [false, true, "worker"], [true, false, "advisor"], [false, false, "neither"],
] as const) {
  await fakeLocal(() => Response.json(response()), async (calls) => {
    const result = await requestRecommendation({ ...input, advisorAvailable, fusionAvailable }, options);
    assert.equal(result.choice, expected);
    assert.deepEqual(result.decisions, { advisor: advisorAvailable ? "yes" : "no", worker: fusionAvailable ? "yes" : "no" });
    assert.equal(calls.length, advisorAvailable || fusionAvailable ? 1 : 0);
    assert.match(result.reason, /unavailable|Neither capability is available/);
    assert.ok(!result.reason.includes("both need attention"), "clamping must not keep a contradictory model reason");
  });
}
await fakeLocal(() => Response.json({ ...response(), usage: undefined }), async () => {
  assert.equal((await requestRecommendation(input, options)).usage, undefined);
});
for (const bad of [
  null, {}, { advisor: "yes", worker: "no" },
  { reason: "Valid reason", advisor: "maybe", worker: "no" },
  { reason: "Valid reason", advisor: "yes", worker: "no", extra: true },
  ...["", "   ", "x".repeat(241), "line\nbreak", "escape\u001b[31m", "null\u0000byte"].map((reason) => ({ reason, advisor: "yes", worker: "no" })),
]) {
  await fakeLocal(() => Response.json(response(bad)), async () => { await assert.rejects(requestRecommendation(input, options), /recommendation/); });
}
for (const bad of [
  {}, { choices: [] }, { choices: [...response().choices, ...response().choices] },
  { choices: [{ finish_reason: "length", message: response().choices[0]!.message }] },
  { choices: [{ finish_reason: "stop", message: { content: '{"reason":"truncated"' } }] },
  { choices: [{ finish_reason: "stop", message: { content: '```json\n{}\n```' } }] },
  { choices: [{ finish_reason: "stop", message: { content: [] } }] },
]) {
  await fakeLocal(() => Response.json(bad), async () => { await assert.rejects(requestRecommendation(input, options), /recommendation/); });
}

await fakeLocal(() => Response.json(response()), async (calls) => {
  for (const endpoint of ["https://example.com", "http://127.0.0.2:8788", "file:///tmp/a", "http://user:secret@localhost:8788", "http://localhost:8788/?key=secret", "http://localhost:8788/#fragment", "http://localhost:8788/other"]) {
    await assert.rejects(requestRecommendation(input, { ...options, endpoint }), /loopback/);
  }
  assert.equal(calls.length, 0, "reject remote endpoints before any fetch");
  await requestRecommendation(input, { ...options, endpoint: "http://localhost:8788/v1" });
  assert.ok(calls.every((call) => call.url.hostname === "127.0.0.1"));
});

await fakeLocal(() => Response.json(response()), async (calls) => {
  const result = await requestRecommendation({
    ...input, prompt: `PROMPT_HEAD${"x".repeat(20_000)}PROMPT_TAIL`, recentContext: `OLD${"y".repeat(20_000)}LATEST_TOOL_ERROR`,
    advisor: { running: Array.from({ length: 9 }, (_, i) => ({ id: `consultation-${i}`, question: "question ".repeat(100) })), last: { id: "latest", question: "", status: "completed" } },
    workers: Array.from({ length: 21 }, (_, i) => ({ id: `worker-${i}`, label: "label".repeat(100), status: i === 20 ? "running" : "idle", task: "task ".repeat(200), queuedTasks: Array(4).fill("queued ".repeat(100)), steering: Array(4).fill("updated ".repeat(100)) })),
  }, options);
  const evidence = JSON.parse(calls[0]!.body.messages[1].content);
  assert.ok(evidence.prompt.length <= 6_000);
  assert.match(evidence.prompt, /^PROMPT_HEAD/);
  assert.match(evidence.prompt, /PROMPT_TAIL$/);
  assert.match(evidence.prompt, /omitted/);
  assert.ok(evidence.recentContext.length <= 8_000);
  assert.match(evidence.recentContext, /LATEST_TOOL_ERROR$/);
  assert.ok(evidence.workers.length > 0 && evidence.workers.length < 20);
  assert.equal(evidence.omittedWorkers, 21 - evidence.workers.length);
  assert.equal(evidence.workers[0].id, "worker-20", "running workers take priority over idle history when bounded");
  assert.ok(evidence.workers.every((worker: any) => worker.label.length <= 160 && worker.status.length <= 40));
  assert.ok(evidence.workers.every((worker: any) => worker.task.length <= 480 && worker.queuedTasks.length === 3 && worker.steering.length === 3
    && [...worker.queuedTasks, ...worker.steering].every((task: string) => task.length <= 240) && worker.omittedQueuedTasks === 1 && worker.omittedSteering === 1));
  assert.ok(evidence.advisor.running.length > 0 && evidence.advisor.running.length <= 8);
  assert.equal(evidence.advisor.omittedRunning, 9 - evidence.advisor.running.length);
  assert.ok(evidence.advisor.running.every((request: any) => request.question.length <= 320));
  assert.equal(evidence.advisor.last.question, "General review");
  assert.equal(evidence.advisor.last.status, "completed");
  assert.ok(JSON.stringify({ advisor: evidence.advisor, workers: evidence.workers, omittedWorkers: evidence.omittedWorkers }).length <= 6_000);
  assert.equal(result.inputTruncated, true);
});

await fakeLocal(() => Response.json(response()), async (calls) => {
  const workers = Array.from({ length: 21 }, (_, i) => ({ id: `worker-${i}`, label: "", status: "idle", task: "Small task", queuedTasks: [], steering: [] }));
  await requestRecommendation({ ...input, workers }, options);
  const evidence = JSON.parse(calls[0]!.body.messages[1].content);
  assert.equal(evidence.workers[0].id, "worker-20", "recent idle workers remain available for reuse when the inventory is bounded");
  assert.ok(!evidence.workers.some((worker: any) => worker.id === "worker-0"));
});

await fakeLocal(() => Response.json(response()), async (calls) => {
  const text = "\u0000".repeat(800);
  const result = await requestRecommendation({ ...input,
    advisor: { running: Array.from({ length: 8 }, (_, i) => ({ id: String(i), question: text })), last: { id: "last", question: text, status: "failed" } },
    workers: [{ id: text, label: text, status: "running", task: text, queuedTasks: [text, text, text], steering: [text, text, text] }],
  }, options);
  const evidence = JSON.parse(calls[0]!.body.messages[1].content);
  assert.ok(JSON.stringify({ advisor: evidence.advisor, workers: evidence.workers, omittedWorkers: evidence.omittedWorkers }).length <= 6_000, "JSON escaping cannot evade the activity budget");
  assert.equal(result.inputTruncated, true);
});

await fakeLocal(() => Response.json(response()), async (calls) => {
  const activity: RecommendationInput = { ...input,
    advisor: { running: [{ id: "review-1", question: "Validate the migration boundary" }], last: { id: "review-0", question: "Check cache ownership", status: "failed" } },
    workers: [{ id: "api-worker", label: "API", status: "running", task: "Implement the migration", queuedTasks: ["Verify rollback"], steering: ["Preserve old clients"] }],
  };
  await requestRecommendation(activity, options);
  assert.deepEqual(JSON.parse(calls[0]!.body.messages[1].content), activity, "the local model receives task ownership and consultation state, not just availability flags");
  assert.match(calls[0]!.body.messages[0].content, /do not repeat a question already being consulted or answered/);
  assert.match(calls[0]!.body.messages[0].content, /Do not duplicate running or queued work/);
  assert.match(calls[0]!.body.messages[0].content, /different independent task/);
});

const evidence = recommendationEvidence([
  { role: "user", content: "old user request" },
  { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_THOUGHT", signature: "PRIVATE_SIGNATURE" }, { type: "text", text: "Public progress", signature: "PRIVATE_SIGNATURE" }, { type: "toolCall", name: "bash", arguments: { command: "npm test" } }] },
  { role: "user", content: [{ type: "text", text: "Latest user: do not delegate" }, { type: "image", data: "PRIVATE_IMAGE_BYTES" }] },
  { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "TypeError: undefined is not iterable" }] },
  { role: "custom", customType: "pi-fusion-worker-result", content: "Worker finished with failing test" },
  { role: "compactionSummary", summary: "The user forbids schema changes" },
  { role: "branchSummary", summary: "The migration was already ruled out" },
  { role: "bashExecution", command: "npm run check", output: "TS2322", exitCode: 2, excludeFromContext: false },
  { role: "bashExecution", command: "PRIVATE_COMMAND", output: "PRIVATE_EXCLUDED_OUTPUT", exitCode: 0, excludeFromContext: true },
  { role: "assistant", content: null },
  null,
]);
assert.match(evidence.prompt, /Latest user: do not delegate/);
assert.match(evidence.prompt, /Image content unavailable/);
assert.match(evidence.recentContext, /old user request/);
assert.match(evidence.recentContext, /Public progress/);
assert.match(evidence.recentContext, /npm test/);
assert.match(evidence.recentContext, /TypeError/);
assert.match(evidence.recentContext, /"isError":true/);
assert.match(evidence.recentContext, /pi-fusion-worker-result/);
assert.match(evidence.recentContext, /The user forbids schema changes/);
assert.match(evidence.recentContext, /The migration was already ruled out/);
assert.match(evidence.recentContext, /TS2322/);
assert.ok(!JSON.stringify(evidence).includes("PRIVATE_"));
assert.equal(recommendationEvidence([{ role: "assistant", content: "No user request yet" }]).prompt, "");
const longPrompt = recommendationEvidence([{ role: "user", content: [{ type: "text", text: `BEGIN${"x".repeat(10_000)}` }, { type: "text", text: `${"y".repeat(10_000)}END` }] }]).prompt;
assert.match(longPrompt, /^BEGIN/);
assert.match(longPrompt, /END$/);
assert.ok(longPrompt.length <= 6_000);

await fakeLocal(() => Response.json(response({ reason: "MODEL_OUTPUT_MUST_NOT_ENTER_HISTORY", advisor: "no", worker: "no" })), async (calls) => {
  const history = new RecommendationHistory();
  const source: any[] = [
    { role: "user", content: "Keep the original API contract; finish the requested fix." },
    ...Array.from({ length: 12 }, (_, i) => ({ role: "assistant", content: `Progress ${i}`, timestamp: i })),
    { role: "bashExecution", command: "npm test", output: "One public failure", exitCode: 1 },
  ];
  const screen = () => requestRecommendation({ ...input, ...recommendationEvidence(source) }, { ...options, history, sourceMessages: source });
  const first = await screen();
  const initial = calls[0]!.body.messages;
  assert.equal(initial.length, 2);
  const seed = JSON.parse(initial[1].content);
  assert.match(seed.prompt, /Keep the original API contract/);
  assert.doesNotMatch(seed.recentContext, /Progress 0"/);
  assert.match(seed.recentContext, /Progress 11/);
  assert.match(seed.recentContext, /One public failure/);
  assert.match(seed.recentContext, /omitted/);
  assert.equal(first.inputTruncated, true);
  source.push({ role: "assistant", content: [{ type: "text", text: "Full public progress" }, { type: "thinking", thinking: "PRIVATE_THOUGHT", signature: "PRIVATE_SIGNATURE" }, { type: "image", data: "PRIVATE_IMAGE_BYTES" }] });
  source.push({ role: "toolResult", toolName: "read", content: `NEW_RESULT_HEAD${"whole content ".repeat(1_000)}NEW_RESULT_TAIL` });
  source.push({ role: "custom", customType: "pi-fusion-recommendation", content: "PRIVATE_RECOMMENDATION" });
  source.push({ role: "custom", customType: "hidden", content: "PRIVATE_HIDDEN", display: false });
  source.push({ role: "bashExecution", command: "PRIVATE_COMMAND", output: "PRIVATE_OUTPUT", excludeFromContext: true });
  await screen();
  const second = calls[1]!.body.messages;
  assert.deepEqual(second.slice(0, initial.length), initial, "all earlier model messages are byte-for-byte stable");
  assert.match(second.at(-1).content, /NEW_RESULT_HEAD/);
  assert.match(second.at(-1).content, /NEW_RESULT_TAIL/);
  assert.ok(second.at(-1).content.length > 8_000, "append public data without the rejected evidence reduction");
  assert.doesNotMatch(JSON.stringify(second), /PRIVATE_|MODEL_OUTPUT_MUST_NOT_ENTER_HISTORY/);
  assert.deepEqual(second[initial.length], { role: "assistant", content: "" }, "preserve the cached pending-assistant boundary");
  assert.ok(second.slice(1).every((message: any) => message.role === "user" || (message.role === "assistant" && message.content === "")), "source tool calls are data and generated decisions never become model turns");

  const updated = { ...input, ...recommendationEvidence(source), advisor: { running: [{ id: "r1", question: "Review the failing migration" }] },
    workers: [{ id: "w1", label: "Fix", status: "running", task: "Implement the fix", queuedTasks: ["Run regression tests"], steering: ["Keep old clients"] }] };
  await requestRecommendation(updated, { ...options, history, sourceMessages: source });
  const third = calls[2]!.body.messages;
  assert.deepEqual(third.slice(0, second.length), second);
  assert.deepEqual(third[second.length], { role: "assistant", content: "" }, "runtime-only updates preserve the same assistant boundary");
  assert.deepEqual(JSON.parse(third.at(-1).content).state.advisor, updated.advisor);
  assert.deepEqual(JSON.parse(third.at(-1).content).state.workers, updated.workers);
  await requestRecommendation(updated, { ...options, history, sourceMessages: source });
  assert.deepEqual(calls[3]!.body.messages, third, "an unchanged source and runtime append nothing");

  source[1].content = "Changed branch progress";
  await screen();
  assert.equal(calls[4]!.body.messages.length, 2, "a changed old source prefix re-seeds even if outside the recent window");
  source.splice(0, source.length, { role: "compactionSummary", summary: "New compacted task state" }, { role: "user", content: "Continue the compacted task" });
  await screen();
  assert.equal(calls[5]!.body.messages.length, 2);
  assert.match(calls[5]!.body.messages[1].content, /New compacted task state/);
  source.push({ role: "toolResult", toolName: "bash", content: `HUGE_OUTPUT${"x".repeat(70_000)}LATEST_FAILURE` });
  await screen();
  const rollover = calls[6]!.body.messages;
  assert.equal(rollover.length, 2, "history growth beyond 64k rolls over to the bounded recent seed");
  assert.ok(JSON.parse(rollover[1].content).recentContext.length <= 8_000);
  assert.match(rollover[1].content, /LATEST_FAILURE/);
  source.push({ role: "user", content: "Resume the failed worker" });
  await screen();
  const resumed = calls[7]!.body.messages;
  assert.deepEqual(resumed.slice(0, rollover.length), rollover);
  assert.equal(JSON.parse(resumed.at(-1).content).state.prompt, "Resume the failed worker");
  history.reset();
  await screen();
  assert.equal(calls[8]!.body.messages.length, 2, "explicit lifecycle resets start from a fresh seed");
});

await fakeLocal((_call) => Response.json(response()), async () => {
  const history = new RecommendationHistory();
  const source = [{ role: "user", content: "Seed" }];
  await requestRecommendation(input, { ...options, history, sourceMessages: source });
  await fakeLocal(() => new Response("failed", { status: 500 }), async () => {
    await assert.rejects(requestRecommendation(input, { ...options, history, sourceMessages: [...source, { role: "assistant", content: "New progress" }] }), /500/);
  });
  await fakeLocal(() => Response.json(response()), async (calls) => {
    await requestRecommendation(input, { ...options, history, sourceMessages: source });
    assert.equal(calls[0]!.body.messages.length, 2, "a fresh request failure clears the growing cache history");
  });
});

await fakeLocal(() => new Response("x".repeat(70_000)), async () => { await assert.rejects(requestRecommendation(input, options), /too large/); });
await fakeLocal(() => new Response("private response content", { status: 500 }), async () => {
  await assert.rejects(requestRecommendation(input, options), (error: Error) => /500/.test(error.message) && !error.message.includes("private"));
});
const streamResult = response({ reason: "Review the 새 constraint.", advisor: "yes", worker: "no" });
const streamContent = streamResult.choices[0]!.message.content;
const event = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;
const streamBody = ": keepalive 512/1024\r\n\r\n"
  + event({ model: "local", choices: [{ index: 0, delta: { role: "assistant", content: streamContent.slice(0, 30) }, finish_reason: null }] })
  + event({ choices: [{ index: 0, delta: { content: streamContent.slice(30) }, finish_reason: "stop" }] })
  + event({ choices: [], usage: streamResult.usage }) + "data: [DONE]\r\n\r\n";
const sseResponse = (body: string) => {
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
};
await fakeLocal(() => sseResponse(streamBody), async () => {
  const result = await requestRecommendation(input, options);
  assert.deepEqual(result.decisions, { advisor: "yes", worker: "no" });
  assert.equal(result.reason, "Review the 새 constraint.");
  assert.equal(result.usage?.totalTokens, 160);
});
for (const incomplete of [streamBody.replace("data: [DONE]\r\n\r\n", ""), streamBody.replace('"finish_reason":"stop"', '"finish_reason":"length"')]) {
  await fakeLocal(() => sseResponse(incomplete), async () => {
    await assert.rejects(requestRecommendation(input, options), /completion|incomplete/);
  });
}
await fakeLocal(() => sseResponse(`: ${"x".repeat(70_000)}\n\n${streamBody}`), async () => {
  await assert.rejects(requestRecommendation(input, options), /too large/, "keepalive bytes count toward the response limit too");
});

const aborted = new AbortController();
aborted.abort(new Error("Session changed"));
await fakeLocal(() => Response.json(response()), async (calls) => {
  await assert.rejects(requestRecommendation(input, { ...options, signal: aborted.signal }), /Session changed/);
  assert.equal(calls.length, 0);
});
const waitForAbort = ({ init }: Call): Promise<Response> => new Promise((_resolve, reject) => {
  const signal = init.signal!;
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
await fakeLocal(waitForAbort, async () => {
  await assert.rejects(requestRecommendation(input, { ...options, timeoutMs: 10 }), /timed out/);
});
const timedOutHistory = new RecommendationHistory();
const timedOutSource = [{ role: "user", content: "Check this task" }];
await fakeLocal(() => Response.json(response()), async () => {
  await requestRecommendation(input, { ...options, history: timedOutHistory, sourceMessages: timedOutSource });
});
timedOutSource.push({ role: "user", content: "The next task update" });
await fakeLocal(waitForAbort, async () => {
  await assert.rejects(requestRecommendation(input, { ...options, timeoutMs: 10, history: timedOutHistory, sourceMessages: timedOutSource }), /timed out/);
});
await fakeLocal(() => Response.json(response()), async (calls) => {
  await requestRecommendation(input, { ...options, history: timedOutHistory, sourceMessages: timedOutSource });
  assert.equal(calls[0]!.body.messages.length, 2, "a timeout recovers with a fresh bounded seed");
});
let requestStarted!: () => void;
const started = new Promise<void>((resolve) => { requestStarted = resolve; });
await fakeLocal((call) => { requestStarted(); return waitForAbort(call); }, async () => {
  const controller = new AbortController();
  const pending = requestRecommendation(input, { ...options, signal: controller.signal });
  await started;
  controller.abort(new Error("Session switched"));
  await assert.rejects(pending, /Session switched/);
});

// A partial streamed response must remain cancellable at the HTTP boundary.
let received!: () => void;
let disconnected!: () => void;
const receiving = new Promise<void>((resolve) => { received = resolve; });
const disconnect = new Promise<void>((resolve) => { disconnected = resolve; });
const server = createServer((_request, reply) => {
  reply.on("close", disconnected);
  reply.writeHead(200, { "Content-Type": "text/event-stream" });
  reply.write(event({ choices: [{ delta: { content: '{"reason":"unfinished' }, finish_reason: null }] }));
  received();
});
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const pending = requestRecommendation(input, { endpoint: `http://127.0.0.1:${address.port}`, signal: controller.signal, timeoutMs: 2_000 });
  const rejected = assert.rejects(pending, /Checkpoint changed/);
  await receiving;
  controller.abort(new Error("Checkpoint changed"));
  await rejected;
  await Promise.race([disconnect, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Stream cancellation did not close the connection")), 2_000);
    timer.unref();
  })]);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log("ok   local recommendations: JSON decisions, capabilities, evidence, loopback transport, bounds, and cancellation");
