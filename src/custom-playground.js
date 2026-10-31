import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Transform, pipeline } from "node:stream";
import { buildUpstreamRequest, readJsonBody } from "./adapters.js";
import { sanitizeMessage } from "./observability/sanitize.js";

/**
 * Custom-endpoint playground.
 *
 * The router Playground only reaches providers the operator configured. This
 * module backs the other mode: the operator types ANY base URL, API key and
 * model and the request is sent there once, outside routing, health, cooldown
 * and the request log. It exists to answer "does this key + endpoint + model
 * work at all?" for a platform the gateway knows nothing about.
 *
 * Why the call is made by the server and not by the browser: most provider
 * APIs send no CORS headers, so a browser could not reach them.
 *
 * What that costs, and how it is paid for. A server that fetches a URL chosen
 * by the caller is an SSRF primitive, and `/api/*` is open when
 * APIROUTER_API_KEYS is empty. So:
 *   - only http(s) base URLs, with no embedded credentials, query or fragment;
 *   - private, loopback, link-local, CGNAT and metadata addresses are refused
 *     unless PLAYGROUND_ALLOW_PRIVATE_HOSTS is set (needed for Ollama / LM
 *     Studio on the same machine);
 *   - the check runs on the address the socket will actually connect to
 *     (inside `lookup`), so DNS rebinding cannot swap in a private address
 *     after validation. IP-literal hosts skip `lookup` in Node, so they are
 *     checked up front;
 *   - redirects are never followed (a public host could 302 to a private one);
 *   - the key is held in memory for the one request: never logged, never
 *     stored, and scrubbed out of any upstream error text sent back.
 */

export const CUSTOM_PROTOCOLS = Object.freeze(["openai-chat", "openai-responses", "anthropic", "gemini"]);

const MAX_URL_LENGTH = 2048;
// The endpoint paths a base URL is sometimes pasted with: chat completions, responses, messages.
const PASTED_ENDPOINT_PATH = /\/(?:chat\/completions|responses|messages)$/i;
const MAX_KEY_LENGTH = 4096;
const MAX_MODEL_LENGTH = 256;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  // NAT64: carries an IPv4 address that could be private.
  ["64:ff9b::", 96],
  // 6to4 and Teredo tunnels also embed an IPv4 address (`2002:7f00:1::` is
  // 127.0.0.1), so they are refused like the other transition ranges.
  ["2002::", 16], ["2001::", 32]
]) blocked.addSubnet(address, prefix, "ipv6");

/** True for an address the playground must not call by default. */
export function isBlockedAddress(address) {
  const value = String(address ?? "").replace(/^\[|\]$/g, "");
  const family = net.isIP(value);
  if (family === 0) return true; // not an address at all: refuse rather than guess

  // `::ffff:10.0.0.1` is the IPv4 address 10.0.0.1 wearing an IPv6 coat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (mapped) return blocked.check(mapped[1], "ipv4");

  return blocked.check(value, family === 4 ? "ipv4" : "ipv6");
}

