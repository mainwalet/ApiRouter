import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_CONTEXT_LIMIT,
  contextLimitMessage,
  evaluateCandidate,
  exceedsContextLimit,
  filterTargetsByRequirements,
  isContextLimitFailure,
  normalizeContextLimit
} from "../src/model-capabilities.js";
import { ModelConfigStore } from "../src/model-config.js";
import { analyzeRequest, estimateRequestTokens } from "../src/request-profile.js";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { postJson, startRouter } from "../test-helpers/router-harness.js";

const quiet = { warn() {}, error() {} };
const target = (model, extra = {}) => ({ provider: "groq", model, protocols: ["openai-chat"], keyIndex: 0, ...extra });

// ---------------------------------------------------------------------------
// The size rule
// ---------------------------------------------------------------------------

test("a context limit is a positive whole number of tokens, or not declared", () => {
  assert.equal(normalizeContextLimit(1_000_000), 1_000_000);
  assert.equal(normalizeContextLimit("200000"), 200_000);
  assert.equal(normalizeContextLimit(" 500000 "), 500_000);
  for (const bad of [0, -5, NaN, Infinity, "", "abc", "1m", null, undefined, {}, [], MAX_CONTEXT_LIMIT + 1]) {
    assert.equal(normalizeContextLimit(bad), null, `${String(bad)} is not a limit`);
  }
});

test("a request is too big only when a limit is declared and the request is larger", () => {
  assert.equal(exceedsContextLimit(500_000, 600_000), true);
  assert.equal(exceedsContextLimit(500_000, 500_000), false, "a request exactly at the limit fits");
  assert.equal(exceedsContextLimit(500_000, 499_999), false);
  // Unknown limit or unknown size is never evidence against a model.
  assert.equal(exceedsContextLimit(null, 9_000_000), false, "no declared limit: never skipped");
  assert.equal(exceedsContextLimit(undefined, 9_000_000), false);
  assert.equal(exceedsContextLimit(500_000, 0), false, "an unmeasured request skips nothing");
  assert.equal(exceedsContextLimit(500_000, undefined), false);
});

test("a context exclusion is reported after capabilities, with its own reason", () => {
  const big = { contextLimit: 100, requestTokens: 600 };

  // No capability requirement at all: size alone still decides.
  assert.deepEqual(evaluateCandidate({ ...big }), { eligible: false, reason: "context_limit_exceeded", missing: [] });
  assert.equal(evaluateCandidate({ contextLimit: 1000, requestTokens: 600 }).eligible, true);

  // A model that cannot do the job is reported for that, not for being small.
  const verdict = evaluateCandidate({
    required: ["image_input"], declared: ["text_input"], protocols: ["openai-chat"], ...big
  });
  assert.equal(verdict.reason, "capability_not_configured");

  // A switched-off model stays "disabled", whatever its size.
  assert.equal(evaluateCandidate({ enabled: false, ...big }).reason, "model_config_disabled");
});

// ---------------------------------------------------------------------------
// The filter, on the scenario this feature exists for
// ---------------------------------------------------------------------------

const EXAMPLE_LIMITS = { "model-1": 1_000_000, "model-2": 500_000, "model-3": 200_000, "model-4": 700_000 };
const exampleTargets = Object.keys(EXAMPLE_LIMITS).map((model) => target(model));
const exampleLookup = (t) => ({ enabled: true, capabilities: ["text_input", "text_output"], contextLimit: EXAMPLE_LIMITS[t.model] });

test("a 600k request keeps only the models that can hold it, in the order they were given", () => {
  const { eligible, exclusions } = filterTargetsByRequirements(
    exampleTargets, ["text_input", "text_output"], exampleLookup, { requestTokens: 600_000 }
  );

  // 1M, then 700k: the 500k and 200k models are never part of the walk.
  assert.deepEqual(eligible.map((t) => t.model), ["model-1", "model-4"]);
  assert.deepEqual(exclusions.map((e) => [e.model, e.reason, e.contextLimit, e.requestTokens]), [
    ["model-2", "context_limit_exceeded", 500_000, 600_000],
    ["model-3", "context_limit_exceeded", 200_000, 600_000]
  ]);
});

