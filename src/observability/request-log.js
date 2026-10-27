import { randomBytes } from "node:crypto";
import { sanitizeMessage } from "./sanitize.js";
import { hasUsage, normalizeUsage } from "../usage.js";

export const DEFAULT_MAX_ENTRIES = 500;

export const OUTCOMES = Object.freeze({
  SUCCESS: "success",
  FAILED: "failed"
});

/**
 * Lifecycle of ONE upstream attempt. An attempt is created `calling` when the
 * call goes on the wire. A non-stream answer settles it to `success` or
 * `failed`; a stream first moves it to `streaming` (the provider answered 2xx
 * and the body is still arriving) and settles it to `success` or `failed` when
 * the stream ends. The order only ever moves forward, and no later attempt can
 * touch it.
 */
export const ATTEMPT_STATES = Object.freeze({
  CALLING: "calling",
  STREAMING: "streaming",
  SUCCESS: "success",
  FAILED: "failed"
});

/**
 * In-flight requests are kept apart from completed ones (`entries`), so
 * analytics, the model catalogue and the Requests page never see a request
 * that has not finished. A request that never reports back is dropped after
 * this long, and the set is capped, so a leak cannot grow without bound.
 */
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;

/**
 * The phases a recorded attempt may carry. This mirrors the vocabulary in
 * fallback-plan.js by value; a phase that is not listed here is stored as null,
 * so the two must be changed together.
 */
const PHASES = ["sticky", "chain", "auto", "manual-selection", "health-fallback", "manual-retry", "health-retry"];
const pad = (value) => String(value).padStart(6, "0");

/**
 * Routing diagnostics that are safe to store: capability ids are a fixed
 * vocabulary and exclusions are fixed reason labels plus provider/model ids.
 * Nothing here can carry a body, a header or a credential.
 */
const MAX_EXCLUSIONS = 50;
const MAX_REQUIREMENTS = 20;
const SAFE_TOKEN = /^[A-Za-z0-9_.:/-]{1,120}$/;

function capabilityList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && /^[a-z_]{2,40}$/.test(item)))].slice(0, MAX_REQUIREMENTS);
}

function exclusionList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_EXCLUSIONS).map((item) => ({
    provider: typeof item?.provider === "string" && SAFE_TOKEN.test(item.provider) ? item.provider : null,
    model: typeof item?.model === "string" && SAFE_TOKEN.test(item.model) ? item.model : null,
    reason: typeof item?.reason === "string" && /^[a-z_]{2,60}$/.test(item.reason) ? item.reason : "excluded",
    missing: capabilityList(item?.missing)
  }));
}


/**
 * Client-side protocol vs. the protocol actually spoken upstream. `translated`
 * (a bridge converted the request/response) is taken from the caller when it
 * says so, otherwise derived from the two protocols differing.
 */
const protocolName = (value) => (typeof value === "string" && SAFE_TOKEN.test(value) ? value : null);

function bridgeFields(clientProtocol, upstreamProtocol, translated) {
  const client = protocolName(clientProtocol);
  const upstream = protocolName(upstreamProtocol);
  const bridged = typeof translated === "boolean" ? translated : (client !== null && upstream !== null && client !== upstream);
  return { clientProtocol: client, bridged, bridge: bridged && client && upstream ? `${client} -> ${upstream}` : null };
}

/**
 * The allow-listed, request-independent part of one attempt row. Identity
 * (`attemptId`, `attemptSeq`, `callIndex`) is added by the log, never by the
 * caller's position in an array.
 */
const EFFORT_LABELS = new Set(["low", "medium", "high", "xhigh"]);
const normalizeEffort = (value) => (EFFORT_LABELS.has(value) ? value : null);

