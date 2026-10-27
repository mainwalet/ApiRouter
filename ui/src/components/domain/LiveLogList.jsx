import { Fragment } from "react";
import { STATE, STATE_TONE, hasUsage, isLive, shortRequestId } from "../../lib/liveLogs.js";
import { sanitizeText } from "../../lib/sanitize.js";
import { EMPTY, formatLatency, formatNumber, providerLabel } from "../../lib/format.js";

/** 24-hour local clock, `HH:MM:SS`; an explicit placeholder when unknown. */
export function formatClock(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return EMPTY;
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** `Provider · model · key N` — every part optional, key shown by index only. */
export function describeTarget(target) {
  return [
    target?.provider ? providerLabel(target.provider) : null,
    target?.model ?? null,
    Number.isInteger(target?.keyIndex) ? `key ${target.keyIndex}` : null
  ].filter(Boolean).join(" · ");
}

/** `Provider · model`, without the key: the key sits with the figures in the card header. */
export function describeModel(target) {
  return [
    target?.provider ? providerLabel(target.provider) : null,
    target?.model ?? null
  ].filter(Boolean).join(" · ");
}

const isNum = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The right-hand figures. A finished row shows `200 · 1.09 s`; a running one
 * shows the time elapsed so far, which `now` keeps ticking.
 */
export function describeOutcome(row, now = Date.now()) {
  if (isLive(row)) {
    return isNum(row.ts) && isNum(now) ? formatLatency(Math.max(0, now - row.ts)) : "";
  }
  const parts = [];
  if (Number.isInteger(row.status)) parts.push(String(row.status));
  if (row.state === STATE.FAILED && !Number.isInteger(row.status)) parts.push("failed");
  if (isNum(row.durationMs)) parts.push(formatLatency(row.durationMs));
  return parts.join(" · ");
}

/**
 * How long this attempt's answer has been streaming in: counts up while it
 * streams (`now` keeps ticking), then holds the final figure once the stream has
 * ended. Empty for anything that never streamed, or from a gateway that does
 * not report when streaming began.
 */
export function describeStream(row, now = Date.now()) {
  if (!row || row.kind !== "attempt") return "";
  if (row.state === STATE.STREAMING) {
    return isNum(row.streamStartedAt) && isNum(now) ? formatLatency(Math.max(0, now - row.streamStartedAt)) : "";
  }
  return isNum(row.streamMs) ? formatLatency(row.streamMs) : "";
}

/** `Streaming 12.34 s` while it streams, `Streamed 12.34 s` once it ended; empty when there is nothing to say. */
export function describeStreamLabel(row, now = Date.now()) {
  const time = describeStream(row, now);
  if (!time) return "";
  return `${row.state === STATE.STREAMING ? "Streaming" : "Streamed"} ${time}`;
}

/**
 * `Input: 1,245 · Output: 387 · Total: 1,632`. A figure the provider did not
 * report is shown as a dash, never as 0.
 */
export function describeUsage(row) {
  const figure = (value) => (isNum(value) ? formatNumber(value) : EMPTY);
  return `Input: ${figure(row?.inputTokens)} · Output: ${figure(row?.outputTokens)} · Total: ${figure(row?.totalTokens)}`;
}

/** This attempt's own token usage, inside its card. */
function UsageLine({ row }) {
  const reported = hasUsage(row);
  const title = reported
    ? "Tokens this attempt used, as reported by the provider"
    : row.state === STATE.CALLING
      ? "Reported once the provider answers"
      : row.state === STATE.STREAMING
        ? "Reported when the stream ends"
      : "The provider did not report usage for this attempt";
  return (
    <div className={`livelog__usage mono tabular${reported ? "" : " dim"}`} title={title} data-usage={reported ? "reported" : "unavailable"}>
      {describeUsage(row)}
    </div>
  );
}

/** What the row says while it has no target yet, or besides the target. */
function requestText(row) {
  // "client -> upstream" when a bridge translated the request, else the one protocol.
  const route = row.bridged && row.clientProtocol && row.protocol
    ? `${row.clientProtocol} → ${row.protocol}`
    : (row.clientProtocol ?? row.protocol);
  return [route, row.bridged ? "BRIDGE" : null, row.requestedModel].filter(Boolean).join(" · ");
}

const STATE_HINT = Object.freeze({
  [STATE.ROUTING]: "Choosing a target",
  [STATE.CALLING]: "Calling this model",
  [STATE.STREAMING]: "Answer is streaming in; tokens are reported when it ends",
  [STATE.SUCCESS]: "This model answered",
  [STATE.FAILED]: "This model failed"
});

const EFFORT_NAME = Object.freeze({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra High" });

/** One attempt's target, as its own box inside its card. */
function TargetBox({ row, tone }) {
  const calling = isLive(row) && row.kind === "attempt";
  const target = row.kind === "request" && row.state === STATE.ROUTING
    ? "Choosing next target…"
    : sanitizeText(describeModel(row));
  const why = row.state === STATE.FAILED && row.kind === "attempt"
    ? sanitizeText([row.reason, row.detail].filter(Boolean).join(" · "))
    : "";

  return (
    <div className="livelog__steps">
      <div
        className={`livelog__step livelog__step--${tone}${calling ? " livelog__step--calling" : ""}`}
        data-step-state={row.state}
      >
        <div className="livelog__step-head">
          <span
            className={`livelog__type livelog__type--${tone}${calling ? " livelog__type--live" : ""}`}
            title={STATE_HINT[row.state]}
          >
            {row.state}
          </span>
          <span className="livelog__target mono" title={target}>{target}</span>
        </div>
        {row.kind === "attempt" && row.effort ? (
          <div className="livelog__effort-row">
            <span
              className={`livelog__effort livelog__effort--${row.effort} mono`}
              title="Reasoning effort this attempt was sent with"
              data-effort={row.effort}
            >
              Effort: {EFFORT_NAME[row.effort] ?? row.effort}
            </span>
          </div>
        ) : null}
        {why ? <div className="livelog__detail livelog__detail--failed mono" title={why}>{why}</div> : null}
      </div>
    </div>
  );
}

/** The line between a failed attempt's card and the next attempt's card. */
function FallbackLink({ from }) {
  const why = sanitizeText([
    Number.isInteger(from.status) ? String(from.status) : null,
    from.reason
  ].filter(Boolean).join(" · "));
  return (
    <li className="livelog__fallback mono" aria-label="Fallback to the next model">
      <span aria-hidden="true">↓</span> FALLBACK{why ? ` · ${why}` : ""}
    </li>
  );
}

/** Time, state, call number, protocol and request id: the top of every card. */
function CardHead({ row, outcome, request, rid, onSelectRequest }) {
  const tone = STATE_TONE[row.state] ?? "neutral";
  const live = isLive(row);
  const call = Number.isInteger(row.callIndex) ? `#${row.callIndex}` : "";
  return (
    <div className="livelog__card-head">
      <time className="livelog__time mono tabular">{formatClock(row.ts)}</time>
      <span
        className={`livelog__type livelog__type--${tone}${live ? " livelog__type--live" : ""}`}
        title={STATE_HINT[row.state]}
      >
        {row.state}
      </span>
      <span className="livelog__sub dim mono" title={request}>{[call ? `Call ${call}` : null, request].filter(Boolean).join(" · ")}</span>
      <span className="livelog__outcome mono tabular">{outcome}</span>
      {rid ? (
        onSelectRequest ? (
          <button
            type="button"
            className="livelog__rid mono"
            title={`Filter to request ${row.requestId}`}
            onClick={() => onSelectRequest(row.requestId)}
          >
            {rid}
          </button>
        ) : (
          <span className="livelog__rid mono" title={row.requestId}>{rid}</span>
        )
      ) : (
        <span className="livelog__rid" />
      )}
    </div>
  );
}

/**
 * ONE card for ONE upstream attempt: its header (time, state, call number,
 * key, status and time) above the box naming the model. The card shows only its
 * own attempt; it knows nothing of the other attempts of the request, so
 * a later attempt can never change what it says. A request that never reached a
 * provider is a single card with no model box. Missing optional fields simply
 * drop out; nothing here can throw on a sparse row.
 */
export function LiveLogRow({ row, now = Date.now(), first = true, onSelectRequest = null }) {
  if (!row) return null;

  const tone = STATE_TONE[row.state] ?? "neutral";
  const live = isLive(row);
  const request = sanitizeText(requestText(row));
  const rid = shortRequestId(row.requestId);
  const cardClass = `livelog__card${first ? " livelog__card--first" : ""} livelog__card--${tone}${live ? " livelog__card--live" : ""}`;
  const identity = {
    "data-state": row.state,
    "data-kind": row.kind,
    "data-attempt-id": row.attemptId ?? undefined,
    "data-request-id": row.requestId ?? undefined
  };

  // Rejected before any provider was tried: one card, no model box.
  if (row.kind === "request") {
    const target = sanitizeText(describeTarget(row));
    const reason = row.reason ? sanitizeText(row.reason) : "";
    return (
      <li className={cardClass} {...identity}>
        <CardHead row={row} request={request} rid={rid} outcome={describeOutcome(row, now)} onSelectRequest={onSelectRequest} />
        {target ? <div className="livelog__target mono livelog__lone" title={target}>{target}</div> : null}
        {reason ? <div className="livelog__detail mono livelog__reason" title={reason}>{reason}</div> : null}
      </li>
    );
  }

  // The figures live in the header only: key, then status and time, then how long it streamed.
  const figures = [
    Number.isInteger(row.keyIndex) ? `key ${row.keyIndex}` : null,
    describeOutcome(row, now),
    describeStreamLabel(row, now)
  ].filter(Boolean).join(" · ");

  return (
    <li className={cardClass} {...identity}>
      <CardHead row={row} request={request} rid={rid} outcome={figures} onSelectRequest={onSelectRequest} />
      <TargetBox row={row} tone={tone} />
      <UsageLine row={row} />
    </li>
  );
}

/**
 * The scrollable chronological list, oldest first, newest last. Every row is its
 * own card, keyed by its attempt id, so a new attempt always mounts a new card.
 * A FALLBACK line joins a failed attempt to the next attempt of the same request.
 */
export function LiveLogList({ rows, now = Date.now(), onSelectRequest = null }) {
  return (
    <ol className="livelog__list" role="log" aria-live="off" aria-label="API calls">
      {rows.map((row, index) => {
        const prev = index > 0 ? rows[index - 1] : null;
        const sameRequest = prev !== null && prev.requestKey === row.requestKey;
        const fallback = sameRequest && prev.kind === "attempt" && prev.state === STATE.FAILED && row.kind === "attempt";
        return (
          <Fragment key={row.key}>
            {fallback ? <FallbackLink from={prev} /> : null}
            <LiveLogRow row={row} now={now} first={!sameRequest} onSelectRequest={onSelectRequest} />
          </Fragment>
        );
      })}
    </ol>
  );
}

/**
 * Plain-text transcript of the given cards (what is on screen), for pasting
 * into a bug report or chat: one block per attempt. Free text is scrubbed like
 * everything else shown; only key indexes appear, never key values.
 */
export function formatRowsAsText(rows) {
  const clean = (value) => sanitizeText(value, { maxLength: 1000 });
  const blocks = (Array.isArray(rows) ? rows : []).filter(Boolean).map((row) => {
    const figures = describeOutcome(row, row.ts);
    const head = [
      `[${formatClock(row.ts)}]`,
      row.state,
      Number.isInteger(row.callIndex) ? `call #${row.callIndex}` : null,
      clean(requestText(row)),
      row.requestId ? `id ${row.requestId}` : null,
      row.attemptId ? `attempt ${row.attemptId}` : null
    ].filter(Boolean).join("  ");
    const lines = [head];

    const target = clean(describeTarget(row));
    if (target) lines.push(`  ${target}${figures && row.kind === "attempt" ? `  (${figures})` : ""}`);
    if (row.kind === "attempt" && row.effort) lines.push(`  Effort: ${EFFORT_NAME[row.effort] ?? row.effort}`);
    if (row.kind === "request" && figures) lines.push(`  ${figures}`);
    const streamed = row.state === STATE.STREAMING ? "" : describeStream(row);   // a running stream has no final time yet
    if (streamed) lines.push(`  Streamed: ${streamed}`);
    if (row.kind === "attempt") lines.push(`  ${describeUsage(row)}`);

    const why = clean([row.reason, row.detail].filter(Boolean).join(" · "));
    if (why) lines.push(`  ${why}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}
