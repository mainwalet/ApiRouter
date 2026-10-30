import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelConfigError, ModelConfigStore, modelConfigId } from "../src/model-config.js";
import { createModelConfigStorage } from "../src/remote-storage.js";
import { startMockGithub } from "../test-helpers/mock-github.js";

const tmpFile = (name = "model-config.json") => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "model-config-")), name);

const target = (provider, model, extra = {}) => ({
  provider, model, protocols: ["openai-chat"], keyIndex: 0, ...extra
});

const quiet = { warn() {}, error() {} };

test("a declaration is persisted to plain JSON and restored", async () => {
  const file = tmpFile();
  const store = new ModelConfigStore({ file, logger: quiet });

  const created = await store.create({
    provider: "Groq",
    model: "llama-3.3-70b",
    capabilities: ["text_input", "text_output", "tool_calling"],
    metadata: { notes: "primary" }
  }, { knownModels: new Set(["groq/llama-3.3-70b"]) });

  assert.equal(created.entry.provider, "groq", "provider ids are normalized");
  assert.equal(created.entry.id, modelConfigId("groq", "llama-3.3-70b"));

  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(document.version, 1);
  assert.equal(document.models.length, 1);
  assert.equal(document.models[0].model, "llama-3.3-70b");
  assert.equal(JSON.stringify(document).includes("apiKey"), false);

  const reopened = new ModelConfigStore({ file, logger: quiet });
  assert.equal(reopened.list().length, 1);
  assert.deepEqual(reopened.list()[0].capabilities, ["text_input", "text_output", "tool_calling"]);
});

test("writing is atomic and a corrupt local file is ignored, not fatal", async () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ not json");
  const store = new ModelConfigStore({ file, logger: quiet });
  assert.equal(store.list().length, 0);
  assert.match(store.warnings[0], /Ignored/);

  await store.create({ provider: "groq", model: "m", capabilities: ["text_input"] }, { knownModels: new Set(["groq/m"]) });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).models.length, 1);
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp")), false);
});

test("capability declarations are normalized and unknown ids are warned about", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const { entry, warnings } = await store.create({
    provider: "groq",
    model: "m",
    capabilities: ["streaming", "text_input", "made_up", "streaming"]
  }, { knownModels: new Set(["groq/m"]) });

  assert.deepEqual(entry.capabilities, ["text_input", "streaming"]);
  assert.match(warnings[0], /made_up/);
});

test("identity is immutable and a duplicate model is refused", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const knownModels = new Set(["groq/m", "groq/other"]);
  const { entry } = await store.create({ provider: "groq", model: "m", capabilities: ["text_input"] }, { knownModels });

  await assert.rejects(
    () => store.update(entry.id, { provider: "groq", model: "other" }),
    (error) => error instanceof ModelConfigError && error.type === "identity_immutable"
  );
  await assert.rejects(
    () => store.create({ provider: "groq", model: "m" }, { knownModels }),
    (error) => error.status === 409 && error.type === "conflict"
  );
});

test("credentials are refused, including token-shaped metadata", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const knownModels = new Set(["groq/m"]);

  for (const input of [
    { provider: "groq", model: "m", apiKey: "sk-live-abcdef123456" },
    { provider: "groq", model: "m", metadata: { apiKey: "secret" } },
    { provider: "groq", model: "m", metadata: { note: "sk-live-abcdef123456" } },
    { provider: "groq", model: "m", metadata: { note: "Bearer abcdef123456" } }
  ]) {
    await assert.rejects(
      () => store.create(input, { knownModels }),
      (error) => error instanceof ModelConfigError && error.type === "secret_rejected",
      JSON.stringify(input)
    );
  }
  assert.equal(store.list().length, 0);
});

test("credentials pasted into names and metadata arrays are refused, and nothing is truncated", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const knownModels = new Set(["groq/m"]);

  for (const input of [
    { provider: "groq", model: "m", displayName: "sk-live-abcdef123456" },
    { provider: "groq", model: "m", metadata: { aliases: ["sk-live-abcdef123456"] } },
    { provider: "groq", model: "sk-live-abcdef123456" }
  ]) {
    await assert.rejects(
      () => store.create(input, { knownModels }),
      (error) => error instanceof ModelConfigError && error.type === "secret_rejected",
      JSON.stringify(input)
    );
  }

  await assert.rejects(
    () => store.create({ provider: "groq", model: "m", metadata: { aliases: ["x".repeat(501)] } }, { knownModels }),
    (error) => error.status === 400 && error.type === "invalid_request"
  );
  assert.equal(store.list().length, 0);
});

