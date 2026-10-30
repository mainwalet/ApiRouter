import test from "node:test";
import assert from "node:assert/strict";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { postJson, startRouter } from "../test-helpers/router-harness.js";

const MODELS = ["m-1", "m-2", "m-3"];

async function startBulkRouter() {
  const upstream = await startMockUpstream(() => ({ status: 200, body: { id: "x", object: "chat.completion", choices: [] } }));
  const router = await startRouter({
    GROQ_API_KEYS: "g0",
    GROQ_MODELS: MODELS.join(","),
    GROQ_BASE_URL: `${upstream.baseUrl}/v1`
  });
  return { router, upstream };
}

const rows = async (router) => (await (await router.request("/api/model-config")).json()).models;
const byModel = (list, model) => list.find((row) => row.model === model);

test("POST /api/model-config/bulk adds a capability to every listed model, declared or not", async () => {
  const { router, upstream } = await startBulkRouter();
  try {
    // One model already has a saved declaration (and a context limit that must survive).
    const created = await router.request("/api/model-config", postJson({
      provider: "groq", model: "m-1", capabilities: ["text_input", "text_output"], contextLimit: 200000
    }));
    assert.equal(created.status, 201);

    const response = await router.request("/api/model-config/bulk", postJson({
      models: MODELS.map((model) => ({ provider: "groq", model })),
      add: ["streaming", "tool_calling"]
    }));
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.ok, true);
    assert.equal(body.changed, 3);
    assert.equal(body.created, 2);

    const list = await rows(router);
    for (const model of MODELS) {
      const row = byModel(list, model);
      assert.equal(row.stored, true, `${model} now has a saved declaration`);
      assert.ok(row.capabilities.includes("streaming"), `${model} streaming`);
      assert.ok(row.capabilities.includes("tool_calling"), `${model} tool_calling`);
      assert.ok(row.capabilities.includes("text_input"), `${model} keeps the inferred base`);
    }
    assert.equal(byModel(list, "m-1").contextLimit, 200000, "other fields are untouched");
  } finally {
    await router.close(); await upstream.close();
  }
});

test("POST /api/model-config/bulk accepts \"all\" and can remove a capability", async () => {
  const { router, upstream } = await startBulkRouter();
  try {
    const added = await router.request("/api/model-config/bulk", postJson({ models: "all", add: ["streaming"] }));
    assert.equal(added.status, 200, await added.clone().text());
    assert.ok((await rows(router)).every((row) => row.capabilities.includes("streaming")));

    const removed = await router.request("/api/model-config/bulk", postJson({ models: "all", remove: ["streaming"] }));
    const body = await removed.json();
    assert.equal(removed.status, 200);
    assert.equal(body.changed, 3);
    assert.ok((await rows(router)).every((row) => !row.capabilities.includes("streaming")));

    const again = await router.request("/api/model-config/bulk", postJson({ models: "all", remove: ["streaming"] }));
    assert.equal((await again.json()).changed, 0, "already matching models are not rewritten");
  } finally {
    await router.close(); await upstream.close();
  }
});

test("POST /api/model-config/bulk refuses bad requests and saves nothing", async () => {
  const { router, upstream } = await startBulkRouter();
  try {
    const send = (body) => router.request("/api/model-config/bulk", postJson(body));

    const unknown = await send({ models: [{ provider: "groq", model: "m-1" }, { provider: "groq", model: "nope" }], add: ["streaming"] });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error?.type, "unknown_model");

    assert.equal((await send({ models: [{ provider: "groq", model: "m-1" }] })).status, 400, "nothing to add or remove");
    assert.equal((await send({ models: [], add: ["streaming"] })).status, 400, "no models");
    assert.equal((await send({ models: [{ provider: "groq", model: "m-1" }], add: ["bogus"] })).status, 400, "unknown capability");

    const get = await router.request("/api/model-config/bulk");
    assert.equal(get.status, 405);

    assert.ok((await rows(router)).every((row) => row.stored === false), "no refused request wrote anything");
  } finally {
    await router.close(); await upstream.close();
  }
});