test("a smaller request still sees every model, and no size means no size filtering", () => {
  const names = (result) => result.eligible.map((t) => t.model);
  assert.deepEqual(names(filterTargetsByRequirements(exampleTargets, [], exampleLookup, { requestTokens: 150_000 })),
    ["model-1", "model-2", "model-3", "model-4"]);
  assert.deepEqual(names(filterTargetsByRequirements(exampleTargets, [], exampleLookup, { requestTokens: 200_000 })),
    ["model-1", "model-2", "model-3", "model-4"], "exactly at the limit still fits");
  // Callers that pass no size (embeddings, realtime) behave exactly as before.
  assert.deepEqual(names(filterTargetsByRequirements(exampleTargets, [], exampleLookup)),
    ["model-1", "model-2", "model-3", "model-4"]);
});

test("a model with no declared limit is never skipped for size", () => {
  const lookup = (t) => ({ enabled: true, capabilities: [], contextLimit: t.model === "known-small" ? 1000 : null });
  const { eligible, exclusions } = filterTargetsByRequirements(
    [target("known-small"), target("unknown")], [], lookup, { requestTokens: 50_000 }
  );
  assert.deepEqual(eligible.map((t) => t.model), ["unknown"]);
  assert.equal(exclusions.length, 1);
  assert.equal(exclusions[0].model, "known-small");
});

test("every key of a too-small model leaves, and the exclusion is reported once", () => {
  const targets = [target("small", { keyIndex: 0 }), target("small", { keyIndex: 1 }), target("big", { keyIndex: 0 })];
  const lookup = (t) => ({ enabled: true, capabilities: [], contextLimit: t.model === "small" ? 10 : 10_000 });
  const { eligible, exclusions } = filterTargetsByRequirements(targets, [], lookup, { requestTokens: 500 });
  assert.deepEqual(eligible.map((t) => `${t.model}#${t.keyIndex}`), ["big#0"]);
  assert.equal(exclusions.length, 1);
});

test("the message for a request nothing can hold names its size and the largest limit", () => {
  const { exclusions } = filterTargetsByRequirements(
    exampleTargets.slice(1, 3), [], exampleLookup, { requestTokens: 600_000 }
  );
  assert.equal(isContextLimitFailure(exclusions), true);
  const message = contextLimitMessage(exclusions, 600_000);
  assert.match(message, /^prompt is too long: about 600000 tokens > 500000 maximum/);
  assert.equal(isContextLimitFailure([{ reason: "capability_not_configured" }]), false);
  assert.equal(isContextLimitFailure([]), false);
});

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

test("a context limit is saved, kept across other edits, cleared explicitly and restored from disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-limit-"));
  const file = path.join(dir, "model-config.json");
  const store = new ModelConfigStore({ file, logger: quiet });
  const known = new Set(["groq/m"]);

  const created = await store.create({ provider: "groq", model: "m", contextLimit: 200_000 }, { knownModels: known });
  assert.equal(created.entry.contextLimit, 200_000);

  // An edit that does not mention the limit leaves it alone.
  const renamed = await store.update(created.entry.id, { displayName: "M" }, { knownModels: known });
  assert.equal(renamed.entry.contextLimit, 200_000);

  // The string a form sends is accepted as a number.
  const typed = await store.update(created.entry.id, { contextLimit: "1000000" }, { knownModels: known });
  assert.equal(typed.entry.contextLimit, 1_000_000);

  const reopened = new ModelConfigStore({ file, logger: quiet });
  assert.equal(reopened.list()[0].contextLimit, 1_000_000);
  assert.equal(reopened.index([target("m")]).get("groq/m").contextLimit, 1_000_000);

  // null and "" both mean "not declared".
  for (const empty of [null, ""]) {
    await store.update(created.entry.id, { contextLimit: 5 }, { knownModels: known });
    const cleared = await store.update(created.entry.id, { contextLimit: empty }, { knownModels: known });
    assert.equal(cleared.entry.contextLimit, null, `${JSON.stringify(empty)} clears the limit`);
  }
});

test("a model nobody declared has no context limit", () => {
  const store = new ModelConfigStore({ logger: quiet });
  assert.equal(store.index([target("m")]).get("groq/m").contextLimit, null);
});