test("a loaded document is validated field by field and unsafe entries are dropped", () => {
  const store = new ModelConfigStore({ logger: quiet });
  store.applyDocument({
    version: 1,
    models: [
      { provider: "groq", model: "string-enabled", enabled: "false" },
      { provider: "groq", model: "string-caps", capabilities: "text_input" },
      { provider: "groq", model: "bad-secret", apiKey: "sk-live-abcdef123456" },
      { provider: "groq", model: "bad-array", metadata: { aliases: ["sk-live-abcdef123456"] } },
      { provider: "groq", model: "bad-proto", metadata: JSON.parse('{"__proto__":{"polluted":true}}') },
      { provider: "groq", model: "good", enabled: true, capabilities: ["text_input"], metadata: { notes: "ok" } }
    ]
  });

  assert.deepEqual(store.list().map((entry) => entry.model), ["good"]);
  assert.equal(store.list()[0].enabled, true);
  assert.deepEqual(store.list()[0].capabilities, ["text_input"]);
  assert.equal(store.skipped.length, 5);
  assert.equal({}.polluted, undefined);
});

test("an unknown model cannot be declared, so a typo never becomes an invisible entry", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  await assert.rejects(
    () => store.create({ provider: "groq", model: "nope" }, { knownModels: new Set(["groq/m"]) }),
    (error) => error.status === 400 && error.type === "unknown_model"
  );
});

test("the effective index overlays declarations on the environment", () => {
  const store = new ModelConfigStore({ logger: quiet });
  const targets = [
    target("groq", "text-model"),
    target("groq", "text-model", { keyIndex: 1 }),
    target("groq", "vision-model"),
    target("gemini", "flash", { protocols: ["gemini"] })
  ];

  // Before any save every model is inferred as text in / text out / streaming
  // and nothing else. A name ("vision-model"), a provider or a protocol (gemini) earns no
  // image_input: only a declaration does.
  let index = store.index(targets);
  assert.equal(index.get("groq/text-model").capabilitiesSource, "inferred");
  assert.equal(index.get("groq/text-model").keyCount, 2);
  for (const id of ["groq/text-model", "groq/vision-model", "gemini/flash"]) {
    assert.deepEqual([...index.get(id).capabilities].sort(), ["streaming", "text_input", "text_output"], `${id}: defaults only`);
  }

  // After a save the declaration replaces the inference for that pair only.
  store.entries = [{
    id: modelConfigId("groq", "text-model"),
    provider: "groq",
    model: "text-model",
    displayName: "Text model",
    enabled: false,
    capabilities: ["text_input"],
    protocol: null,
    metadata: {},
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }];
  index = store.index(targets);
  assert.equal(index.get("groq/text-model").capabilitiesSource, "configured");
  assert.deepEqual(index.get("groq/text-model").capabilities, ["text_input"]);
  assert.equal(index.get("groq/text-model").enabled, false);
  assert.equal(store.explicitlyDisabled("groq", "text-model"), true);

  // The other models keep the environment behaviour exactly.
  assert.equal(index.get("groq/vision-model").capabilitiesSource, "inferred");
  assert.equal(index.get("groq/vision-model").enabled, true);
});

test("a declaration whose model is no longer configured stays visible and warns", () => {
  const store = new ModelConfigStore({ logger: quiet });
  store.entries = [{
    id: modelConfigId("groq", "gone"),
    provider: "groq",
    model: "gone",
    displayName: "gone",
    enabled: true,
    capabilities: ["text_input"],
    protocol: null,
    metadata: {},
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }];

  const rows = store.listEffective([]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].configuredInEnvironment, false);
  assert.match(rows[0].warnings.join(" "), /No provider currently configures this model/);
});

test("image input is a routing dead end only when no adapter can carry it, never because of a pool", () => {
  const store = new ModelConfigStore({ logger: quiet });
  store.entries = [{
    id: modelConfigId("groq", "text-model"),
    provider: "groq",
    model: "text-model",
    displayName: "text-model",
    enabled: true,
    capabilities: ["text_input", "text_output", "image_input"],
    protocol: null,
    metadata: {},
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }];

  // Declared on a model whose adapter can carry images: this is how a model is
  // made an image candidate, so there is nothing to warn about.
  const row = store.index([target("groq", "text-model")]).get("groq/text-model");
  assert.deepEqual(row.warnings, []);
  assert.ok(row.executableCapabilities.includes("image_input"));
  assert.deepEqual(row.unsupportedCapabilities, []);

  // Declared on a model that only speaks a wire format no adapter can execute:
  // the declaration is a dead end, and the row says so.
  const stuck = store.index([target("groq", "text-model", { protocols: ["mystery-wire"] })]).get("groq/text-model");
  assert.ok(stuck.unsupportedCapabilities.includes("image_input"));
  assert.ok(!stuck.executableCapabilities.includes("image_input"));
  assert.match(stuck.warnings.join(" "), /No adapter can execute: .*image_input/);
});

