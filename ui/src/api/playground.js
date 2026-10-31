import { apiStream } from "./client.js";
import { sanitizeText } from "../lib/sanitize.js";
import { ApiError, apiErrorFromException, apiErrorFromTimeout } from "../lib/errors.js";

/**
 * Playground transport.
 *
 * The playground talks to the gateway's *public* proxy endpoints — never to a
 * provider directly and never to an internal shortcut. That is deliberate:
 * "never bypass the backend router" means the playground exercises exactly the
 * path a real client would, including protocol detection, health ranking,
 * cooldown and fallback. With Auto Route on, nothing is pinned and the gateway
 * chooses. With it off, the chosen provider (and key, when one is picked) are
 * sent as pin headers and the gateway calls exactly that target.
 */

export const PROTOCOL_ENDPOINTS = Object.freeze({
  "openai-chat": "/v1/chat/completions",
  "openai-responses": "/v1/responses",
  anthropic: "/v1/messages",
  gemini: "/v1beta/models"
});

export const CUSTOM_ENDPOINT = "/api/playground/custom";

export function buildCustomPayload({ protocol, baseUrl, apiKey, model, request }) {
  return {
    protocol,
    baseUrl: String(baseUrl ?? "").trim(),
    apiKey: String(apiKey ?? "").trim(),
    model: String(model ?? "").trim(),
    request
  };
}

/**
 * Why a custom-endpoint request cannot be sent yet, or null when it can. Shown
 * as a hint beside the Send button, so it only says what is missing — the
 * gateway re-validates everything and has the final word.
 */
