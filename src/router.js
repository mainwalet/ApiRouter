import { HealthRegistry } from "./health.js";
import { TARGET_RETRY_ALLOWANCE } from "./fallback-plan.js";

const DEFAULT_RETRY_STATUS_CODES = new Set([401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

// Sessions are keyed by a client-supplied header, so the store must be bounded:
// an unbounded map would grow without limit on a long-running gateway.
const DEFAULT_MAX_SESSIONS = 10000;

/**
 * How far a failure reaches.
 *
 * This is the distinction that keeps one bad model from taking out its
 * siblings: a failure that names the model cools THAT target down, while a
 * failure that describes the credential or the account cools every model
 * sharing that key. Getting it wrong in either direction is expensive — too
 * narrow and a dead key is retried once per model, too wide and one withdrawn
 * model disables a provider's whole catalogue.
 */
export const FAILURE_SCOPE = Object.freeze({
  TARGET: "target",
  KEY: "key",
  PROVIDER: "provider"
});

// These statuses describe the API key / account rather than the request.
// `describeFailure` decides how far each one reaches: a 401, or a 402/403 whose
// message positively names a dead/expired/suspended credential or an empty
// balance, is key-scoped; a 402/403 that names a model or budget pool, or says
// nothing useful, stays on the one key + model tried. A provider adapter can
// still set `error.scope` to override either way.
const KEY_LEVEL_STATUS_CODES = new Set([401, 402, 403]);

// These describe the request or the model rather than the credential or the
// provider, and must never reach a sibling: a withdrawn model (404) or a
// request this model cannot accept (400, 413, 422) says nothing about the
// other models on the same key.
const MODEL_LEVEL_STATUS_CODES = new Set([400, 404, 413, 422]);

// Wording that says the shared credential or account itself is the problem. It
// is checked first, so a message that mentions both an account problem and a
// model/pool never gets narrowed to one target.
const SHARED_CREDENTIAL_MESSAGE = /\b(invalid|incorrect|expired|revoked|missing|disabled|suspended|banned|deactivated)\b[^.\n]{0,40}\b(api[ _-]?key|token|credential|account)\b|\b(api[ _-]?key|token|credential|account)\b[^.\n]{0,40}\b(invalid|incorrect|expired|revoked|disabled|suspended|banned|deactivated)\b|\binsufficient\b[^.\n]{0,30}\b(balance|credits?|funds)\b|\b(account|credit) balance\b|\bbilling\b/i;

// Wording that says the limit belongs to one budget pool or one model rather
// than to the whole key: a pool is selected per model, so another model on the
// same key can still be served from a different pool.
const TARGET_SCOPED_MESSAGE = [
  [/\bbudget pools?\b/i, "budget pool exhausted"],
  [/\b(do(?:es)? not|don't|doesn't|no) (?:have )?(?:access|permission)[^.\n]{0,30}\bmodel\b/i, "no access to this model"],
  [/\bmodel\b[^.\n]{0,60}\b(?:not (?:allowed|available|enabled|permitted|authori[sz]ed)|restricted|forbidden)\b/i, "model not permitted"],
  [/\b(?:quota|limit|budget)\b[^.\n]{0,40}\b(?:for|on) (?:the |this |requested )*model\b/i, "model quota exhausted"]
];

// Only these statuses are ever narrowed by message. 401 is always the
// credential, whatever the text says.
const MESSAGE_NARROWABLE_STATUS_CODES = new Set([402, 403]);

/**
 * Classifies a failed attempt and says why, from the metadata available.
 *
 * Returns `{ scope, kind }`; `kind` is a short fixed label (never upstream text,
 * which can carry anything and must not reach `/health`) set only when the
 * message was positive evidence that narrowed a key-level status to one target.
 */
export function describeFailure(status, error = null) {
  const explicit = error?.scope;
  if (explicit === FAILURE_SCOPE.KEY || explicit === FAILURE_SCOPE.PROVIDER || explicit === FAILURE_SCOPE.TARGET) {
    return { scope: explicit, kind: null };
  }
  const code = Number(status);
  if (KEY_LEVEL_STATUS_CODES.has(code)) {
    // 401 is always the credential: no model or pool changes whether the key is
    // valid, so it cools every model sharing the key.
    if (code === 401) return { scope: FAILURE_SCOPE.KEY, kind: null };
    if (MESSAGE_NARROWABLE_STATUS_CODES.has(code) && typeof error?.message === "string") {
      const text = error.message;
      // Positive evidence of a shared credential/account problem (invalid or
      // expired key, suspended account, no balance) is key-wide.
      if (SHARED_CREDENTIAL_MESSAGE.test(text)) return { scope: FAILURE_SCOPE.KEY, kind: null };
      // Positive evidence of a per-model / per-pool limit stays on one target.
      for (const [pattern, kind] of TARGET_SCOPED_MESSAGE) {
        if (pattern.test(text)) return { scope: FAILURE_SCOPE.TARGET, kind };
      }
    }
    // A bare 402/403 ("Forbidden") is ambiguous: take the narrow answer, which
    // can only cost a retry, never disable a healthy sibling model.
    return { scope: FAILURE_SCOPE.TARGET, kind: null };
  }
  return { scope: FAILURE_SCOPE.TARGET, kind: null };
}

/**
 * Classifies a failed attempt from the metadata actually available.
 *
 * A provider adapter that can read the upstream error body may state the scope
 * outright (`error.scope`); that wins, because it is the provider's own account
 * of what went wrong. Otherwise the status code decides — except that a 402/403
 * whose message shows the limit is a budget pool's or a model's, not the key's,
 * is target-scoped. Anything unrecognised is treated as target-scoped — the
 * narrow answer, which can only cost a retry, never a needlessly disabled model
 * — except 401 (always key-level) and a 402/403 whose message positively names
 * a shared credential or account problem (key-level).
 */
export function classifyFailure(status, error = null) {
  return describeFailure(status, error).scope;
}

/**
 * A failure that says "not right now" rather than "not this request / not this
 * credential": a timeout, rate limit, server error, or a call that never got an
 * HTTP answer at all. Only these are worth a retry in the Manual <-> Health
 * alternation. Everything else (400/404/413/422 about the request or model, 401/402/403
 * about the credential) would simply fail the same way again.
 */
function isTransientStatus(status) {
  const code = Number(status) || 0;
  return code === 0 || code === 408 || code === 425 || code === 429 || code >= 500;
}

const SIZE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

// Sibling keys of a model that answered 503 are left alone for a short while.
const MODEL_UNAVAILABLE_COOLDOWN_MS = 60 * 1000;
// Gemini statuses that hit every key of a model alike (overloaded / loop / timeout).
const MODEL_WIDE_GEMINI_STATUSES = new Set([503, 508, 408]);

// A 408 is a timeout (this router's own, or an upstream's). It says the call was
// slow right now, not that the provider is down, so cool the target down
// briefly instead of for the full 12 minute default. Otherwise one slow network
// moment puts every provider and model into cooldown at once.
const TIMEOUT_COOLDOWN_MS = 60 * 1000;

// A 400 from upstream puts that model on a fixed 8 minute cooldown, so the
// router stops sending it requests it keeps rejecting and falls through to the
// next target instead.
const BAD_REQUEST_COOLDOWN_MS = 8 * 60 * 1000;

// A 429 is a rate limit on THIS key + model. It normally clears within a minute
// (per-minute quotas), so it must not park the key for the full 12 minute
// default. The upstream's own `Retry-After` wins when it sent one; otherwise
// a short fixed cooldown applies. The other keys of the same model are
// separate targets and keep being tried.
export const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
export const RATE_LIMIT_MIN_COOLDOWN_MS = 5 * 1000;
export const RATE_LIMIT_MAX_COOLDOWN_MS = 12 * 60 * 1000;

// A quota that resets once a day or once a month is not a per-minute rate limit:
// asking again a minute later cannot succeed, it only burns a call (and, with
// many keys and models, a request's worth of time). These get a cooldown that
// matches the window instead of RATE_LIMIT_COOLDOWN_MS.
export const QUOTA_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const MONTHLY_QUOTA_RECHECK_MS = 6 * 60 * 60 * 1000;
const QUOTA_RESET_BUFFER_MS = 60 * 1000;

const DAILY_QUOTA_MESSAGE = /per[- _]?day|\bdaily\b|\bper day\b|"code"\s*:\s*4006\b|\bcode["']?\s*[:=]\s*4006\b/i;
const MONTHLY_QUOTA_MESSAGE = /per[- _]?month|\/\s*month\b|\bmonthly\b|\bper month\b/i;
// Providers that say WHEN the quota resets put it in the body as an epoch
// (seconds or milliseconds), e.g. OpenRouter's X-RateLimit-Reset.
const RESET_EPOCH = /x-ratelimit-reset["']?\s*[:=]\s*["']?(\d{10,13})\b/i;

const nextUtcMidnight = (now) => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
};

/**
 * Recognises a 429 that is a daily or monthly quota (not a per-minute rate
 * limit) and says how long to leave the target alone.
 *
 * Returns `{ cooldownMs, kind }` or `null` when the 429 is an ordinary rate
 * limit, in which case the caller keeps the short cooldown. Only the wording and
 * a reset time the upstream itself reported are used; nothing is guessed from
 * the status alone.
 *
 *   daily    until the reset the upstream reported, else the next 00:00 UTC
 *   monthly  re-checked every MONTHLY_QUOTA_RECHECK_MS (a cheap single call)
 *
 * Capped at QUOTA_MAX_COOLDOWN_MS so a wrong guess can park a target for at
 * most a day.
 */
export function quotaCooldown(status, error = null, now = Date.now()) {
  if (Number(status) !== 429) return null;
  const text = typeof error?.message === "string" ? error.message : "";
  if (!text) return null;

  const daily = DAILY_QUOTA_MESSAGE.test(text);
  const monthly = !daily && MONTHLY_QUOTA_MESSAGE.test(text);
  if (!daily && !monthly) return null;

  let resetAt = null;
  const match = RESET_EPOCH.exec(text);
  if (match) {
    const raw = Number(match[1]);
    const epochMs = match[1].length <= 10 ? raw * 1000 : raw;
    if (Number.isFinite(epochMs) && epochMs > now) resetAt = epochMs;
  }

  let cooldownMs;
  if (resetAt !== null) cooldownMs = resetAt - now + QUOTA_RESET_BUFFER_MS;
  else if (daily) cooldownMs = nextUtcMidnight(now) - now + QUOTA_RESET_BUFFER_MS;
  else cooldownMs = MONTHLY_QUOTA_RECHECK_MS;

  return {
    kind: daily ? "daily" : "monthly",
    cooldownMs: Math.min(Math.max(cooldownMs, RATE_LIMIT_COOLDOWN_MS), QUOTA_MAX_COOLDOWN_MS)
  };
}

function rateLimitCooldownMs(error) {
  const retryAfterMs = Number(error?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(Math.max(retryAfterMs, RATE_LIMIT_MIN_COOLDOWN_MS), RATE_LIMIT_MAX_COOLDOWN_MS);
  }
  return RATE_LIMIT_COOLDOWN_MS;
}

/**
 * Parses an HTTP `Retry-After` header value (delta-seconds or an HTTP date)
 * into milliseconds from `now`, or `null` when it is absent or unusable.
 */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000;
    return ms > 0 ? ms : null;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  const ms = at - now;
  return ms > 0 ? ms : null;
}

/** `markFailure` options for a failed attempt: short cooldowns for transient statuses. */
function cooldownOptions(status, error = null) {
  if (status === 400) return { cooldownMs: BAD_REQUEST_COOLDOWN_MS };
  if (status === 413) return { cooldownMs: SIZE_LIMIT_COOLDOWN_MS };
  if (status === 408) return { cooldownMs: TIMEOUT_COOLDOWN_MS };
  if (status === 429) {
    const quota = quotaCooldown(status, error);
    if (quota) return { cooldownMs: quota.cooldownMs, quotaKind: quota.kind };
    return { cooldownMs: rateLimitCooldownMs(error) };
  }
  // Any other client error (405, 410, 415, 422, 451 ...) most likely belongs to
  // this one request, so it must not park the key for the full 12 minutes. 401,
  // 402, 403 and 404 describe the key or the model and keep the default.
  if (status >= 400 && status < 500 && !KEY_LEVEL_STATUS_CODES.has(status) && status !== 404) {
    return { cooldownMs: CLIENT_ERROR_COOLDOWN_MS };
  }
  return {};
}

// Client errors with no dedicated rule: a short per key + model cooldown.
export const CLIENT_ERROR_COOLDOWN_MS = 60 * 1000;

// Statuses that say something about the key, the model or the moment rather than
// about the request. When every target fails with the same OTHER 4xx, that is
// the request's own fault and the client is told so, not given a 502.
const NOT_A_REQUEST_FAULT = new Set([401, 402, 403, 404, 408, 409, 425, 429]);

function sharedClientErrorStatus(failures) {
  if (failures.length === 0) return null;
  const status = failures[0].status;
  if (!(status >= 400 && status < 500) || NOT_A_REQUEST_FAULT.has(status)) return null;
  return failures.every((failure) => failure.status === status) ? status : null;
}

export function isRetryableStatus(status, retryableStatus = DEFAULT_RETRY_STATUS_CODES) {
  return retryableStatus.has(Number(status));
}

/** Insertion-ordered, least-recently-used bounded session store. */
export class SessionStore {
  constructor({ maxEntries = DEFAULT_MAX_SESSIONS } = {}) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  get size() {
    return this.entries.size;
  }

  get(key) {
    const existing = this.entries.get(key);
    if (existing === undefined) return null;
    // Re-insert so Map insertion order tracks recency.
    this.entries.delete(key);
    this.entries.set(key, existing);
    return existing;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, value);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }

    return value;
  }

  values() {
    return [...this.entries.values()];
  }
}