test("a context limit that is not a size is refused on a write", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  for (const bad of [0, -1, 1.5, "abc", "1m", {}, [], true, MAX_CONTEXT_LIMIT + 1]) {
    await assert.rejects(
      () => store.create({ provider: "groq", model: "m", contextLimit: bad }),
      (error) => error.status === 400 && error.type === "invalid_context_limit",
      `${JSON.stringify(bad)} must be refused`
    );
  }
  assert.equal(store.list().length, 0, "nothing was saved");
});

test("a bad stored limit is forgiven as not declared and keeps the rest of the entry", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "context-limit-")), "model-config.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    models: [
      { provider: "groq", model: "a", capabilities: ["text_input"], contextLimit: "garbage" },
      { provider: "groq", model: "b", capabilities: ["text_input"] },
      { provider: "groq", model: "c", capabilities: ["text_input"], contextLimit: 128000 }
    ]
  }));
  const store = new ModelConfigStore({ file, logger: quiet });
  assert.deepEqual(store.list().map((entry) => [entry.model, entry.contextLimit]), [["a", null], ["b", null], ["c", 128_000]]);
  assert.deepEqual(store.list()[0].capabilities, ["text_input"], "the entry is kept");
});

// ---------------------------------------------------------------------------
// The size of a request
// ---------------------------------------------------------------------------

test("a request is measured at about four characters per token across client protocols", () => {
  const text = "x".repeat(40_000);
  const chatTokens = estimateRequestTokens({ messages: [{ role: "user", content: text }] });
  const responsesTokens = estimateRequestTokens({ input: text });
  const geminiTokens = estimateRequestTokens({ contents: [{ role: "user", parts: [{ text }] }] });
  const anthropicTokens = estimateRequestTokens({ system: "be brief", messages: [{ role: "user", content: text }] });
  for (const tokens of [chatTokens, responsesTokens, geminiTokens, anthropicTokens]) {
    assert.ok(tokens >= 10_000 && tokens < 10_200, `about 10k tokens, got ${tokens}`);
  }
  // System prompt and tool definitions are part of the context.
  assert.ok(estimateRequestTokens({ messages: [], system: text }) >= 10_000);
  assert.ok(estimateRequestTokens({ messages: [], tools: [{ name: "t", description: text }] }) >= 10_000);
});

test("only what the model reads is measured, and an inline image is never counted as text", () => {
  assert.equal(estimateRequestTokens({ model: "m", max_tokens: 99_999, temperature: 1 }), 0, "settings are not context");
  assert.equal(estimateRequestTokens(null), 0);
  assert.equal(estimateRequestTokens("a string"), 0);

  const image = "A".repeat(2_000_000);
  const anthropic = estimateRequestTokens({ messages: [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: image } }
  ] }] });
  const openai = estimateRequestTokens({ messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }
  ] }] });
  const gemini = estimateRequestTokens({ contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: image } }] }] });
  for (const tokens of [anthropic, openai, gemini]) {
    assert.ok(tokens > 0 && tokens < 9_000, `a 2 MB image is a bounded estimate, got ${tokens}`);
  }
});

test("the request profile carries the estimate", () => {
  const profile = analyzeRequest({
    protocol: "openai-chat",
    pathname: "/v1/chat/completions",
    body: { messages: [{ role: "user", content: "x".repeat(4000) }] }
  });
  assert.ok(profile.estimatedInputTokens >= 1000 && profile.estimatedInputTokens < 1100);
});

// ---------------------------------------------------------------------------
// End to end: the gateway
// ---------------------------------------------------------------------------

const okBody = (model) => ({
  status: 200,
  body: {
    id: "x",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }]
  }
});

const putJson = (router, pathname, method, body) => router.request(pathname, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});

const MODELS = ["model-1", "model-2", "model-3", "model-4"];

