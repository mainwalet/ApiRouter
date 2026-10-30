import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  buildCustomUpstream,
  createCustomPlayground,
  isBlockedAddress,
  validateCustomRequest
} from "../src/custom-playground.js";

const KEY = "sk-test-SECRET-1234567890";

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => server.address().port);
}

/** A stand-in for "some provider the gateway has never heard of". */
async function startUpstream(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    seen.push(record);
    handler(record, res);
  });
  const port = await listen(server);
  return { port, seen, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

/** The playground handler behind a real HTTP server, as api.js mounts it. */
async function startPlayground(options) {
  const handler = createCustomPlayground(options);
  const server = http.createServer((req, res) => { handler(req, res); });
  const port = await listen(server);
  const call = async (payload) => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    return { response, text: await response.text() };
  };
  return { call, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const chatRequest = (extra = {}) => ({ messages: [{ role: "user", content: "hi" }], stream: false, ...extra });

// --- address policy ---------------------------------------------------------

test("isBlockedAddress refuses private, loopback, link-local and metadata addresses", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "[::1]",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "not-an-ip"
  ]) {
    assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
  }
});

test("isBlockedAddress allows ordinary public addresses", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedAddress(address), false, `${address} must be allowed`);
  }
});

// --- validation -------------------------------------------------------------

test("validateCustomRequest normalizes a good request", () => {
  const spec = validateCustomRequest({
    protocol: "openai-chat", baseUrl: " https://api.example.com/v1/ ", apiKey: ` ${KEY} `, model: " gpt-x ", request: chatRequest()
  });
  assert.equal(spec.baseUrl, "https://api.example.com/v1");
  assert.equal(spec.apiKey, KEY);
  assert.equal(spec.model, "gpt-x");
  assert.equal(spec.host, "api.example.com");
});

test("validateCustomRequest rejects bad input with a message naming the field", () => {
  const good = { baseUrl: "https://api.example.com/v1", apiKey: KEY, model: "m", request: chatRequest() };
  const cases = [
    [{ ...good, baseUrl: "" }, /Base URL is required/],
    [{ ...good, baseUrl: "api.example.com" }, /not a valid URL/],
    [{ ...good, baseUrl: "ftp://api.example.com" }, /http:\/\/ or https:\/\//],
    [{ ...good, baseUrl: "https://user:pw@api.example.com" }, /username or password/],
    [{ ...good, baseUrl: "https://api.example.com/v1?key=abc" }, /query string/],
    [{ ...good, model: "  " }, /Model is required/],
    [{ ...good, apiKey: "bad\r\nx-evil: 1" }, /API key/],
    [{ ...good, protocol: "soap" }, /protocol must be one of/],
    [{ ...good, request: null }, /request must be a JSON object/],
    [{ ...good, request: [] }, /request must be a JSON object/]
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => validateCustomRequest(input), (error) => error.status === 400 && pattern.test(error.message), String(pattern));
  }
});

test("validateCustomRequest refuses private IP literals unless allowed, including encoded forms", () => {
  const base = { apiKey: KEY, model: "m", request: chatRequest() };
  for (const baseUrl of [
    "http://127.0.0.1:11434", "http://10.0.0.5", "http://169.254.169.254/latest", "http://[::1]:8080",
    "http://[::ffff:127.0.0.1]", "http://2130706433", "http://0x7f.1"
  ]) {
    assert.throws(() => validateCustomRequest({ ...base, baseUrl }), (error) => error.type === "blocked_host", baseUrl);
  }
  assert.doesNotThrow(() => validateCustomRequest({ ...base, baseUrl: "http://127.0.0.1:11434/v1" }, { allowPrivateHosts: true }));
});

// --- upstream request shape -------------------------------------------------

