/** No model calls: schema, public evidence, and loopback transport checks. */
import assert from "node:assert/strict";
import { formatRecommendation, formatRecommendationStatus, recommendationEvidence, requestRecommendation, type RecommendationInput } from "./recommendations.ts";

const input: RecommendationInput = { prompt: "Implement the scoped task", recentContext: "Tests fail", advisorAvailable: true, fusionAvailable: true, workers: [] };
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
  assert.match(formatRecommendation(result), /optional guidance/);
  assert.match(formatRecommendation(result), /Evaluate each yes recommendation before continuing or finalizing/);
  assert.match(formatRecommendation(result), /If it is still useful, consult ask_advisor or delegate via fusion_spawn\/fusion_followup/);
  assert.match(formatRecommendation(result), /if you skip it, briefly state the concrete reason in your next user-facing update/);
  assert.match(formatRecommendation(result), /User and project instructions, Fusion mode, and tool permissions take precedence/);
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
    workers: Array.from({ length: 21 }, (_, i) => ({ id: `worker-${i}`, label: "label".repeat(100), status: "running".repeat(100) })),
  }, options);
  const evidence = JSON.parse(calls[0]!.body.messages[1].content);
  assert.ok(evidence.prompt.length <= 6_000);
  assert.match(evidence.prompt, /^PROMPT_HEAD/);
  assert.match(evidence.prompt, /PROMPT_TAIL$/);
  assert.match(evidence.prompt, /omitted/);
  assert.ok(evidence.recentContext.length <= 8_000);
  assert.match(evidence.recentContext, /LATEST_TOOL_ERROR$/);
  assert.equal(evidence.workers.length, 20);
  assert.equal(evidence.omittedWorkers, 1);
  assert.ok(evidence.workers.every((worker: any) => worker.label.length <= 160 && worker.status.length <= 40));
  assert.equal(result.inputTruncated, true);
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

await fakeLocal(() => new Response("x".repeat(70_000)), async () => { await assert.rejects(requestRecommendation(input, options), /too large/); });
await fakeLocal(() => new Response("private response content", { status: 500 }), async () => {
  await assert.rejects(requestRecommendation(input, options), (error: Error) => /500/.test(error.message) && !error.message.includes("private"));
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
let requestStarted!: () => void;
const started = new Promise<void>((resolve) => { requestStarted = resolve; });
await fakeLocal((call) => { requestStarted(); return waitForAbort(call); }, async () => {
  const controller = new AbortController();
  const pending = requestRecommendation(input, { ...options, signal: controller.signal });
  await started;
  controller.abort(new Error("Session switched"));
  await assert.rejects(pending, /Session switched/);
});

console.log("ok   local recommendations: JSON decisions, capabilities, evidence, loopback transport, bounds, and cancellation");
