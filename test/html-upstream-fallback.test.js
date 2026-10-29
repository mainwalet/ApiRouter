import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

const ok = (model) => ({
  status: 200,
  body: { id: "x", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }
});

// What a Cloudflare challenge looks like: HTTP 200 with an HTML page.
const cloudflarePage = {
  status: 200,
  headers: { "content-type": "text/html; charset=UTF-8", server: "cloudflare" },
  body: "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>challenge</body></html>"
};

const chat = (router) => router.request("/v1/chat/completions", postJson({
  model: "anything", messages: [{ role: "user", content: "hello" }]
}));

test("a 200 HTML page from one provider falls back to the next provider instead of being forwarded", async () => {
  const blocked = await startMockUpstream(() => cloudflarePage);
  const healthy = await startMockUpstream(() => ok("m2"));
  const router = await startRouter({
    GROQ_API_KEYS: "g0",
    GROQ_MODELS: "m1",
    GROQ_BASE_URL: `${blocked.baseUrl}/v1`,
    MISTRAL_API_KEYS: "s0",
    MISTRAL_MODELS: "m2",
    MISTRAL_BASE_URL: `${healthy.baseUrl}/v1`
  });
  try {
    const response = await chat(router);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(JSON.parse(text).choices[0].message.content, "hi");
    assert.ok(!/<html/i.test(text), "the HTML challenge page must never reach the client");
  } finally {
    await router.close();
    await blocked.close();
    await healthy.close();
  }
});

test("when every provider answers HTML the client gets a JSON error, not the HTML page", async () => {
  const blocked = await startMockUpstream(() => cloudflarePage);
  const router = await startRouter({
    GROQ_API_KEYS: "g0",
    GROQ_MODELS: "m1",
    GROQ_BASE_URL: `${blocked.baseUrl}/v1`
  });
  try {
    const response = await chat(router);
    const text = await response.text();
    assert.ok(response.status >= 500, `expected a 5xx, got ${response.status}: ${text}`);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.ok(!/<html/i.test(text));
  } finally {
    await router.close();
    await blocked.close();
  }
});