test("buildCustomUpstream follows the router's URL rules and auth per protocol", () => {
  const chat = buildCustomUpstream({ protocol: "openai-chat", baseUrl: "https://api.example.com/v1", apiKey: KEY, model: "m1", request: chatRequest() });
  assert.equal(chat.url, "https://api.example.com/v1/chat/completions");
  assert.equal(chat.headers.authorization, `Bearer ${KEY}`);
  assert.equal(JSON.parse(chat.body).model, "m1");

  const bare = buildCustomUpstream({ protocol: "openai-chat", baseUrl: "https://api.example.com", apiKey: KEY, model: "m1", request: chatRequest() });
  assert.equal(bare.url, "https://api.example.com/v1/chat/completions");

  const anthropic = buildCustomUpstream({ protocol: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: KEY, model: "claude-x", request: { messages: [], stream: true } });
  assert.equal(anthropic.url, "https://api.anthropic.com/v1/messages");
  assert.equal(anthropic.headers["x-api-key"], KEY);
  assert.equal(anthropic.headers.authorization, `Bearer ${KEY}`);
  assert.equal(anthropic.headers["anthropic-version"], "2023-06-01");
  assert.equal(anthropic.stream, true);

  const gemini = buildCustomUpstream({ protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: KEY, model: "gemini-x", request: { contents: [], stream: true } });
  assert.equal(gemini.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
  assert.equal(gemini.headers["x-goog-api-key"], KEY);
  assert.equal(gemini.stream, false, "gemini is always the non-streaming method here");

  const responses = buildCustomUpstream({ protocol: "openai-responses", baseUrl: "https://api.example.com/v1", apiKey: KEY, model: "m", request: { input: "hi" } });
  assert.equal(responses.url, "https://api.example.com/v1/responses");
});

test("buildCustomUpstream sends no Authorization header when no key was typed", () => {
  const built = buildCustomUpstream({ protocol: "openai-chat", baseUrl: "http://localhost:11434/v1", apiKey: "", model: "llama3", request: chatRequest() });
  assert.equal("authorization" in built.headers, false);
});

// --- end to end -------------------------------------------------------------

test("forwards a non-streaming call with the typed key and model, and tags the response", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }] }));
  });
  const playground = await startPlayground({ allowPrivateHosts: true });
  try {
    const { response, text } = await playground.call({
      protocol: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: KEY, model: "my-model", request: chatRequest()
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(text).choices[0].message.content, "pong");
    assert.equal(response.headers.get("x-multi-ai-provider"), "custom");
    assert.equal(response.headers.get("x-multi-ai-model"), "my-model");
    assert.equal(response.headers.get("cache-control"), "no-store");

    assert.equal(upstream.seen.length, 1);
    const seen = upstream.seen[0];
    assert.equal(seen.url, "/v1/chat/completions");
    assert.equal(seen.headers.authorization, `Bearer ${KEY}`);
    assert.equal(JSON.parse(seen.body).model, "my-model");
  } finally {
    await playground.close();
    await upstream.close();
  }
});

test("streams server-sent events through unchanged", async () => {
  const frames = ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n', "data: [DONE]\n\n"];
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames) res.write(frame);
    res.end();
  });
  const playground = await startPlayground({ allowPrivateHosts: true });
  try {
    const { response, text } = await playground.call({
      protocol: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: KEY, model: "m", request: chatRequest({ stream: true })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.equal(text, frames.join(""));
    assert.equal(upstream.seen[0].headers.accept, "text/event-stream");
  } finally {
    await playground.close();
    await upstream.close();
  }
});

test("an upstream error is reported with its status and never echoes the API key back", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. Check your key.` } }));
  });
  const playground = await startPlayground({ allowPrivateHosts: true });
  try {
    const { response, text } = await playground.call({
      protocol: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: KEY, model: "m", request: chatRequest()
    });
    // 502, not 401: a 401 here would look like the router's own login failing.
    assert.equal(response.status, 502);
    const body = JSON.parse(text);
    assert.equal(body.error.type, "upstream_error");
    assert.equal(body.error.details.upstreamStatus, 401);
    assert.match(body.error.message, /HTTP 401/);
    assert.match(body.error.message, /Incorrect API key/);
    assert.equal(text.includes(KEY), false, "the typed key must not appear in the response");
    assert.equal(text.includes("SECRET-1234567890"), false);
  } finally {
    await playground.close();
    await upstream.close();
  }
});

test("a redirect is reported, not followed", async () => {
  const target = await startUpstream((_req, res) => { res.writeHead(200); res.end("{}"); });
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.port}/elsewhere` });
    res.end();
  });
  const playground = await startPlayground({ allowPrivateHosts: true });
  try {
    const { response, text } = await playground.call({
      protocol: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: KEY, model: "m", request: chatRequest()
    });
    assert.equal(response.status, 502);
    assert.equal(JSON.parse(text).error.type, "upstream_redirect");
    assert.equal(target.seen.length, 0, "the redirect target must never be contacted");
  } finally {
    await playground.close();
    await upstream.close();
    await target.close();
  }
});

