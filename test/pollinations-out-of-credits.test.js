import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const NOTICE = "The account behind this API key doesn\u2019t have enough credits. Please top up or complete a quest, then try again.";

const completion = (model, content) => ({
  status: 200,
  body: { id: "x", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }
});
const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const noticeStream = () => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  stream: [chunk({ role: "assistant", content: "" }), chunk({ content: NOTICE }), chunk({}, "stop"), "data: [DONE]\n\n"]
});
const goodStream = () => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  stream: [chunk({ role: "assistant", content: "" }), chunk({ content: "real " }), chunk({ content: "answer" }), chunk({}, "stop"), "data: [DONE]\n\n"]
});

const chat = (router, stream = false) => router.request("/v1/chat/completions", postJson({
  model: "anything", stream, messages: [{ role: "user", content: "hello" }]
}));

const usedKey = (record) => String(record.headers.authorization ?? "").replace(/^Bearer\s+/i, "");

test("a 200 JSON out-of-credits notice is a failed attempt: the next Pollinations key answers", async () => {
  const upstream = await startMockUpstream((record) =>
    usedKey(record) === "p0" ? completion("m", NOTICE) : completion("m", "real answer"));
  const router = await startRouter({
    POLLINATIONS_API_KEYS: "p0,p1",
    POLLINATIONS_MODELS: "m",
    POLLINATIONS_BASE_URL: `${upstream.baseUrl}/v1`
  });
  try {
    const response = await chat(router);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.equal(JSON.parse(text).choices[0].message.content, "real answer");
    assert.ok(!text.includes("enough credits"), "the notice must never reach the client as an answer");
  } finally {
    await router.close();
    await upstream.close();
  }
});

test("a streamed out-of-credits notice is a failed attempt: the next key answers", async () => {
  const upstream = await startMockUpstream((record) => usedKey(record) === "p0" ? noticeStream() : goodStream());
  const router = await startRouter({
    POLLINATIONS_API_KEYS: "p0,p1",
    POLLINATIONS_MODELS: "m",
    POLLINATIONS_BASE_URL: `${upstream.baseUrl}/v1`
  });
  try {
    const response = await chat(router, true);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.ok(text.includes("real "), text);
    assert.ok(!text.includes("enough credits"), "the notice must never be streamed to the client");
  } finally {
    await router.close();
    await upstream.close();
  }
});

test("when the Pollinations account is out of credits, the next provider answers", async () => {
  const broke = await startMockUpstream(() => completion("m", NOTICE));
  const healthy = await startMockUpstream(() => completion("g", "from groq"));
  const router = await startRouter({
    POLLINATIONS_API_KEYS: "p0",
    POLLINATIONS_MODELS: "m",
    POLLINATIONS_BASE_URL: `${broke.baseUrl}/v1`,
    GROQ_API_KEYS: "g0",
    GROQ_MODELS: "g",
    GROQ_BASE_URL: `${healthy.baseUrl}/v1`
  });
  try {
    for (let i = 0; i < 2; i += 1) {
      const response = await chat(router);
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.equal(JSON.parse(text).choices[0].message.content, "from groq");
    }
  } finally {
    await router.close();
    await broke.close();
    await healthy.close();
  }
});

test("when every target is out of credits the client gets an error, not the notice as an answer", async () => {
  const broke = await startMockUpstream(() => completion("m", NOTICE));
  const router = await startRouter({
    POLLINATIONS_API_KEYS: "p0",
    POLLINATIONS_MODELS: "m",
    POLLINATIONS_BASE_URL: `${broke.baseUrl}/v1`
  });
  try {
    const response = await chat(router);
    const text = await response.text();
    assert.ok(response.status >= 400, `expected an error status, got ${response.status}: ${text}`);
  } finally {
    await router.close();
    await broke.close();
  }
});

test("a normal Pollinations reply passes through untouched, JSON and stream", async () => {
  const upstream = await startMockUpstream((record) =>
    JSON.parse(record.rawBody || "{}").stream ? goodStream() : completion("m", "real answer"));
  const router = await startRouter({
    POLLINATIONS_API_KEYS: "p0",
    POLLINATIONS_MODELS: "m",
    POLLINATIONS_BASE_URL: `${upstream.baseUrl}/v1`
  });
  try {
    const json = await chat(router);
    assert.equal(JSON.parse(await json.text()).choices[0].message.content, "real answer");
    const streamed = await (await chat(router, true)).text();
    assert.ok(streamed.includes("real ") && streamed.includes("answer") && streamed.includes("[DONE]"), streamed);
  } finally {
    await router.close();
    await upstream.close();
  }
});
