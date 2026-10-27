import { describeAttempt } from "./errors.js";
import { sanitizeText } from "./sanitize.js";

/**
 * Live Logs: one card per real upstream attempt.
 *
 * ONE REAL UPSTREAM ATTEMPT = ONE CARD. The gateway reports every attempt as
 * its own event, with its own `attemptId`, while it runs (`calling`) and once it
 * answers (`success` / `failed`). A card is keyed by that id and by nothing
 * else, so:
 *
 *   - the same provider/model/key called again is a new card, never an old one
 *     reused or updated: its attempt has a new id;
 *   - a card moves once, CALLING -> SUCCESS or FAILED, and a final card is never
 *     rewritten, not by a stale snapshot and not by a later attempt;
 *   - the request id only groups cards (`requestId`); it is not a card key.
 *
 * A request that never reached a provider (rejected up front), or has not
 * picked a target yet, has no attempt to show, so it gets one request card
 * (`kind: "request"`), which a real attempt replaces.
 *
 * Live pushes, the snapshot and the history all go through the same builders
 * (`buildAttemptRow`, `buildRequestRow`), so a card looks the same whichever way
 * it arrived. Only key *indexes* are ever carried: the log has no key values, and
 * every free-text field is scrubbed again here before it can reach the DOM.
 */

export const STATE = Object.freeze({
  /** A request with no attempt on the wire yet, or rejected before any attempt. */
  ROUTING: "ROUTING",
  /** This attempt is on the wire right now. */
  CALLING: "CALLING",
  /** This attempt answered 2xx and its body is still streaming in. */
  STREAMING: "STREAMING",
  /** This attempt answered with a 2xx and, for a stream, the stream ended. */
  SUCCESS: "SUCCESS",
  /** This attempt answered with an error, or timed out. */
  FAILED: "FAILED"
});

/** Badge tone per state. */
export const STATE_TONE = Object.freeze({
  [STATE.ROUTING]: "neutral",
  [STATE.CALLING]: "info",
  [STATE.STREAMING]: "info",
  [STATE.SUCCESS]: "ok",
  [STATE.FAILED]: "danger"
});

/** States in which a card is still changing. */
export const LIVE_STATES = Object.freeze([STATE.ROUTING, STATE.CALLING, STATE.STREAMING]);
export const isLive = (row) => LIVE_STATES.includes(row?.state);

/**
 * Live Logs keeps the last 50 cards. When a newer one arrives past that, the
 * oldest is dropped, so the view stays short and a long-open tab cannot grow.
 */
export const MAX_ROWS = 50;

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const optInt = (value) => (Number.isInteger(value) ? value : null);
const tokenCount = (value) => (isNum(value) && value >= 0 ? Math.round(value) : null);

/**
 * The token usage ONE attempt reported. Missing figures stay `null`, never 0. The
 * total is the provider's own when it sent one; otherwise input + output, and only
 * when both are known.
 */