/** A remembered target stays preferred for 20 minutes after its last success. */
export const STICKY_TTL_MS = 20 * 60 * 1000;

/**
 * Per-session "remember last successful". Scoped by the caller's key (protocol
 * + session id).
 */
export class RouteSession {
  constructor({ targetId = null, expiresAt = null, ttlMs = STICKY_TTL_MS } = {}) {
    this.targetId = targetId;
    // Absolute deadline (ms epoch), checked at request time. No timer: nothing
    // keeps the process alive and an idle session costs nothing.
    this.expiresAt = Number.isFinite(expiresAt) ? expiresAt : null;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : STICKY_TTL_MS;
  }

  /**
   * The remembered target id, only while its TTL is active. An expired (or
   * never timestamped) target is cleared and reported as absent, so the request
   * walks the chain from its start and the stale target is never used again.
   */
  validTargetId(now = Date.now()) {
    if (!this.targetId) return null;
    if (this.expiresAt === null || !(now < this.expiresAt)) {
      this.clear();
      return null;
    }
    return this.targetId;
  }

  /** A success makes this target the remembered one and starts a fresh TTL. */
  saveSuccess(target, health, now = Date.now()) {
    this.targetId = health.key(target);
    this.expiresAt = now + this.ttlMs;
  }

  /** Forgets the remembered target. Used by Reset Fallback. */
  clear() {
    this.targetId = null;
    this.expiresAt = null;
  }
}

