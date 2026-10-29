import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import {
  ProviderModelsStore, ProviderModelsError, cleanModelList, applyProviderModelOverrides, MAX_PROVIDER_MODELS
} from "../src/provider-models.js";
import { resolveProviderDiscoveryInput } from "../src/custom-model-discovery.js";
import { createModelConfigStorage } from "../src/remote-storage.js";
import { startMockGithub } from "../test-helpers/mock-github.js";
import { startRouter } from "../test-helpers/router-harness.js";

const KEY = "sk-test-SECRET-1234567890";
const quiet = { warn() {}, log() {} };

async function startUpstream(models) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, seen, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

test("cleanModelList keeps order, drops duplicates and refuses bad ids", () => {
  assert.deepEqual(cleanModelList(["b", "a", "b", " c "]), ["b", "a", "c"]);
  assert.throws(() => cleanModelList([]), /at least one model/);
  assert.throws(() => cleanModelList("a,b"), /array/);
  assert.throws(() => cleanModelList(["has space"]), /not a valid model id/);
  assert.throws(() => cleanModelList(["a,b"]), /not a valid model id/);
  assert.throws(() => cleanModelList(Array.from({ length: MAX_PROVIDER_MODELS + 1 }, (_, i) => `m${i}`)), /At most/);
});

test("the store saves, resets, notifies and refuses unknown providers", async () => {
  const store = new ProviderModelsStore({ knownIds: ["groq", "gemini"], logger: quiet });
  const events = [];
  store.onChange((current, previous) => events.push({ current, previous }));

  assert.deepEqual(await store.set("groq", ["a", "b"]), ["a", "b"]);
  assert.deepEqual(store.get("groq"), ["a", "b"]);
  assert.equal(store.has("GROQ"), true);
  assert.deepEqual(events[0], { current: { groq: ["a", "b"] }, previous: {} });

  await assert.rejects(store.set("nope", ["a"]), (error) => error instanceof ProviderModelsError && error.status === 404);
  assert.equal(await store.reset("groq"), true);
  assert.equal(await store.reset("groq"), false, "nothing to reset the second time");
  assert.equal(store.get("groq"), null);
  assert.equal(events.length, 2);
});

test("lists survive a restart through the local file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
  const file = path.join(dir, "provider-models.json");
  await new ProviderModelsStore({ file, knownIds: ["groq"], logger: quiet }).set("groq", ["x", "y"]);
  const again = new ProviderModelsStore({ file, knownIds: ["groq"], logger: quiet });
  assert.deepEqual(again.get("groq"), ["x", "y"]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).providers.groq.models.length, 2);
});

test("GitHub holds the truth: a fresh container gets the saved lists back", async () => {
  const github = await startMockGithub();
  const remote = () => createModelConfigStorage({ repo: "acme/data", token: "ghp_testtoken", branch: "data", path: "provider-models.json", apiBase: github.apiBase });
  try {
    const first = new ProviderModelsStore({ remote: remote(), knownIds: ["groq"], logger: quiet });
    await first.init();
    await first.set("groq", ["kept-1", "kept-2"]);

    const fresh = new ProviderModelsStore({ remote: remote(), knownIds: ["groq"], logger: quiet });
    await fresh.init();
    assert.deepEqual(fresh.get("groq"), ["kept-1", "kept-2"]);

    github.setFailing?.(true);
    await assert.rejects(first.set("groq", ["lost"]), (error) => error.status === 503 || error.status === 409);
    assert.deepEqual(first.get("groq"), ["kept-1", "kept-2"], "a failed save changes nothing");
  } finally { await github.close(); }
});

test("a stale save is retried on top of the newer GitHub copy without losing the other provider", async () => {
  const github = await startMockGithub();
  const remote = () => createModelConfigStorage({ repo: "acme/data", token: "ghp_testtoken", branch: "data", path: "provider-models.json", apiBase: github.apiBase });
  try {
    const a = new ProviderModelsStore({ remote: remote(), knownIds: ["groq", "gemini"], logger: quiet });
    const b = new ProviderModelsStore({ remote: remote(), knownIds: ["groq", "gemini"], logger: quiet });
    await a.init();
    await b.init();
    await a.set("groq", ["from-a"]);
    // b still holds the revision from before a's save: GitHub refuses it once, then it is retried on the fresh copy.
    await b.set("gemini", ["from-b"]);
    assert.deepEqual(b.get("groq"), ["from-a"], "the other provider's newer list is kept");
    assert.deepEqual(b.get("gemini"), ["from-b"]);

    const fresh = new ProviderModelsStore({ remote: remote(), knownIds: ["groq", "gemini"], logger: quiet });
    await fresh.init();
    assert.deepEqual(fresh.get("groq"), ["from-a"]);
    assert.deepEqual(fresh.get("gemini"), ["from-b"]);
  } finally { await github.close(); }
});