export function customProblem({ baseUrl, model } = {}) {
  const base = String(baseUrl ?? "").trim();
  if (!base) return "Enter a base URL.";
  let url;
  try {
    url = new URL(base);
  } catch {
    return "Base URL must be a full URL, e.g. https://api.example.com/v1";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Base URL must start with http:// or https://";
  if (!String(model ?? "").trim()) return "Enter a model id.";
  return null;
}

/**
 * Anthropic's API rejects a request with no `max_tokens`, unlike the others, so
 * a blank field means a small default there instead of "no limit".
 */
export function customMaxTokens(protocol, value) {
  const parsed = parseMaxTokens(value);
  if (parsed !== null) return parsed;
  return protocol === "anthropic" ? 1024 : null;
}

/**
 * Pin headers understood by the gateway. A pin needs a provider; a key index
 * is meaningless on its own, so it is only sent alongside one.
 */
export function buildPinHeaders({ autoRoute, provider, keyIndex, customModel, preferModel, rotateAfter, rotate } = {}) {
  if (autoRoute || !provider) return {};
  const headers = { "x-multi-ai-pin-provider": provider };
  if (Number.isInteger(keyIndex) && keyIndex >= 0) headers["x-multi-ai-pin-key-index"] = String(keyIndex);
  // A custom model is a model id typed in by hand, not one of the provider's
  // configured models. The gateway only accepts an unconfigured id when told to.
  if (customModel === true) headers["x-multi-ai-pin-custom-model"] = "1";
  // Auto model on a pinned provider: the gateway walks that provider's models,
  // and this one (the last that answered) goes first.
  else if (rotate === true) {
    headers["x-multi-ai-pin-rotate"] = "1";
    if (typeof rotateAfter === "string" && rotateAfter.trim()) headers["x-multi-ai-pin-rotate-after"] = rotateAfter.trim();
  }
  else if (typeof preferModel === "string" && preferModel.trim()) headers["x-multi-ai-pin-prefer-model"] = preferModel.trim();
  return headers;
}

export function endpointFor(protocol, model) {
  if (protocol === "gemini") {
    return `/v1beta/models/${encodeURIComponent(model || "model")}:generateContent`;
  }
  return PROTOCOL_ENDPOINTS[protocol] ?? PROTOCOL_ENDPOINTS["openai-chat"];
}

/**
 * Build a request body in the client protocol's native shape.
 *
 * Auto Route omits `model`, which is what makes the gateway widen to every
 * protocol-compatible target instead of pinning one.
 */
/** Parse the Max tokens field: blank, zero or garbage all mean "no limit". */
export function parseMaxTokens(value) {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

/**
 * Turn the on-screen transcript into the earlier turns of a conversation.
 *
 * Only complete question/answer pairs are sent: a turn whose reply failed, was
 * cancelled or came back empty is left out, so the history always alternates
 * user / assistant and starts with a user turn (Anthropic and Gemini both
 * require that). Earlier images are not re-sent — they would be uploaded again
 * on every message and would force every later request to carry the image_input
 * requirement — so a turn that had images carries a short "[image attached]" note instead.
 * There is deliberately no length cap: the whole conversation is sent.
 */
export function buildHistory(messages = []) {
  const history = [];
  for (let i = 0; i < messages.length - 1; i += 1) {
    const question = messages[i];
    const answer = messages[i + 1];
    if (question?.role !== "user" || answer?.role !== "assistant") continue;
    if (answer.error || answer.pending || !answer.text) continue;

    const imageCount = question.images?.length ?? question.imageCount ?? 0;
    const text = [question.text, imageCount > 0 ? "[image attached]" : ""].filter(Boolean).join(" ");
    if (!text) continue;

    history.push({ role: "user", text }, { role: "assistant", text: answer.text });
    i += 1;
  }
  return history;
}

export function buildRequestBody({
  protocol,
  model,
  autoRoute,
  prompt,
  system,
  temperature,
  maxTokens,
  images = [],
  history = [],
  stream = true
}) {
  const text = String(prompt ?? "");
  const pictures = Array.isArray(images) ? images.filter((image) => image?.data && image?.mimeType) : [];
  const includeModel = !autoRoute && Boolean(model);
  // Blank means "no limit": the field is simply not sent, so the provider's own
  // default applies. (`Number("")` is 0, which must never reach the wire.)
  const limited = Number.isFinite(maxTokens) && maxTokens > 0;
  const earlier = Array.isArray(history) ? history.filter((turn) => turn && turn.text) : [];

  if (protocol === "anthropic") {
    return {
      ...(includeModel ? { model } : {}),
      ...(limited ? { max_tokens: maxTokens } : {}),
      ...(system ? { system } : {}),
      ...(Number.isFinite(temperature) ? { temperature } : {}),
      messages: [
        ...earlier.map((turn) => ({ role: turn.role, content: turn.text })),
        {
          role: "user",
          content: pictures.length === 0
            ? text
            : [
              ...pictures.map((image) => ({
                type: "image",
                source: { type: "base64", media_type: image.mimeType, data: image.data }
              })),
              ...(text ? [{ type: "text", text }] : [])
            ]
        }
      ],
      stream
    };
  }

  if (protocol === "openai-responses") {
    return {
      ...(includeModel ? { model } : {}),
      input: pictures.length === 0 && earlier.length === 0
        ? text
        : [
          ...earlier.map((turn) => ({ role: turn.role, content: turn.text })),
          pictures.length === 0
            ? { role: "user", content: text }
            : {
              role: "user",
              content: [
                ...(text ? [{ type: "input_text", text }] : []),
                ...pictures.map((image) => ({
                  type: "input_image",
                  image_url: `data:${image.mimeType};base64,${image.data}`
                }))
              ]
            }
        ],
      ...(system ? { instructions: system } : {}),
      ...(Number.isFinite(temperature) ? { temperature } : {}),
      ...(limited ? { max_output_tokens: maxTokens } : {}),
      stream
    };
  }

  if (protocol === "gemini") {
    const generationConfig = {};
    if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
    if (limited) generationConfig.maxOutputTokens = maxTokens;

    return {
      contents: [
        ...earlier.map((turn) => ({ role: turn.role === "assistant" ? "model" : "user", parts: [{ text: turn.text }] })),
        {
          role: "user",
          parts: [
            ...(text || pictures.length === 0 ? [{ text }] : []),
            ...pictures.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))
          ]
        }
      ],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {})
    };
  }

  return {
    ...(includeModel ? { model } : {}),
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      ...earlier.map((turn) => ({ role: turn.role, content: turn.text })),
      {
        role: "user",
        content: pictures.length === 0
          ? text
          : [
            ...(text ? [{ type: "text", text }] : []),
            ...pictures.map((image) => ({
              type: "image_url",
              image_url: { url: `data:${image.mimeType};base64,${image.data}` }
            }))
          ]
      }
    ],
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(limited ? { max_tokens: maxTokens } : {}),
    stream
  };
}

