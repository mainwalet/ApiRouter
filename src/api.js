import { CUSTOM_PROTOCOLS } from "./custom-playground.js";
import { createHash } from "node:crypto";
import { describeHealth, HEALTH_STATES } from "./health.js";
import { ONE_MODEL_MAX_COOLDOWN_MS, ONE_PROVIDER_MAX_MODELS, normalizeKeyId, oneModelKeyId } from "./one-model.js";
import { modelLatency, resetAutomaticOrderCache, routeOrder } from "./fallback-plan.js";
import {
  FALLBACK_MODE_INFO,
  FALLBACK_MODES,
  MAX_KEYS,
  activeEntries,
  allowedKeyIndexes,
  entryId,
  isKnownMode,
  normalizeEntries,
  remembersSuccess
} from "./fallback-chain.js";
import { readJsonBody } from "./adapters.js";
import { CAPABILITY_INFO, ADAPTER_CAPABILITIES, inferCapabilities } from "./model-capabilities.js";
import { MODEL_CONFIG_SCHEMA_VERSION, MODEL_PROTOCOLS } from "./model-config.js";
import { describeConfig, describeEnvironment } from "./observability/config-view.js";
import { describeRouting } from "./observability/router-preview.js";
import { servableProtocols } from "./observability/route-select.js";
import { describeSystem } from "./observability/system-info.js";
import {
  breakdown,
  classifyFailure,
  errorDistribution,
  modelCatalogue,
  providerRollup,
  resolveRange,
  series,
  summarizeHealth,
  summarizeRequests
} from "./observability/metrics.js";

/**
 * Read-only JSON API backing the control panel.
 *
 * Kept in its own module so `src/server.js` gains one mount point rather than
 * a second routing table. Every handler is a pure read over state that already
 * exists (`health.js`, `config.js`, the request log) — nothing here can change
 * routing, health or provider behaviour.
 *
 * Auth mirrors the proxy path exactly: the same `authorized(req)` predicate, so
 * enabling client auth protects the admin surface too.
 */

const JSON_TYPE = "application/json; charset=utf-8";

/**
 * Stable weak ETag so polling clients can use `If-None-Match`.
 *
 * `generatedAt` is excluded from the hash: it changes on every request, so
 * including it would make every conditional poll a miss and defeat the point.
 * Everything that actually describes gateway state stays in the hash.
 */
function stableKey(body) {
  if (body && typeof body === "object" && !Array.isArray(body) && "generatedAt" in body) {
    const { generatedAt, ...rest } = body;
    return JSON.stringify(rest);
  }
  return JSON.stringify(body);
}

function etagOf(body) {
  return `W/"${createHash("sha1").update(stableKey(body)).digest("hex").slice(0, 20)}"`;
}

function sendJson(req, res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);

  const headers = {
    "content-type": JSON_TYPE,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  };

  // Only 200s are cacheable; an error must never be pinned by an ETag.
  if (status === 200) {
    const etag = etagOf(body);
    headers.etag = etag;
    if (req.headers["if-none-match"] === etag) {
      return sendJsonRaw(res, 304, headers, "");
    }
  }

  return sendJsonRaw(res, status, headers, payload);
}