test("declared capabilities no adapter can execute are reported, not silently trusted", () => {
  const store = new ModelConfigStore({ logger: quiet });
  store.entries = [{
    id: modelConfigId("groq", "image-maker"),
    provider: "groq",
    model: "image-maker",
    displayName: "image-maker",
    enabled: true,
    capabilities: ["text_input", "computer_use"],
    protocol: null,
    metadata: {},
    version: 1,
    createdAt: 1,
    updatedAt: 1
  }];

  const row = store.index([target("groq", "image-maker")]).get("groq/image-maker");
  assert.deepEqual(row.unsupportedCapabilities, ["computer_use"]);
  assert.deepEqual(row.executableCapabilities, ["text_input"]);
  assert.match(row.warnings.join(" "), /No adapter can execute: computer_use/);
});

test("a document from a newer schema is refused and never rewritten", () => {
  const store = new ModelConfigStore({ logger: quiet });
  assert.throws(
    () => store.applyDocument({ version: 99, models: [] }),
    (error) => error.status === 409 && error.type === "schema_too_new"
  );
  assert.equal(store.list().length, 0);
});

test("a local-only store never overwrites a newer local document it could not read", async () => {
  const file = tmpFile();
  const original = JSON.stringify({ version: 99, revision: "future", models: [] });
  fs.writeFileSync(file, original);
  const store = new ModelConfigStore({ file, logger: quiet });

  assert.equal(store.list().length, 0);
  assert.match(store.warnings[0], /schema 99/);
  await assert.rejects(
    () => store.create({ provider: "groq", model: "m" }, { knownModels: new Set(["groq/m"]) }),
    (error) => error instanceof ModelConfigError && error.status === 409 && error.type === "schema_too_new"
  );
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("malformed entries are skipped with a warning, the rest of the document is kept", () => {
  const store = new ModelConfigStore({ logger: quiet });
  store.applyDocument({
    version: 1,
    models: [
      { provider: "groq", model: "good", capabilities: ["text_input"] },
      { provider: "", model: "bad" },
      { provider: "groq", model: "good", capabilities: ["text_output"] },
      "not an object"
    ]
  });
  assert.equal(store.list().length, 1);
  assert.equal(store.skipped.length, 3);
});

// ---------------------------------------------------------------------------
// GitHub persistence
// ---------------------------------------------------------------------------

test("the model document is stored as plain JSON in GitHub and survives a fresh container", async () => {
  const github = await startMockGithub();
  const storage = { repo: github.repo, token: github.token, apiBase: github.apiBase, branch: "main", path: "model-config.json" };
  const remote = createModelConfigStorage(storage);
  const firstFile = tmpFile();

  const first = new ModelConfigStore({ file: firstFile, remote, logger: quiet });
  await first.init();
  await first.create({ provider: "groq", model: "m", capabilities: ["text_input", "text_output"] }, {
    knownModels: new Set(["groq/m"])
  });
  assert.deepEqual(first.storageInfo().ready, true);

  const stored = JSON.parse(github.stored("main", "model-config.json"));
  assert.equal(stored.models.length, 1);
  assert.equal(JSON.stringify(stored).includes(github.token), false);
  assert.equal(JSON.stringify(stored).includes("apiKey"), false);

  // A new process with an EMPTY local mirror must adopt the remote document.
  const second = new ModelConfigStore({ file: tmpFile(), remote: createModelConfigStorage(storage), logger: quiet });
  assert.equal(await second.init(), true);
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].model, "m");
  await github.close();
});