export function guardedLookup(allowPrivateHosts) {
  return (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const allowed = allowPrivateHosts ? addresses : addresses.filter((entry) => !isBlockedAddress(entry.address));
      if (allowed.length === 0) {
        const refusal = new Error("Host resolves to a private or reserved address");
        refusal.code = "EPLAYGROUND_BLOCKED_HOST";
        return callback(refusal);
      }
      // Node's connect may ask for every address (autoSelectFamily) or one.
      if (options.all) return callback(null, allowed);
      return callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export class PlaygroundError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

const hasControlChars = (text) => /[\u0000-\u001F\u007F]/.test(text);

/**
 * Validate a base URL typed by the operator and return it normalized (origin +
 * path, no trailing slash). Throws a PlaygroundError (400) naming the problem.
 * Shared by the one-shot playground and by saved custom endpoints, so both
 * refuse exactly the same URLs.
 */
export function validateEndpointBaseUrl(value, { allowPrivateHosts = false } = {}) {
  const bad = (message) => new PlaygroundError(400, "invalid_request_error", message);
  const rawBase = String(value ?? "").trim();
  if (!rawBase) throw bad("Base URL is required");
  if (rawBase.length > MAX_URL_LENGTH) throw bad("Base URL is too long");

  let url;
  try { url = new URL(rawBase); } catch { throw bad("Base URL is not a valid URL (include https://)"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw bad("Base URL must start with http:// or https://");
  if (url.username || url.password) throw bad("Base URL must not contain a username or password; use the API key field");
  if (url.search || url.hash) throw bad("Base URL must not contain a query string or fragment");

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) throw bad("Base URL has no host");
  // Node skips `lookup` for IP literals, so they have to be judged here.
  if (!allowPrivateHosts && net.isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
    throw new PlaygroundError(400, "blocked_host", "That address is private or reserved. Set PLAYGROUND_ALLOW_PRIVATE_HOSTS=1 on the gateway to test a local endpoint.");
  }

  // A full endpoint URL pasted from a provider's docs (".../v1/chat/completions") is
  // taken to mean its API root. Every request builder appends the endpoint path
  // itself, so keeping it would send the call to ".../chat/completions/v1/chat/completions".
  return url.origin + url.pathname.replace(/\/+$/, "").replace(PASTED_ENDPOINT_PATH, "");
}

/**
 * Validate the caller-supplied target. Returns the normalized target, or throws
 * a PlaygroundError (400) describing exactly which field is wrong.
 */
export function validateCustomRequest(input, { allowPrivateHosts = false } = {}) {
  const bad = (message) => new PlaygroundError(400, "invalid_request_error", message);
  if (!input || typeof input !== "object") throw bad("Request body must be a JSON object");

  const protocol = String(input.protocol ?? "openai-chat");
  if (!CUSTOM_PROTOCOLS.includes(protocol)) throw bad(`protocol must be one of: ${CUSTOM_PROTOCOLS.join(", ")}`);

  const baseUrl = validateEndpointBaseUrl(input.baseUrl, { allowPrivateHosts });
  const url = new URL(baseUrl);

  const model = String(input.model ?? "").trim();
  if (!model) throw bad("Model is required");
  if (model.length > MAX_MODEL_LENGTH || hasControlChars(model)) throw bad("Model id is not valid");

  const apiKey = String(input.apiKey ?? "").trim();
  if (apiKey.length > MAX_KEY_LENGTH || hasControlChars(apiKey)) throw bad("API key contains characters that cannot be sent in a header");

  const request = input.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) throw bad("request must be a JSON object in the chosen protocol's shape");

  return {
    protocol,
    baseUrl,
    host: url.host,
    apiKey,
    model,
    request
  };
}

// ---------------------------------------------------------------------------
// Upstream call
// ---------------------------------------------------------------------------

/** Scrub the caller's own key (and its encoded forms) plus the usual shapes. */
export function scrub(text, apiKey) {
  let result = String(text ?? "");
  if (apiKey.length >= 6) {
    for (const form of new Set([apiKey, encodeURIComponent(apiKey), JSON.stringify(apiKey).slice(1, -1)])) {
      if (form) result = result.split(form).join("[redacted]");
    }
  }
  return sanitizeMessage(result, { maxLength: 500 }) ?? "";
}

export function describeUpstreamError(raw, apiKey) {
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    const found = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? parsed?.detail;
    if (typeof found === "string") message = found;
    else if (found && typeof found === "object") message = JSON.stringify(found);
  } catch { /* not JSON: use the text as it came */ }
  return scrub(message, apiKey);
}

export function networkErrorMessage(error) {
  switch (error?.code) {
    case "EPLAYGROUND_BLOCKED_HOST":
      return "That host resolves to a private or reserved address. Set PLAYGROUND_ALLOW_PRIVATE_HOSTS=1 on the gateway to test a local endpoint.";
    case "ENOTFOUND": return "Could not resolve the host name. Check the base URL.";
    case "ECONNREFUSED": return "Connection refused. Check the host and port.";
    case "ECONNRESET": return "The connection was reset by the host.";
    case "ETIMEDOUT": case "ESOCKETTIMEDOUT": return "The host did not answer in time.";
    case "CERT_HAS_EXPIRED": case "DEPTH_ZERO_SELF_SIGNED_CERT": case "UNABLE_TO_VERIFY_LEAF_SIGNATURE": case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "TLS certificate problem: the host's certificate is not trusted or does not match the name.";
    default: return "Could not reach the host.";
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) { res.end(); return; }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  res.end(payload);
}

function sendError(res, status, type, message, details = null) {
  sendJson(res, status, { error: { message, type, ...(details ? { details } : {}) } });
}

/**
 * Build the upstream request using the same URL rules as the router's own
 * adapters (so `/v1` handling matches what the operator would get when they
 * add the same provider for real), plus the auth quirks of a stranger's API.
 */
export function buildCustomUpstream({ protocol, baseUrl, apiKey, model, request }) {
  const wantsStream = protocol !== "gemini" && request.stream === true;
  const target = { provider: "custom", baseUrl, apiKey, model };
  const built = buildUpstreamRequest(
    target,
    protocol,
    request,
    { accept: wantsStream ? "text/event-stream" : "application/json" },
    { stream: wantsStream }
  );

  const headers = { ...built.options.headers, "accept-encoding": "identity", "user-agent": "apirouter-playground" };
  if (!apiKey) {
    // Keyless endpoints (local models) must not receive "Bearer " with nothing after it.
    delete headers.authorization;
    delete headers["x-goog-api-key"];
  } else if (protocol === "anthropic") {
    // Anthropic itself wants x-api-key; gateways in front of it usually want Bearer. Send both.
    headers["x-api-key"] = apiKey;
  }

  return { url: built.url, headers, body: built.options.body, stream: wantsStream };
}

export function createCustomPlayground({
  timeoutMs = 120_000,
  maxBodyBytes = 10 * 1024 * 1024,
  allowPrivateHosts = false,
  isPaused = () => false
} = {}) {
  const lookup = guardedLookup(allowPrivateHosts);

  return async function handleCustomPlayground(req, res) {
    if (isPaused()) {
      return sendError(res, 409, "gateway_paused", "Gateway is shut down; resume it before sending requests");
    }

    let input;
    let spec;
    try {
      input = await readJsonBody(req, maxBodyBytes);
      spec = validateCustomRequest(input, { allowPrivateHosts });
    } catch (error) {
      const status = error.status ?? 400;
      return sendError(res, status, error.type ?? "invalid_request_error", scrub(error.message, String(input?.apiKey ?? "")));
    }

    let upstream;
    try {
      upstream = buildCustomUpstream(spec);
    } catch (error) {
      return sendError(res, 400, "invalid_request_error", scrub(error.message, spec.apiKey));
    }

    const target = new URL(upstream.url);
    const transport = target.protocol === "https:" ? https : http;

    await new Promise((resolve) => {
      const upstreamReq = transport.request(target, {
        method: "POST",
        headers: upstream.headers,
        lookup,
        timeout: timeoutMs
      });

      // Client gone (Stop button, closed tab): stop paying for the upstream call.
      const onClientClose = () => { if (!res.writableEnded) upstreamReq.destroy(); };
      res.on("close", onClientClose);
      const done = () => { res.off("close", onClientClose); resolve(); };

      upstreamReq.on("timeout", () => {
        const error = new Error("timeout");
        error.code = "ETIMEDOUT";
        upstreamReq.destroy(error);
      });

      upstreamReq.on("error", (error) => {
        if (!res.headersSent) {
          sendError(res, 502, "upstream_unreachable", networkErrorMessage(error));
        } else {
          res.destroy();
        }
        done();
      });

      upstreamReq.on("response", (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;

        if (status >= 300 && status < 400) {
          upstreamRes.resume();
          sendError(res, 502, "upstream_redirect", `The host answered with a redirect (HTTP ${status}). Redirects are not followed — use the final URL as the base URL.`, { upstreamStatus: status });
          return done();
        }

        if (status < 200 || status >= 300) {
          const chunks = [];
          let size = 0;
          upstreamRes.on("data", (chunk) => {
            if (size >= MAX_ERROR_BYTES) return;
            chunks.push(chunk);
            size += chunk.length;
          });
          upstreamRes.on("end", () => {
            const text = describeUpstreamError(Buffer.concat(chunks).toString("utf8"), spec.apiKey);
            sendError(res, 502, "upstream_error", `Upstream returned HTTP ${status}${text ? `: ${text}` : ""}`, { upstreamStatus: status });
            done();
          });
          upstreamRes.on("error", () => { sendError(res, 502, "upstream_error", `Upstream returned HTTP ${status}`, { upstreamStatus: status }); done(); });
          return;
        }

        // An API call never legitimately answers with an HTML page. A 2xx text/html body is a
        // CDN / WAF interstitial (a JS challenge such as Alibaba Cloud WAF or Cloudflare) or a base
        // URL that serves a website. Showing it as a 200 "reply" hides the real problem, so report
        // it as a failed call with a message that says what happened.
        if (/text\/html/i.test(String(upstreamRes.headers["content-type"] ?? ""))) {
          upstreamRes.resume();
          sendError(
            res,
            502,
            "upstream_html_response",
            `The host answered HTTP ${status} with an HTML page instead of an API response. This is usually a WAF / bot-protection challenge that blocks server-side requests, or a base URL that points at a website. Check the base URL, or whether this provider only accepts requests from its own approved clients.`,
            { upstreamStatus: status }
          );
          return done();
        }

        res.writeHead(status, {
          "content-type": upstreamRes.headers["content-type"] || "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-multi-ai-provider": "custom",
          "x-multi-ai-model": spec.model,
          "x-multi-ai-upstream-host": spec.host
        });

        let total = 0;
        const limiter = new Transform({
          transform(chunk, _encoding, next) {
            total += chunk.length;
            if (total > MAX_RESPONSE_BYTES) return next(new Error("response too large"));
            return next(null, chunk);
          }
        });

        pipeline(upstreamRes, limiter, res, () => done());
      });

      upstreamReq.end(upstream.body);
    });
  };
}