/** One provider, four models declared with the limits from the feature request. */
async function startLimited({ failing = [], limits = EXAMPLE_LIMITS } = {}) {
  const upstream = await startMockUpstream((record) => {
    const model = record.body?.model;
    return failing.includes(model) ? { status: 500, body: { error: { message: "upstream down" } } } : okBody(model);
  });
  const router = await startRouter({
    GROQ_API_KEYS: "g0",
    GROQ_MODELS: MODELS.join(","),
    GROQ_BASE_URL: `${upstream.baseUrl}/v1`
  });
  for (const model of MODELS) {
    const response = await putJson(router, "/api/model-config", "POST", {
      provider: "groq", model, capabilities: ["text_input", "text_output", "streaming"], contextLimit: limits[model] ?? null
    });
    assert.equal(response.status, 201, await response.clone().text());
  }
  const chain = await putJson(router, "/api/fallback", "PUT", {
    entries: MODELS.map((model) => ({ provider: "groq", model }))
  });
  assert.equal(chain.status, 200, await chain.clone().text());
  return { router, upstream };
}

const sentModels = (upstream) => [...new Set(upstream.apiRequests.map((record) => record.body?.model))];
const chatOf = (characters) => postJson({
  model: "anything",
  messages: [{ role: "user", content: "x".repeat(characters) }]
});

test("a 600k request tries the 1M model first and falls back to the 700k model, never the smaller two", async () => {
  const { router, upstream } = await startLimited({ failing: ["model-1"] });
  try {
    // About 600,000 estimated tokens.
    const response = await router.request("/v1/chat/completions", chatOf(2_400_000));
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(JSON.parse(text).model, "model-4", "the 700k model answered after the 1M model failed");
    assert.deepEqual(sentModels(upstream), ["model-1", "model-4"], "the 500k and 200k models were never called");
  } finally {
    await router.close(); await upstream.close();
  }
});

test("a small request still walks the chain in order, so nothing is skipped without a reason", async () => {
  const { router, upstream } = await startLimited({ failing: ["model-1", "model-2"] });
  try {
    const response = await router.request("/v1/chat/completions", chatOf(400));
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(sentModels(upstream), ["model-1", "model-2", "model-3"]);
  } finally {
    await router.close(); await upstream.close();
  }
});

test("a request too big for every model is a clear 400 and reaches no upstream", async () => {
  const { router, upstream } = await startLimited();
  try {
    // About 1.1M estimated tokens: larger than the biggest declared limit (1M).
    const response = await router.request("/v1/chat/completions", chatOf(4_400_000));
    const body = JSON.parse(await response.text());
    assert.equal(response.status, 400);
    assert.equal(body.error.type, "context_length_exceeded");
    assert.equal(body.error.code, "context_length_exceeded");
    assert.match(body.error.message, /^prompt is too long: about \d+ tokens > 1000000 maximum/);
    assert.ok(body.error.estimated_input_tokens > 1_000_000);
    assert.deepEqual(
      body.error.excluded_candidates.map((entry) => [entry.model, entry.reason]).sort(),
      MODELS.map((model) => [model, "context_limit_exceeded"]).sort()
    );
    assert.equal(upstream.apiRequests.length, 0, "no model was called");
  } finally {
    await router.close(); await upstream.close();
  }
});

test("models without a declared limit keep serving requests of any size", async () => {
  const { router, upstream } = await startLimited({ limits: { "model-1": 1000, "model-2": 1000 } });
  try {
    // model-1 and model-2 are far too small; model-3 and model-4 declare nothing.
    const response = await router.request("/v1/chat/completions", chatOf(400_000));
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(sentModels(upstream), ["model-3"], "the first model that can hold it, in chain order");
  } finally {
    await router.close(); await upstream.close();
  }
});

test("the configurator API reports the limit and refuses a bad one", async () => {
  const { router, upstream } = await startLimited();
  try {
    const payload = await (await router.request("/api/model-config")).json();
    const limits = Object.fromEntries(payload.models.map((row) => [row.model, row.contextLimit]));
    assert.deepEqual(limits, EXAMPLE_LIMITS);

    const row = payload.models.find((entry) => entry.model === "model-1");
    const refused = await putJson(router, `/api/model-config/${encodeURIComponent(row.configId)}`, "PUT", { contextLimit: "lots" });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error.type, "invalid_context_limit");

    const cleared = await putJson(router, `/api/model-config/${encodeURIComponent(row.configId)}`, "PUT", { contextLimit: null });
    assert.equal(cleared.status, 200);
    const after = await (await router.request("/api/model-config")).json();
    assert.equal(after.models.find((entry) => entry.model === "model-1").contextLimit, null);
  } finally {
    await router.close(); await upstream.close();
  }
});
