/**
 * Screens the start of a 2xx upstream response for a provider that reports a
 * billing problem as ordinary reply text.
 *
 * Pollinations, for one, answers HTTP 200 with a normal-looking completion
 * whose text is "The account behind this API key doesn't have enough credits.
 * Please top up or complete a quest...". Passing that through logs a SUCCESS and
 * hands the client an error as if it were the model's answer, and the fallback
 * walk never moves on. Only the first part of the body is read, so a real reply
 * starts streaming as soon as it is clear it is a real reply.
 */

// Wording that no genuine model reply opens with: an account/key out of credits.
export const OUT_OF_CREDITS_PATTERN = /(?:doesn['’]t|does not|do not|don['’]t) have enough credits|top up or complete a quest|(?:insufficient|not enough|no) credits? (?:left|remaining|available)\b/i;

const PEEK_BYTES = 8 * 1024;
const PEEK_CONTENT_CHARS = 160;

// Fold the escapes JSON puts in a string, so the pattern sees the same text a person would read.
function readable(raw) {
  return raw
    .replace(/\\u2019/gi, "\u2019")
    .replace(/\\u0027/g, "'")
    .replace(/\\'/g, "'");
}

/** Pulls the assistant text and the "this is a real reply" signals out of SSE lines seen so far. */
function inspectEventStream(raw) {
  let content = "";
  let decided = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") { decided = true; continue; }
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    const choice = event?.choices?.[0];
    const delta = choice?.delta ?? choice?.message ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (delta.tool_calls || delta.reasoning || delta.reasoning_content || delta.function_call) decided = true;
    if (choice?.finish_reason) decided = true;
  }
  return { content, decided };
}

/**
 * Returns `{ upstream, message }`. `message` is the billing text when the body
 * is one, otherwise null and `upstream` is a response that still carries every
 * byte (the bytes read here are replayed ahead of the rest of the body).
 */
export async function screenForOutOfCredits(upstream, { pattern = OUT_OF_CREDITS_PATTERN } = {}) {
  const type = upstream?.headers?.get?.("content-type") ?? "";
  const isStream = /text\/event-stream/i.test(type);
  const isJson = /json/i.test(type);
  if (!upstream?.body || (!isStream && !isJson)) return { upstream, message: null };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const held = [];
  let raw = "";
  let bytes = 0;
  let finished = false;

  while (!finished && bytes < PEEK_BYTES) {
    const { done, value } = await reader.read();
    if (done) { finished = true; break; }
    held.push(value);
    bytes += value.byteLength;
    raw += decoder.decode(value, { stream: true });

    const text = readable(raw);
    if (pattern.test(text)) {
      try { await reader.cancel(); } catch { /* already closed */ }
      const match = text.match(/"content"\s*:\s*"([^"]{0,300})/);
      return { upstream: null, message: (match?.[1] ?? text).slice(0, 300) };
    }
    if (isStream) {
      const { content, decided } = inspectEventStream(text);
      if (decided || content.length >= PEEK_CONTENT_CHARS) break;
    }
  }

  let index = 0;
  const replay = new ReadableStream({
    async pull(controller) {
      if (index < held.length) { controller.enqueue(held[index]); index += 1; return; }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  return {
    upstream: new Response(replay, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers }),
    message: null
  };
}