/**
 * Walks an explicit, already-ordered plan (see fallback-plan.js) sequentially.
 *
 * The order is authoritative: nothing is re-ranked. A model's eligible keys are
 * all tried, in key order, before the walk advances to the next model, and the
 * next model starts at its own first eligible key.
 *
 * Per request, a target (provider + model + keyIndex) is invoked at most
 * once; a repeat is reported through `onSkip`, never called. Targets cooling
 * down in the shared health registry are skipped the same way.
 *
 * The one exception is a step flagged `retry` (the later rounds of Manual Model
 * Selection, which alternates Manual -> Health -> Manual -> Health, see
 * fallback-plan.js). A retry is authorised per TARGET from per-request state,
 * never because another round began:
 *
 *   - a target is retried at most TARGET_RETRY_ALLOWANCE times per request;
 *   - a target this request never called is not "retried": it is walked as a
 *     first attempt, and only if it is available right now. A cooldown that
 *     existed when the request reached it is never overridden;
 *   - a target whose failure here was credential-level, provider-level,
 *     non-transient (400/401/402/403/404/413/422 ...) or opted out of health
 *     tracking is never retried: it would fail the same way again;
 *   - the one cooldown a retry looks past is the one THIS request put on the
 *     target through a transient, target-scoped failure (timeout, 429, 5xx,
 *     transport error), and only while it is still exactly that cooldown, so a
 *     health refresh or another request that touched it since is respected.
 *     Without that, every target that failed in the first round would be
 *     sitting in the cooldown that failure just created and no retry could
 *     happen. A retry success clears the cooldown; a retry failure starts a
 *     fresh one.
 *
 * Termination: every call either consumes the target's single first attempt or
 * one unit of its retry allowance, so the number of calls is bounded by
 * (1 + allowance) x the number of distinct targets, and a round in which no
 * target is authorised simply calls nothing.
 *
 * Every success is
 * recorded on the session as its remembered target when the selected mode
 * remembers one — the walker never edits the configured order, and the record
 * is per session, never global.
 */
