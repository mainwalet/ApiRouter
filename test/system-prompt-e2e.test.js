import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";
import { DEFAULT_SYSTEM_PROMPT } from "../src/system-prompt.js";

/**
 * The ApiRouter system prompt, through the real server process: what the upstream
 * model actually receives.
 */
const completion = () => ({
  status: 200,
  body: { id: "x", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }
});

async function start(t, env = {}) {
  const mock = await startMockUpstream(completion);
  const router = await startRouter({
    GROQ_API_KEYS: "q0", GROQ_MODELS: "m", GROQ_BASE_URL: `${mock.baseUrl}/v1`,
    ...env
  });
  t.after(async () => { await router.close(); await mock.close(); });
  const calls = () => mock.requests.filter((r) => r.method === "POST" && String(r.url ?? r.path ?? "").includes("chat"));
  return { router, mock, calls };
}

test("openai-chat: the prompt leads, the client's own system message follows, the user message is untouched", async (t) => {
  const { router, mock, calls } = await start(t);
  mock.requests.length = 0;
  const response = await router.request("/v1/chat/completions", postJson({
    model: "auto",
    messages: [{ role: "system", content: "Answer in one word." }, { role: "user", content: "hello" }]
  }));
  assert.equal(response.status, 200);
  const [call] = calls();
  assert.deepEqual(call.body.messages, [
    { role: "system", content: DEFAULT_SYSTEM_PROMPT },
    { role: "system", content: "Answer in one word." },
    { role: "user", content: "hello" }
  ]);
});

test("anthropic client: the prompt is placed in front of its system text, reaching the model as the leading system message", async (t) => {
  const { router, mock, calls } = await start(t);
  mock.requests.length = 0;
  const response = await router.request("/v1/messages", postJson({
    model: "auto", max_tokens: 64, system: "Answer in one word.",
    messages: [{ role: "user", content: "hello" }]
  }));
  assert.equal(response.status, 200, await response.clone().text());
  const [call] = calls();
  const lead = call.body.messages[0];
  assert.equal(lead.role, "system");
  const text = typeof lead.content === "string" ? lead.content : lead.content.map((p) => p.text).join("\n");
  assert.ok(text.startsWith(DEFAULT_SYSTEM_PROMPT), "the prompt comes first");
  assert.ok(text.endsWith("Answer in one word."), "the client's own system text comes after it");
  assert.equal(call.body.messages.at(-1).content, "hello");
});

test("a request that already carries the prompt is not given it twice", async (t) => {
  const { router, mock, calls } = await start(t);
  mock.requests.length = 0;
  await router.request("/v1/chat/completions", postJson({
    model: "auto",
    messages: [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }, { role: "user", content: "hello" }]
  }));
  const [call] = calls();
  assert.equal(call.body.messages.filter((m) => m.role === "system").length, 1);
});

test("SYSTEM_PROMPT=off: the request reaches the model exactly as the client sent it", async (t) => {
  const { router, mock, calls } = await start(t, { SYSTEM_PROMPT: "off" });
  mock.requests.length = 0;
  const messages = [{ role: "user", content: "hello" }];
  assert.equal((await router.request("/v1/chat/completions", postJson({ model: "auto", messages }))).status, 200);
  const [call] = calls();
  assert.deepEqual(call.body.messages, messages);
});

test("a pinned request (Playground) is sent as written, without the prompt", async (t) => {
  const { router, mock, calls } = await start(t);
  mock.requests.length = 0;
  const messages = [{ role: "user", content: "hello" }];
  const response = await router.request("/v1/chat/completions", postJson(
    { model: "m", messages },
    { "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "0" }
  ));
  assert.equal(response.status, 200, await response.clone().text());
  const [call] = calls();
  assert.deepEqual(call.body.messages, messages);
});

test("a prompt that cannot be read stops the server at startup with a clear message", async () => {
  await assert.rejects(
    () => startRouter({ SYSTEM_PROMPT_FILE: "/nonexistent/prompt.txt" }),
    /Cannot read SYSTEM_PROMPT_FILE/
  );
});
