import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCustomPayload, buildHistory, buildPinHeaders, buildRequestBody, customMaxTokens, customProblem, endpointFor,
  extractDelta, extractErrorMessage, extractStreamMeta, extractText, parseMaxTokens, sendCustomRequest, CUSTOM_ENDPOINT
} from "../playground.js";

/**
 * The playground must not invent a provider-specific request shape: it reuses
 * the same client protocols the gateway's public endpoints expect, and omits
 * `model` entirely for Auto Route so the backend widens the candidate set.
 */
describe("playground request building", () => {
  it("routes gemini through the model path rather than a JSON body field", () => {
    expect(endpointFor("gemini", "gemini-2.0-flash"))
      .toBe("/v1beta/models/gemini-2.0-flash:generateContent");
    expect(endpointFor("anthropic")).toBe("/v1/messages");
    expect(endpointFor("openai-responses")).toBe("/v1/responses");
    expect(endpointFor("openai-chat")).toBe("/v1/chat/completions");
    expect(endpointFor("unknown-protocol")).toBe("/v1/chat/completions");
  });

  it("omits the model entirely when Auto Route is on", () => {
    // This is what makes the gateway choose rather than pin a target.
    const body = buildRequestBody({
      protocol: "openai-chat",
      model: "some-model",
      autoRoute: true,
      prompt: "hi"
    });

    expect(body).not.toHaveProperty("model");
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "hi" });
  });

  it("pins the model when Auto Route is off", () => {
    const body = buildRequestBody({
      protocol: "openai-chat",
      model: "pinned-model",
      autoRoute: false,
      prompt: "hi"
    });

    expect(body.model).toBe("pinned-model");
  });

  it("emits the native shape for each client protocol", () => {
    const anthropic = buildRequestBody({
      protocol: "anthropic", model: "m", autoRoute: false, prompt: "hi", system: "be terse", maxTokens: 256
    });
    expect(anthropic.system).toBe("be terse");
    expect(anthropic.max_tokens).toBe(256);

    const responses = buildRequestBody({
      protocol: "openai-responses", model: "m", autoRoute: false, prompt: "hi", system: "be terse"
    });
    expect(responses.input).toBe("hi");
    expect(responses.instructions).toBe("be terse");

    const gemini = buildRequestBody({
      protocol: "gemini", model: "m", autoRoute: false, prompt: "hi", system: "be terse", temperature: 0.4
    });
    expect(gemini.contents[0].parts[0].text).toBe("hi");
    expect(gemini.systemInstruction.parts[0].text).toBe("be terse");
    expect(gemini.generationConfig.temperature).toBe(0.4);
    // Gemini has no stream flag on generateContent in this shape.
    expect(gemini).not.toHaveProperty("stream");
  });

  it("carries the system prompt as a leading message for chat protocols", () => {
    const body = buildRequestBody({
      protocol: "openai-chat", model: "m", autoRoute: true, prompt: "hi", system: "be terse"
    });

    expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
  });
});