test("a 200 HTML page (WAF challenge) is reported as an error, not shown as a reply", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><meta name="aliyun_waf_aa" content="x"><script>/* challenge */</script>');
  });
  const playground = await startPlayground({ allowPrivateHosts: true });
  try {
    const { response, text } = await playground.call({
      protocol: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: KEY, model: "m", request: chatRequest()
    });
    assert.equal(response.status, 502);
    const error = JSON.parse(text).error;
    assert.equal(error.type, "upstream_html_response");
    assert.equal(error.details.upstreamStatus, 200);
    assert.ok(!text.includes("aliyun_waf"), "the HTML body must not be passed through");
  } finally {
    await playground.close();
    await upstream.close();
  }
});

test("private hosts are refused by default, both as an IP literal and by name", async () => {
  const upstream = await startUpstream((_req, res) => { res.writeHead(200); res.end("{}"); });
  const playground = await startPlayground({});
  try {
    const literal = await playground.call({
      protocol: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: KEY, model: "m", request: chatRequest()
    });
    assert.equal(literal.response.status, 400);
    assert.equal(JSON.parse(literal.text).error.type, "blocked_host");

    // `localhost` passes URL validation and is caught where the socket resolves it.
    const byName = await playground.call({
      protocol: "openai-chat", baseUrl: `http://localhost:${upstream.port}`, apiKey: KEY, model: "m", request: chatRequest()
    });
    assert.equal(byName.response.status, 502);
    assert.match(JSON.parse(byName.text).error.message, /private or reserved/);

    assert.equal(upstream.seen.length, 0, "no request may reach a private address");
  } finally {
    await playground.close();
    await upstream.close();
  }
});

test("an unreachable host gives a plain message, not a stack trace", async () => {
  const playground = await startPlayground({ allowPrivateHosts: true });
  try {
    // Port 1 on loopback: nothing listens there.
    const { response, text } = await playground.call({
      protocol: "openai-chat", baseUrl: "http://127.0.0.1:1", apiKey: KEY, model: "m", request: chatRequest()
    });
    assert.equal(response.status, 502);
    const body = JSON.parse(text);
    assert.equal(body.error.type, "upstream_unreachable");
    assert.match(body.error.message, /refused/i);
  } finally {
    await playground.close();
  }
});

test("a paused gateway refuses the call before touching the network", async () => {
  const upstream = await startUpstream((_req, res) => { res.writeHead(200); res.end("{}"); });
  const playground = await startPlayground({ allowPrivateHosts: true, isPaused: () => true });
  try {
    const { response, text } = await playground.call({
      protocol: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}`, apiKey: KEY, model: "m", request: chatRequest()
    });
    assert.equal(response.status, 409);
    assert.equal(JSON.parse(text).error.type, "gateway_paused");
    assert.equal(upstream.seen.length, 0);
  } finally {
    await playground.close();
    await upstream.close();
  }
});

test("invalid JSON and oversized bodies are client errors", async () => {
  const playground = await startPlayground({ maxBodyBytes: 200 });
  try {
    const big = await playground.call({ protocol: "openai-chat", baseUrl: "https://api.example.com", apiKey: KEY, model: "m", request: { pad: "x".repeat(500) } });
    assert.equal(big.response.status, 413);
    assert.equal(big.text.includes(KEY), false);
  } finally {
    await playground.close();
  }
});
