import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter, postJson } from "../test-helpers/router-harness.js";

/**
 * Output intent, through the real server process.
 *
 * groq/text-model declares text only; mistral/image-model also declares
 * image_output. A plain chat message that asks for a photo must reach the
 * image model (and ask it for the media); one that asks for audio, which no
 * model here declares, must still be answered by a text model that has been told to
 * say so; ordinary chat must be untouched.
 */
const completion = (model) => ({
  status: 200,
  body: { id: "x", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }
});

// The capability notice only. The ApiRouter system prompt is also a leading system message and is
// not what these tests are about, so they look for the notice itself rather than counting messages.
const hasRouterNotice = (messages) => messages.some((m) => typeof m.content === "string" && m.content.startsWith("Router notice:"));

async function start(t, { withImageModel = true } = {}) {
  const textMock = await startMockUpstream(() => completion("text-model"));
  const imageMock = await startMockUpstream(() => completion("image-model"));
  const env = {
    GROQ_API_KEYS: "q0", GROQ_MODELS: "text-model", GROQ_BASE_URL: `${textMock.baseUrl}/v1`
  };
  if (withImageModel) {
    env.MISTRAL_API_KEYS = "m0";
    env.MISTRAL_MODELS = "image-model";
    env.MISTRAL_BASE_URL = `${imageMock.baseUrl}/v1`;
  }
  const router = await startRouter(env);
  t.after(async () => { await router.close(); await textMock.close(); await imageMock.close(); });

  const declare = async (provider, model, capabilities) => {
    const response = await router.request("/api/model-config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, model, capabilities })
    });
    assert.ok(response.status >= 200 && response.status < 300, await response.text());
  };
  await declare("groq", "text-model", ["text_input", "text_output", "streaming"]);
  if (withImageModel) await declare("mistral", "image-model", ["text_input", "text_output", "image_output", "streaming"]);

  const posts = (mock) => mock.requests.filter((r) => r.method === "POST" && String(r.url ?? r.path ?? "").includes("chat"));
  const ask = (text) => router.request("/v1/chat/completions", postJson({ model: "auto", messages: [{ role: "user", content: text }] }));
  const reset = () => { textMock.requests.length = 0; imageMock.requests.length = 0; };
  return { ask, textMock, imageMock, posts, reset };
}

test("a photo request goes to the model that declares image_output, and asks it for the image", async (t) => {
  const h = await start(t);
  h.reset();
  const response = await h.ask("create a photo of a cat");
  assert.equal(response.status, 200);
  assert.equal(h.posts(h.textMock).length, 0, "a text-only model is not tried");
  const [call] = h.posts(h.imageMock);
  assert.ok(call, "the image model is called");
  assert.deepEqual(call.body.modalities, ["image", "text"]);
});

test("a typo'd photo request (\"genarete a image\") is routed the same way", async (t) => {
  const h = await start(t);
  h.reset();
  assert.equal((await h.ask("genarete a image")).status, 200);
  assert.equal(h.posts(h.textMock).length, 0);
  assert.equal(h.posts(h.imageMock).length, 1);
});

test("requests outside the create/generate + image/photo/video shape are plain chat", async (t) => {
  const h = await start(t);
  for (const text of ["produce a photo", "give me an image of a cat", "produce a voice-over"]) {
    h.reset();
    const response = await h.ask(text);
    assert.equal(response.status, 200, text);
    const [call] = [...h.posts(h.textMock), ...h.posts(h.imageMock)];
    assert.equal(hasRouterNotice(call.body.messages), false, `${text}: no notice added`);
    assert.equal(call.body.modalities, undefined, text);
  }
});

test("\"create video\" is answered by a text model told it cannot be generated", async (t) => {
  const h = await start(t);
  h.reset();
  const response = await h.ask("create video");
  assert.equal(response.status, 200, "not rejected");
  const [call] = [...h.posts(h.textMock), ...h.posts(h.imageMock)];
  assert.equal(call.body.messages[0].role, "system");
  assert.match(call.body.messages[0].content, /video/);
  assert.match(call.body.messages[0].content, /could not be generated/);
  assert.equal(call.body.modalities, undefined);
});

test("with no image-capable model at all, a photo request falls back with the notice", async (t) => {
  const h = await start(t, { withImageModel: false });
  h.reset();
  assert.equal((await h.ask("create image")).status, 200);
  const [call] = h.posts(h.textMock);
  assert.match(call.body.messages[0].content, /image/);
  assert.match(call.body.messages[0].content, /could not be generated/);
});

test("ordinary chat is untouched: no notice, no modalities", async (t) => {
  const h = await start(t);
  h.reset();
  assert.equal((await h.ask("explain how video compression works")).status, 200);
  const [call] = [...h.posts(h.textMock), ...h.posts(h.imageMock)];
  assert.equal(hasRouterNotice(call.body.messages), false);
  assert.equal(call.body.modalities, undefined);
});