function plainAttempt(attempt, index) {
  return {
    index: index + 1,
    attemptId: typeof attempt?.attemptId === "string" && attempt.attemptId ? attempt.attemptId : null,
    // "sticky" | "chain" | "auto" | "manual-selection" | "health-fallback" | "manual-retry" | "health-retry" | null (older callers); and whether this row was
    // skipped without a network call (cooldown / already attempted).
    phase: PHASES.includes(attempt?.phase) ? attempt.phase : null,
    skipped: attempt?.skipped === true,
    skipReason: attempt?.skipped === true && typeof attempt?.skipReason === "string" ? attempt.skipReason : null,
    provider: attempt?.provider ?? null,
    model: attempt?.model ?? null,
    keyIndex: Number.isInteger(attempt?.keyIndex) ? attempt.keyIndex : null,
    effort: normalizeEffort(attempt?.effort),
    protocol: attempt?.protocol ?? null,
    translated: typeof attempt?.translated === "boolean" ? attempt.translated : null,
    // A skipped attempt never reached the network; only real attempts count
    // toward the fallback total the UI shows.
    ok: attempt?.ok === true,
    status: Number.isInteger(attempt?.status) ? attempt.status : null,
    startedAt: Number.isFinite(attempt?.startedAt) ? attempt.startedAt : null,
    completedAt: Number.isFinite(attempt?.completedAt) ? attempt.completedAt : null,
    latencyMs: Number.isFinite(attempt?.latencyMs) ? attempt.latencyMs : null,
    errorMessage: sanitizeMessage(attempt?.errorMessage),
    // What the provider reported for THIS attempt only; null (never 0) when it reported nothing.
    ...normalizeUsage(attempt)
  };
}

/**
 * Bounded, in-memory record of routed requests.
 *
 * Bounded because the gateway is long-running: an unbounded log would grow
 * without limit and eventually take the process down. The oldest entry is
 * evicted once `maxEntries` is reached, which is the right trade-off for an
 * operational view (recent history beats complete history for debugging).
 *
 * The stored shape is an explicit allow-list, in the same defensive style as
 * `HealthRegistry.describe`: request bodies, upstream bodies, headers and
 * credentials are never copied in, so they cannot leak later even if the
 * upstream error text contained them.
 */
export class RequestLog {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES, maxAttemptEvents = maxEntries * 4 } = {}) {
    this.maxEntries = maxEntries;
    this.maxAttemptEvents = maxAttemptEvents;
    this.entries = new Map();
    this.pendingEntries = new Map();
    this.sequence = 0;
    this.listeners = new Set();