describe("playground stream parsing", () => {
  it("extracts openai-chat deltas and ignores the sentinel", () => {
    expect(extractDelta("openai-chat", { choices: [{ delta: { content: "Hel" } }] })).toBe("Hel");
    expect(extractDelta("openai-chat", { choices: [{ delta: {} }] })).toBe("");
    expect(extractDelta("openai-chat", null)).toBe("");
  });

  it("extracts anthropic content_block deltas", () => {
    expect(extractDelta("anthropic", { type: "content_block_delta", delta: { text: "Hi" } })).toBe("Hi");
    expect(extractDelta("anthropic", { type: "message_start" })).toBe("");
  });

  it("extracts openai-responses output text deltas", () => {
    expect(extractDelta("openai-responses", { type: "response.output_text.delta", delta: "Hi" })).toBe("Hi");
  });

  it("reads usage and finish reason from a final chunk", () => {
    expect(extractStreamMeta("openai-chat", { choices: [{ finish_reason: "stop" }], usage: { total_tokens: 42 } }))
      .toEqual({ tokens: 42, finishReason: "stop" });

    expect(extractStreamMeta("anthropic", { usage: { input_tokens: 10, output_tokens: 5 } }))
      .toEqual({ tokens: 15 });

    expect(extractStreamMeta("gemini", { usageMetadata: { totalTokens: 7 }, candidates: [{ finishReason: "STOP" }] }))
      .toEqual({ tokens: 7, finishReason: "STOP" });

    expect(extractStreamMeta("openai-chat", {})).toEqual({});
  });

  it("never reports a token count it was not given", () => {
    const meta = extractStreamMeta("openai-chat", { choices: [{ finish_reason: "stop" }] });
    expect(meta).not.toHaveProperty("tokens");
    expect(meta.finishReason).toBe("stop");
  });

  it("assembles non-streaming text for each protocol", () => {
    expect(extractText("anthropic", { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("ab");
    expect(extractText("gemini", { candidates: [{ content: { parts: [{ text: "g" }] } }] })).toBe("g");
    expect(extractText("openai-responses", { output_text: "r" })).toBe("r");
    expect(extractText("openai-chat", { choices: [{ message: { content: "c" } }] })).toBe("c");
    expect(extractText("openai-chat", null)).toBe("");
  });
});

describe("max tokens", () => {
  it("treats a blank, zero or invalid field as no limit", () => {
    for (const value of ["", "   ", "0", "-5", "abc", null, undefined]) {
      expect(parseMaxTokens(value)).toBeNull();
    }
    expect(parseMaxTokens("2048")).toBe(2048);
    expect(parseMaxTokens(" 500000 ")).toBe(500000);
  });

  it("does not send a token cap when there is no limit", () => {
    const common = { model: "m", autoRoute: false, prompt: "hi", maxTokens: null };

    expect(buildRequestBody({ ...common, protocol: "openai-chat" })).not.toHaveProperty("max_tokens");
    expect(buildRequestBody({ ...common, protocol: "openai-responses" })).not.toHaveProperty("max_output_tokens");
    expect(buildRequestBody({ ...common, protocol: "gemini" })).not.toHaveProperty("generationConfig");
  });

  it("still sends an explicit limit, with no upper cap", () => {
    const body = buildRequestBody({ protocol: "openai-chat", model: "m", autoRoute: false, prompt: "hi", maxTokens: 500000 });
    expect(body.max_tokens).toBe(500000);
  });

  it("omits max_tokens for Anthropic when there is no limit, and sends an explicit one unchanged", () => {
    const none = buildRequestBody({ protocol: "anthropic", model: "m", autoRoute: false, prompt: "hi", maxTokens: null });
    expect(none).not.toHaveProperty("max_tokens");
    const set = buildRequestBody({ protocol: "anthropic", model: "m", autoRoute: false, prompt: "hi", maxTokens: 500000 });
    expect(set.max_tokens).toBe(500000);
  });
});

describe("playground pinning", () => {
  it("sends no pin headers under Auto Route or without a provider", () => {
    expect(buildPinHeaders({ autoRoute: true, provider: "groq", keyIndex: 1 })).toEqual({});
    expect(buildPinHeaders({ autoRoute: false, provider: "", keyIndex: 1 })).toEqual({});
    expect(buildPinHeaders()).toEqual({});
  });

  it("pins the provider, and the key only when one is chosen", () => {
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", keyIndex: null }))
      .toEqual({ "x-multi-ai-pin-provider": "groq" });
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", keyIndex: 0 }))
      .toEqual({ "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-key-index": "0" });
  });

  it("flags a custom model only when pinned to a provider", () => {
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", keyIndex: null, customModel: true }))
      .toEqual({ "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-custom-model": "1" });
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", customModel: false }))
      .toEqual({ "x-multi-ai-pin-provider": "groq" });
    expect(buildPinHeaders({ autoRoute: true, provider: "groq", customModel: true })).toEqual({});
    expect(buildPinHeaders({ autoRoute: false, provider: "", customModel: true })).toEqual({});
  });
});

describe("playground image attachments", () => {
  const png = { mimeType: "image/png", data: "AAAA" };

  it("keeps the plain-text shape when there are no images", () => {
    expect(buildRequestBody({ protocol: "openai-chat", autoRoute: true, prompt: "hi", images: [] }).messages.at(-1))
      .toEqual({ role: "user", content: "hi" });
    expect(buildRequestBody({ protocol: "anthropic", autoRoute: true, prompt: "hi" }).messages[0].content).toBe("hi");
  });

  it("sends images as image_url parts for openai-chat", () => {
    const body = buildRequestBody({ protocol: "openai-chat", autoRoute: true, prompt: "what is this?", images: [png] });
    expect(body.messages.at(-1).content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    ]);
  });

  it("sends images as base64 image blocks for anthropic", () => {
    const body = buildRequestBody({ protocol: "anthropic", autoRoute: true, prompt: "what is this?", images: [png] });
    expect(body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "what is this?" }
    ]);
  });

  it("sends images as input_image parts for openai-responses", () => {
    const body = buildRequestBody({ protocol: "openai-responses", autoRoute: true, prompt: "what is this?", images: [png] });
    expect(body.input).toEqual([{
      role: "user",
      content: [
        { type: "input_text", text: "what is this?" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" }
      ]
    }]);
  });

  it("sends images as inlineData parts for gemini", () => {
    const body = buildRequestBody({ protocol: "gemini", autoRoute: true, prompt: "what is this?", images: [png] });
    expect(body.contents[0].parts).toEqual([
      { text: "what is this?" },
      { inlineData: { mimeType: "image/png", data: "AAAA" } }
    ]);
  });

  it("allows an image with no text", () => {
    const body = buildRequestBody({ protocol: "openai-chat", autoRoute: true, prompt: "", images: [png] });
    expect(body.messages.at(-1).content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    ]);
  });

  it("is detected as an image request by the gateway's own rules", async () => {
    const { requestHasImage } = await import("../../../../src/vision.js");
    for (const protocol of ["openai-chat", "anthropic", "openai-responses", "gemini"]) {
      const body = buildRequestBody({ protocol, autoRoute: true, prompt: "x", images: [png] });
      expect(requestHasImage(body), protocol).toBe(true);
      expect(requestHasImage(buildRequestBody({ protocol, autoRoute: true, prompt: "x" })), protocol).toBe(false);
    }
  });
});