function sendJsonRaw(res, status, headers, payload) {
  res.writeHead(status, { ...headers, "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function fail(req, res, status, message, type, details = null) {
  const error = { message, type };
  // Optional machine-readable context, so the UI can offer the valid values
  // rather than only reporting that something was wrong.
  if (details) error.details = details;
  return sendJson(req, res, status, { error });
}

// ---------------------------------------------------------------------------

/** Live-stream clients allowed at once; each one is an open socket. */
const MAX_LIVE_STREAMS = 50;
const STREAM_HEARTBEAT_MS = 15_000;

export function createApi({
  config,
  targets,
  health,
  requestLog,
  monitor,
  gateway = null,
  effortState = null,
  refreshHealth,
  fallbackChain = null,
  modelSwitch = null,
  modelConfig = null,
  oneModel = null,
  keyPacer = null,
  resetFallbackState = null,
  describeFallbackState = null,
  clearRememberedTargets = null,
  customPlayground = null,
  customEndpoints = null,
  customModelDiscovery = null,
  providerModels = null,
  providerModelBaseline = null,
  providerModelDiscovery = null
}) {
  const liveStreams = new Set();

  /**
   * Server-sent events for Live Logs: the current state first (`snapshot`, the
   * same payload as `GET /api/requests`), then one event per change, written in
   * the same tick the request log changes, so a box appears with no polling
   * delay. Same auth as every other /api route (the caller has already passed it).
   */
  function openRequestStream(req, res, searchParams) {
    if (liveStreams.size >= MAX_LIVE_STREAMS) {
      return fail(req, res, 503, "Too many live streams", "unavailable");
    }

    res.socket?.setNoDelay?.(true);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff"
    });

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let closed = false;
    let unsubscribe = () => {};
    let heartbeat = null;
    const handle = { close };
    function close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      liveStreams.delete(handle);
      if (!res.writableEnded) res.end();
    }
    liveStreams.add(handle);
    req.on("close", close);
    res.on("close", close);
    res.on("error", close);

    // Subscribe before reading the snapshot, in the same tick, so no change can
    // fall between the two.
    unsubscribe = requestLog.subscribe(({ type, entry }) => send(type, entry));
    send("snapshot", {
      generatedAt: new Date().toISOString(),
      ...requestLog.list({ limit: searchParams.get("limit") }),
      pending: requestLog.pending(),
      // Every real upstream attempt as its own event, oldest first: the same
      // events the stream then pushes one by one as `attempt`.
      attempts: requestLog.listAttempts({ limit: searchParams.get("attemptLimit") }).entries
    });
    heartbeat = setInterval(() => res.write(": ping\n\n"), STREAM_HEARTBEAT_MS);
    heartbeat.unref?.();
    return undefined;
  }

  const describeAll = (now = Date.now()) => health.describe(targets, now);

  // Targets routing may actually use: models switched off in the Control Panel
  // or in the Model Configurator are removed, so every order shown by the API is
  // the order requests walk. True when the model is off on its own OR its whole
  // provider is off.
  const isSwitchedOff = (target) => Boolean(
    modelSwitch?.isDisabled?.(target.provider, target.model)
    || modelConfig?.explicitlyDisabled?.(target.provider, target.model)
  );
  const isProviderSwitchedOff = (provider) => Boolean(modelSwitch?.isProviderDisabled?.(provider));
  // With One Provider Fallback on, only the chosen provider's listed models are
  // ever routed, so every order the API shows is limited to them, as the proxy
  // path is.
  const oneModelActive = () => oneModel?.active?.() ?? null;
  const routableTargets = () => {
    const live = modelSwitch ? targets.filter((target) => !isSwitchedOff(target)) : targets;
    return oneModelActive() ? live.filter((target) => oneModel.matches(target)) : live;
  };

  // The chain store is the single source of truth for order and mode. These two
  // read it defensively so the API module stays usable when it is constructed
  // without one (a test harness, or a future embedder).
  const fallbackSnapshot = () => (fallbackChain ? fallbackChain.get() : []);
  const fallbackMode = () => fallbackChain?.mode ?? FALLBACK_MODES.AUTO;

  // --- /api/health -------------------------------------------------------
  function healthPayload(now = Date.now()) {
    const entries = describeAll(now);
    // The real route order, exactly as the saved selection produces it;
    // health only removes cooling targets. Not a health-score sort.
    const ranked = routeOrder(routableTargets(), {
      chain: fallbackSnapshot(),
      health,
      now,
      isEligible: (target) => health.isAvailable(target, now)
    });

    return {
      ok: true,
      generatedAt: new Date(now).toISOString(),
      service: "apirouter",
      summary: summarizeHealth(entries),
      providers: providerRollup(entries),
      targets: entries,
      ranked: ranked.map((target, index) => ({
        rank: index + 1,
        id: health.key(target),
        provider: target.provider,
        model: target.model,
        keyIndex: target.keyIndex,
        protocols: [...(target.protocols ?? [])]
      })),
      monitor: monitor ? monitor.snapshot(now) : null,
      retryableStatus: [...config.retryableStatus].sort((a, b) => a - b),
      states: Object.values(HEALTH_STATES)
    };
  }

  // --- /api/providers ----------------------------------------------------
  /**
   * The rollup a provider gets when it has no targets. Same shape as
   * `providerRollup`, so the UI renders one table for both.
   */
  const emptyRollup = (provider) => ({
    targets: 0,
    healthy: 0,
    cooldown: 0,
    failed: 0,
    unknown: 0,
    successes: 0,
    failures: 0,
    successRate: null,
    latencyMs: null,
    lastUpdatedAt: null,
    status: "unknown",
    models: provider.models,
    modelCount: provider.modelCount,
    protocols: provider.protocols,
    totalObservations: 0
  });

  function providersPayload(now = Date.now()) {
    const allEntries = describeAll(now);
    const rollup = providerRollup(allEntries);
    const configView = describeConfig(config, targets);
    const byId = new Map(configView.providers.map((provider) => [provider.id, provider]));

    const providers = configView.providers.map((provider) => {
      const healthRow = rollup.find((row) => row.provider === provider.id);
      return {
        ...provider,
        // Switched off from the Control Panel: none of its models are routed.
        disabled: isProviderSwitchedOff(provider.id),
        // Where the model list comes from: the provider's env variable, or a list
        // chosen on this page (Fetch Models). Custom endpoints have their own form.
        modelsEditable: Boolean(providerModels) && !provider.custom && Object.hasOwn(providerModelBaseline ?? {}, provider.id),
        modelsSource: providerModels?.has(provider.id) ? "panel" : "env",
        envModels: providerModelBaseline?.[provider.id] ? [...providerModelBaseline[provider.id]] : [],
        health: healthRow ?? emptyRollup(provider),
        // Per-target detail is what the provider drawer renders.
        targets: allEntries.filter((entry) => entry.provider === provider.id)
      };
    });

    // A provider can appear in health without appearing in config only if the
    // catalog and config disagree; surface that rather than silently dropping it.
    const orphans = rollup.filter((row) => !byId.has(row.provider));

    return {
      generatedAt: new Date(now).toISOString(),
      summary: {
        ...configView.summary,
        health: summarizeHealth(allEntries)
      },
      providers,
      unconfiguredHealth: orphans
    };
  }

  // --- /api/models -------------------------------------------------------
  function modelsPayload(now = Date.now()) {
    const entries = describeAll(now);
    // `disabled` is the effective state (the model's own switch OR its provider's),
    // so every key row of a model agrees. `providerDisabled` says when the
    // provider is the reason, because the model's own switch cannot undo that.
    const catalogue = modelCatalogue(entries, [...requestLog.entries.values()])
      .map((row) => ({
        ...row,
        disabled: isSwitchedOff(row),
        providerDisabled: isProviderSwitchedOff(row.provider)
      }));

    return {
      generatedAt: new Date(now).toISOString(),
      models: catalogue,
      filters: {
        providers: [...new Set(catalogue.map((model) => model.provider))].sort(),
        protocols: [...new Set(catalogue.flatMap((model) => model.protocols))].sort(),
        statuses: Object.values(HEALTH_STATES)
      },
      summary: summarizeHealth(entries)
    };
  }

  // --- /api/one-model (One Provider Fallback) -----------------------------
  function oneModelPayload(now = Date.now()) {
    const state = oneModel.get();
    const healthById = new Map(describeAll(now).map((entry) => [entry.id, entry]));

    // What can be chosen: one row per provider/model, with how many keys it has
    // and whether the Model Switch currently has it off.
    const groups = new Map();
    for (const target of targets) {
      const id = `${target.provider}/${target.model}`;
      const group = groups.get(id) ?? {
        provider: target.provider, model: target.model, keyCount: 0, disabled: isSwitchedOff(target)
      };
      group.keyCount += 1;
      groups.set(id, group);
    }
    const candidates = [...groups.values()]
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
      .map((group) => {
        const rank = group.provider === state.provider ? state.models.indexOf(group.model) : -1;
        // `selected` = in the chosen provider's list; `rank` is its place (1 = leads).
        return { ...group, selected: rank >= 0, rank: rank >= 0 ? rank + 1 : null };
      });

    const keys = targets
      .filter((target) => oneModel.matches(target))
      .sort((a, b) => oneModel.modelRank(a) - oneModel.modelRank(b) || a.keyIndex - b.keyIndex)
      .map((target) => {
        const entry = healthById.get(health.key(target));
        const pacing = keyPacer ? keyPacer.describe(target, now) : { cooldownUntil: 0, ready: true };
        return {
          provider: target.provider,
          model: target.model,
          // 1 = the model that leads; the next model is used when this one's keys all fail or cool.
          rank: oneModel.modelRank(target) + 1,
          keyIndex: target.keyIndex,
          // Id to use in `cooldowns`: "model::keyIndex".
          keyId: oneModelKeyId(target),
          // The cooldown the operator set on this key, in ms (0 = none).
          cooldownMs: oneModel.cooldownFor(target),
          ready: pacing.ready,
          cooldownUntil: pacing.cooldownUntil,
          status: entry?.status ?? "unknown",
          lastStatus: entry?.lastStatus ?? null,
          successes: entry?.successes ?? 0,
          failures: entry?.failures ?? 0,
          latencyMs: entry?.requestLatencyMs ?? entry?.latencyMs ?? null
        };
      });

    return {
      generatedAt: new Date(now).toISOString(),
      enabled: state.enabled,
      provider: state.provider || null,
      // The chosen models in priority order: the first leads.
      models: state.models,
      // True when requests are really being routed this way right now.
      active: Boolean(oneModel.active()),
      // True when every listed model is switched off in the Control Panel.
      switchedOff: state.models.length > 0
        && state.models.every((model) => Boolean(modelSwitch?.isDisabled?.(state.provider, model))),
      candidates,
      keys
    };
  }

  /**
   * Validates one entry's `keys` exactly as the operator sent it.
   *
   * `keys` is the one field where a lenient reading is dangerous: `null` means
   * EVERY key, so mistaking an unusable restriction for "no restriction" can
   * only widen routing. The store no longer makes that mistake on its own — an
   * unreadable persisted value normalizes to an empty restriction that permits
   * nothing — and this is the boundary that stops such a value being written in
   * the first place. A restriction that cannot be honoured is a 400, rather
   * than a chain that silently routes nowhere.
   *
   * Absent and explicit `null` still mean every key: that is the documented way
   * to say it, and it is what the panel sends for an unrestricted model.
   * Everything else must be an array of real integers this provider has.
   *
   * Returns null when the restriction is valid, or a machine-readable reason.
   */
  function keyRestrictionProblem(keys, available) {
    if (keys === undefined || keys === null) return null;
    if (!Array.isArray(keys)) return { reason: "keys_not_an_array", keys };
    if (keys.length === 0) return { reason: "keys_empty", keys };
    const offending = [...new Set(keys.filter((value) => (
      typeof value !== "number"
      || !Number.isInteger(value)
      || value < 0
      || value >= MAX_KEYS
      || !available.has(value)
    )))];
    return offending.length > 0 ? { reason: "keys_not_configured", keys: offending } : null;
  }

  // --- /api/fallback -----------------------------------------------------
  /**
   * Everything the Fallback Configuration page needs, in one payload: the saved
   * chain, the selected mode, and the catalogue of models that can be
   * added — each with its per-key health and its measured latency.
   *
   * Latency is reported WITH its source (`request` = a real generation, `probe`
   * = a health probe, `null` = never measured). The panel must be able to say
   * "not measured yet" rather than show a number the router does not have.
   */
  function fallbackPayload(now = Date.now()) {
    const health = describeAll(now);
    const index = new Map();

    for (const entry of health) {
      const id = `${entry.provider}/${entry.model}`;
      let group = index.get(id);
      if (!group) {
        group = { id, provider: entry.provider, model: entry.model, keyStates: [], protocols: [] };
        index.set(id, group);
      }
      // Every key of one model serves the same protocols; the union is taken
      // anyway so a partially configured provider cannot understate it.
      for (const protocol of entry.protocols ?? []) {
        if (!group.protocols.includes(protocol)) group.protocols.push(protocol);
      }
      const available = !(Number(entry.cooldownUntil) > now);
      group.keyStates.push({
        id: entry.id,
        keyIndex: entry.keyIndex,
        status: available ? entry.status : "cooldown",
        score: entry.score,
        available,
        cooldownUntil: entry.cooldownUntil,
        latencyMs: entry.latencyMs,
        requestLatencyMs: entry.requestLatencyMs ?? null,
        probeLatencyMs: entry.probeLatencyMs ?? null,
        lastStatus: entry.lastStatus,
        modelListed: entry.modelListedConfirmed ?? null
      });
    }

    // The entries the planner narrows by, read exactly as `chainGroups` reads
    // them: enabled entries only, one per provider/model.
    const entries = new Map(activeEntries(fallbackChain?.get?.() ?? []).map((entry) => [entryId(entry), entry]));
    for (const group of index.values()) {
      group.keyStates.sort((a, b) => a.keyIndex - b.keyIndex);
      // The key indexes this model actually has, which is what an entry's own
      // `keys` narrows. Kept separate from `keyStates` so an entry's saved
      // subset can never be confused with the provider's key inventory.
      group.keyIndexes = group.keyStates.map((key) => key.keyIndex);
      // The number routing actually orders by, and where it came from: the
      // planner's own definition (`modelLatency`), not a second one, applied to
      // the keys the planner orders this model by. When the chain restricts the
      // entry to a subset of keys, only those keys are eligible and only they
      // count: key 0 at 50 ms must not speed up an entry that allows key 1 only
      // (900 ms). A model with no enabled entry is ordered over all its keys.
      const entry = entries.get(entryId(group));
      const eligible = entry ? new Set(allowedKeyIndexes(entry, group.keyIndexes)) : null;
      const ordering = modelLatency(
        eligible ? group.keyStates.filter((key) => eligible.has(key.keyIndex)) : group.keyStates
      );
      const lowest = (field) => {
        const values = group.keyStates.map((key) => key[field]).filter((value) => Number.isFinite(value));
        return values.length > 0 ? Math.min(...values) : null;
      };
      group.measuredLatencyMs = lowest("requestLatencyMs");
      group.probeLatencyMs = lowest("probeLatencyMs");
      group.latencyMs = ordering.latencyMs;
      group.latencySource = ordering.source;
      group.available = group.keyStates.some((key) => key.available);
      group.status = rollupStatus(group.keyStates);
      group.disabled = Boolean(modelSwitch?.isDisabled?.(group.provider, group.model));
      group.providerDisabled = isProviderSwitchedOff(group.provider);
    }

    return {
      mode: fallbackMode(),
      remembersSuccess: remembersSuccess(fallbackMode()),
      modes: FALLBACK_MODE_INFO,
      chain: fallbackChain?.get?.() ?? [],
      catalogue: [...index.values()],
      disabledModels: modelSwitch?.list?.() ?? [],
      disabledProviders: modelSwitch?.listProviders?.() ?? [],
      // What the router is currently remembering, so the panel can show it and
      // Reset Fallback can be seen to have worked rather than merely claimed.
      remembered: typeof describeFallbackState === "function" ? describeFallbackState() : null
    };
  }

  /** One status for a model, from its keys. Cooling keys are never reported healthy. */
  function rollupStatus(keys) {
    if (keys.some((key) => key.available && key.status === "healthy")) return "healthy";
    if (keys.every((key) => !key.available)) return "cooldown";
    if (keys.some((key) => key.status === "failed")) return "failed";
    return "unknown";
  }

  // --- /api/router/preview -----------------------------------------------
  /**
   * A faithful, read-only rendering of the decision the router makes for a given
   * request shape. Routing is capability-based: every configured target is a
   * candidate, and the request's required capabilities decide which ones are
   * eligible. There is no separate text/vision pool — a model that declares
   * image_input can serve image requests, and one that does not cannot.
   */
  function routerPreviewPayload(searchParams, now = Date.now()) {
    const protocol = (searchParams.get("protocol") || "").trim();
    if (!protocol) {
      return { error: "a protocol query parameter is required" };
    }

    // The preview runs against the same target set the proxy would use.
    const switchedOnTargets = targets.filter((target) => !isSwitchedOff(target));

    if (targets.length > 0 && switchedOnTargets.length === 0) {
      return {
        status: 503,
        type: "models_disabled",
        error: "Every model is switched off in the Control Panel"
      };
    }

    // One Provider Fallback: only the chosen provider's listed models are routed.
    const activeOneModel = oneModelActive();
    const routableForPreview = activeOneModel
      ? switchedOnTargets.filter((target) => oneModel.matches(target))
      : switchedOnTargets;

    if (activeOneModel && switchedOnTargets.length > 0 && routableForPreview.length === 0) {
      return {
        status: 503,
        type: "one_model_unavailable",
        error: `One Provider Fallback is on and ${activeOneModel.provider} has no usable key for its chosen models`
      };
    }

    if (routableForPreview.length === 0) {
      return {
        status: 503,
        type: "no_route",
        error: "No provider is configured"
      };
    }

    // A client protocol is servable if any target can be reached for it —
    // natively, or through a bridge (so a chat client is servable by a
    // Gemini-only configuration).
    const supported = servableProtocols(routableForPreview);
    if (!supported.has(protocol)) {
      return {
        error: `protocol "${protocol}" is not served by any configured target`,
        details: { supported: [...supported].sort() }
      };
    }

    return {
      generatedAt: new Date(now).toISOString(),
      protocols: [...supported].sort(),
      ...describeRouting({
        targets: routableForPreview,
        health,
        protocol,
        chain: fallbackChain?.get?.() ?? [],
        retryableStatus: config.retryableStatus,
        model: (searchParams.get("model") || "").trim(),
        stickyTargetId: (searchParams.get("session") || "").trim() || null, // observability text only
        now
      })
    };
  }

  // --- /api/analytics ----------------------------------------------------
  function analyticsPayload(searchParams, now = Date.now()) {
    const { label, rangeMs } = resolveRange(searchParams.get("range") || "1h", now);
    const buckets = Math.max(2, Math.min(Number(searchParams.get("buckets")) || 30, 120));

    const start = now - rangeMs;
    const entries = [...requestLog.entries.values()].filter((entry) =>
      entry.receivedAt >= start);

    return {
      generatedAt: new Date(now).toISOString(),
      range: { label, rangeMs, from: new Date(start).toISOString(), to: new Date(now).toISOString() },
      bucketMs: Math.floor(rangeMs / buckets),
      availableRanges: ["5m", "15m", "1h", "6h", "24h", "7d"],

      // Explicit: these figures come from live in-memory traffic only.
      source: "in-memory request log",
      sampleSize: entries.length,
      // Metrics that need a data source the gateway does not have yet are
      // reported as unavailable rather than as zero.
      unavailable: entries.length === 0 ? ["all metrics (no requests recorded in this range)"] : [],

      summary: summarizeRequests(entries),
      series: series(entries, { rangeMs, buckets, now }),
      breakdowns: {
        provider: breakdown(entries, (entry) => entry.finalProvider),
        model: breakdown(entries, (entry) => entry.finalModel),
        protocol: breakdown(entries, (entry) => entry.protocol),
        outcome: breakdown(entries, (entry) => entry.outcome),
        errors: errorDistribution(entries),
        fallback: breakdown(
          entries.filter((entry) => (entry.fallbackCount ?? 0) > 0),
          (entry) => `${entry.finalProvider ?? "unknown"} / ${entry.finalModel ?? "unknown"}`
        )
      },
      recentFailures: entries
        .filter((entry) => entry.outcome === "failed")
        .slice(-10)
        .reverse()
        .map((entry) => ({
          id: entry.id,
          seq: entry.seq,
          receivedAt: entry.receivedAt,
          provider: entry.finalProvider,
          model: entry.finalModel,
          protocol: entry.protocol,
          httpStatus: entry.httpStatus,
          category: classifyFailure(entry),
          message: entry.errorMessage
        })),
      recentFallbacks: entries
        .filter((entry) => (entry.fallbackCount ?? 0) > 0)
        .slice(-10)
        .reverse()
        .map((entry) => ({
          id: entry.id,
          seq: entry.seq,
          receivedAt: entry.receivedAt,
          fallbackCount: entry.fallbackCount,
          outcome: entry.outcome,
          finalProvider: entry.finalProvider,
          finalModel: entry.finalModel,
          attempts: entry.attempts
        }))
    };
  }

  // --- /api/model-config (Unified Model Configurator) --------------------
  /**
   * Everything the Model Configurator page needs, and nothing else: no key, no
   * base URL and no credential ever leaves the gateway through this payload.
   *
   * Each row is the EFFECTIVE entry for one provider/model: the environment's
   * keys/protocols, the persisted declaration when there is one, and the
   * live Model Switch state. `enabled` therefore answers "may the router pick
   * this at all", while `enabledByConfig` is only the persisted checkbox — so
   * the page can say WHY a model is off instead of guessing.
   */
  function modelConfigPayload(now = Date.now()) {
    if (!modelConfig) {
      return {
        generatedAt: new Date(now).toISOString(),
        available: false,
        models: [],
        summary: { total: 0, configured: 0, environmentOnly: 0, enabled: 0, disabled: 0 },
        storage: { mode: "unavailable", location: null, ready: false, error: "The Model Configurator is not available in this process", localOnly: true },
        schema: { version: MODEL_CONFIG_SCHEMA_VERSION, capabilities: CAPABILITY_INFO, protocols: [...MODEL_PROTOCOLS] },
        adapters: ADAPTER_CAPABILITIES
      };
    }

    const inSelection = new Set(
      activeEntries(fallbackChain?.get?.() ?? []).map((entry) => `${entry.provider}/${entry.model}`)
    );

    const models = modelConfig.listEffective(targets).map((row) => {
      const key = `${row.provider}/${row.model}`;
      const switchedOff = Boolean(modelSwitch?.isDisabled?.(row.provider, row.model));
      const providerOff = Boolean(modelSwitch?.isProviderDisabled?.(row.provider));
      return {
        id: row.id,
        configId: row.configId,
        provider: row.provider,
        model: row.model,
        displayName: row.displayName,
        // The unified checkbox, before the other switches are applied.
        enabledByConfig: row.enabled,
        // The effective answer routing obeys.
        enabled: row.enabled && !switchedOff && !providerOff,
        disabledBySwitch: switchedOff,
        disabledByProvider: providerOff,
        capabilities: row.capabilities,
        capabilitiesSource: row.capabilitiesSource,
        executableCapabilities: row.executableCapabilities,
        unsupportedCapabilities: row.unsupportedCapabilities,
        protocol: row.protocol,
        contextLimit: row.contextLimit,
        metadata: row.metadata,
        protocols: row.protocols,
        keyCount: row.keyCount,
        configuredInEnvironment: row.configuredInEnvironment,
        stored: row.stored,
        source: row.stored ? "configured" : "environment",
        inManualSelection: inSelection.has(key),
        warnings: row.warnings,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      };
    });

    const count = (predicate) => models.filter(predicate).length;
    return {
      generatedAt: new Date(now).toISOString(),
      available: true,
      revision: modelConfig.revision,
      updatedAt: modelConfig.updatedAt ? new Date(modelConfig.updatedAt).toISOString() : null,
      storage: modelConfig.storageInfo(),
      warnings: modelConfig.warnings,
      models,
      summary: {
        total: models.length,
        configured: count((row) => row.stored),
        environmentOnly: count((row) => !row.stored),
        enabled: count((row) => row.enabled),
        disabled: count((row) => !row.enabled),
        declaredUnsupported: count((row) => row.unsupportedCapabilities.length > 0)
      },
      schema: {
        version: MODEL_CONFIG_SCHEMA_VERSION,
        capabilities: CAPABILITY_INFO,
        protocols: [...MODEL_PROTOCOLS]
      },
      adapters: ADAPTER_CAPABILITIES
    };
  }

  /** The `provider/model` pairs the environment can actually route to. */
  const knownModelIds = () => new Set(targets.map((target) => `${target.provider}/${target.model}`));

  /**
   * Validation defaults for a NEW declaration: the capabilities the environment
   * already implies for that model, so "configure" starts from the truth instead
   * of from an empty checkbox grid.
   */
  function inferDefaultsFor(provider, model) {
    const normalizedProvider = typeof provider === "string" ? provider.trim().toLowerCase() : "";
    const normalizedModel = typeof model === "string" ? model.trim() : "";
    const row = modelConfig?.index(targets).get(`${normalizedProvider}/${normalizedModel}`);
    if (!row) return null;
    return {
      capabilities: inferCapabilities()
    };
  }

  /**
   * The Model Switch and the unified `enabled` flag are two views of one
   * decision. Whichever surface the operator used, both must agree afterwards:
   * this projects the configurator's checkbox onto the (unchanged) Model Switch
   * store, and the switch is still applied independently when routing.
   */
  function syncModelSwitch(entry, { explicit }) {
    if (!modelSwitch || !explicit) return;
    try { modelSwitch.set(entry.provider, entry.model, entry.enabled === false); }
    catch { /* the switch is an optimisation of the same flag, never a save blocker */ }
  }

  function modelConfigFailure(req, res, error) {
    if (error?.status && error.status < 500) {
      return fail(req, res, error.status, error.message, error.type || "invalid_request");
    }
    return fail(req, res, 500, "Could not save the model configuration", "server_error");
  }

  // --- dispatcher --------------------------------------------------------
  async function handleApi(req, res, pathname, searchParams) {
    const now = Date.now();

    if (pathname === "/api/health" && req.method === "GET") {
      return sendJson(req, res, 200, healthPayload(now));
    }

    // Master on/off switch. "shutdown" pauses the gateway: no proxy request and
    // no health probe reaches an upstream until it is resumed. The process and
    // this admin API stay up so the Control Panel can turn it back on.
    if (pathname === "/api/gateway" || pathname === "/api/gateway/shutdown" || pathname === "/api/gateway/resume") {
      if (!gateway) return fail(req, res, 503, "Gateway control is not available", "unavailable");
      if (pathname === "/api/gateway") {
        if (req.method !== "GET") return fail(req, res, 405, "Use GET", "method_not_allowed");
        return sendJson(req, res, 200, gateway.snapshot());
      }
      if (req.method !== "POST") return fail(req, res, 405, "Use POST", "method_not_allowed");
      const snapshot = pathname.endsWith("/shutdown") ? gateway.pause("shut down from Control Panel") : gateway.resume();
      return sendJson(req, res, 200, { ok: true, ...snapshot });
    }

    // The model effort used for every request that reaches a reasoning model.
    if (pathname === "/api/effort") {
      if (!effortState) return fail(req, res, 503, "Effort control is not available", "unavailable");
      if (req.method === "GET") return sendJson(req, res, 200, effortState.snapshot());
      if (req.method !== "POST" && req.method !== "PUT") return fail(req, res, 405, "Use GET, or POST/PUT with { \"effort\": \"low|medium|high|xhigh\" }", "method_not_allowed");
      let body;
      try { body = await readJsonBody(req, config.maxBodyBytes); }
      catch (error) { return fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request"); }
      const snapshot = effortState.set(body?.effort);
      if (!snapshot) return fail(req, res, 400, "effort must be one of: low, medium, high, xhigh", "invalid_request");
      return sendJson(req, res, 200, { ok: true, ...snapshot });
    }

    if (pathname === "/api/health/refresh" && req.method === "POST") {
      if (gateway?.paused) {
        return fail(req, res, 409, "Gateway is shut down; resume it before refreshing health", "gateway_paused");
      }
      if (!monitor || typeof refreshHealth !== "function") {
        return fail(req, res, 503, "Health refresh is not available", "unavailable");
      }
      const result = await monitor.runManualCycle(refreshHealth);
      if (!result.started) {
        return sendJson(req, res, 409, { error: { message: result.reason, type: "conflict" }, ...result });
      }
      return sendJson(req, res, 200, { ok: true, cycle: result, health: healthPayload(Date.now()) });
    }

    /*
     * Saved custom endpoints: a base URL + API style + any number of models and
     * keys that the operator keeps permanently. Each becomes a normal provider
     * (`custom-<name>`) in the Fallback Chain. Keys go in, never out: the panel
     * only gets a key COUNT back.
     */
    if (customEndpoints && (pathname === "/api/custom-endpoints" || pathname.startsWith("/api/custom-endpoints/"))) {
      let id = "";
      if (pathname !== "/api/custom-endpoints") {
        try { id = decodeURIComponent(pathname.slice("/api/custom-endpoints/".length)); }
        catch { return fail(req, res, 400, "Bad endpoint id", "invalid_request"); }
      }
      const respond = (error) => {
        if (error?.status && error.status < 500) return fail(req, res, error.status, error.message, error.type || "invalid_request");
        return fail(req, res, 500, "Could not save the custom endpoint", "server_error");
      };

      if (id === "discover" && customModelDiscovery) {
        if (req.method !== "POST") return fail(req, res, 405, "Use POST /api/custom-endpoints/discover", "method_not_allowed");
        let body;
        try { body = await readJsonBody(req, config.maxBodyBytes); }
        catch (error) { return fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request"); }
        try {
          const spec = customModelDiscovery.resolve(body);
          const found = await customModelDiscovery.discover(spec);
          return sendJson(req, res, 200, { ok: true, ...found });
        } catch (error) {
          // Provider-side failures (wrong key, no model list, unreachable host) are
          // the answer the operator needs, so their scrubbed message is passed on.
          const providerFailure = typeof error?.type === "string" && (error.type.startsWith("upstream_") || error.type === "no_models");
          if (error?.status && (error.status < 500 || providerFailure)) return fail(req, res, error.status, error.message, error.type || "invalid_request");
          return fail(req, res, 500, "Could not fetch the model list", "server_error");
        }
      }

      if (!id && req.method === "GET") {
        return sendJson(req, res, 200, { endpoints: customEndpoints.describeAll(), protocols: [...CUSTOM_PROTOCOLS], storage: customEndpoints.storageInfo() });
      }

      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        if ((req.method === "POST") !== !id) return fail(req, res, 405, "Use POST /api/custom-endpoints to create and PUT /api/custom-endpoints/:id to change", "method_not_allowed");
        let body;
        try { body = await readJsonBody(req, config.maxBodyBytes); }
        catch (error) { return fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request"); }
        try {
          const endpoint = id ? await customEndpoints.update(id, body) : await customEndpoints.create(body);
          return sendJson(req, res, id ? 200 : 201, { ok: true, endpoint, endpoints: customEndpoints.describeAll() });
        } catch (error) { return respond(error); }
      }

      if (id && req.method === "DELETE") {
        try {
          const removed = await customEndpoints.remove(id);
          return sendJson(req, res, 200, { ok: true, removed, endpoints: customEndpoints.describeAll() });
        } catch (error) { return respond(error); }
      }

      return fail(req, res, 405, "Method not allowed", "method_not_allowed");
    }

    /*
     * Model lists of the built-in providers. "Fetch Models" asks the provider
     * itself what it serves (with its first configured key, which never leaves
     * the server); the operator keeps the ones they want, and that list replaces
     * the provider's <PROVIDER>_MODELS env list until it is reset.
     */
    if (providerModels && pathname.startsWith("/api/providers/") && pathname !== "/api/providers/switch") {
      let rest;
      try { rest = decodeURIComponent(pathname.slice("/api/providers/".length)); }
      catch { return fail(req, res, 400, "Bad provider id", "invalid_request"); }
      const respond = (error) => {
        if (error?.status && error.status < 500) return fail(req, res, error.status, error.message, error.type || "invalid_request");
        return fail(req, res, 500, "Could not save the model list", "server_error");
      };
      const readBody = async () => {
        try { return { body: await readJsonBody(req, config.maxBodyBytes) }; }
        catch (error) { return { failure: fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request") }; }
      };

      if (rest === "discover" && providerModelDiscovery) {
        if (req.method !== "POST") return fail(req, res, 405, "Use POST /api/providers/discover", "method_not_allowed");
        const { body, failure } = await readBody();
        if (failure) return failure;
        try {
          const provider = typeof body?.provider === "string" ? body.provider.trim().toLowerCase() : "";
          const found = await providerModelDiscovery.discover(providerModelDiscovery.resolve(provider));
          return sendJson(req, res, 200, {
            ok: true,
            provider,
            ...found,
            current: [...(config.providers[provider]?.models ?? [])],
            modelsSource: providerModels.has(provider) ? "panel" : "env"
          });
        } catch (error) {
          // Same rule as custom endpoints: a provider-side failure (wrong key, no model list) is the answer.
          const providerFailure = typeof error?.type === "string" && (error.type.startsWith("upstream_") || error.type === "no_models");
          if (error?.status && (error.status < 500 || providerFailure)) return fail(req, res, error.status, error.message, error.type || "invalid_request");
          return fail(req, res, 500, "Could not fetch the model list", "server_error");
        }
      }

      const match = /^([^/]+)\/models$/.exec(rest);
      if (match) {
        const provider = match[1].trim().toLowerCase();
        if (req.method === "PUT") {
          const { body, failure } = await readBody();
          if (failure) return failure;
          try {
            const models = await providerModels.set(provider, body?.models);
            return sendJson(req, res, 200, { ok: true, provider, models, modelsSource: "panel" });
          } catch (error) { return respond(error); }
        }
        if (req.method === "DELETE") {
          try {
            const reset = await providerModels.reset(provider);
            return sendJson(req, res, 200, {
              ok: true, provider, reset, modelsSource: "env",
              models: [...(providerModelBaseline?.[provider] ?? [])]
            });
          } catch (error) { return respond(error); }
        }
        return fail(req, res, 405, "Use PUT to save the model list and DELETE to reset it to the environment list", "method_not_allowed");
      }
    }

    if (pathname === "/api/providers" && req.method === "GET") {
      return sendJson(req, res, 200, providersPayload(now));
    }

    if (pathname === "/api/models" && req.method === "GET") {
      return sendJson(req, res, 200, modelsPayload(now));
    }

    /*
     * The Unified Model Configurator: one declaration per provider/model, with
     * an enabled flag and the capabilities that model really has. It is the
     * overlay routing and the page both read, so a checkbox cannot disagree with
     * a route. The document holds ids and declarations only — never a key.
     */
    if (modelConfig && (pathname === "/api/model-config" || pathname === "/api/model-config/refresh" || pathname.startsWith("/api/model-config/"))) {
      if (pathname === "/api/model-config/refresh") {
        if (req.method !== "POST") return fail(req, res, 405, "Use POST", "method_not_allowed");
        // Re-read the remote document. This is serialized with writes, so a
        // refresh can never race a save and adopt the document that save just
        // replaced. A failure is reported in `storage`, with the last known
        // configuration still in force — never wiped.
        await modelConfig.refresh();
        return sendJson(req, res, 200, { ok: true, ...modelConfigPayload(Date.now()) });
      }

      /*
       * Add or remove capabilities on many models at once, in ONE saved
       * document (one GitHub commit, all-or-nothing).
       *   body: { models: [{provider, model}, ...] | "all", add: [...], remove: [...] }
       */
      if (pathname === "/api/model-config/bulk") {
        if (req.method !== "POST") return fail(req, res, 405, "Use POST", "method_not_allowed");
        let body;
        try { body = await readJsonBody(req, config.maxBodyBytes); }
        catch (error) { return fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return fail(req, res, 400, "Request body must be a JSON object", "invalid_request");
        }

        await modelConfig.idle();
        const pairs = body.models === "all"
          ? [...modelConfig.index(targets).values()].map((row) => ({ provider: row.provider, model: row.model }))
          : body.models;

        let result;
        try {
          result = await modelConfig.bulkCapabilities(pairs, {
            add: body.add ?? [],
            remove: body.remove ?? [],
            knownModels: knownModelIds(),
            baseFor: () => inferCapabilities(),
            enabledFor: (provider, model) => (modelSwitch ? !modelSwitch.isDisabled(provider, model) : true)
          });
        } catch (error) { return modelConfigFailure(req, res, error); }

        resetAutomaticOrderCache();
        return sendJson(req, res, 200, {
          ok: true,
          changed: result.changed,
          created: result.created,
          unchanged: result.unchanged,
          ignored: result.warnings,
          ...modelConfigPayload(Date.now())
        });
      }

      let id = "";
      if (pathname !== "/api/model-config") {
        try { id = decodeURIComponent(pathname.slice("/api/model-config/".length)); }
        catch { return fail(req, res, 400, "Malformed model configuration id", "invalid_request"); }
      }

      if (!id) {
        if (req.method === "GET") {
          // A save (or the cleanup after a provider model was removed) may still
          // be in flight; wait for it so the page never shows the old list.
          await modelConfig.idle();
          return sendJson(req, res, 200, modelConfigPayload(Date.now()));
        }
        if (req.method !== "POST") {
          return fail(req, res, 405, "Use GET /api/model-config or POST /api/model-config", "method_not_allowed");
        }

        let body;
        try { body = await readJsonBody(req, config.maxBodyBytes); }
        catch (error) { return fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request"); }
        const input = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : body;

        // A new declaration starts from the switch's current state, so adding a
        // configuration cannot silently turn a disabled model back on.
        if (input && typeof input === "object" && input.enabled === undefined && modelSwitch) {
          const provider = typeof input.provider === "string" ? input.provider.trim().toLowerCase() : "";
          const model = typeof input.model === "string" ? input.model.trim() : "";
          if (provider && model) input.enabled = !modelSwitch.isDisabled(provider, model);
        }

        let result;
        try {
          result = await modelConfig.create(input, {
            knownModels: knownModelIds(),
            defaults: inferDefaultsFor(input?.provider, input?.model)
          });
        } catch (error) { return modelConfigFailure(req, res, error); }

        syncModelSwitch(result.entry, { explicit: true });
        resetAutomaticOrderCache();
        return sendJson(req, res, 201, {
          ok: true,
          entry: result.entry,
          warnings: result.warnings,
          ...modelConfigPayload(Date.now())
        });
      }

      if (req.method === "PUT" || req.method === "PATCH") {
        let body;
        try { body = await readJsonBody(req, config.maxBodyBytes); }
        catch (error) { return fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request"); }
        const input = body && typeof body === "object" && !Array.isArray(body) ? body : body;
        const explicitEnabled = Boolean(input && typeof input === "object" && input.enabled !== undefined);

        let result;
        try { result = await modelConfig.update(id, input, { knownModels: knownModelIds() }); }
        catch (error) { return modelConfigFailure(req, res, error); }

        syncModelSwitch(result.entry, { explicit: explicitEnabled });
        resetAutomaticOrderCache();
        return sendJson(req, res, 200, {
          ok: true,
          entry: result.entry,
          warnings: result.warnings,
          ...modelConfigPayload(Date.now())
        });
      }

      if (req.method === "DELETE") {
        let result;
        try { result = await modelConfig.remove(id); }
        catch (error) { return modelConfigFailure(req, res, error); }
        // Removing the declaration restores the environment's default (enabled).
        // The switch had been kept in step with it, so it is always cleared here
        // (even for an inconsistent legacy state); the operator can switch the
        // model off again on the Models page.
        if (result.removed && modelSwitch) {
          try { modelSwitch.set(result.removed.provider, result.removed.model, false); } catch { /* same flag, best effort */ }
        }
        resetAutomaticOrderCache();
        return sendJson(req, res, 200, {
          ok: true,
          removed: result.removed,
          ...modelConfigPayload(Date.now())
        });
      }

      return fail(req, res, 405, "Method not allowed", "method_not_allowed");
    }

    if (pathname === "/api/fallback" && fallbackChain) {
      if (req.method === "GET") return sendJson(req, res, 200, fallbackPayload(now));

      if (req.method === "PUT") {
        let body;
        try { body = await readJsonBody(req, config.maxBodyBytes); }
        catch (error) { return fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request"); }

        /*
         * Everything is validated BEFORE anything is written. A rejected save
         * must leave the configuration exactly as it was — including the case
         * where one request carries both a mode and entries and only the second
         * is invalid, which used to persist the mode on the way to the error.
         */
        const hasMode = body?.mode !== undefined;
        if (!hasMode && !Array.isArray(body?.entries)) {
          return fail(req, res, 400, "an entries array is required", "invalid_request");
        }

        /*
         * The mode is DERIVED from the saved selection now, so a posted mode is
         * accepted for compatibility and ignored: an older client can still flip
         * between Automatic and Manual Model Selection by saving an empty or a
         * non-empty list. A value that names no mode at all — current or retired
         * — is still refused, so a typo is not silently swallowed.
         */
        if (hasMode) {
          const requested = body.mode === null ? "" : String(body.mode).trim().toLowerCase();
          if (requested !== "" && !isKnownMode(requested)) {
            return fail(req, res, 400, `unknown mode "${body.mode}"`, "invalid_request", { modes: FALLBACK_MODES });
          }
        }

        // A body that names only a (valid) mode carries no selection to save.
        // The mode is derived from the saved entries, so there is nothing to
        // write: answer with the state in force instead of walking an entries
        // list that was never sent.
        if (!Array.isArray(body?.entries)) {
          return sendJson(req, res, 200, fallbackPayload(now));
        }

        // What the chain can actually be routed to: the models configured, and
        // the key indexes each of those providers actually has.
        const keyIndexes = new Map();
        for (const target of targets) {
          const id = `${target.provider}/${target.model}`;
          if (!keyIndexes.has(id)) keyIndexes.set(id, new Set());
          keyIndexes.get(id).add(target.keyIndex);
        }

        // Checked against what was SENT, not the normalized form. The store
        // reads a file on disk forgivingly on purpose — a malformed
        // restriction becomes an unusable one (permitting nothing) and a stale
        // index becomes one that matches no key — but neither is something an
        // operator should be able to save from here, so a write that cannot be
        // honoured is refused rather than stored.
        const unknown = [];
        const badKeys = [];
        for (const raw of body.entries) {
          const provider = String(raw?.provider ?? "").trim().toLowerCase();
          const model = String(raw?.model ?? "").trim();
          // Malformed entries carry no routing intent; normalization drops them.
          if (!provider || !model) continue;
          const id = `${provider}/${model}`;
          const available = keyIndexes.get(id);
          if (!available) {
            unknown.push(id);
            continue;
          }
          const problem = keyRestrictionProblem(raw?.keys, available);
          if (problem) {
            badKeys.push({
              provider, model,
              ...problem,
              available: [...available].sort((a, b) => a - b)
            });
          }
        }

        if (unknown.length > 0) {
          return fail(req, res, 400, "entries contains models that are not configured", "invalid_request", { unknown });
        }
        if (badKeys.length > 0) {
          return fail(req, res, 400, "entries contains key restrictions that are not valid", "invalid_request", { keys: badKeys });
        }

        const entries = normalizeEntries(body.entries);

        // Nothing above failed, so this is the only place anything is written.
        // A posted mode is not written — it is derived from the entries — so
        // only the entries are persisted, in ONE update.
        const chainBefore = JSON.stringify(fallbackChain.get());
        try {
          fallbackChain.update({ entries });
        } catch {
          return fail(req, res, 500, "Could not save the fallback configuration", "server_error");
        }
        // A remembered target is only a preference over the chain that was in
        // force when it succeeded. Once the chain has really changed it must not
        // override the new order, so remembered targets are dropped — and only
        // after the write above succeeded. Health and cooldowns are deliberately
        // left alone.
        if (typeof clearRememberedTargets === "function" && JSON.stringify(fallbackChain.get()) !== chainBefore) {
          try { clearRememberedTargets(); } catch { /* the chain is saved; a stale preference is not worth failing the save */ }
        }
        // The saved configuration is live from this moment. Invalidated only
        // after the writes succeeded, so a rejected save cannot disturb the
        // order already in force.
        resetAutomaticOrderCache();
        return sendJson(req, res, 200, fallbackPayload(now));
      }
    }

    /*
     * The Model Switch: turn one provider/model off or on without touching the
     * saved chain. Takes effect immediately — new requests no longer plan the
     * model, and a request still waiting on it is aborted and falls back to the
     * next model (see server.js). Only ids and a flag are accepted.
     */
    if (pathname === "/api/models/switch" && modelSwitch) {
      if (req.method === "GET") return sendJson(req, res, 200, { disabledModels: modelSwitch.list() });

      if (req.method === "PUT") {
        let body;
        try { body = await readJsonBody(req, config.maxBodyBytes); }
        catch (error) { return fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request"); }

        const provider = typeof body?.provider === "string" ? body.provider.trim().toLowerCase() : "";
        const model = typeof body?.model === "string" ? body.model.trim() : "";
        if (!provider || !model) return fail(req, res, 400, "provider and model are required", "invalid_request");
        if (typeof body?.disabled !== "boolean") return fail(req, res, 400, "disabled must be true or false", "invalid_request");

        // Only a configured model can be switched; a typo must not create an
        // entry nobody can see or clear. A model that has since been removed
        // from the configuration may still be switched back ON.
        const known = targets.some((target) => target.provider === provider && target.model === model);
        if (body.disabled && !known) {
          return fail(req, res, 404, `no configured model "${provider}/${model}"`, "not_found");
        }

        // For a DECLARED model the unified enabled flag is the durable source of
        // truth. The Models page must update it first; otherwise the local
        // switch and the declaration disagree, and a restart or a GitHub
        // refresh would undo the click. Environment-only models keep the
        // switch-only behaviour.
        const override = modelConfig?.overrideFor?.(provider, model) ?? null;
        const desiredEnabled = !body.disabled;
        let configChanged = false;
        if (override && override.enabled !== desiredEnabled) {
          try {
            await modelConfig.update(override.id, { enabled: desiredEnabled });
            configChanged = true;
          } catch (error) {
            return modelConfigFailure(req, res, error);
          }
        }

        let switched = false;
        try { switched = modelSwitch.set(provider, model, body.disabled); }
        catch { return fail(req, res, 500, "Could not save the model switch", "server_error"); }
        resetAutomaticOrderCache();
        return sendJson(req, res, 200, {
          ok: true,
          changed: configChanged || switched,
          configChanged,
          provider,
          model,
          disabled: body.disabled,
          ...fallbackPayload(now)
        });
      }
    }

    /*
     * The Provider Switch: turn a whole provider off or on. While it is off none
     * of its models (any key) is planned, fallen back to or
     * previewed, and requests already waiting on it are aborted and fall back to
     * the next model. Nothing is cooled down and no model's own switch or health
     * data changes, so enabling the provider restores exactly the previous
     * behaviour.
     */
    if (pathname === "/api/providers/switch" && modelSwitch) {
      if (req.method === "GET") return sendJson(req, res, 200, { disabledProviders: modelSwitch.listProviders() });

      if (req.method === "PUT") {
        let body;
        try { body = await readJsonBody(req, config.maxBodyBytes); }
        catch (error) { return fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request"); }

        const provider = typeof body?.provider === "string" ? body.provider.trim().toLowerCase() : "";
        if (!provider) return fail(req, res, 400, "provider is required", "invalid_request");
        if (typeof body?.disabled !== "boolean") return fail(req, res, 400, "disabled must be true or false", "invalid_request");

        // Only a configured provider can be switched off; a typo must not create
        // an entry nobody can see or clear. A provider that has since been
        // removed from the configuration may still be switched back ON.
        const known = targets.some((target) => target.provider === provider);
        if (body.disabled && !known) {
          return fail(req, res, 404, `no configured provider "${provider}"`, "not_found");
        }

        let changed;
        try { changed = modelSwitch.setProvider(provider, body.disabled); }
        catch { return fail(req, res, 500, "Could not save the provider switch", "server_error"); }
        resetAutomaticOrderCache();
        return sendJson(req, res, 200, {
          ok: true, changed, provider, disabled: body.disabled,
          disabledProviders: modelSwitch.listProviders(),
          ...fallbackPayload(now)
        });
      }
    }

    /*
     * One Provider Fallback: serve every request from ONE chosen provider and
     * nothing else, trying its listed models in order (see one-model.js). A key
     * with a cooldown cools for that long the moment it is called. Takes effect
     * immediately and changes no saved
     * chain, health measurement or model switch, so switching it off restores
     * the previous routing exactly.
     */
    if (pathname === "/api/one-model" && oneModel) {
      if (req.method === "GET") return sendJson(req, res, 200, oneModelPayload(now));

      if (req.method === "PUT") {
        let body;
        try { body = await readJsonBody(req, config.maxBodyBytes); }
        catch (error) { return fail(req, res, error.status || 400, "Invalid JSON body", "invalid_request"); }

        if (body?.enabled !== undefined && typeof body.enabled !== "boolean") {
          return fail(req, res, 400, "enabled must be true or false", "invalid_request");
        }
        const hasProvider = body?.provider !== undefined;
        if (hasProvider && typeof body.provider !== "string") {
          return fail(req, res, 400, "provider must be a string", "invalid_request");
        }
        // The ordered model list. `model` (one name) is still accepted as a list of one.
        if (body?.models !== undefined && body?.model !== undefined) {
          return fail(req, res, 400, "send models or model, not both", "invalid_request");
        }
        let nextModels = null;
        if (body?.models !== undefined) {
          if (!Array.isArray(body.models) || body.models.some((entry) => typeof entry !== "string")) {
            return fail(req, res, 400, "models must be a list of model names", "invalid_request");
          }
          nextModels = [...new Set(body.models.map((entry) => entry.trim()).filter(Boolean))];
        } else if (body?.model !== undefined) {
          if (typeof body.model !== "string") return fail(req, res, 400, "model must be a string", "invalid_request");
          nextModels = body.model.trim() ? [body.model.trim()] : [];
        }
        if (nextModels && nextModels.length > ONE_PROVIDER_MAX_MODELS) {
          return fail(req, res, 400, `at most ${ONE_PROVIDER_MAX_MODELS} models`, "invalid_request");
        }
        if ((hasProvider || nextModels !== null) && !(hasProvider && nextModels !== null)) {
          return fail(req, res, 400, "provider and models must be sent together", "invalid_request");
        }

        // Per-key cooldowns: { "model::0": 60000, "model::1": null }. A number sets a
        // key's cooldown in ms, null (or 0) removes it, a key left out is kept.
        let cooldowns = {};
        if (body?.cooldowns !== undefined) {
          if (body.cooldowns === null || typeof body.cooldowns !== "object" || Array.isArray(body.cooldowns)) {
            return fail(req, res, 400, "cooldowns must be an object of \"model::keyIndex\" to milliseconds", "invalid_request");
          }
          for (const [id, ms] of Object.entries(body.cooldowns)) {
            // The current "model::0" form, plus legacy ids ("text:0", "model::text:0").
            if (normalizeKeyId(id, ["_"]) === null) {
              return fail(req, res, 400, `invalid key id "${id.slice(0, 20)}": use "model::0" (the model, then the key index)`, "invalid_request");
            }
            const ok = ms === null || ms === 0
              || (Number.isSafeInteger(ms) && ms >= 1 && ms <= ONE_MODEL_MAX_COOLDOWN_MS);
            if (!ok) {
              return fail(req, res, 400, "a cooldown must be a whole number of milliseconds from 1 to 86400000, or null for none", "invalid_request");
            }
          }
          cooldowns = body.cooldowns;
        }

        const current = oneModel.get();
        const next = {
          enabled: body?.enabled ?? current.enabled,
          provider: hasProvider ? body.provider.trim().toLowerCase() : current.provider,
          models: nextModels ?? current.models
        };
        if (next.enabled && (!next.provider || next.models.length === 0)) {
          return fail(req, res, 400, "choose a provider and at least one model first", "invalid_request");
        }
        // Only configured models can be chosen; a typo must not leave the gateway
        // routing everything to a model that does not exist. Switching the mode
        // OFF is always allowed.
        if ((next.enabled || hasProvider) && next.provider) {
          const unknownModel = next.models.find((model) =>
            !targets.some((target) => target.provider === next.provider && target.model === model));
          if (unknownModel !== undefined) {
            return fail(req, res, 404, `no configured model "${next.provider}/${unknownModel}"`, "not_found");
          }
        }

        // Cooldowns are for the chosen models' keys; one for a key that is not
        // there would sit in the file doing nothing and nobody could see it.
        // Legacy ids ("text:0", "model::text:0", "model::vision:0") are accepted
        // and rewritten to the current "model::index" form.
        const resolvedCooldowns = {};
        for (const [id, ms] of Object.entries(cooldowns)) {
          resolvedCooldowns[normalizeKeyId(id, next.models) ?? id] = ms;
        }
        cooldowns = resolvedCooldowns;
        if (Object.keys(cooldowns).length > 0) {
          const keyIds = new Set(targets
            .filter((target) => target.provider === next.provider && next.models.includes(target.model))
            .map((target) => oneModelKeyId(target)));
          const unknownKey = Object.entries(cooldowns).find(([id, ms]) => ms !== null && ms !== 0 && !keyIds.has(id));
          if (unknownKey) return fail(req, res, 404, `the chosen models have no key "${unknownKey[0]}"`, "not_found");
        }

        let changed;
        try { changed = oneModel.set({ ...next, cooldowns }); }
        catch { return fail(req, res, 500, "Could not save the One Provider Fallback setting", "server_error"); }
        resetAutomaticOrderCache();
        return sendJson(req, res, 200, { ok: true, changed, ...oneModelPayload(Date.now()) });
      }
    }

    if (pathname === "/api/fallback/reset" && req.method === "POST" && fallbackChain) {
      // Reset clears what the router REMEMBERS. It must not touch the saved
      // selection, the providers, the keys, the health measurements or a
      // genuine cooldown — those are all still true after the button is pressed.
      if (typeof resetFallbackState !== "function") {
        return fail(req, res, 503, "Reset is not available in this process", "unavailable");
      }
      let result;
      try { result = resetFallbackState(); }
      catch { return fail(req, res, 500, "Could not reset the fallback state", "server_error"); }
      return sendJson(req, res, 200, {
        ok: true,
        message: "Remembered targets cleared. The next request starts from the saved selection, or the automatic order when none is saved.",
        reset: result,
        ...fallbackPayload(now)
      });
    }

    if (pathname === "/api/router/preview" && req.method === "GET") {
      const payload = routerPreviewPayload(searchParams, now);
      if (payload.error) {
        return fail(req, res, payload.status || 400, payload.error, payload.type || "invalid_request",
          payload.details || null);
      }
      return sendJson(req, res, 200, payload);
    }

    if (pathname === "/api/analytics" && req.method === "GET") {
      return sendJson(req, res, 200, analyticsPayload(searchParams, now));
    }

    if (pathname === "/api/config" && req.method === "GET") {
      return sendJson(req, res, 200, {
        generatedAt: new Date(now).toISOString(),
        ...describeConfig(config, targets),
        environment: describeEnvironment(config)
      });
    }

    if (pathname === "/api/system" && req.method === "GET") {
      return sendJson(req, res, 200, {
        ...describeSystem({
          config,
          targets,
          monitor: monitor ? monitor.snapshot(now) : null,
          now
        }),
        gateway: gateway ? gateway.snapshot(now) : null,
        effort: effortState ? effortState.snapshot() : null
      });
    }

    if (pathname === "/api/requests" && req.method === "GET") {
      return sendJson(req, res, 200, {
        generatedAt: new Date(now).toISOString(),
        ...requestLog.list({
          limit: searchParams.get("limit"),
          cursor: searchParams.get("cursor"),
          status: searchParams.get("status"),
          provider: searchParams.get("provider"),
          protocol: searchParams.get("protocol"),
          outcome: searchParams.get("outcome")
        }),
        // Requests still running, so the Live Logs view can show them before
        // they finish. Never part of `entries`, so metrics are unaffected.
        pending: requestLog.pending(),
        attempts: requestLog.listAttempts({ limit: searchParams.get("attemptLimit") }).entries
      });
    }

    // Clear the request log (Live Logs "Clear"). Finished requests and attempts
    // are removed for good, so a page refresh cannot bring them back.
    if (pathname === "/api/requests" && req.method === "DELETE") {
      const cleared = requestLog.clearCompleted();
      return sendJson(req, res, 200, { ok: true, cleared });
    }

    // One event per real upstream attempt, oldest first. A request's attempts
    // share its `requestId`; no two attempts ever share an `attemptId`.
    if (pathname === "/api/attempts" && req.method === "GET") {
      return sendJson(req, res, 200, {
        generatedAt: new Date(now).toISOString(),
        ...requestLog.listAttempts({
          limit: searchParams.get("limit") ?? undefined,
          afterSeq: searchParams.get("afterSeq") ?? 0,
          requestId: searchParams.get("requestId"),
          state: searchParams.get("state"),
          provider: searchParams.get("provider")
        })
      });
    }

    // Before the `/api/requests/<id>` lookup below, which would take it for an id.
    if (pathname === "/api/requests/stream" && req.method === "GET") {
      return openRequestStream(req, res, searchParams);
    }

    if (pathname.startsWith("/api/requests/") && req.method === "GET") {
      let id;
      try { id = decodeURIComponent(pathname.slice("/api/requests/".length)); }
      catch { return fail(req, res, 400, "Malformed percent-encoding in request path", "invalid_request"); }
      // Accept either the client-visible request id or the internal sequence.
      const entry = requestLog.findById(id) ?? requestLog.get(id);
      if (!entry) return fail(req, res, 404, "Request not found", "not_found");
      return sendJson(req, res, 200, { request: entry });
    }

    // The one write-through route in this module: it forwards a single request
    // to an endpoint the operator typed in. It touches no routing state, health
    // or request log (see custom-playground.js for the SSRF rules).
    if (pathname === "/api/playground/custom") {
      if (req.method !== "POST") return fail(req, res, 405, "Use POST", "method_not_allowed");
      if (!customPlayground) return fail(req, res, 503, "Custom playground is not available", "unavailable");
      return customPlayground(req, res);
    }

    if (pathname.startsWith("/api/")) {
      // An unknown admin path is a JSON 404 — never the SPA shell, so a typo
      // in a fetch call surfaces as an error instead of HTML.
      return fail(req, res, 404, "Not found", "not_found");
    }

    return false;
  }

  // Open live streams never end on their own, so shutdown has to close them or
  // `server.close()` would wait on them forever.
  handleApi.closeStreams = () => { for (const stream of [...liveStreams]) stream.close(); };
  return handleApi;
}
