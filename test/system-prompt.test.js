import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  applySystemPrompt,
  hasSystemPrompt,
  loadSystemPrompt
} from "../src/system-prompt.js";

const PROMPT = DEFAULT_SYSTEM_PROMPT;

test("the built-in prompt names ApiRouter and keeps its main sections", () => {
  assert.match(PROMPT, /^You are ApiRouter, an AI assistant/);
  for (const heading of [
    "1. Instructions and Communication", "2. User Control and Security", "3. Correctness and Coding",
    "4. Security and Credentials", "5. Testing and Verification", "6. Tools, Files, and Git", "7. Response Format"
  ]) {
    assert.ok(PROMPT.includes(heading), heading);
  }
});

test("openai-chat: a leading system message, the client's own messages follow", () => {
  const body = { messages: [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }] };
  assert.equal(applySystemPrompt("openai-chat", body, PROMPT), true);
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[0], { role: "system", content: PROMPT });
  assert.equal(body.messages[1].content, "be terse");
});

test("anthropic: string and array system are both prepended, never replaced", () => {
  const text = { system: "be terse", messages: [] };
  applySystemPrompt("anthropic", text, PROMPT);
  assert.ok(text.system.startsWith(PROMPT) && text.system.endsWith("be terse"));

  const none = { messages: [] };
  applySystemPrompt("anthropic", none, PROMPT);
  assert.equal(none.system, PROMPT);

  const blocks = { system: [{ type: "text", text: "be terse" }], messages: [] };
  applySystemPrompt("anthropic", blocks, PROMPT);
  assert.equal(blocks.system.length, 2);
  assert.deepEqual(blocks.system[0], { type: "text", text: PROMPT });
  assert.equal(blocks.system[1].text, "be terse");
});

test("openai-responses: instructions", () => {
  const empty = { input: "hi" };
  applySystemPrompt("openai-responses", empty, PROMPT);
  assert.equal(empty.instructions, PROMPT);

  const own = { input: "hi", instructions: "be terse" };
  applySystemPrompt("openai-responses", own, PROMPT);
  assert.ok(own.instructions.startsWith(PROMPT) && own.instructions.endsWith("be terse"));
});

test("gemini: systemInstruction parts, snake_case spelling kept", () => {
  const camel = { contents: [], systemInstruction: { parts: [{ text: "old" }] } };
  applySystemPrompt("gemini", camel, PROMPT);
  assert.equal(camel.systemInstruction.parts.length, 2);
  assert.equal(camel.systemInstruction.parts[0].text, PROMPT);
  assert.equal(camel.systemInstruction.parts[1].text, "old");

  const snake = { contents: [], system_instruction: { parts: [{ text: "old" }] } };
  applySystemPrompt("gemini", snake, PROMPT);
  assert.equal(snake.system_instruction.parts[0].text, PROMPT);
  assert.equal(snake.systemInstruction, undefined);

  const none = { contents: [] };
  applySystemPrompt("gemini", none, PROMPT);
  assert.equal(none.systemInstruction.parts[0].text, PROMPT);
});

test("applied once: a request that already carries the prompt is not changed again", () => {
  const bodies = {
    "openai-chat": { messages: [{ role: "user", content: "hi" }] },
    anthropic: { system: "be terse", messages: [] },
    "openai-responses": { input: "hi" },
    gemini: { contents: [] }
  };
  for (const [protocol, body] of Object.entries(bodies)) {
    assert.equal(applySystemPrompt(protocol, body, PROMPT), true, protocol);
    const once = JSON.stringify(body);
    assert.equal(hasSystemPrompt(body, PROMPT), true, protocol);
    assert.equal(applySystemPrompt(protocol, body, PROMPT), false, protocol);
    assert.equal(JSON.stringify(body), once, protocol);
  }
});

test("nothing to add: empty prompt, non-object body", () => {
  const body = { messages: [] };
  assert.equal(applySystemPrompt("openai-chat", body, ""), false);
  assert.deepEqual(body, { messages: [] });
  assert.equal(applySystemPrompt("openai-chat", null, PROMPT), false);
  assert.equal(applySystemPrompt("openai-chat", [], PROMPT), false);
});

test("a request's own text is never mistaken for the prompt", () => {
  const body = { messages: [{ role: "user", content: "You are ApiRouter, an AI assistant" }] };
  assert.equal(hasSystemPrompt(body, PROMPT), false);
  assert.equal(applySystemPrompt("openai-chat", body, PROMPT), true);
});

test("loadSystemPrompt: off gives nothing, the built-in is the default, a file replaces it", () => {
  assert.equal(loadSystemPrompt({ enabled: false }), "");
  assert.equal(loadSystemPrompt({}), PROMPT);

  const dir = mkdtempSync(join(tmpdir(), "apirouter-prompt-"));
  try {
    const file = join(dir, "prompt.txt");
    writeFileSync(file, "  You are a test prompt.\nSecond line.  \n");
    assert.equal(loadSystemPrompt({ file }), "You are a test prompt.\nSecond line.");

    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "\n  \n");
    assert.throws(() => loadSystemPrompt({ file: empty }), /empty/);
    assert.throws(() => loadSystemPrompt({ file: join(dir, "missing.txt") }), /Cannot read SYSTEM_PROMPT_FILE/);
    // Disabled wins: a bad file is not even read.
    assert.equal(loadSystemPrompt({ enabled: false, file: join(dir, "missing.txt") }), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: on by default, SYSTEM_PROMPT=off disables, SYSTEM_PROMPT_FILE is read", () => {
  assert.equal(loadConfig({}).systemPromptEnabled, true);
  assert.equal(loadConfig({}).systemPromptFile, "");
  for (const value of ["off", "OFF", "0", "false", "no", " off "]) {
    assert.equal(loadConfig({ SYSTEM_PROMPT: value }).systemPromptEnabled, false, value);
  }
  assert.equal(loadConfig({ SYSTEM_PROMPT: "on" }).systemPromptEnabled, true);
  assert.equal(loadConfig({ SYSTEM_PROMPT_FILE: " prompts/mine.txt " }).systemPromptFile, "prompts/mine.txt");
});