describe("custom model reaches the gateway", () => {
  it("puts the chosen model in the gemini URL", () => {
    expect(endpointFor("gemini", "brand-new-model")).toBe("/v1beta/models/brand-new-model:generateContent");
  });
});


/**
 * Custom endpoint mode: the operator types a base URL, key and model. The call
 * is made by the gateway, so the browser only ever talks to the gateway's own
 * /api/playground/custom route.
 */
describe("custom endpoint playground", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("explains what is missing before a request can be sent", () => {
    expect(customProblem({ baseUrl: "", model: "m" })).toMatch(/base URL/i);
    expect(customProblem({ baseUrl: "api.example.com", model: "m" })).toMatch(/full URL/i);
    expect(customProblem({ baseUrl: "ftp://api.example.com", model: "m" })).toMatch(/http/);
    expect(customProblem({ baseUrl: "https://api.example.com/v1", model: "  " })).toMatch(/model/i);
    expect(customProblem({ baseUrl: " https://api.example.com/v1 ", model: "gpt-x" })).toBeNull();
    // A local model needs no key, so a blank key is never a blocker.
    expect(customProblem({ baseUrl: "http://localhost:11434/v1", model: "llama3" })).toBeNull();
  });

  it("defaults max_tokens only for Anthropic, which rejects a request without it", () => {
    expect(customMaxTokens("anthropic", "")).toBe(1024);
    expect(customMaxTokens("anthropic", "256")).toBe(256);
    expect(customMaxTokens("openai-chat", "")).toBeNull();
    expect(customMaxTokens("gemini", "0")).toBeNull();
  });

  it("builds a payload with trimmed fields and the native request body", () => {
    const request = buildRequestBody({ protocol: "openai-chat", model: "m", autoRoute: false, prompt: "hi", stream: true });
    expect(buildCustomPayload({
      protocol: "openai-chat", baseUrl: " https://api.example.com/v1 ", apiKey: " sk-abc ", model: " m ", request
    })).toEqual({
      protocol: "openai-chat", baseUrl: "https://api.example.com/v1", apiKey: "sk-abc", model: "m", request
    });
  });

  it("posts to the gateway route, keeps the key out of the URL and headers, and streams the answer", async () => {
    const calls = [];
    const frames = `data: ${JSON.stringify({ choices: [{ delta: { content: "po" } }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ delta: { content: "ng" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    vi.stubGlobal("fetch", (url, options) => {
      calls.push({ url, options });
      return Promise.resolve(new Response(frames, {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-multi-ai-provider": "custom", "x-multi-ai-model": "m", "x-multi-ai-upstream-host": "api.example.com" }
      }));
    });

    const deltas = [];
    const result = await sendCustomRequest({
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-live-SECRET-KEY-123",
      model: "m",
      body: buildRequestBody({ protocol: "openai-chat", model: "m", autoRoute: false, prompt: "ping", stream: true }),
      onDelta: (delta) => deltas.push(delta)
    });

    expect(result.text).toBe("pong");
    expect(deltas).toEqual(["po", "ng"]);
    expect(result.finishReason).toBe("stop");
    expect(result.routed.upstreamHost).toBe("api.example.com");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CUSTOM_ENDPOINT);
    const sent = JSON.parse(calls[0].options.body);
    expect(sent.apiKey).toBe("sk-live-SECRET-KEY-123");
    expect(sent.baseUrl).toBe("https://api.example.com/v1");
    expect(sent.request.messages.at(-1)).toEqual({ role: "user", content: "ping" });
    expect(calls[0].url).not.toContain("SECRET");
    expect(JSON.stringify(calls[0].options.headers)).not.toContain("SECRET");
  });

  it("surfaces the gateway's upstream error message", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(
      JSON.stringify({ error: { type: "upstream_error", message: "Upstream returned HTTP 401: Incorrect API key provided", details: { upstreamStatus: 401 } } }),
      { status: 502, headers: { "content-type": "application/json" } }
    )));

    await expect(sendCustomRequest({
      protocol: "openai-chat", baseUrl: "https://api.example.com/v1", apiKey: "bad", model: "m",
      body: buildRequestBody({ protocol: "openai-chat", model: "m", autoRoute: false, prompt: "hi" })
    })).rejects.toMatchObject({ message: expect.stringContaining("Incorrect API key") });
  });
});

describe("custom endpoint playground: replies that used to be lost or blank", () => {
  afterEach(() => vi.unstubAllGlobals());

  const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;
  const stream = (text, headers = {}) => new Response(text, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const send = (protocol = "openai-chat") => sendCustomRequest({
    protocol, baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m",
    body: buildRequestBody({ protocol, model: "m", autoRoute: false, prompt: "hi", stream: true })
  });

  it("keeps the last frame when the stream ends without the blank line after it", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(stream(frame({ choices: [{ delta: { content: "Hel" } }] })
      + `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`)));
    expect((await send()).text).toBe("Hello");
  });

  it("reads message content that arrives as an array of parts", async () => {
    expect(extractText("openai-chat", { choices: [{ message: { content: [{ type: "text", text: "Hel" }, { type: "text", text: "lo" }] } }] })).toBe("Hello");
    expect(extractDelta("openai-chat", { choices: [{ delta: { content: [{ type: "text", text: "Hi" }] } }] })).toBe("Hi");
    expect(extractText("openai-chat", { choices: [{ text: "legacy" }] })).toBe("legacy");
    vi.stubGlobal("fetch", () => Promise.resolve(json({ choices: [{ message: { content: [{ type: "text", text: "Hello" }] } }] })));
    expect((await send()).text).toBe("Hello");
  });

  it("recognises an error carried by a 200 response, and ignores error: null", () => {
    expect(extractErrorMessage({ error: { message: "insufficient_quota" } })).toBe("insufficient_quota");
    expect(extractErrorMessage({ error: "boom" })).toBe("boom");
    expect(extractErrorMessage({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).toBe("Overloaded");
    expect(extractErrorMessage({ type: "response.failed", response: { error: { message: "failed" } } })).toBe("failed");
    expect(extractErrorMessage({ type: "response.completed", response: { error: null }, error: null })).toBe("");
    expect(extractErrorMessage({ choices: [{ delta: { content: "x" } }] })).toBe("");
  });

  it("reports a 200 JSON error body instead of showing a blank reply", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(json({ error: { message: "insufficient_quota" } })));
    await expect(send()).rejects.toMatchObject({ label: "The provider reported an error", message: "insufficient_quota" });
  });

  it("keeps the text already streamed, then reports an error frame", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(stream(frame({ choices: [{ delta: { content: "par" } }] })
      + frame({ error: { message: "upstream died" } }))));
    const deltas = [];
    await expect(sendCustomRequest({
      protocol: "openai-chat", baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m",
      body: buildRequestBody({ protocol: "openai-chat", model: "m", autoRoute: false, prompt: "hi", stream: true }),
      onDelta: (delta) => deltas.push(delta)
    })).rejects.toMatchObject({ message: "upstream died" });
    expect(deltas).toEqual(["par"]);
  });

  it("explains an empty reply (for example a reasoning-only stream) instead of a blank message", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(stream(frame({ choices: [{ delta: { reasoning_content: "thinking" } }] }) + "data: [DONE]\n\n")));
    await expect(send()).rejects.toMatchObject({ label: "Empty reply" });
    vi.stubGlobal("fetch", () => Promise.resolve(json({ choices: [] })));
    await expect(send()).rejects.toMatchObject({ label: "Empty reply" });
  });

  it("labels an endpoint failure with the endpoint's own status, not 'All targets failed'", async () => {
    const reply = (type, message, details, status = 502) => json({ error: { type, message, ...(details ? { details } : {}) } }, status);
    const cases = [
      [reply("upstream_error", "Upstream returned HTTP 401: Incorrect API key", { upstreamStatus: 401 }), /API key/],
      [reply("upstream_error", "Upstream returned HTTP 404: no such model", { upstreamStatus: 404 }), /not found/i],
      [reply("upstream_error", "Upstream returned HTTP 429: slow down", { upstreamStatus: 429 }), /rate limited/i],
      [reply("upstream_error", "Upstream returned HTTP 503", { upstreamStatus: 503 }), /Endpoint error/],
      [reply("upstream_unreachable", "Connection refused. Check the host and port."), /Cannot reach/],
      [reply("upstream_html_response", "The host answered HTTP 200 with an HTML page"), /web page/],
      [reply("gateway_paused", "Gateway is shut down", null, 409), /paused/i]
    ];
    for (const [response, label] of cases) {
      vi.stubGlobal("fetch", () => Promise.resolve(response.clone()));
      const error = await send().catch((caught) => caught);
      expect(error.label).toMatch(label);
      expect(`${error.label} ${error.hint}`).not.toMatch(/fallback chain|All targets/i);
      expect(error.message).toBeTruthy();
    }
  });

  it("leaves the router's own error labels alone outside custom mode", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(json({ error: { type: "upstream_error", message: "All routing targets failed" } }, 502)));
    const { sendPlaygroundRequest } = await import("../playground.js");
    const error = await sendPlaygroundRequest({ protocol: "openai-chat", body: { messages: [] } }).catch((caught) => caught);
    expect(error.label).toBe("All targets failed");
  });
});

describe("playground temperature", () => {
  it("is not sent unless the operator chose one", () => {
    const base = { model: "m", autoRoute: false, prompt: "hi" };
    for (const protocol of ["openai-chat", "openai-responses", "anthropic", "gemini"]) {
      const body = buildRequestBody({ ...base, protocol, temperature: null });
      expect(JSON.stringify(body)).not.toContain("temperature");
    }
    expect(buildRequestBody({ ...base, protocol: "openai-chat", temperature: 0.2 }).temperature).toBe(0.2);
    expect(buildRequestBody({ ...base, protocol: "openai-chat", temperature: 0 }).temperature).toBe(0);
  });
});

describe("playground conversation history", () => {
  const messages = [
    { id: "u1", role: "user", text: "my name is Rafi" },
    { id: "a1", role: "assistant", text: "Nice to meet you, Rafi." },
    { id: "u2", role: "user", text: "broken one" },
    { id: "a2", role: "assistant", text: "", error: { label: "Request failed" } },
    { id: "u3", role: "user", text: "", images: [{ id: "i" }] },
    { id: "a3", role: "assistant", text: "A cat." }
  ];

  it("keeps complete pairs, drops failed turns and notes earlier images", () => {
    expect(buildHistory(messages)).toEqual([
      { role: "user", text: "my name is Rafi" },
      { role: "assistant", text: "Nice to meet you, Rafi." },
      { role: "user", text: "[image attached]" },
      { role: "assistant", text: "A cat." }
    ]);
  });

  it("has no length cap", () => {
    const long = Array.from({ length: 500 }, (_, i) => [
      { id: `u${i}`, role: "user", text: `q${i}` },
      { id: `a${i}`, role: "assistant", text: `r${i}` }
    ]).flat();
    expect(buildHistory(long)).toHaveLength(1000);
  });

  it("sends earlier turns before the new prompt in every protocol", () => {
    const history = buildHistory(messages.slice(0, 2));
    const common = { model: "m", autoRoute: true, prompt: "what is my name?", history };

    const chat = buildRequestBody({ ...common, protocol: "openai-chat" });
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(chat.messages[0].content).toBe("my name is Rafi");
    expect(chat.messages.at(-1).content).toBe("what is my name?");

    const anthropic = buildRequestBody({ ...common, protocol: "anthropic" });
    expect(anthropic.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

    const responses = buildRequestBody({ ...common, protocol: "openai-responses" });
    expect(responses.input.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(responses.input.at(-1).content).toBe("what is my name?");

    const gemini = buildRequestBody({ ...common, protocol: "gemini" });
    expect(gemini.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(gemini.contents.at(-1).parts[0].text).toBe("what is my name?");
  });

  it("keeps the old single-turn shape when there is no history", () => {
    const body = buildRequestBody({ protocol: "openai-responses", model: "m", autoRoute: true, prompt: "hi" });
    expect(body.input).toBe("hi");
  });
});

describe("auto model on a pinned provider", () => {
  it("sends the remembered model as the one to try first", () => {
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", preferModel: "m2" }))
      .toEqual({ "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-prefer-model": "m2" });
  });

  it("sends no preference when none is remembered or the switch is off", () => {
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", preferModel: "" }))
      .toEqual({ "x-multi-ai-pin-provider": "groq" });
    expect(buildPinHeaders({ autoRoute: true, provider: "groq", preferModel: "m2" })).toEqual({});
  });

  it("round-robin sends the model that answered last, to start after it", () => {
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", rotate: true, rotateAfter: "m2", preferModel: "m2" }))
      .toEqual({ "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-rotate": "1", "x-multi-ai-pin-rotate-after": "m2" });
    expect(buildPinHeaders({ autoRoute: false, provider: "groq", rotate: true }))
      .toEqual({ "x-multi-ai-pin-provider": "groq", "x-multi-ai-pin-rotate": "1" });
  });

  it("omits the model from the request body so the provider's models are walked", () => {
    const body = buildRequestBody({ protocol: "openai-chat", model: "", autoRoute: true, prompt: "hi" });
    expect(body.model).toBeUndefined();
  });
});