/** Incremental text from one SSE `data:` payload, per protocol shape. */
export function extractDelta(protocol, parsed) {
  if (!parsed || typeof parsed !== "object") return "";

  if (protocol === "anthropic") {
    if (parsed.type === "content_block_delta") return parsed.delta?.text ?? "";
    return "";
  }

  if (protocol === "openai-responses") {
    if (typeof parsed.delta === "string" && parsed.type?.includes("output_text")) return parsed.delta;
    return "";
  }

  // openai-chat
  const choice = parsed.choices?.[0];
  if (!choice) return "";
  const content = contentText(choice.delta?.content);
  if (content) return content;
  // Some providers emit the non-streaming shape even on the stream endpoint.
  return contentText(choice.message?.content);
}

/**
 * The text of an OpenAI-style `content`: a plain string, or (from some gateways)
 * an array of parts such as `[{ type: "text", text: "..." }]`. Anything else is "".
 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
    .join("");
}

/**
 * The error a 200 response carries INSTEAD of text, in any of the shapes the
 * protocols use (`{ error: { message } }`, `{ error: "..." }`, an SSE
 * `{ type: "error" }` event, a Responses `response.failed` event). Empty when
 * the payload is a normal one — `error: null` is not an error.
 */
export function extractErrorMessage(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  const direct = parsed.error;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object" && typeof direct.message === "string") return direct.message;
  if (parsed.type === "error" && typeof parsed.message === "string") return parsed.message;
  const failed = parsed.response?.error;
  if (parsed.type === "response.failed" && failed && typeof failed.message === "string") return failed.message;
  return "";
}