test("applyProviderModelOverrides restores the env list when an override is gone", () => {
  const config = { providers: { groq: { models: ["env-1"] }, gemini: { models: ["env-g"] } } };
  const baseline = { groq: ["env-1"], gemini: ["env-g"] };
  applyProviderModelOverrides(config, { groq: ["picked"] }, baseline);
  assert.deepEqual(config.providers.groq.models, ["picked"]);
  assert.deepEqual(config.providers.gemini.models, ["env-g"]);
  applyProviderModelOverrides(config, {}, baseline);
  assert.deepEqual(config.providers.groq.models, ["env-1"]);
});

test("provider discovery uses the configured key and base URL, and refuses what cannot work", () => {
  const providers = {
    groq: { envPrefix: "GROQ", apiKeys: [KEY, "second"], baseUrl: "https://api.groq.com/openai/v1", models: ["m"] },
    gemini: { envPrefix: "GEMINI", apiKeys: [KEY], baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: ["g"] },
    nokey: { envPrefix: "NOKEY", apiKeys: [], baseUrl: "https://x.example.com/v1", models: ["m"] },
    nobase: { envPrefix: "NOBASE", apiKeys: [KEY], baseUrl: "", models: ["m"] },
    "custom-1": { custom: true, apiKeys: [KEY], baseUrl: "https://c.example.com/v1", models: ["m"] }
  };
  assert.deepEqual(resolveProviderDiscoveryInput("groq", providers), { protocol: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", apiKey: KEY });
  assert.equal(resolveProviderDiscoveryInput("GEMINI", providers).protocol, "gemini");
  assert.throws(() => resolveProviderDiscoveryInput("nokey", providers), /NOKEY_API_KEYS is empty/);
  assert.throws(() => resolveProviderDiscoveryInput("nobase", providers), /NOBASE_BASE_URL is empty/);
  assert.throws(() => resolveProviderDiscoveryInput("custom-1", providers), /no built-in provider/);
  assert.throws(() => resolveProviderDiscoveryInput("missing", providers), /no built-in provider/);
});

test("Providers page flow end to end: fetch, keep some, remove one, reset, and it survives a restart", async () => {
  const upstream = await startUpstream(["alpha", "beta", "gamma", "text-embedding-x"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-e2e-"));
  const env = {
    PLAYGROUND_ALLOW_PRIVATE_HOSTS: "1",
    PROVIDER_MODELS_FILE: path.join(dir, "provider-models.json"),
    GROQ_API_KEYS: KEY,
    GROQ_MODELS: "alpha",
    GROQ_BASE_URL: `http://127.0.0.1:${upstream.port}/v1`
  };
  const send = (router, method, url, body) => router.request(url, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const groq = async (router) => (await (await router.request("/api/providers")).json()).providers.find((p) => p.id === "groq");

  let router = await startRouter(env);
  try {
    const start = await groq(router);
    assert.deepEqual(start.models, ["alpha"]);
    assert.equal(start.modelsSource, "env");
    assert.equal(start.modelsEditable, true);

    const fetched = await send(router, "POST", "/api/providers/discover", { provider: "groq" });
    assert.equal(fetched.status, 200);
    const found = await fetched.json();
    assert.deepEqual(found.models, ["alpha", "beta", "gamma", "text-embedding-x"]);
    assert.deepEqual(found.current, ["alpha"]);
    assert.equal(upstream.seen.at(-1).headers.authorization, `Bearer ${KEY}`, "the configured key is what the provider sees");
    assert.equal(JSON.stringify(found).includes(KEY), false, "the key never comes back");

    const saved = await send(router, "PUT", "/api/providers/groq/models", { models: ["alpha", "beta", "gamma"] });
    assert.equal(saved.status, 200);
    let now = await groq(router);
    assert.deepEqual(now.models, ["alpha", "beta", "gamma"]);
    assert.equal(now.modelsSource, "panel");
    assert.deepEqual(now.envModels, ["alpha"]);
    assert.equal(now.targetCount, 3, "new models become routable targets at once");

    // Remove one: it leaves routing without a restart.
    await send(router, "PUT", "/api/providers/groq/models", { models: ["alpha", "gamma"] });
    now = await groq(router);
    assert.deepEqual(now.models, ["alpha", "gamma"]);
    assert.equal(now.targetCount, 2);
  } finally { await router.close(); }

  // A restart keeps the chosen list (the env still says only "alpha").
  router = await startRouter(env);
  try {
    assert.deepEqual((await groq(router)).models, ["alpha", "gamma"]);

    const reset = await send(router, "DELETE", "/api/providers/groq/models");
    assert.equal(reset.status, 200);
    const back = await groq(router);
    assert.deepEqual(back.models, ["alpha"]);
    assert.equal(back.modelsSource, "env");
    assert.equal(back.targetCount, 1);

    // Refusals
    assert.equal((await send(router, "PUT", "/api/providers/groq/models", { models: [] })).status, 400);
    assert.equal((await send(router, "PUT", "/api/providers/groq/models", { models: ["bad id"] })).status, 400);
    assert.equal((await send(router, "PUT", "/api/providers/nope/models", { models: ["a"] })).status, 404);
    assert.equal((await send(router, "POST", "/api/providers/discover", { provider: "nope" })).status, 404);
    assert.equal((await send(router, "POST", "/api/providers/discover", { provider: "gemini" })).status, 400, "no key configured");
    assert.equal((await router.request("/api/providers/discover")).status, 405);
  } finally { await router.close(); await upstream.close(); }
});

test("One Provider Fallback follows the Providers page: removed models leave its list, added ones join it, and the list is saved while the mode is off", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-one-"));
  const env = {
    PROVIDER_MODELS_FILE: path.join(dir, "provider-models.json"),
    ONE_MODEL_FILE: path.join(dir, "one-model.json"),
    GROQ_API_KEYS: KEY,
    GROQ_MODELS: "alpha,beta,gamma",
    GROQ_BASE_URL: "http://127.0.0.1:9/v1"
  };
  const send = (router, method, url, body) => router.request(url, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const one = async (router) => (await router.request("/api/one-model")).json();

  let router = await startRouter(env);
  try {
    // The list is kept with the mode OFF, so a page refresh does not lose it.
    const chosen = await send(router, "PUT", "/api/one-model", { enabled: false, provider: "groq", models: ["alpha", "beta"] });
    assert.equal(chosen.status, 200);
    assert.deepEqual((await one(router)).models, ["alpha", "beta"]);
    assert.equal((await one(router)).enabled, false);

    // Turn it on, then remove "beta" and add "delta" on the Providers page.
    assert.equal((await send(router, "PUT", "/api/one-model", { enabled: true, provider: "groq", models: ["alpha", "beta"] })).status, 200);
    assert.equal((await send(router, "PUT", "/api/providers/groq/models", { models: ["alpha", "gamma", "delta"] })).status, 200);
    let state = await one(router);
    assert.deepEqual(state.models, ["alpha", "delta"], "beta left, only the newly added delta joined (gamma was already the provider's), alpha kept first");
    assert.equal(state.enabled, true);
    assert.deepEqual(state.candidates.filter((c) => c.provider === "groq").map((c) => c.model).sort(), ["alpha", "delta", "gamma"]);
    assert.equal((await send(router, "PUT", "/api/one-model", { enabled: true, provider: "groq", models: state.models })).status, 200, "saving works: no stale model blocks it");

    // Reset the provider back to its env list: the added models leave again.
    assert.equal((await send(router, "DELETE", "/api/providers/groq/models")).status, 200);
    state = await one(router);
    assert.deepEqual(state.models, ["alpha", "beta"], "delta left, beta is back, the order already chosen is kept");
  } finally { await router.close(); }

  // A restart keeps the list.
  router = await startRouter(env);
  try {
    const state = await one(router);
    assert.equal(state.provider, "groq");
    assert.deepEqual(state.models, ["alpha", "beta"]);
  } finally { await router.close(); }
});