    // Identity. A request id names one client request; an attempt id names one
    // real upstream call. Both come from this log only, from counters that never
    // repeat, so nothing about a target (provider/model/key) or a session can
    // ever stand in for them. The boot id keeps ids from a previous process
    // from colliding with this one's.
    this.bootId = randomBytes(3).toString("hex");
    this.requestCounter = 0;
    this.attemptSequence = 0;
    /** attemptId -> frozen attempt event, oldest first (insertion order). */
    this.attemptEvents = new Map();
  }

  #mintRequestId() {
    this.requestCounter += 1;
    return `req-${this.bootId}-${pad(this.requestCounter)}`;
  }

  #mintAttempt() {
    this.attemptSequence += 1;
    return { attemptSeq: this.attemptSequence, attemptId: `att-${this.bootId}-${pad(this.attemptSequence)}` };
  }

  /**
   * Store a new snapshot of one attempt and announce it. Snapshots are frozen:
   * a listener can hold one, and a later state of the same attempt is a new
   * object, never a mutation of the old one.
   */
  #putAttemptEvent(event) {
    const frozen = Object.freeze({ ...event });
    this.attemptEvents.set(frozen.attemptId, frozen);
    while (this.attemptEvents.size > this.maxAttemptEvents) {
      this.attemptEvents.delete(this.attemptEvents.keys().next().value);
    }
    this.#emit("attempt", frozen);
    return frozen;
  }

  /**
   * Be told the moment a request starts, moves, or finishes, so a live view can
   * be pushed to instead of polled. The listener gets `{ type, entry }` where
   * `type` is "pending" (a running request, as `pending()` lists it) or "entry"
   * (a completed one, as `list()` returns it). It is called synchronously, so it
   * must serialize `entry` before returning rather than hold on to it: pending
   * entries are updated in place. A throwing listener never affects the request.
   * Returns the function that unsubscribes.
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  #emit(type, entry) {
    for (const listener of this.listeners) {
      try { listener({ type, entry }); } catch { /* observability only */ }
    }
  }

  /** Drop a pending request; an attempt it left on the wire can no longer finish. */
  #dropPending(key) {
    const entry = this.pendingEntries.get(key);
    this.pendingEntries.delete(key);
    const open = entry?.inflight?.attemptId;
    if (open) this.finishAttempt(open, { ok: false, errorMessage: "request abandoned before the attempt answered" });
  }

  #prunePending(now = Date.now()) {
    for (const [key, entry] of this.pendingEntries) {
      if (now - (entry.receivedAt ?? now) > PENDING_TTL_MS) this.#dropPending(key);
    }
    while (this.pendingEntries.size > MAX_PENDING) {
      this.#dropPending(this.pendingEntries.keys().next().value);
    }
  }

  /**
   * Turn the attempts a caller reports into rows that carry identity. A real
   * attempt keeps the id it was given when it went on the wire; one reported
   * without an id (older callers) is given a fresh one, once, and recorded as
   * an already-finished event. A skipped target never reached the network, so it
   * is not an attempt and has no id. Whatever state an attempt event has already
   * reached is final and wins over anything re-reported later.
   */
  #normalizeAttempts(list, ctx, previous = []) {
    let calls = 0;
    return (Array.isArray(list) ? list : []).map((raw, index) => {
      const row = plainAttempt(raw, index);
      row.requestId = ctx.requestId;
      row.requestSeq = ctx.requestSeq;
      Object.assign(row, bridgeFields(ctx.protocol, row.protocol ?? ctx.protocol, row.translated));
      delete row.translated;

      if (row.skipped) return { ...row, attemptId: null, attemptSeq: null, callIndex: null };

      calls += 1;
      // Same position in a later report of the same list is the same attempt.
      const reused = previous[index];
      if (!row.attemptId && reused && !reused.skipped) row.attemptId = reused.attemptId ?? null;

      let event = row.attemptId ? this.attemptEvents.get(row.attemptId) : null;
      if (!row.attemptId) {
        const { attemptSeq, attemptId } = this.#mintAttempt();
        row.attemptId = attemptId;
        event = this.#putAttemptEvent({
          attemptId,
          attemptSeq,
          requestId: ctx.requestId,
          requestSeq: ctx.requestSeq,
          sessionId: ctx.sessionId,
          requestedModel: ctx.requestedModel ?? null,
          protocol: row.protocol ?? ctx.protocol ?? null,
          clientProtocol: row.clientProtocol,
          bridged: row.bridged,
          bridge: row.bridge,
          phase: row.phase,
          callIndex: calls,
          provider: row.provider,
          model: row.model,
          keyIndex: row.keyIndex,
          effort: row.effort ?? null,
          state: row.ok ? ATTEMPT_STATES.SUCCESS : ATTEMPT_STATES.FAILED,
          ok: row.ok,
          status: row.status,
          startedAt: row.startedAt,
          completedAt: row.completedAt ?? (row.startedAt !== null && row.latencyMs !== null ? row.startedAt + row.latencyMs : null),
          latencyMs: row.latencyMs,
          errorMessage: row.errorMessage,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          tokens: row.tokens
        });
      } else if (event && event.state === ATTEMPT_STATES.CALLING) {
        event = this.finishAttempt(row.attemptId, row);
      }

      if (event) {
        row.attemptSeq = event.attemptSeq;
        row.callIndex = event.callIndex;
        row.state = event.state;
        row.ok = event.ok;
        row.status = event.status;
        row.startedAt = event.startedAt;
        row.completedAt = event.completedAt;
        row.latencyMs = event.latencyMs;
        if (event.streamStartedAt !== undefined) row.streamStartedAt = event.streamStartedAt;
        if (event.streamMs !== undefined) row.streamMs = event.streamMs;
        row.errorMessage = event.errorMessage;
        // Usage belongs to the attempt event; a nested row never invents its own.
        row.inputTokens = event.inputTokens ?? null;
        row.outputTokens = event.outputTokens ?? null;
        row.tokens = event.tokens ?? null;
      } else {
        row.attemptSeq = null;
        row.callIndex = calls;
      }
      return row;
    });
  }

  /**
   * Register a request that has started but not finished, so a live view can
   * show it while it runs. Returns its `startSeq`; pass that as `pendingSeq`
   * to `record()` when the request completes and the pending entry is retired.
   * Same allow-list rule as `record()`: no bodies, headers or credentials.
   */
  begin(entry = {}) {
    this.sequence += 1;
    const startSeq = this.sequence;
    this.pendingEntries.set(startSeq, {
      startSeq,
      // `requestId` names this one request; `id` is the (sticky) session id the
      // client sees, which many requests can share.
      requestId: typeof entry.requestId === "string" && entry.requestId ? entry.requestId : this.#mintRequestId(),
      id: entry.id ?? null,
      receivedAt: Number.isFinite(entry.receivedAt) ? entry.receivedAt : Date.now(),
      protocol: entry.protocol ?? null,
      requestedModel: sanitizeMessage(entry.requestedModel, { maxLength: 120 }),
      // What this request needs, so a route that was not taken can be explained
      // without recording the payload.
      requiredCapabilities: capabilityList(entry.requiredCapabilities),
      excludedCandidates: exclusionList(entry.excludedCandidates),
      outcome: "pending",
      attempts: [],
      attemptCount: 0,
      fallbackCount: 0,
      attemptsStarted: 0,
      inflight: null
    });
    this.#prunePending();
    this.#emit("pending", this.pendingEntries.get(startSeq));
    return startSeq;
  }

  /**
   * Update a pending request: the attempts finished so far, and/or the attempt
   * currently on the wire (`inflight`, or `null` once it has answered).
   */
  progress(startSeq, { attempts, inflight, excludedCandidates } = {}) {
    const pending = this.pendingEntries.get(startSeq);
    if (!pending) return;
    if (attempts !== undefined) {
      pending.attempts = this.#normalizeAttempts(attempts, {
        requestId: pending.requestId, requestSeq: startSeq, sessionId: pending.id,
        protocol: pending.protocol, requestedModel: pending.requestedModel
      }, pending.attempts);
      const real = pending.attempts.filter((a) => !a.skipped).length;
      pending.attemptCount = real;
      pending.fallbackCount = Math.max(0, real - 1);
    }
    if (inflight !== undefined) {
      pending.inflight = inflight
        ? {
          attemptId: typeof inflight.attemptId === "string" ? inflight.attemptId : null,
          provider: inflight.provider ?? null,
          model: inflight.model ?? null,
          keyIndex: Number.isInteger(inflight.keyIndex) ? inflight.keyIndex : null,
          protocol: inflight.protocol ?? null,
          startedAt: Number.isFinite(inflight.startedAt) ? inflight.startedAt : null
        }
        : null;
    }
    if (excludedCandidates !== undefined) pending.excludedCandidates = exclusionList(excludedCandidates);
    this.#emit("pending", pending);
  }

  /**
   * ONE REAL UPSTREAM ATTEMPT = ONE NEW EVENT. Call this the moment a call goes
   * on the wire. It always creates a brand-new attempt, with a new `attemptId`,
   * whatever provider/model/key it targets and however many times that target
   * was called before. Returns the `attemptId` (or `null` when the request is
   * not being tracked); hand it to `finishAttempt` when the call answers.
   */
  startAttempt(startSeq, target = {}) {
    const pending = this.pendingEntries.get(startSeq);
    if (!pending) return null;

    const { attemptSeq, attemptId } = this.#mintAttempt();
    pending.attemptsStarted += 1;
    const startedAt = Number.isFinite(target.startedAt) ? target.startedAt : Date.now();
    const protocol = target.protocol ?? pending.protocol ?? null;

    this.#putAttemptEvent({
      attemptId,
      attemptSeq,
      requestId: pending.requestId,
      requestSeq: startSeq,
      sessionId: pending.id,
      requestedModel: pending.requestedModel,
      protocol,
      ...bridgeFields(pending.protocol, protocol, target.translated),
      phase: PHASES.includes(target.phase) ? target.phase : null,
      callIndex: pending.attemptsStarted,
      provider: target.provider ?? null,
      model: target.model ?? null,
      keyIndex: Number.isInteger(target.keyIndex) ? target.keyIndex : null,
      effort: normalizeEffort(target.effort),
      state: ATTEMPT_STATES.CALLING,
      ok: false,
      status: null,
      startedAt,
      completedAt: null,
      latencyMs: null,
      errorMessage: null,
      inputTokens: null,
      outputTokens: null,
      tokens: null
    });

    pending.inflight = {
      attemptId,
      provider: target.provider ?? null,
      model: target.model ?? null,
      keyIndex: Number.isInteger(target.keyIndex) ? target.keyIndex : null,
      protocol,
      bridged: bridgeFields(pending.protocol, protocol, target.translated).bridged,
      startedAt
    };
    this.#emit("pending", pending);
    return attemptId;
  }

  /**
   * Settle ONE attempt: `calling` becomes `success` or `failed`, once. The
   * result is a new frozen snapshot with the same `attemptId`; every other
   * attempt is untouched. An attempt that already has a final state keeps it
   * (the existing snapshot is returned unchanged), so a late or repeated report
   * can never rewrite history.
   */
  finishAttempt(attemptId, result = {}) {
    const current = this.attemptEvents.get(attemptId);
    if (!current || current.state !== ATTEMPT_STATES.CALLING) return current ?? null;

    const ok = result.ok === true;
    // A 2xx whose body is still streaming: the provider answered, the attempt
    // is not over. It stays open (no completedAt) until `completeAttempt`.
    const streaming = ok && result.streaming === true;
    const completedAt = Number.isFinite(result.completedAt) ? result.completedAt : Date.now();
    const latencyMs = Number.isFinite(result.latencyMs)
      ? result.latencyMs
      : (Number.isFinite(current.startedAt) ? Math.max(0, completedAt - current.startedAt) : null);

    const done = this.#putAttemptEvent({
      ...current,
      state: streaming ? ATTEMPT_STATES.STREAMING : ok ? ATTEMPT_STATES.SUCCESS : ATTEMPT_STATES.FAILED,
      ok,
      status: Number.isInteger(result.status) ? result.status : null,
      completedAt: streaming ? null : completedAt,
      // The moment the body started streaming in: the Live Logs card counts "streaming for N s" from here.
      ...(streaming ? { streamStartedAt: completedAt } : {}),
      latencyMs,
      errorMessage: sanitizeMessage(result.errorMessage),
      // Only usage the caller reports for THIS attempt id. A failed attempt that
      // reported nothing stays null; it can never inherit another attempt's figures.
      ...normalizeUsage(result)
    });

    const pending = this.pendingEntries.get(current.requestSeq);
    if (pending?.inflight?.attemptId === attemptId) pending.inflight = null;
    return done;
  }

  /**
   * Attach the usage a provider reported for ONE already-settled attempt.
   *
   * An attempt settles when the upstream answers (headers), but the figures can
   * only be read from the body, which arrives later (and for a stream, last). So
   * usage is the one thing a settled attempt may still gain, exactly once:
   * state, status and timing never change, an attempt that already carries usage
   * keeps it, and no other attempt is touched. Announced as a new `attempt`
   * snapshot with the same `attemptId`, like any other transition.
   */
  recordAttemptUsage(attemptId, usage = {}) {
    const current = this.attemptEvents.get(attemptId);
    if (!current || current.state === ATTEMPT_STATES.CALLING || current.state === ATTEMPT_STATES.STREAMING) return current ?? null;
    if (hasUsage(current)) return current;

    const reported = normalizeUsage(usage);
    if (!hasUsage(reported)) return current;

    const done = this.#putAttemptEvent({ ...current, ...reported });
    this.#syncAttemptUsage(done);
    return done;
  }

  /**
   * A streamed attempt ends: `streaming` becomes `success` (the stream ran to
   * its end) or `failed` (it was cut), once, and the usage the provider
   * reported over the whole stream lands in the SAME event, so the card turns
   * SUCCESS with its input / output / total tokens already on it. Anything that
   * is not currently `streaming` is left untouched.
   */
  completeAttempt(attemptId, result = {}) {
    const current = this.attemptEvents.get(attemptId);
    if (!current || current.state !== ATTEMPT_STATES.STREAMING) return current ?? null;

    const ok = result.ok === true;
    const completedAt = Number.isFinite(result.completedAt) ? result.completedAt : Date.now();
    const done = this.#putAttemptEvent({
      ...current,
      state: ok ? ATTEMPT_STATES.SUCCESS : ATTEMPT_STATES.FAILED,
      ok,
      completedAt,
      totalMs: Number.isFinite(current.startedAt) ? Math.max(0, completedAt - current.startedAt) : null,
      // How long the stream itself ran (from the first answer to its end), apart from the wait before it.
      streamMs: Number.isFinite(current.streamStartedAt) ? Math.max(0, completedAt - current.streamStartedAt) : null,
      errorMessage: ok ? current.errorMessage : sanitizeMessage(result.errorMessage ?? "stream ended before completion"),
      ...normalizeUsage(result)
    });
    this.#syncAttemptUsage(done);
    return done;
  }

  /** Mirror an attempt's usage into the request rows that already copied the attempt. */
  #syncAttemptUsage(event) {
    const apply = (rows) => {
      for (const row of rows ?? []) {
        if (row?.attemptId === event.attemptId) {
          row.state = event.state;
          row.ok = event.ok;
          row.completedAt = event.completedAt;
          if (event.streamStartedAt !== undefined) row.streamStartedAt = event.streamStartedAt;
          if (event.streamMs !== undefined) row.streamMs = event.streamMs;
          row.errorMessage = event.errorMessage;
          row.inputTokens = event.inputTokens;
          row.outputTokens = event.outputTokens;
          row.tokens = event.tokens;
        }
      }
    };
    apply(this.pendingEntries.get(event.requestSeq)?.attempts);
    for (const entry of this.entries.values()) {
      if (entry.startSeq === event.requestSeq) apply(entry.attempts);
    }
  }

  /**
   * Attempt events, oldest first: the order the upstream calls were made.
   * `afterSeq` resumes after an attempt; `limit` keeps the newest N matches.
   * These are the very same events the live stream pushes as `attempt`.
   */
  listAttempts({ limit = 200, afterSeq = 0, requestId = null, state = null, provider = null } = {}) {
    const size = Math.max(1, Math.min(Number(limit) || 200, this.maxAttemptEvents));
    const after = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0;
    const filtered = [...this.attemptEvents.values()].filter((event) => {
      if (event.attemptSeq <= after) return false;
      if (requestId && event.requestId !== requestId) return false;
      if (state && event.state !== state) return false;
      if (provider && event.provider !== provider) return false;
      return true;
    });
    const entries = filtered.length > size ? filtered.slice(filtered.length - size) : filtered;
    return { entries, returned: entries.length, matched: filtered.length, total: this.attemptEvents.size };
  }

  /** Requests currently in flight, oldest first. */
  pending() {
    this.#prunePending();
    return [...this.pendingEntries.values()];
  }

  get size() {
    return this.entries.size;
  }

  /** Evict oldest-first by insertion order, which Map preserves. */
  #trim() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  /**
   * Store one completed request. `id` is caller-supplied so the id already
   * returned to the client in `x-multi-ai-session-id` can be reused as the
   * request id, keeping the UI and the wire in agreement.
   */
  record(entry = {}) {
    this.sequence += 1;

    const startSeq = Number.isInteger(entry.pendingSeq) ? entry.pendingSeq : null;
    const pending = startSeq !== null ? this.pendingEntries.get(startSeq) ?? null : null;
    const requestId = pending?.requestId
      ?? (typeof entry.requestId === "string" && entry.requestId ? entry.requestId : this.#mintRequestId());
    const requestSeq = startSeq ?? this.sequence;

    const attempts = this.#normalizeAttempts(entry.attempts, {
      requestId, requestSeq, sessionId: entry.id ?? pending?.id ?? null,
      protocol: entry.protocol ?? pending?.protocol ?? null,
      requestedModel: sanitizeMessage(entry.requestedModel ?? pending?.requestedModel, { maxLength: 120 })
    }, pending?.attempts);

    // A request that ends while a call is still on the wire: that call can
    // never answer now, so settle it rather than leave it `calling` forever.
    const open = pending?.inflight?.attemptId;
    if (open) {
      this.finishAttempt(open, { ok: false, errorMessage: entry.errorMessage ?? "request ended before the attempt answered" });
    }
    // Same for a stream that never reported its end.
    for (const row of attempts) {
      if (row.attemptId && this.attemptEvents.get(row.attemptId)?.state === ATTEMPT_STATES.STREAMING) {
        this.completeAttempt(row.attemptId, { ok: false, errorMessage: entry.errorMessage ?? "request ended before the stream finished" });
        row.state = ATTEMPT_STATES.FAILED;
        row.ok = false;
      }
    }
    if (startSeq !== null) this.pendingEntries.delete(startSeq);

    const stored = {
      seq: this.sequence,
      // Order the request *began* in. Equals `seq` for a request that was never
      // registered as pending, so it is a stable key for a live view either way.
      startSeq: startSeq ?? this.sequence,
      requestId,
      id: entry.id ?? null,
      receivedAt: entry.receivedAt ?? null,
      completedAt: entry.completedAt ?? null,
      protocol: entry.protocol ?? null,
      requestedModel: sanitizeMessage(entry.requestedModel, { maxLength: 120 }),
      // The request's capability requirements and the candidates routing ruled
      // out (and why). Fixed vocabulary only; never a body or a credential.
      requiredCapabilities: entry.requiredCapabilities !== undefined
        ? capabilityList(entry.requiredCapabilities)
        : (pending?.requiredCapabilities ?? []),
      excludedCandidates: entry.excludedCandidates !== undefined
        ? exclusionList(entry.excludedCandidates)
        : (pending?.excludedCandidates ?? []),
      autoRouted: entry.autoRouted === true,
      streamed: entry.streamed === true,
      attempts,
      attemptCount: attempts.filter((a) => !a.skipped).length,
      fallbackCount: Math.max(0, attempts.filter((a) => !a.skipped).length - 1),
      // Did the answering (last real) attempt go through a protocol bridge?
      bridged: attempts.filter((a) => !a.skipped).at(-1)?.bridged === true,
      upstreamProtocol: attempts.filter((a) => !a.skipped).at(-1)?.protocol ?? null,
      finalProvider: entry.finalProvider ?? null,
      finalModel: entry.finalModel ?? null,
      finalKeyIndex: Number.isInteger(entry.finalKeyIndex) ? entry.finalKeyIndex : null,
      httpStatus: Number.isInteger(entry.httpStatus) ? entry.httpStatus : null,
      latencyMs: Number.isFinite(entry.latencyMs) ? entry.latencyMs : null,
      totalMs: Number.isFinite(entry.totalMs) ? entry.totalMs : null,
      bytes: Number.isFinite(entry.bytes) ? entry.bytes : null,
      tokens: Number.isFinite(entry.tokens) ? entry.tokens : null,
      finishReason: sanitizeMessage(entry.finishReason, { maxLength: 60 }),
      errorType: entry.errorType ?? null,
      errorMessage: sanitizeMessage(entry.errorMessage),
      outcome: entry.outcome === OUTCOMES.FAILED ? OUTCOMES.FAILED : OUTCOMES.SUCCESS
    };

    this.entries.set(this.#keyOf(stored), stored);
    this.#trim();
    this.#emit("entry", stored);
    return stored;
  }

  /**
   * Entries are keyed by a synthetic monotonic key rather than by `id`, so a
   * request with no id (or a duplicated id) still occupies its own slot.
   */
  #keyOf(entry) {
    return `${entry.seq}`;
  }

  get(seq) {
    const key = String(seq);
    return this.entries.get(key) ?? null;
  }

  /** Look an entry up by its client-visible request id. */
  findById(id) {
    const wanted = String(id ?? "");
    if (!wanted) return null;
    for (const entry of this.entries.values()) {
      if (entry.id === wanted) return entry;
    }
    return null;
  }

  /**
   * Newest-first, cursor-paginated listing.
   *
   * The cursor is the `seq` to resume *after*, so a client paging with
   * `nextCursor` never sees a shifting window: new requests arriving
   * mid-pagination have higher sequence numbers and cannot reorder the page.
   */
  list({ limit = 50, cursor = null, status = null, provider = null, protocol = null, outcome = null } = {}) {
    const size = Math.max(1, Math.min(Number(limit) || 50, this.maxEntries));

    // `Number(null)` is 0, which would match every sequence number and return
    // an empty page. Only a real cursor value constrains the window.
    const hasCursor = cursor !== null && cursor !== undefined && cursor !== "";
    const after = hasCursor ? Number(cursor) : NaN;

    const all = [...this.entries.values()].reverse();
    const filtered = all.filter((entry) => {
      if (Number.isFinite(after) && entry.seq >= after) return false;
      if (outcome && entry.outcome !== outcome) return false;
      if (protocol && entry.protocol !== protocol) return false;
      if (provider && entry.finalProvider !== provider) return false;
      if (status && String(entry.httpStatus) !== String(status)) return false;
      return true;
    });

    const entries = filtered.slice(0, size);
    const last = entries.at(-1);
    const nextCursor = filtered.length > size && last ? last.seq : null;

    return {
      entries,
      returned: entries.length,
      matched: filtered.length,
      total: this.entries.size,
      nextCursor
    };
  }

  /**
   * Forget everything that has finished, for the Live Logs "Clear" button.
   * Requests and attempts still running are kept, so they can finish normally.
   * The counters are never reset, so cleared sequence numbers are not reused.
   * Announces `cleared` so every open Live Logs view empties too.
   */
  clearCompleted() {
    const cleared = this.entries.size;
    this.entries.clear();
    for (const [attemptId, event] of this.attemptEvents) {
      if (event.state !== ATTEMPT_STATES.CALLING) this.attemptEvents.delete(attemptId);
    }
    this.#emit("cleared", { cleared, sequence: this.sequence });
    return cleared;
  }

  clear() {
    this.entries.clear();
    this.pendingEntries.clear();
    this.attemptEvents.clear();
  }
}

export const requestLog = new RequestLog();