/** Terminal metadata from a final chunk, when the provider reports it. */
export function extractStreamMeta(protocol, parsed) {
  if (!parsed || typeof parsed !== "object") return {};

  const meta = {};

  const usage = parsed.usage ?? parsed.usageMetadata ?? null;
  if (usage) {
    if (Number.isFinite(usage.total_tokens)) meta.tokens = usage.total_tokens;
    else if (Number.isFinite(usage.totalTokens)) meta.tokens = usage.totalTokens;
    else if (Number.isFinite(usage.input_tokens) || Number.isFinite(usage.output_tokens)) {
      meta.tokens = (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
    }
  }

  const finish =
    parsed.choices?.[0]?.finish_reason ??
    parsed.stop_reason ??
    parsed.candidates?.[0]?.finishReason ??
    null;
  if (typeof finish === "string") meta.finishReason = finish;

  return meta;
}

/** Non-streaming body → text, for providers that answer with plain JSON. */
export function extractText(protocol, parsed) {
  if (!parsed || typeof parsed !== "object") return "";

  if (protocol === "anthropic") {
    return (parsed.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("");
  }

  if (protocol === "gemini") {
    return (parsed.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part?.text ?? "")
      .join("");
  }

  if (protocol === "openai-responses") {
    if (typeof parsed.output_text === "string") return parsed.output_text;
    return (parsed.output ?? [])
      .flatMap((item) => item?.content ?? [])
      .map((part) => part?.text ?? "")
      .join("");
  }

  const choice = parsed.choices?.[0];
  const text = contentText(choice?.message?.content);
  // Older completions-style providers answer with `choices[0].text`.
  return text || (typeof choice?.text === "string" ? choice.text : "");
}

/**
 * Send a playground request, reporting text as it arrives.
 *
 * `onDelta` is called with each incremental chunk; `signal` cancels. Returns
 * the final metadata plus the routed target, which comes from the gateway's
 * own response headers rather than from any client-side guess.
 */
export async function sendPlaygroundRequest({
  protocol,
  model,
  body,
  headers,
  signal,
  timeoutMs,
  onDelta,
  onMeta
}) {
  return runPlaygroundRequest({
    path: endpointFor(protocol, model ?? body.model),
    protocol,
    body,
    headers,
    signal,
    timeoutMs,
    onDelta,
    onMeta
  });
}

/**
 * Custom endpoint: the base URL, API key and model are typed in by the operator
 * and the gateway forwards ONE request there — outside routing, health,
 * cooldown and fallback. `body` is the usual client-protocol body; the gateway
 * works out the upstream URL and auth from `baseUrl` + `protocol`.
 *
 * The key is sent in the request body to the operator's own gateway and is
 * never kept by this module.
 */
export async function sendCustomRequest({
  protocol,
  baseUrl,
  apiKey,
  model,
  body,
  signal,
  timeoutMs,
  onDelta,
  onMeta
}) {
  try {
    return await runPlaygroundRequest({
      path: CUSTOM_ENDPOINT,
      protocol,
      body: buildCustomPayload({ protocol, baseUrl, apiKey, model, request: body }),
      signal,
      timeoutMs,
      onDelta,
      onMeta,
      requireText: true
    });
  } catch (error) {
    throw describeCustomError(error);
  }
}

/**
 * What a failed custom-endpoint call means, in the operator's terms.
 *
 * The gateway answers every upstream failure with HTTP 502, which the generic
 * error table calls "All targets failed ... check the fallback chain". A custom
 * endpoint has no targets and no chain: the useful facts are the endpoint's OWN
 * status (carried in `details.upstreamStatus`) and what to check, so the label
 * and hint are replaced here. The message (the endpoint's own reason) is kept.
 */
const CUSTOM_UPSTREAM_STATUS = {
  400: ["Endpoint rejected the request", "The endpoint refused this request. Check the model id and the API style; the message below is its own reason."],
  401: ["Endpoint rejected the API key", "Check the API key. If it is right, the endpoint may expect a different API style."],
  402: ["Endpoint needs payment", "The account has no balance or quota left for this model."],
  403: ["Endpoint refused access", "The key is valid but is not allowed to use this model or endpoint."],
  404: ["Endpoint or model not found", "Check the base URL (is the /v1 part right?), the model id and the API style."],
  408: ["Endpoint timed out", "The endpoint did not answer in time. Try again."],
  429: ["Endpoint rate limited", "The endpoint is throttling this key. Wait a moment and try again."],
  504: ["Endpoint timed out", "The endpoint did not answer in time. Try again."]
};

const CUSTOM_ERROR_TYPES = {
  upstream_unreachable: ["Cannot reach the endpoint", "Check the base URL and port, and that the host is reachable from the gateway."],
  upstream_redirect: ["Endpoint redirected the request", "Use the final URL as the base URL; redirects are not followed."],
  upstream_html_response: ["Endpoint returned a web page", "The base URL may point at a website, or the host blocks server-side requests."],
  blocked_host: ["Host not allowed", "Private and local addresses need PLAYGROUND_ALLOW_PRIVATE_HOSTS=1 on the gateway."],
  gateway_paused: ["Gateway is paused", "Resume the gateway, then send again."]
};

export function describeCustomError(error) {
  if (!(error instanceof ApiError) || error.kind !== "http") return error;

  let found = CUSTOM_ERROR_TYPES[error.type] ?? null;
  if (!found && error.type === "upstream_error") {
    const status = Number(error.details?.upstreamStatus);
    found = CUSTOM_UPSTREAM_STATUS[status]
      ?? (status >= 500
        ? ["Endpoint error", "The endpoint failed on its side. Try again in a moment."]
        : [Number.isFinite(status) && status > 0 ? `Endpoint returned HTTP ${status}` : "Endpoint error", "The message below is the endpoint's own reason."]);
  }
  if (found) {
    error.label = found[0];
    error.hint = found[1];
  }
  return error;
}

async function runPlaygroundRequest({ path, protocol, body, headers, signal, timeoutMs, onDelta, onMeta, requireText = false }) {
  // `apiStream` keeps its timeout and the caller's abort bridge attached for the
  // whole stream lifetime; `release` drops them once the body is done with.
  const { response, release, wasTimedOut } = await apiStream(
    path,
    { body, signal, headers, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
  );

  try {
    return await readPlaygroundResponse({ protocol, response, onDelta, onMeta, requireText });
  } catch (error) {
    // Errors raised while consuming the body reach here unnormalized, because
    // `apiStream` has already returned. Normalizing them keeps one error shape
    // for every caller — and a timeout stays a timeout rather than being
    // reported as the user cancelling.
    if (error instanceof ApiError) throw error;
    throw wasTimedOut() ? apiErrorFromTimeout() : apiErrorFromException(error);
  } finally {
    release();
  }
}

/** A 200 reply that carries an error instead of text. Not an HTTP failure, so it gets its own label. */
function replyError(message) {
  const error = new ApiError({ status: 502, type: "reply_error", message });
  error.category = "provider-error";
  error.label = "The provider reported an error";
  error.hint = "The reply contained an error instead of text. The message below is the provider's own reason.";
  return error;
}

/** A reply with no text at all, which would otherwise show as a blank message. */
function emptyReplyError() {
  const error = new ApiError({ status: 502, type: "empty_reply", message: "The endpoint answered, but the reply had no text." });
  error.category = "provider-error";
  error.label = "Empty reply";
  error.hint = "A reasoning model can spend its whole Max tokens limit thinking and send no answer. Raise Max tokens or try again; also check the API style matches the endpoint.";
  return error;
}

async function readPlaygroundResponse({ protocol, response, onDelta, onMeta, requireText = false }) {
  const routed = {
    provider: response.headers.get("x-multi-ai-provider"),
    model: response.headers.get("x-multi-ai-model"),
    keyIndex: Number(response.headers.get("x-multi-ai-key-index")),
    sessionId: response.headers.get("x-multi-ai-session-id"),
    upstreamHost: response.headers.get("x-multi-ai-upstream-host"),
    status: response.status,
    contentType: response.headers.get("content-type") ?? ""
  };

  onMeta?.({ routed });

  const contentType = routed.contentType;
  let text = "";
  let meta = {};

  // Anthropic always streams when `stream: true`; Gemini generateContent does
  // not stream at all, so it takes the JSON path.
  const isStream = contentType.includes("text/event-stream");

  if (!isStream) {
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    text = parsed ? extractText(protocol, parsed) : sanitizeText(raw);
    meta = parsed ? extractStreamMeta(protocol, parsed) : {};
    if (!text && parsed) {
      const reason = extractErrorMessage(parsed);
      if (reason) throw replyError(reason);
    }
    if (!text && requireText) throw emptyReplyError();
    if (text) onDelta?.(text);
    return { text, ...meta, routed };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError = "";

  const handleFrame = (frame) => {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let parsed = null;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      const delta = extractDelta(protocol, parsed);
      if (delta) {
        text += delta;
        onDelta?.(delta);
      }

      // An error frame on a 200 stream (the provider failed after answering OK).
      if (!streamError) streamError = extractErrorMessage(parsed);

      const streamMeta = extractStreamMeta(protocol, parsed);
      if (Object.keys(streamMeta).length > 0) meta = { ...meta, ...streamMeta };
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. Anything after the last
      // separator stays buffered until more bytes arrive.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";

      for (const frame of frames) handleFrame(frame);
    }

    // The stream may end without the blank line after its last frame. Without
    // this the final chunk of the reply would be silently dropped.
    buffer += decoder.decode();
    if (buffer.trim()) handleFrame(buffer);
  } finally {
    reader.releaseLock?.();
  }

  // What was received stays on screen (the page flushes it); the error follows it.
  if (streamError) throw replyError(streamError);
  if (!text && requireText) throw emptyReplyError();
  return { text, ...meta, routed };
}
