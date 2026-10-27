import test from "node:test";
import assert from "node:assert/strict";
import { effortLabel, withEffort, withDefaultGeminiThinking, withoutReasoning } from "../src/bridge-reasoning.js";

const gemini = (model) => ({ provider: "gemini", model });
const hi = { model: "x", messages: [{ role: "user", content: "Hi" }] };

test("the label is the effort actually sent", () => {
  for (const effort of ["low", "medium", "high"]) {
    const body = withEffort(hi, "openai-chat", effort, { provider: "groq", model: "m" });
    assert.equal(effortLabel(body, "openai-chat", { model: "m" }, "openai-chat"), effort);
  }
});

test("xhigh is shown as high where an OpenAI-style model would be sent high", () => {
  const body = withEffort(hi, "openai-chat", "xhigh", { model: "llama" });
  assert.equal(effortLabel(body, "openai-chat", { model: "llama" }, "openai-chat"), "high");
  assert.equal(effortLabel(withEffort(hi, "openai-chat", "xhigh", { model: "gpt-5.2" }), "openai-chat", { model: "gpt-5.2" }, "openai-chat"), "xhigh");
});

test("no reasoning control means no label", () => {
  assert.equal(effortLabel(withoutReasoning({ ...hi, reasoning_effort: "high" }), "openai-chat", null, "openai-chat"), null);
});

test("Gemini 3.x under Medium is labelled low, which is what it is really sent", () => {
  const target = gemini("gemini-3.8-flash");
  const body = withDefaultGeminiThinking(withEffort(hi, "openai-chat", "medium", target), "openai-chat", target);
  assert.equal(effortLabel(body, "openai-chat", target, "gemini"), "low");
  const high = withDefaultGeminiThinking(withEffort(hi, "openai-chat", "high", target), "openai-chat", target);
  assert.equal(effortLabel(high, "openai-chat", target, "gemini"), "high");
});
