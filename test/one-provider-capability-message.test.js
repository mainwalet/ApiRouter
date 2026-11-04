import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockUpstream } from "../test-helpers/mock-upstream.js";
import { startRouter } from "../test-helpers/router-harness.js";

// Regression: One Provider Fallback is on, the chosen model declares only text,
// and the client (Claude Code) sends tools. The request used to be refused with
// "none speaks this client protocol", which is wrong: every protocol is bridged,
// and the model was dropped because it does not declare tool_calling.

const TEXT_ONLY = ["text_input", "text_output", "streaming"];

test("One Provider Fallback names the missing capability, not the protocol", async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: { id: "x", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apirouter-one-"));
  const oneModelFile = path.join(dir, "one-model.json");
  fs.writeFileSync(oneModelFile, JSON.stringify({ enabled: true, provider: "groq", models: ["plain-model"] }));
  const router = await startRouter({
    ONE_MODEL_FILE: oneModelFile,
    GROQ_API_KEYS: "g0",
    GROQ_MODELS: "plain-model,tool-model",
    GROQ_BASE_URL: `${upstream.baseUrl}/v1`
  });
  try {
    const declare = (model, capabilities) => router.request("/api/model-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "groq", model, capabilities })
    });
    assert.equal((await declare("plain-model", TEXT_ONLY)).status, 201);
    // Another model can do tools, so the request is not refused as "no capable route".
    assert.equal((await declare("tool-model", [...TEXT_ONLY, "tool_calling"])).status, 201);

    const response = await router.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "get_time", description: "time", input_schema: { type: "object", properties: {} } }]
      })
    });
    assert.equal(response.status, 503);
    const { error } = await response.json();
    assert.equal(error.type, "one_model_unavailable");
    assert.doesNotMatch(error.message, /client protocol/);
    assert.match(error.message, /Tool calling|tool_calling|tool/i);
    assert.match(error.message, /Model Configurator/);
    assert.ok(error.required_capabilities.includes("tool_calling"));
    assert.ok(error.excluded_candidates.some((entry) => entry.model === "plain-model"));
  } finally {
    await router.close();
    await upstream.close?.();
  }
});