export async function withFallback(
  targets,
  invoke,
  retryableStatus = DEFAULT_RETRY_STATUS_CODES,
  session = new RouteSession(),
  health = new HealthRegistry(),
  { plan: steps = null, onSkip = null, remember = true } = {}
) {
  const ordered = Array.isArray(steps) && steps.length > 0
    ? steps
    : (Array.isArray(targets) ? targets : []).map((target) => ({ target, phase: null }));

  if (ordered.length === 0) {
    const err = new Error("No fully configured routing targets available");
    err.status = 503;
    throw err;
  }

  const attempted = new Set();
  // Retry bookkeeping (see the `retry` rules above): how many retries each
  // target has used, and which targets must never be retried at all.
  const retries = new Map();
  const noRetry = new Set();
  const retrySkipReported = new Set();
  // target id -> the cooldownUntil THIS request set through a transient failure.
  const ownTransientCooldown = new Map();
  const cooldownReported = new Set();
  // Targets this request must not call because their model already failed model-wide. Kept
  // per request on purpose: a pinned request (the Playground) reports every target as
  // available, so a cooldown alone would not stop it.
  const modelWideSkip = new Set();
  const failures = [];
  // Unique targets only: a target can appear in more than one phase, and a
  // sibling must be marked failed once, not once per appearance.
  const allTargets = [...new Map(ordered.map((step) => [health.key(step.target), step.target])).values()];
  let eligible = 0;

  const skip = (step, reason) => {
    if (typeof onSkip === "function") onSkip(step.target, { phase: step.phase, reason });
  };

  for (const step of ordered) {
    const target = step.target;
    const id = health.key(target);

    // A retry step for a target this request has not called is a first attempt
    // that happens to sit in a later round; it gets no retry privileges.
    const isRetry = step.retry === true && attempted.has(id);
    if (isRetry) {
      const reason = retries.get(id) >= TARGET_RETRY_ALLOWANCE ? "already_retried" : noRetry.has(id) ? "not_retryable" : null;
      if (reason) {
        if (!retrySkipReported.has(id)) {
          retrySkipReported.add(id);
          skip(step, reason);
        }
        continue;
      }
    } else if (attempted.has(id)) {
      skip(step, "already_attempted");
      continue;
    }
    // The cooldown this request itself created by a transient failure does not
    // block a retry, as long as it is still exactly that cooldown.
    const ownCooldown = isRetry
      && ownTransientCooldown.has(id)
      && Number(health.get(id)?.cooldownUntil) === ownTransientCooldown.get(id);
    if (modelWideSkip.has(id)) {
      if (!cooldownReported.has(id)) {
        cooldownReported.add(id);
        skip(step, "model_unavailable");
      }
      continue;
    }
    if (!ownCooldown && !health.isAvailable(target)) {
      // A cooling target is skipped here; it may appear again later in the
      // plan, which is the same skip, not a retry.
      if (!cooldownReported.has(id)) {
        cooldownReported.add(id);
        skip(step, "cooldown");
      }
      continue;
    }

    eligible += 1;
    attempted.add(id);
    if (isRetry) retries.set(id, (retries.get(id) ?? 0) + 1);
    ownTransientCooldown.delete(id);
    const startedAt = Date.now();

    try {
      const result = await invoke(target, { phase: step.phase });
      health.markSuccess(target, { latencyMs: Date.now() - startedAt });
      if (remember) session.saveSuccess(target, health);
      return result;
    } catch (error) {
      const status = Number(error?.status || 0);
      failures.push({ target, status, message: error?.message || String(error) });

      // No upstream failure ends the request on its own: another key (or another
      // model) of the chain may well succeed where this one failed, whatever the
      // status. Only an error that says the request itself is over — the client
      // disconnected (`retryable === false`) — stops the walk. `retryableStatus`
      // is accepted for compatibility but no longer decides this.
      if (error?.retryable === false) throw error;

      // An error can opt out of health tracking entirely (skipCooldown). A
      // target that refused the request for its own reasons — an image it
      // cannot carry, say — is not unhealthy, so it is not cooled down, and it
      // is not retried either: the same request would be refused again.
      if (error?.skipCooldown) {
        noRetry.add(id);
        continue;
      }

      const { scope, kind } = describeFailure(status, error);
      const { quotaKind, ...cooldown } = cooldownOptions(status, error);
      // Only a transient, target-scoped failure is worth a second look. A daily
      // or monthly quota will not have reset by the time this request retries.
      if (scope !== FAILURE_SCOPE.TARGET || !isTransientStatus(status) || quotaKind) noRetry.add(id);
      // A failure narrowed to this target by its message carries a fixed,
      // non-upstream reason so the Models page can say why it is cooling down.
      health.markFailure(target, status, {
        ...cooldown,
        // Fixed labels only, never upstream text, so nothing sensitive reaches /health.
        ...(kind
          ? { reason: `${status} ${kind} on ${target.model}` }
          : quotaKind ? { reason: `429 ${quotaKind} quota exhausted on ${target.model}` } : {})
      });
      if (scope === FAILURE_SCOPE.TARGET) {
        if (isTransientStatus(status) && !quotaKind) {
          ownTransientCooldown.set(id, Number(health.get(id)?.cooldownUntil) || 0);
        }
        // A Gemini 503 / 508 / 408 means the MODEL is overloaded or hanging, which every key of it shares, so
        // trying the remaining keys of this model only burns time. Cool its sibling
        // keys down briefly so the walk moves straight on to the next model.
        if (MODEL_WIDE_GEMINI_STATUSES.has(status) && String(target.provider).toLowerCase() === "gemini") {
          const reason = `${status} on ${target.model} (model unavailable); other keys skipped`;
          for (const sibling of allTargets) {
            if (health.key(sibling) === id) continue;
            if (sibling.provider !== target.provider || sibling.model !== target.model) continue;
            if (attempted.has(health.key(sibling))) continue;
            modelWideSkip.add(health.key(sibling));
            health.markFailure(sibling, status, { cooldownMs: MODEL_UNAVAILABLE_COOLDOWN_MS, reason });
          }
        }
        continue;
      }

      // Key- and account-level failures describe the credential, so the sibling
      // models sharing it are cooled down too and this request stops burning
      // time on requests that are guaranteed to fail. Model-level failures
      // deliberately do NOT do this.
      const reason = `${status} on ${target.model} applies to the whole ${scope === FAILURE_SCOPE.PROVIDER ? "provider" : "key"}`;
      for (const sibling of allTargets) {
        if (health.key(sibling) === id) continue;
        if (sibling.provider !== target.provider) continue;
        if (scope === FAILURE_SCOPE.KEY && sibling.keyIndex !== target.keyIndex) continue;
        health.markFailure(sibling, status, { reason });
      }
    }
  }

  if (eligible === 0) {
    const err = new Error("No routing targets are currently available");
    err.status = 503;
    err.failures = [];
    throw err;
  }

  // Every target answered with the same client error (400, 422 ...): the request
  // itself is almost certainly invalid, so report that to the client instead of
  // masking it as a 502 gateway error.
  const clientStatus = sharedClientErrorStatus(failures);
  const err = new Error(clientStatus ? failures[failures.length - 1].message : "All routing targets failed");
  err.status = clientStatus ?? 502;
  err.failures = failures;
  throw err;
}
