import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Model lists for the built-in providers, chosen in the control panel.
 *
 * A built-in provider (groq, gemini, openrouter, ...) normally gets its models
 * from the `<PROVIDER>_MODELS` environment variable. The Providers page can
 * instead ask the provider which models it serves ("Fetch Models") and let the
 * operator keep the ones they want. That choice is stored HERE, per provider,
 * and replaces the env list for that provider until it is reset. A provider
 * with no entry keeps using its env list, so nothing changes until you use it.
 *
 * Only model ids are stored — never keys, URLs or any other setting — so the
 * document is plain JSON, and (like the Model Configurator's) it is mirrored in
 * GitHub when a repository is configured, because a free Render disk is wiped on
 * every redeploy.
 */

export const PROVIDER_MODELS_SCHEMA_VERSION = 1;
export const MAX_PROVIDER_MODELS = 300;
const MAX_MODEL_LENGTH = 256;
const RETRY_INTERVAL_MS = 60_000;

export class ProviderModelsError extends Error {
  constructor(status, message, type = "invalid_request") {
    super(message);
    this.name = "ProviderModelsError";
    this.status = status;
    this.type = type;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** One model id, or null when it cannot be a model id (empty, too long, spaces, commas, control characters). */
function cleanModel(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > MAX_MODEL_LENGTH) return null;
  return /[\u0000-\u001F\u007F\s,]/.test(id) ? null : id;
}

/**
 * Validates a list sent by the panel. Order is kept (it is the order the
 * provider's models are tried in), duplicates are dropped.
 */
export function cleanModelList(input) {
  if (!Array.isArray(input)) throw new ProviderModelsError(400, "models must be an array of model ids");
  const seen = new Set();
  for (const raw of input) {
    const id = cleanModel(raw);
    if (!id) throw new ProviderModelsError(400, `"${String(raw).slice(0, 60)}" is not a valid model id (no spaces or commas, at most ${MAX_MODEL_LENGTH} characters)`);
    seen.add(id);
  }
  const models = [...seen];
  if (models.length === 0) {
    throw new ProviderModelsError(400, "Keep at least one model, or use Reset to go back to the environment list.");
  }
  if (models.length > MAX_PROVIDER_MODELS) {
    throw new ProviderModelsError(400, `At most ${MAX_PROVIDER_MODELS} models per provider (${models.length} selected).`);
  }
  return models;
}

export class ProviderModelsStore {
  /**
   * @param file       local mirror path ("" keeps it in memory, as in tests)
   * @param remote     optional plain GitHub storage (createModelConfigStorage). When set it
   *                   is the source of truth and the local file is a mirror.
   * @param knownIds   provider ids that may carry an override; anything else is refused.
   */
  constructor({ file = null, remote = null, knownIds = null, logger = console } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.remote = remote ?? null;
    this.knownIds = knownIds ? new Set(knownIds) : null;
    this.logger = logger;
    this.overrides = new Map();
    this.revision = crypto.randomUUID();
    this.updatedAt = Date.now();
    this.remoteReady = !remote;
    this.remoteRevision = null;
    this.lastRemoteError = null;
    this.warnings = [];
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.retryTimer = null;
    this.loadLocal();
  }

  // --- loading and persistence -------------------------------------------

  loadLocal() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      this.applyDocument(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch (error) {
      this.warnings = [`Ignored the local provider model lists: ${error?.message ?? error}`];
      this.logger?.warn?.(`provider models: ignoring ${this.file} (${error?.message ?? error})`);
    }
  }

  /** Validates a whole document and adopts it atomically. A bad entry is skipped, never half-adopted. */
  applyDocument(parsed) {
    if (!isObject(parsed)) throw new ProviderModelsError(400, "The provider model lists are not a JSON object", "invalid_document");
    const version = Number(parsed.version ?? 1);
    if (!Number.isInteger(version) || version < 1) throw new ProviderModelsError(400, "No valid schema version", "invalid_document");
    if (version > PROVIDER_MODELS_SCHEMA_VERSION) {
      throw new ProviderModelsError(409, `The saved provider model lists use schema ${version}; this build understands ${PROVIDER_MODELS_SCHEMA_VERSION}.`, "schema_too_new");
    }
    const next = new Map();
    const warnings = [];
    const providers = isObject(parsed.providers) ? parsed.providers : {};
    for (const [rawId, entry] of Object.entries(providers)) {
      const id = String(rawId).trim().toLowerCase();
      if (this.knownIds && !this.knownIds.has(id)) { warnings.push(`Ignored a saved model list for unknown provider "${id.slice(0, 60)}"`); continue; }
      try { next.set(id, cleanModelList(isObject(entry) ? entry.models : null)); }
      catch (error) { warnings.push(`Ignored the saved model list of "${id.slice(0, 60)}": ${error.message}`); }
    }
    const parsedAt = Date.parse(parsed.updatedAt);
    this.overrides = next;
    this.revision = typeof parsed.revision === "string" && parsed.revision.trim() ? parsed.revision.trim().slice(0, 120) : crypto.randomUUID();
    this.updatedAt = Number.isFinite(parsedAt) ? parsedAt : Date.now();
    this.warnings = warnings;
  }

  serialize({ overrides = this.overrides, revision = this.revision, updatedAt = this.updatedAt } = {}) {
    const providers = {};
    for (const id of [...overrides.keys()].sort()) providers[id] = { models: [...overrides.get(id)] };
    return JSON.stringify({
      version: PROVIDER_MODELS_SCHEMA_VERSION,
      revision,
      updatedAt: new Date(updatedAt).toISOString(),
      providers
    }, null, 2);
  }

  writeLocal(text) {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /**
   * Reads the remote copy (remote wins over the local mirror; a fresh container
   * starts with an empty file). Never throws: an unreachable remote leaves the
   * local lists usable. Returns true when the adopted lists changed.
   */
  async init() {
    if (!this.remote) return false;
    try {
      const snapshot = await this.remote.read();
      let changed = false;
      if (snapshot === null) {
        this.remoteRevision = null;
        if (this.overrides.size > 0) {
          const result = await this.remote.write(this.serialize(), { expectedRevision: null });
          this.remoteRevision = result?.revision ?? null;
        }
      } else {
        const before = this.snapshot();
        this.applyDocument(JSON.parse(snapshot.text));
        changed = JSON.stringify(this.snapshot()) !== JSON.stringify(before);
        this.remoteRevision = snapshot.revision;
        try { this.writeLocal(this.serialize()); } catch { /* the mirror is optional */ }
      }
      this.remoteReady = true;
      this.lastRemoteError = null;
      return changed;
    } catch (error) {
      this.remoteReady = false;
      this.lastRemoteError = error?.message ?? String(error);
      this.logger?.warn?.(`provider models: remote storage not available (${this.lastRemoteError}); using the local lists until it answers`);
      return false;
    }
  }

  /** Re-reads the remote copy through the same queue as writes. */
  refresh() {
    return this.exclusive(async () => {
      const previous = this.snapshot();
      const changed = await this.init();
      if (changed) this.emit(previous);
      return changed;
    });
  }

  /** Keeps trying to reach GitHub until it answers, then hot-loads what it holds. */
  startRetry() {
    if (!this.remote || this.retryTimer) return;
    this.retryTimer = setInterval(async () => {
      if (this.remoteReady) { clearInterval(this.retryTimer); this.retryTimer = null; return; }
      await this.refresh();
      if (this.remoteReady && this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    }, RETRY_INTERVAL_MS);
    this.retryTimer.unref?.();
  }

  stopRetry() {
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
  }

  storageInfo() {
    if (!this.remote) return { mode: "file", location: this.file || "memory", ready: true, error: null, localOnly: true };
    return {
      mode: this.remote.name ?? "github",
      location: this.remote.location,
      ready: this.remoteReady,
      error: this.remoteReady ? null : this.lastRemoteError,
      localOnly: false
    };
  }

  // --- observers ----------------------------------------------------------

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Observers get the new lists and the previous ones (copies), as plain `{ provider: [models] }` objects. */
  emit(previous = {}) {
    const current = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(current, previous); } catch { /* observers must never break a save */ }
    }
  }

  async ensureReady() {
    if (this.remoteReady) return;
    const previous = this.snapshot();
    const changed = await this.init();
    if (!this.remoteReady) {
      throw new ProviderModelsError(503, `Remote storage is not reachable (${this.lastRemoteError ?? "unknown error"}). Nothing was saved.`, "unavailable");
    }
    if (changed) this.emit(previous);
  }

  /** Durable state first (GitHub, then the local mirror), then memory: a failed write changes nothing. */
  async persist(nextOverrides) {
    const revision = crypto.randomUUID();
    const updatedAt = Date.now();
    const text = this.serialize({ overrides: nextOverrides, revision, updatedAt });

    if (this.remote) {
      try {
        const result = await this.remote.write(text, { expectedRevision: this.remoteRevision });
        this.remoteRevision = result?.revision ?? this.remoteRevision;
      } catch (error) {
        if (error?.code === "conflict" || error?.status === 409) throw new ProviderModelsError(409, error.message, "conflict");
        throw new ProviderModelsError(503, `Could not save the model list (${error?.message ?? "remote storage unavailable"}). Nothing was saved.`, "unavailable");
      }
      try { this.writeLocal(text); } catch { /* the mirror is optional when GitHub holds the truth */ }
    } else {
      try { this.writeLocal(text); }
      catch (error) { throw new ProviderModelsError(500, `Could not save the model list (${error?.message ?? "local write failed"})`, "server_error"); }
    }

    this.overrides = nextOverrides;
    this.revision = revision;
    this.updatedAt = updatedAt;
    this.lastRemoteError = null;
  }

  exclusive(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  // --- reads ---------------------------------------------------------------

  /** `{ provider: [models] }`, copies only. */
  snapshot() {
    return Object.fromEntries([...this.overrides].map(([id, models]) => [id, [...models]]));
  }

  has(provider) {
    return this.overrides.has(String(provider ?? "").trim().toLowerCase());
  }

  get(provider) {
    const models = this.overrides.get(String(provider ?? "").trim().toLowerCase());
    return models ? [...models] : null;
  }

  // --- writes --------------------------------------------------------------

  assertKnown(id) {
    if (this.knownIds && !this.knownIds.has(id)) {
      throw new ProviderModelsError(404, `no built-in provider "${id.slice(0, 80)}" (custom endpoints are edited on their own form)`, "not_found");
    }
  }

  /** Replaces the provider's model list. */
  set(provider, models) {
    const id = String(provider ?? "").trim().toLowerCase();
    return this.exclusive(async () => {
      this.assertKnown(id);
      const list = cleanModelList(models);
      await this.ensureReady();
      const previous = this.snapshot();
      await this.persistChange((overrides) => { overrides.set(id, list); return true; });
      this.emit(previous);
      return [...list];
    });
  }

  /** Drops the override, so the provider goes back to its `<PROVIDER>_MODELS` list. */
  reset(provider) {
    const id = String(provider ?? "").trim().toLowerCase();
    return this.exclusive(async () => {
      this.assertKnown(id);
      await this.ensureReady();
      if (!this.overrides.has(id)) return false;
      const previous = this.snapshot();
      const saved = await this.persistChange((overrides) => overrides.delete(id));
      if (!saved) return false;
      this.emit(previous);
      return true;
    });
  }

  /**
   * Applies one provider's change to the current lists and saves it. When GitHub
   * refuses the save because the file moved on (another device, a redeploy, or a
   * manual commit), the newer file is read in and the same single-provider change
   * is applied on top of it, once. Other providers' lists are never overwritten:
   * only the list being edited is this save's to replace.
   *
   * `change(overrides)` mutates a copy and returns false when there is nothing to save.
   */
  async persistChange(change) {
    const attempt = async () => {
      const next = new Map(this.overrides);
      if (change(next) === false) return false;
      await this.persist(next);
      return true;
    };
    try {
      return await attempt();
    } catch (error) {
      if (!this.remote || error?.type !== "conflict") throw error;
      await this.init();
      if (!this.remoteReady) throw error;
      return attempt();
    }
  }
}

/**
 * Puts the saved lists onto the live provider configuration. `baseline` holds
 * each provider's environment list, so resetting a provider (or a list that was
 * removed from the file) restores exactly what the env gave it.
 */
export function applyProviderModelOverrides(config, overrides, baseline) {
  for (const [id, envModels] of Object.entries(baseline ?? {})) {
    const provider = config.providers?.[id];
    if (!provider) continue;
    provider.models = [...(overrides?.[id] ?? envModels)];
  }
}