export function readUsage(source) {
  const inputTokens = tokenCount(source?.inputTokens);
  const outputTokens = tokenCount(source?.outputTokens);
  let totalTokens = tokenCount(source?.tokens) ?? tokenCount(source?.totalTokens);
  if (totalTokens === null && inputTokens !== null && outputTokens !== null) totalTokens = inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

/** Does this card carry at least one reported token figure? */
export const hasUsage = (row) =>
  row?.inputTokens !== null && row?.inputTokens !== undefined
  || row?.outputTokens !== null && row?.outputTokens !== undefined
  || row?.totalTokens !== null && row?.totalTokens !== undefined;
const optText = (value, maxLength = 300) => {
  const text = sanitizeText(value, { maxLength });
  return text ? text : null;
};

/** Request-level context an attempt may inherit when its own event lacks it. */
function requestContext(entry) {
  const startSeq = isNum(entry?.startSeq) ? entry.startSeq : (isNum(entry?.seq) ? entry.seq : null);
  return {
    startSeq,
    requestId: entry?.requestId ?? entry?.id ?? null,
    sessionId: entry?.id ?? null,
    protocol: entry?.protocol ?? null,
    requestedModel: entry?.requestedModel ?? null
  };
}

/**
 * One card for one attempt. `attempt` is an attempt event (live or listed) or an
 * attempt row nested in a request entry; both carry the same identity. Returns
 * `null` for anything that is not a real attempt (a skipped target, malformed
 * input, or one with no way to be told apart from another).
 */
export function buildAttemptRow(attempt, ctx = {}) {
  if (!attempt || typeof attempt !== "object" || attempt.skipped === true) return null;

  // An attempt id is what makes a card. Only a gateway that predates attempt
  // ids falls back to the position inside its request, and only for that
  // request, so even then two requests can never share a card.
  const attemptId = typeof attempt.attemptId === "string" && attempt.attemptId ? attempt.attemptId : null;
  const requestKey = isNum(attempt.requestSeq) ? attempt.requestSeq : (isNum(ctx.startSeq) ? ctx.startSeq : null);
  const legacyIndex = Number.isInteger(attempt.index) ? attempt.index : null;
  const key = attemptId ?? (requestKey !== null && legacyIndex !== null ? `legacy:${requestKey}:${legacyIndex}` : null);
  if (key === null) return null;

  const state = attempt.state === "calling"
    ? STATE.CALLING
    : attempt.state === "streaming"
      ? STATE.STREAMING
    : attempt.state === "success" || (attempt.state === undefined && attempt.ok === true)
      ? STATE.SUCCESS
      : STATE.FAILED;
  const calling = state === STATE.CALLING;
  const streaming = state === STATE.STREAMING;
  const failed = state === STATE.FAILED;
  const requestId = attempt.requestId ?? ctx.requestId ?? null;

  return {
    key,
    kind: "attempt",
    attemptId,
    // The number the log gave the attempt; orders attempts started in the same millisecond.
    order: isNum(attempt.attemptSeq) ? attempt.attemptSeq : (legacyIndex ?? 0),
    // Which request it belongs to, in the request log's own numbering. Used to
    // honour Clear and to spot a restarted gateway, never to identify a card.
    requestKey: requestKey ?? 0,
    callIndex: optInt(attempt.callIndex) ?? legacyIndex,
    requestId: requestId ? String(requestId) : null,
    state,
    pending: calling || streaming,
    ts: isNum(attempt.startedAt) ? attempt.startedAt : null,
    // `protocol` is what was spoken upstream; `clientProtocol` is what the
    // client sent. `bridged` means a bridge translated between the two.
    protocol: attempt.protocol ?? ctx.protocol ?? null,
    clientProtocol: attempt.clientProtocol ?? ctx.protocol ?? null,
    bridged: typeof attempt.bridged === "boolean"
      ? attempt.bridged
      : Boolean((attempt.clientProtocol ?? ctx.protocol) && (attempt.protocol ?? ctx.protocol) && (attempt.clientProtocol ?? ctx.protocol) !== (attempt.protocol ?? ctx.protocol)),
    requestedModel: optText(attempt.requestedModel ?? ctx.requestedModel, 120),
    phase: attempt.phase ?? null,
    provider: attempt.provider ?? null,
    model: attempt.model ?? null,
    keyIndex: optInt(attempt.keyIndex),
    // Which reasoning effort this attempt carried (low / medium / high / xhigh); null when none was sent.
    effort: ["low", "medium", "high", "xhigh"].includes(attempt.effort) ? attempt.effort : null,
    status: calling ? null : optInt(attempt.status),
    durationMs: calling || streaming ? null : (isNum(attempt.latencyMs) ? attempt.latencyMs : null),
    // When the body began streaming in (so the card can count up), and how long the whole stream took once it ended.
    streamStartedAt: isNum(attempt.streamStartedAt) ? attempt.streamStartedAt : null,
    streamMs: isNum(attempt.streamMs) ? attempt.streamMs : null,
    reason: failed ? describeAttempt({ ...attempt, ok: false }).label : null,
    detail: failed ? optText(attempt.errorMessage) : null,
    // This attempt's own usage; a running attempt has none yet.
    ...(calling || streaming ? { inputTokens: null, outputTokens: null, totalTokens: null } : readUsage(attempt))
  };
}

/**
 * The one card for a request that has no attempt to show: still choosing a
 * target (ROUTING), or finished without ever calling a provider.
 */
export function buildRequestRow(entry) {
  if (!entry || typeof entry !== "object") return null;
  const ctx = requestContext(entry);
  if (ctx.startSeq === null) return null;

  const pending = entry.outcome === "pending";
  const state = pending ? STATE.ROUTING : entry.outcome === "failed" ? STATE.FAILED : STATE.SUCCESS;
  const total = isNum(entry.totalMs) ? entry.totalMs : isNum(entry.latencyMs) ? entry.latencyMs : null;

  return {
    key: `req:${ctx.startSeq}`,
    kind: "request",
    attemptId: null,
    order: ctx.startSeq,
    requestKey: ctx.startSeq,
    callIndex: null,
    requestId: ctx.requestId ? String(ctx.requestId) : null,
    state,
    pending,
    ts: isNum(entry.receivedAt) ? entry.receivedAt : null,
    protocol: ctx.protocol,
    clientProtocol: ctx.protocol,
    bridged: false,
    requestedModel: optText(entry.requestedModel, 120),
    phase: null,
    provider: entry.finalProvider ?? null,
    model: entry.finalModel ?? null,
    keyIndex: optInt(entry.finalKeyIndex),
    status: pending ? null : optInt(entry.httpStatus),
    durationMs: pending ? null : total,
    reason: state === STATE.FAILED ? (optText(entry.errorMessage) ?? optText(entry.errorType, 60)) : null,
    detail: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null
  };
}

/**
 * Every card a request entry (running or finished) accounts for: one per real
 * attempt it lists, plus the attempt on the wire, or the single request card
 * when there is no attempt at all.
 */
export function buildRows(entry) {
  if (!entry || typeof entry !== "object") return [];
  const ctx = requestContext(entry);
  const listed = Array.isArray(entry.attempts) ? entry.attempts : [];
  const rows = listed.map((attempt) => buildAttemptRow(attempt, ctx)).filter(Boolean);

  const inflight = entry.outcome === "pending" && entry.inflight && typeof entry.inflight === "object" ? entry.inflight : null;
  if (inflight) {
    const calling = buildAttemptRow({ ...inflight, state: "calling", index: listed.length + 1 }, ctx);
    if (calling) rows.push(calling);
  }

  if (rows.length === 0) {
    const request = buildRequestRow(entry);
    return request ? [request] : [];
  }
  return rows;
}

/** Chronological order by start time; ties fall back to the order the log numbered them. */
export function compareRows(a, b) {
  const at = isNum(a.ts) ? a.ts : null;
  const bt = isNum(b.ts) ? b.ts : null;
  if (at !== null && bt !== null && at !== bt) return at - bt;
  if (a.order !== b.order) return a.order - b.order;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * May `next` replace the card already held under the same key? Cards arrive from
 * two places (pushed events and snapshots), and a snapshot taken a moment earlier
 * can land after a newer event. An attempt that has answered is final: nothing
 * turns it back into CALLING and nothing rewrites its outcome. Only a request
 * card, which stands for a whole request rather than one attempt, may move from
 * running to finished.
 */
function supersedes(next, prev) {
  if (!prev) return true;
  if (prev.kind === "attempt") {
    if (prev.pending) {
      // A late snapshot of an earlier moment never moves a streaming card back to CALLING.
      return !(prev.state === STATE.STREAMING && next.state === STATE.CALLING);
    }
    // An answered attempt is final, with one exception: the usage its provider
    // reports arrives after the answer (a stream reports it last). The same attempt,
    // in the same state, may gain it once; nothing else about the card changes,
    // and a snapshot without usage never erases usage already shown.
    return next.kind === "attempt" && !next.pending && next.state === prev.state
      && !hasUsage(prev) && hasUsage(next);
  }
  return !(!prev.pending && next.pending);
}

/**
 * Upsert incoming cards by key and sort them chronologically, newest last,
 * capped at `MAX_ROWS`. A new attempt id is a new card, however much it looks
 * like an earlier one; only the *same* attempt can update a card.
 */
export function mergeRows(current, incoming, { max = MAX_ROWS } = {}) {
  if (!incoming || incoming.length === 0) return current;

  const byKey = new Map(current.map((row) => [row.key, row]));
  for (const row of incoming) {
    if (supersedes(row, byKey.get(row.key))) byKey.set(row.key, row);
  }

  // A request card that only says "still routing" is a placeholder: once any
  // real attempt of that request is on screen it has nothing left to say.
  const withAttempts = new Set();
  for (const row of byKey.values()) if (row.kind === "attempt") withAttempts.add(row.requestKey);
  for (const [key, row] of byKey) {
    if (row.kind === "request" && row.state === STATE.ROUTING && withAttempts.has(row.requestKey)) byKey.delete(key);
  }

  const merged = [...byKey.values()].sort(compareRows);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

/**
 * Turn one `/api/requests` payload (or stream snapshot) into cards.
 *
 * `floor` is the highest request sequence number the operator cleared, so cleared
 * requests do not come back on the next poll. `maxSeq` is the highest request
 * sequence seen so far; a payload whose highest sequence is *lower* means the
 * gateway restarted (its counter reset) and the view starts over.
 */
export function ingestPayload(payload, { floor = 0, maxSeq = 0 } = {}) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const pending = Array.isArray(payload?.pending) ? payload.pending : [];
  const events = Array.isArray(payload?.attempts) ? payload.attempts : [];
  const requests = [...entries, ...pending].filter((entry) => entry && isNum(entry.seq ?? entry.startSeq));

  if (requests.length === 0 && events.length === 0) return { rows: [], maxSeq, restarted: false };

  const seen = [
    ...requests.map((entry) => Math.max(entry.seq ?? 0, entry.startSeq ?? 0)),
    ...events.filter((event) => isNum(event?.requestSeq)).map((event) => event.requestSeq)
  ];
  const newest = seen.length > 0 ? Math.max(...seen) : maxSeq;
  const restarted = newest < maxSeq;
  const lowest = restarted ? 0 : floor;

  // The listed attempt events and the attempts nested in each request are the
  // same attempts (same ids), so building both is harmless: they merge by id.
  const rows = [
    ...events.map((event) => buildAttemptRow(event)),
    ...requests.flatMap(buildRows)
  ].filter((row) => row && row.requestKey > lowest);

  return { rows, maxSeq: restarted ? newest : Math.max(newest, maxSeq), restarted };
}

/**
 * Turn one pushed event (`attempt`, `pending` or `entry`) into cards. Unlike a
 * full payload, a single event says nothing about the rest of the log, so it
 * cannot signal a gateway restart: an old call that is still running legitimately
 * has a lower sequence number than newer calls that already finished.
 */
export function ingestEvent(event, { floor = 0, maxSeq = 0 } = {}) {
  const data = event?.data;
  if (!data || typeof data !== "object") return { rows: [], maxSeq };

  if (event.event === "attempt") {
    const row = buildAttemptRow(data);
    if (!row) return { rows: [], maxSeq };
    return {
      rows: row.requestKey > floor ? [row] : [],
      maxSeq: Math.max(row.requestKey, maxSeq)
    };
  }

  if (!isNum(data.seq ?? data.startSeq)) return { rows: [], maxSeq };
  const newest = Math.max(data.seq ?? 0, data.startSeq ?? 0);
  return {
    rows: buildRows(data).filter((row) => row.requestKey > floor),
    maxSeq: Math.max(newest, maxSeq)
  };
}

/** Text a search box matches against. Never includes anything but display fields. */
function haystack(row) {
  return [
    row.state, row.requestId, row.provider, row.model, row.protocol, row.clientProtocol, row.bridged ? "bridge" : "", row.requestedModel,
    Number.isInteger(row.keyIndex) ? `key ${row.keyIndex}` : "",
    Number.isInteger(row.callIndex) ? `call ${row.callIndex}` : "",
    row.status, row.reason, row.detail
  ].filter((part) => part !== null && part !== undefined && part !== "").join(" ").toLowerCase();
}

/**
 * Apply the panel filters. `status` is "running", "success" or "failed";
 * "running" covers every row that has not finished yet.
 */
export function filterRows(rows, { provider = null, status = null, search = "", requestId = "" } = {}) {
  const needle = String(search ?? "").trim().toLowerCase();
  const rid = String(requestId ?? "").trim().toLowerCase();

  return rows.filter((row) => {
    if (provider && row.provider !== provider) return false;
    if (status === "running" && !row.pending) return false;
    if (status === "success" && row.state !== STATE.SUCCESS) return false;
    if (status === "failed" && row.state !== STATE.FAILED) return false;
    if (rid && !String(row.requestId ?? "").toLowerCase().includes(rid)) return false;
    if (needle && !haystack(row).includes(needle)) return false;
    return true;
  });
}

/** Is a scroll container within `threshold` px of its bottom edge? */
export function isNearBottom({ scrollTop, scrollHeight, clientHeight }, threshold = 24) {
  if (![scrollTop, scrollHeight, clientHeight].every(isNum)) return true;
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * A short, still-distinguishing form of a request id. The gateway's own ids
 * (`req-<boot>-<000042>`) differ only at the end, so they shorten to `req-42`;
 * anything else (a client-supplied id) keeps its first characters.
 */
export function shortRequestId(id, length = 8) {
  if (!id) return null;
  const text = String(id);
  const own = /^req-[0-9a-f]+-(\d+)$/i.exec(text);
  if (own) return `req-${own[1].replace(/^0+(?=\d)/, "")}`;
  return text.length > length ? text.slice(0, length) : text;
}