test("refresh adopts a newer GitHub document and reports the previous list", async () => {
  const github = await startMockGithub();
  const options = { repo: github.repo, token: github.token, apiBase: github.apiBase, branch: "main", path: "model-config.json" };
  const knownModels = new Set(["groq/a", "groq/b"]);

  const first = new ModelConfigStore({ remote: createModelConfigStorage(options), logger: quiet });
  await first.init();
  await first.create({ provider: "groq", model: "a", enabled: false }, { knownModels });

  const second = new ModelConfigStore({ remote: createModelConfigStorage(options), logger: quiet });
  assert.equal(await second.init(), true);
  await second.create({ provider: "groq", model: "b" }, { knownModels });

  const changes = [];
  first.onChange((current, previous) => changes.push({ current, previous }));
  assert.equal(await first.refresh(), true);
  assert.deepEqual(first.list().map((entry) => entry.model).sort(), ["a", "b"]);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].previous.map((entry) => entry.model), ["a"]);
  assert.deepEqual(changes[0].current.map((entry) => entry.model).sort(), ["a", "b"]);
  assert.equal(JSON.parse(github.stored("main", "model-config.json")).models.length, 2);
  await github.close();
});

test("a stale write is refused with 409 instead of overwriting a newer document", async () => {
  const github = await startMockGithub();
  const options = { repo: github.repo, token: github.token, apiBase: github.apiBase, branch: "main", path: "model-config.json" };
  const knownModels = new Set(["groq/a", "groq/b"]);

  const one = new ModelConfigStore({ remote: createModelConfigStorage(options), logger: quiet });
  await one.init();
  await one.create({ provider: "groq", model: "a" }, { knownModels });

  const two = new ModelConfigStore({ remote: createModelConfigStorage(options), logger: quiet });
  await two.init();

  // `one` saves first, moving the document on.
  await one.create({ provider: "groq", model: "b" }, { knownModels });

  // `two` still holds the old revision. Its save MUST fail, not win.
  await assert.rejects(
    () => two.update(two.list()[0].id, { displayName: "stale" }),
    (error) => error.status === 409 && error.type === "conflict"
  );

  const stored = JSON.parse(github.stored("main", "model-config.json"));
  assert.equal(stored.models.length, 2);
  assert.equal(stored.models.find((entry) => entry.model === "a").displayName, "a");
  await github.close();
});

test("an unreachable remote is reported, and a save is refused rather than losing newer data", async () => {
  const github = await startMockGithub();
  const options = { repo: github.repo, token: github.token, apiBase: github.apiBase, branch: "main", path: "model-config.json" };
  const store = new ModelConfigStore({ remote: createModelConfigStorage(options), logger: quiet });

  github.setFailing(true);
  assert.equal(await store.init(), false);
  assert.equal(store.storageInfo().ready, false);
  assert.match(store.storageInfo().error, /HTTP 503|unavailable/);

  await assert.rejects(
    () => store.create({ provider: "groq", model: "m" }, { knownModels: new Set(["groq/m"]) }),
    (error) => error.status === 503 && error.type === "unavailable"
  );
  assert.equal(github.stored("main", "model-config.json"), null);

  github.setFailing(false);
  const created = await store.create({ provider: "groq", model: "m" }, { knownModels: new Set(["groq/m"]) });
  assert.equal(created.entry.model, "m");
  assert.equal(store.storageInfo().ready, true);
  await github.close();
});

test("removing the last declaration restores the environment default", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const { entry } = await store.create({ provider: "groq", model: "m", enabled: false }, {
    knownModels: new Set(["groq/m"])
  });
  assert.equal(store.explicitlyDisabled("groq", "m"), true);

  await store.remove(entry.id);
  assert.equal(store.list().length, 0);
  assert.equal(store.explicitlyDisabled("groq", "m"), false);
});

test("concurrent saves are serialized, so neither can persist a stale list", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const knownModels = new Set(["groq/a", "groq/b", "groq/c"]);
  await Promise.all([
    store.create({ provider: "groq", model: "a" }, { knownModels }),
    store.create({ provider: "groq", model: "b" }, { knownModels }),
    store.create({ provider: "groq", model: "c" }, { knownModels })
  ]);
  assert.deepEqual(store.list().map((entry) => entry.model).sort(), ["a", "b", "c"]);
});

