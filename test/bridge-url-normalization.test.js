import test from "node:test";
import assert from "node:assert/strict";

import { buildUpstreamRequest } from "../src/adapters.js";
import { buildChatRequest } from "../src/chat-bridge.js";
import { buildCodexRequest } from "../src/codex-bridge.js";
import { buildBridgeRequest } from "../src/anthropic-bridge.js";
import { buildGeminiBridgeRequest } from "../src/gemini-bridge.js";
import { stripApiVersion, openAiSuffixPath } from "../src/url-utils.js";

/**
 * Regression: a configured base URL that already carries the API version
 * (`.../v1beta`, which `health-checks.js` accepts) must not have the version
 * appended a second time. Every Gemini URL used to be built by naively
 * appending `v1beta/models/...`, so a version-suffixed base produced
 * `/v1beta/v1beta/models/...` — a 404 from every provider so configured.
 */

const GEMINI_ROOT = "https://generativelanguage.googleapis.com";
const GEMINI_VERSIONED = GEMINI_ROOT + "/v1beta";

const geminiTarget = (baseUrl) => ({
  provider: "gemini",
  model: "gemini-3.8-flash",
  baseUrl,
  apiKey: "k",
  protocols: ["gemini"],
  keyIndex: 0
});

/** The four request builders that can address a Gemini provider. */
const builders = (target, baseUrl) => ({
  "adapters.buildUpstreamRequest": buildUpstreamRequest(target, "gemini", { contents: [] }, {}).url,
  "chat-bridge.buildChatRequest": buildChatRequest(target, "gemini", { messages: [] }, {}).url,
  "codex-bridge.buildCodexRequest": buildCodexRequest(target, "gemini", { input: [] }, {}).url,
  "anthropic-bridge.buildBridgeRequest": buildBridgeRequest(target, "gemini", { messages: [] }, {}).url
});

test("gemini URL: a base URL without a version gets /v1beta exactly once", () => {
  const target = geminiTarget(GEMINI_ROOT);
  for (const [name, url] of Object.entries(builders(target, GEMINI_ROOT))) {
    assert.equal(
      url,
      `${GEMINI_ROOT}/v1beta/models/gemini-3.8-flash:generateContent`,
      `${name} built ${url}`
    );
  }
});

test("gemini URL: a base URL that already carries /v1beta is not doubled", () => {
  const target = geminiTarget(GEMINI_VERSIONED);
  for (const [name, url] of Object.entries(builders(target, GEMINI_VERSIONED))) {
    assert.equal(
      url,
      `${GEMINI_ROOT}/v1beta/models/gemini-3.8-flash:generateContent`,
      `${name} built ${url}`
    );
    assert.ok(!url.includes("/v1beta/v1beta/"), `${name} duplicated the version: ${url}`);
  }
});

test("gemini URL: a trailing slash on the base URL does not create an empty segment", () => {
  for (const base of [GEMINI_ROOT + "/", GEMINI_VERSIONED + "/"]) {
    const target = geminiTarget(base);
    for (const [name, url] of Object.entries(builders(target, base))) {
      assert.equal(
        url,
        `${GEMINI_ROOT}/v1beta/models/gemini-3.8-flash:generateContent`,
        `${name} built ${url} for base ${base}`
      );
    }
  }
});

test("gemini URL: streaming keeps its ?alt=sse and still resolves the model once", () => {
  const target = geminiTarget(GEMINI_VERSIONED);
  const url = buildUpstreamRequest(target, "gemini", { contents: [] }, { accept: "text/event-stream" }, { stream: true }).url;
  assert.equal(url, `${GEMINI_ROOT}/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`);
  assert.equal((url.match(/v1beta/g) || []).length, 1, url);
});

test("gemini URL: a custom non-Google base URL is preserved, only its version is normalized", () => {
  const target = geminiTarget("https://gemini-proxy.internal/api/v1beta");
  const url = buildUpstreamRequest(target, "gemini", { contents: [] }, {}).url;
  assert.equal(url, "https://gemini-proxy.internal/api/v1beta/models/gemini-3.8-flash:generateContent");
});

test("stripApiVersion: strips a trailing version, keeps a custom path", () => {
  assert.equal(stripApiVersion("https://x.dev"), "https://x.dev");
  assert.equal(stripApiVersion("https://x.dev/"), "https://x.dev");
  assert.equal(stripApiVersion("https://x.dev/v1beta"), "https://x.dev");
  assert.equal(stripApiVersion("https://x.dev/v1beta/"), "https://x.dev");
  assert.equal(stripApiVersion("https://x.dev/v2alpha1"), "https://x.dev");
  assert.equal(stripApiVersion("https://x.dev/v1"), "https://x.dev");
  // A version-looking path segment that is NOT the last one is left alone.
  assert.equal(stripApiVersion("https://x.dev/v1beta/models"), "https://x.dev/v1beta/models");
  assert.equal(stripApiVersion(""), "");
});

test("stripApiVersion does not pretend to support a query string", () => {
  // A base URL carrying a query is refused by `loadConfig` (see
  // test/config.test.js), because every caller appends its endpoint path as a
  // plain string. The helper must not quietly normalise one into something that
  // looks usable: the version is only stripped from an unambiguous path end.
  assert.equal(stripApiVersion("https://x.dev/v1beta?key=1"), "https://x.dev/v1beta?key=1");
  assert.equal(stripApiVersion("https://x.dev/?key=1"), "https://x.dev/?key=1");
});

