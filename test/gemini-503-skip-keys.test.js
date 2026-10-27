import test from "node:test";
import assert from "node:assert/strict";
import { HealthRegistry } from "../src/health.js";
import { withFallback } from "../src/router.js";

const t = (provider, model, keyIndex) => ({ provider, model, keyIndex, pool: "text", protocols: ["openai-chat"] });
const fail = (status) => Object.assign(new Error(`boom ${status}`), { status });

const run = async (targets, status) => {
  const calls = [];
  const result = await withFallback(
    targets,
    async (target) => {
      calls.push(`${target.provider}/${target.model}#${target.keyIndex}`);
      if (target.model !== "ok") throw fail(status);
      return "done";
    },
    undefined,
    undefined,
    new HealthRegistry(),
    { plan: targets.map((target) => ({ target, phase: null })) }
  );
  return { result, calls };
};

test("a Gemini 503 skips the model's other keys and goes to the next model", async () => {
  const targets = [t("gemini", "g1", 0), t("gemini", "g1", 1), t("gemini", "g1", 2), t("gemini", "ok", 0)];
  const { result, calls } = await run(targets, 503);
  assert.equal(result, "done");
  assert.deepEqual(calls, ["gemini/g1#0", "gemini/ok#0"]);
});

test("other statuses and other providers still try every key", async () => {
  const gemini429 = [t("gemini", "g1", 0), t("gemini", "g1", 1), t("gemini", "ok", 0)];
  assert.deepEqual((await run(gemini429, 429)).calls, ["gemini/g1#0", "gemini/g1#1", "gemini/ok#0"]);

  const other503 = [t("groq", "g1", 0), t("groq", "g1", 1), t("groq", "ok", 0)];
  assert.deepEqual((await run(other503, 503)).calls, ["groq/g1#0", "groq/g1#1", "groq/ok#0"]);
});

test("Gemini 508 and 408 also skip the model's other keys", async () => {
  for (const status of [508, 408]) {
    const targets = [t("gemini", "g1", 0), t("gemini", "g1", 1), t("gemini", "ok", 0)];
    assert.deepEqual((await run(targets, status)).calls, ["gemini/g1#0", "gemini/ok#0"]);
  }
});

test("a pinned request (every target reported available) also skips the model's other keys", async () => {
  const targets = [t("gemini", "g1", 0), t("gemini", "g1", 1), t("gemini", "g1", 2), t("gemini", "ok", 0)];
  for (const status of [503, 408]) {
    const health = new HealthRegistry();
    health.isAvailable = () => true;
    const calls = [];
    const result = await withFallback(
      targets,
      async (target) => {
        calls.push(`${target.model}#${target.keyIndex}`);
        if (target.model !== "ok") throw fail(status);
        return "done";
      },
      undefined,
      undefined,
      health,
      { plan: targets.map((target) => ({ target, phase: null })) }
    );
    assert.equal(result, "done");
    assert.deepEqual(calls, ["g1#0", "ok#0"]);
  }
});