test("bulk: adds a capability to many models in ONE persisted write", async () => {
  const file = tmpFile();
  const store = new ModelConfigStore({ file, logger: quiet });
  await store.create({ provider: "groq", model: "a", capabilities: ["text_input", "text_output"], contextLimit: 200000, enabled: false },
    { knownModels: new Set(["groq/a"]) });

  const known = new Set(["groq/a", "groq/b", "gemini/c"]);
  const before = store.revision;
  const result = await store.bulkCapabilities(
    [{ provider: "groq", model: "a" }, { provider: "groq", model: "b" }, { provider: "Gemini", model: "c" }],
    { add: ["streaming", "tool_calling"], knownModels: known, baseFor: () => ["text_input", "text_output"], enabledFor: () => true }
  );

  assert.equal(result.changed, 3);
  assert.equal(result.created, 2);
  assert.equal(result.unchanged, 0);
  assert.notEqual(store.revision, before);

  const [a, b, c] = ["a", "b", "c"].map((model) => store.list().find((entry) => entry.model === model));
  assert.deepEqual([...a.capabilities].sort(), ["streaming", "text_input", "text_output", "tool_calling"]);
  for (const entry of [a, b, c]) {
    assert.ok(entry.capabilities.includes("streaming"));
    assert.ok(entry.capabilities.includes("tool_calling"));
    assert.ok(entry.capabilities.includes("text_input"), "the inferred base is kept");
  }
  // An existing declaration keeps everything that is not a capability.
  assert.equal(a.enabled, false);
  assert.equal(a.contextLimit, 200000);
  assert.equal(c.provider, "gemini");

  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(document.models.length, 3);
});

test("bulk: removing a capability and re-running is a no-op that does not write", async () => {
  const file = tmpFile();
  const store = new ModelConfigStore({ file, logger: quiet });
  const known = new Set(["groq/a", "groq/b"]);
  await store.create({ provider: "groq", model: "a", capabilities: ["text_input", "streaming"] }, { knownModels: known });
  await store.create({ provider: "groq", model: "b", capabilities: ["text_input"] }, { knownModels: known });

  const first = await store.bulkCapabilities(
    [{ provider: "groq", model: "a" }, { provider: "groq", model: "b" }],
    { remove: ["streaming"], knownModels: known }
  );
  assert.equal(first.changed, 1);
  assert.equal(first.unchanged, 1);
  assert.deepEqual(store.list().find((entry) => entry.model === "a").capabilities, ["text_input"]);

  const revision = store.revision;
  const second = await store.bulkCapabilities(
    [{ provider: "groq", model: "a" }, { provider: "groq", model: "b" }],
    { remove: ["streaming"], knownModels: known }
  );
  assert.equal(second.changed, 0);
  assert.equal(store.revision, revision, "nothing to change means nothing is saved");
});

test("bulk: a bad request changes nothing at all", async () => {
  const store = new ModelConfigStore({ logger: quiet });
  const known = new Set(["groq/a"]);
  await store.create({ provider: "groq", model: "a", capabilities: ["text_input"] }, { knownModels: known });
  const revision = store.revision;

  await assert.rejects(
    store.bulkCapabilities([{ provider: "groq", model: "a" }, { provider: "groq", model: "typo" }], { add: ["streaming"], knownModels: known }),
    (error) => error instanceof ModelConfigError && error.status === 400 && error.type === "unknown_model"
  );
  await assert.rejects(
    store.bulkCapabilities([{ provider: "groq", model: "a" }], { add: [], remove: [], knownModels: known }),
    (error) => error.status === 400
  );
  await assert.rejects(
    store.bulkCapabilities([{ provider: "groq", model: "a" }], { add: ["streaming"], remove: ["streaming"], knownModels: known }),
    (error) => error.status === 400
  );
  await assert.rejects(
    store.bulkCapabilities([], { add: ["streaming"], knownModels: known }),
    (error) => error.status === 400
  );
  await assert.rejects(
    store.bulkCapabilities([{ provider: "groq", model: "a" }], { add: ["made_up"], knownModels: known }),
    (error) => error.status === 400
  );

  assert.equal(store.revision, revision);
  assert.deepEqual(store.list()[0].capabilities, ["text_input"]);
  assert.equal(store.list().length, 1);
});

test("bulk: against GitHub it makes a single commit for the whole batch", async () => {
  const github = await startMockGithub();
  try {
    const remote = createModelConfigStorage({
      repo: github.repo, token: github.token, apiBase: github.apiBase, branch: "main", path: "model-config.json"
    });
    const store = new ModelConfigStore({ remote, logger: quiet });
    await store.init();
    const puts = () => github.requests.filter((request) => request.method === "PUT").length;
    const before = puts();

    const models = ["a", "b", "c", "d"];
    const known = new Set(models.map((model) => `groq/${model}`));
    const result = await store.bulkCapabilities(
      models.map((model) => ({ provider: "groq", model })),
      { add: ["streaming"], knownModels: known }
    );

    assert.equal(result.changed, 4);
    assert.equal(puts() - before, 1, "one commit, not one per model");
    assert.equal(JSON.parse(github.stored("main", "model-config.json")).models.length, 4);
  } finally {
    await github.close();
  }
});