// ------------------------------------------------- OpenAI-compatible paths

/**
 * The OpenAI-compatible rule is deliberately NOT the Gemini one. An
 * OpenAI-compatible base that already ends in a version is taken as the API root
 * whatever that version is, because providers expose `/v1`, `/v2` and custom
 * prefixes; stripping it would rewrite a working custom base URL into a
 * different endpoint. These tests pin that difference so it is not "fixed" into
 * a regression.
 */

const openAiTarget = (baseUrl) => ({
  provider: "custom",
  model: "m",
  baseUrl,
  apiKey: "k",
  protocols: ["openai-chat"],
  keyIndex: 0
});

/** Every builder that produces an OpenAI-compatible URL, for one base URL. */
const openAiBuilders = (target) => ({
  "adapters.buildUpstreamRequest": buildUpstreamRequest(target, "openai-chat", {}, {}).url,
  "chat-bridge.buildGeminiBridgeRequest": buildGeminiBridgeRequest(target, {}).url,
  "codex-bridge.buildCodexRequest": buildCodexRequest(target, "openai-chat", {}, {}).url,
  "anthropic-bridge.buildBridgeRequest": buildBridgeRequest(target, "openai-chat", {}, {}).url
});

test("openai path: a base with no version gets /v1 exactly once", () => {
  for (const [name, url] of Object.entries(openAiBuilders(openAiTarget("https://api.example.com")))) {
    assert.equal(url, "https://api.example.com/v1/chat/completions", `${name} built ${url}`);
  }
});

test("openai path: a base ending in /v1 does not get a second /v1", () => {
  for (const [name, url] of Object.entries(openAiBuilders(openAiTarget("https://api.example.com/v1")))) {
    assert.equal(url, "https://api.example.com/v1/chat/completions", `${name} built ${url}`);
  }
});

test("openai path: a custom /v2 root is RESPECTED, not rewritten to /v1", () => {
  // This is the case that makes the OpenAI rule different from `stripApiVersion`.
  for (const [name, url] of Object.entries(openAiBuilders(openAiTarget("https://api.example.com/v2")))) {
    assert.equal(url, "https://api.example.com/v2/chat/completions", `${name} rewrote a custom base URL: ${url}`);
  }
});

test("openai path: a custom prefix plus a version is preserved", () => {
  for (const [name, url] of Object.entries(openAiBuilders(openAiTarget("https://api.example.com/openai/v1")))) {
    assert.equal(url, "https://api.example.com/openai/v1/chat/completions", `${name} built ${url}`);
  }
  for (const [name, url] of Object.entries(openAiBuilders(openAiTarget("https://api.example.com/v1/")))) {
    assert.equal(url, "https://api.example.com/v1/chat/completions", `${name} built ${url}`);
  }
});

test("openai path: the Responses endpoint follows the same rule", () => {
  const t = openAiTarget("https://api.example.com/v2");
  assert.equal(buildUpstreamRequest(t, "openai-responses", {}, {}).url, "https://api.example.com/v2/responses");
  const t2 = openAiTarget("https://api.example.com");
  assert.equal(buildUpstreamRequest(t2, "openai-responses", {}, {}).url, "https://api.example.com/v1/responses");
});

test("openAiSuffixPath states the rule directly", () => {
  assert.equal(openAiSuffixPath("https://x.dev", "chat/completions"), "v1/chat/completions");
  assert.equal(openAiSuffixPath("https://x.dev/v1", "chat/completions"), "chat/completions");
  assert.equal(openAiSuffixPath("https://x.dev/v2", "chat/completions"), "chat/completions");
  assert.equal(openAiSuffixPath("https://x.dev/openai/v1", "chat/completions"), "chat/completions");
  assert.equal(openAiSuffixPath("", "chat/completions"), "v1/chat/completions");
  // Google's OpenAI-compatible root carries the version before `openai`.
  assert.equal(openAiSuffixPath("https://generativelanguage.googleapis.com/v1beta/openai", "chat/completions"), "chat/completions");
  assert.equal(openAiSuffixPath("https://x.dev/openai", "chat/completions"), "v1/chat/completions");
});

test("streaming and non-streaming agree on the path in every builder", () => {
  const gemini = geminiTarget(GEMINI_VERSIONED);
  const nonStream = buildUpstreamRequest(gemini, "gemini", { contents: [] }, {}).url;
  const stream = buildUpstreamRequest(gemini, "gemini", { contents: [] }, {}, { stream: true }).url;
  assert.equal(nonStream, `${GEMINI_ROOT}/v1beta/models/gemini-3.8-flash:generateContent`);
  assert.equal(stream, `${GEMINI_ROOT}/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`);
  // Only the method and its ?alt=sse differ; the path is identical.
  assert.equal(stream.split(":")[0], nonStream.split(":")[0]);
});

test("anthropic path: a custom base ending in /v1 does not become /v1/v1/messages", () => {
  for (const baseUrl of ["https://gw.example.com", "https://gw.example.com/", "https://gw.example.com/v1", "https://gw.example.com/api/v1/"]) {
    const target = { provider: "custom-gw", baseUrl, model: "m", apiKey: "k" };
    const { url } = buildUpstreamRequest(target, "anthropic", { messages: [] }, {});
    assert.equal(url.endsWith("/v1/messages"), true, url);
    assert.equal(url.includes("/v1/v1/"), false, url);
  }
});
