import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CAPABILITY_IDS,
  DEFAULT_CAPABILITIES,
  MAX_CONTEXT_LIMIT,
  inferCapabilities,
  normalizeCapabilities,
  normalizeContextLimit,
  unsupportedCapabilities
} from "./model-capabilities.js";

/**
 * The unified model configuration: ONE normalized source for which provider/model
 * combinations exist, whether they are enabled, and which capabilities they
 * declare.
 *
 * Two layers, deliberately:
 *
 *   environment   every provider/model that `buildTargets` can reach: its keys,
 *                 base URL and protocols still come from the existing
 *                 provider configuration (env or a saved custom endpoint). These
 *                 entries are synthesized on every read and are marked
 *                 `capabilitiesSource: "inferred"`.
 *   overrides     the entries this store persists: operator declarations that
 *                 are saved locally and (optionally) in GitHub. They are marked
 *                 `"configured"`.
 *
 * An override for the same `provider/model` replaces the inferred declaration
 * for that pair — deterministically, with no merge and no partial precedence. A
 * model with no override keeps working exactly as it always has, which is what
 * makes a deployment with no unified configuration file (or an unreachable
 * GitHub) behave as before.
 *
 * The persisted document is PLAIN JSON and contains model ids, capability
 * declarations, flags, protocol hints and a small metadata bag. It must never
 * contain credentials: secret-shaped fields and token-shaped values are refused
 * even inside `metadata`, and there is no code path that reads a provider key
 * into it. Keys stay in `.env`, `data/custom-endpoints.json`, or the encrypted
 * GitHub blob those already use.
 *
 * Schema versions: `version` is the integer schema. This build understands 1.
 * A document written by a NEWER build is refused rather than reinterpreted (and
 * never overwritten), so a downgrade cannot silently lose fields it does not
 * know about.
 */

export const MODEL_CONFIG_SCHEMA_VERSION = 1;
export const MODEL_PROTOCOLS = Object.freeze(["openai-chat", "openai-responses", "anthropic", "gemini"]);
export const MAX_MODEL_CONFIG_ENTRIES = 500;

const MAX_PROVIDER_LENGTH = 100;
const MAX_MODEL_LENGTH = 300;
const MAX_NAME_LENGTH = 120;
const MAX_METADATA_BYTES = 4000;
const RETRY_INTERVAL_MS = 60_000;

const hasControlChars = (text) => /[\u0000-\u001F\u007F]/.test(text);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Top-level fields that name a credential. Refused explicitly, not silently dropped. */
const SECRET_FIELDS = new Set([
  "apikey", "apikeys", "key", "keys", "token", "tokens", "secret", "secrets",
  "password", "passphrase", "authorization", "bearer", "credential", "credentials",
  "auth", "clientsecret", "client_secret"
]);

/** A metadata key that names a credential, in any casing/spelling. */
const SECRET_KEY = /^(api[-_]?keys?|access[-_]?keys?|private[-_]?keys?|keys?|tokens?|secrets?|password|passphrase|authorization|bearer|credentials?|client[-_]?secret)$/i;
// Known provider token shapes. This is intentionally checked on every free-text
// field (model id, display name, metadata) so a credential pasted into the wrong
// box is refused instead of becoming part of the persisted document.
const SECRET_VALUE = /^(?:sk-[A-Za-z0-9_-]{6,}|(?:pk|rk|gsk|xai|pplx|hf|fal|r8|glpat|shpat)[-_][A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{6,}|xox[baprs]-[A-Za-z0-9-]{6,}|AIza[0-9A-Za-z_-]{10,}|Bearer\s+\S+)/i;
const UNSAFE_METADATA_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const secretValue = (value) => typeof value === "string" && SECRET_VALUE.test(value.trim());

export class ModelConfigError extends Error {
  constructor(status, message, type = "invalid_request") {
    super(message);
    this.status = status;
    this.type = type;
  }
}

const bad = (message, type = "invalid_request") => new ModelConfigError(400, message, type);

/** A deterministic id, so two devices deriving the same model produce the same id. */
export function modelConfigId(provider, model) {
  const digest = crypto.createHash("sha1").update(`${String(provider).trim().toLowerCase()}/${String(model).trim()}`).digest("hex");
  return `mc_${digest.slice(0, 16)}`;
}

export const legacyModelConfigId = (provider, model) => `legacy:${provider}/${model}`;

function cleanProvider(value) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!provider) throw bad("provider is required");
  if (provider.length > MAX_PROVIDER_LENGTH || hasControlChars(provider) || !/^[a-z0-9][a-z0-9._-]*$/.test(provider)) {
    throw bad("provider is not a valid provider id");
  }
  if (secretValue(provider)) throw bad("provider looks like a credential; model configuration must not hold credentials", "secret_rejected");
  return provider;
}

function cleanModel(value) {
  const model = typeof value === "string" ? value.trim() : "";
  if (!model) throw bad("model is required");
  if (model.length > MAX_MODEL_LENGTH || hasControlChars(model)) throw bad("model is not a valid model id");
  if (secretValue(model)) throw bad("model looks like a credential; model configuration must not hold credentials", "secret_rejected");
  return model;
}

function cleanDisplayName(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const name = String(value).trim();
  if (name.length > MAX_NAME_LENGTH || hasControlChars(name)) throw bad(`displayName must be at most ${MAX_NAME_LENGTH} characters`);
  if (secretValue(name)) throw bad("displayName looks like a credential; model configuration must not hold credentials", "secret_rejected");
  return name;
}

function assertNoSecretFields(input, path = "") {
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_FIELDS.has(key.toLowerCase().replace(/[-_]/g, ""))) {
      throw bad(`"${path}${key}" is not accepted: model configuration never stores credentials. Configure keys on the provider instead.`, "secret_rejected");
    }
    if (typeof value === "string" && secretValue(value)) {
      throw bad(`"${path}${key}" looks like a credential; model configuration must not hold credentials`, "secret_rejected");
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (typeof item === "string" && secretValue(item)) {
          throw bad(`"${path}${key}[${index}]" looks like a credential; model configuration must not hold credentials`, "secret_rejected");
        }
      }
    }
  }
}

function cleanMetadata(value) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw bad("metadata must be an object");
  const out = {};
  let count = 0;
  const walk = (source, target, depth) => {
    if (depth > 4) throw bad("metadata is nested too deeply");
    for (const [rawKey, item] of Object.entries(source)) {
      const key = String(rawKey).trim();
      if (!key || key.length > 80 || hasControlChars(key)) throw bad("metadata contains an invalid key");
      if (UNSAFE_METADATA_KEYS.has(key)) throw bad(`metadata."${key}" is not an allowed key`);
      if (SECRET_KEY.test(key)) throw bad(`metadata."${key}" is not accepted: the model configuration must not hold credentials`, "secret_rejected");
      count += 1;
      if (count > 100) throw bad("metadata has too many fields");
      if (typeof item === "string") {
        if (item.length > 500) throw bad(`metadata."${key}" is too long`);
        if (secretValue(item)) throw bad(`metadata."${key}" looks like a credential; model configuration must not hold credentials`, "secret_rejected");
        target[key] = item;
      } else if (typeof item === "number" || typeof item === "boolean" || item === null) {
        target[key] = item;
      } else if (Array.isArray(item)) {
        if (item.length > 50 || item.some((entry) => typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean")) {
          throw bad(`metadata."${key}" must be a flat list of simple values`);
        }
        for (const entry of item) {
          if (typeof entry === "string" && entry.length > 500) throw bad(`metadata."${key}" contains a value that is too long`);
          if (secretValue(entry)) {
            throw bad(`metadata."${key}" looks like a credential; model configuration must not hold credentials`, "secret_rejected");
          }
        }
        target[key] = [...item];
      } else if (isObject(item)) {
        target[key] = {};
        walk(item, target[key], depth + 1);
      } else {
        throw bad(`metadata."${key}" has an unsupported value`);
      }
    }
  };
  walk(value, out, 0);
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_METADATA_BYTES) {
    throw bad(`metadata must be smaller than ${MAX_METADATA_BYTES} bytes`);
  }
  return out;
}

function cleanProtocol(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const protocol = String(value).trim().toLowerCase();
  if (!MODEL_PROTOCOLS.includes(protocol)) {
    throw bad(`protocol must be one of: ${MODEL_PROTOCOLS.join(", ")}`, "invalid_protocol");
  }
  return protocol;
}

/**
 * A declared context limit, in tokens. `null` (or an empty string) means "not
 * declared": the model is never excluded for size. Anything else must be a whole
 * number of at least 1; a typo is refused on a write instead of being saved as
 * a limit that silently excludes (or never excludes) the model.
 */
function cleanContextLimit(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const limit = normalizeContextLimit(value);
  if (limit === null || (typeof value === "number" && !Number.isInteger(value))) {
    throw bad(`contextLimit must be a whole number of tokens between 1 and ${MAX_CONTEXT_LIMIT}, or empty for "not declared"`, "invalid_context_limit");
  }
  return limit;
}

function cloneEntry(entry) {
  return {
    ...entry,
    capabilities: [...entry.capabilities],
    metadata: structuredClone(entry.metadata ?? {})
  };
}

/**
 * Forgives a bad persisted entry (it is dropped with a warning, never fatal) but
 * never invents fields. Used for both the local mirror and the GitHub document.
 */
export function normalizeStoredEntry(raw) {
  if (!isObject(raw)) return null;
  try {
    // A loaded document gets the same credential check as a write. Known fields
    // are projected below, but a token smuggled into an unknown top-level field
    // still means the document is not safe to keep.
    assertNoSecretFields(raw);
    const provider = cleanProvider(raw.provider);
    const model = cleanModel(raw.model);
    // The id is derived, never trusted: a hand-edited or hostile document must
    // not be able to collide two models or smuggle an arbitrary string through.
    const id = modelConfigId(provider, model);
    if (raw.capabilities !== undefined && !Array.isArray(raw.capabilities)) {
      throw bad("capabilities must be an array of capability ids");
    }
    const { capabilities } = normalizeCapabilities(raw.capabilities);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
      throw bad("enabled must be true or false");
    }
    const version = Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 1;
    return {
      id,
      provider,
      model,
      displayName: cleanDisplayName(raw.displayName, model),
      enabled: raw.enabled !== false,
      capabilities,
      protocol: raw.protocol == null ? null : cleanProtocol(raw.protocol),
      // A stored limit that is not a valid size is forgiven as "not declared":
      // dropping the whole entry over it would lose the capabilities it carries.
      contextLimit: normalizeContextLimit(raw.contextLimit),
      metadata: cleanMetadata(raw.metadata),
      version,
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : null,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null
    };
  } catch {
    return null;
  }
}

/** Strict validation for a write. `existing` is the entry being replaced, if any. */
function buildEntry(input, { existing = null, now = Date.now() } = {}) {
  if (!isObject(input)) throw bad("Request body must be a JSON object");
  assertNoSecretFields(input);

  const provider = input.provider === undefined && existing ? existing.provider : cleanProvider(input.provider);
  const model = input.model === undefined && existing ? existing.model : cleanModel(input.model);
  if (existing && (provider !== existing.provider || model !== existing.model)) {
    throw bad("provider and model cannot be changed; remove this configuration and add the new model instead", "identity_immutable");
  }

  const capabilitiesInput = input.capabilities === undefined ? (existing?.capabilities ?? DEFAULT_CAPABILITIES) : input.capabilities;
  if (!Array.isArray(capabilitiesInput)) throw bad("capabilities must be an array of capability ids");
  const { capabilities, unknown } = normalizeCapabilities(capabilitiesInput);

  const enabled = input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled;
  if (typeof enabled !== "boolean") throw bad("enabled must be true or false");

  const protocol = input.protocol === undefined ? (existing?.protocol ?? null) : cleanProtocol(input.protocol);
  const metadata = input.metadata === undefined ? (existing?.metadata ?? {}) : cleanMetadata(input.metadata);
  const displayName = cleanDisplayName(input.displayName, existing?.displayName ?? model);
  // Omitted keeps the saved limit; an explicit null / "" clears it.
  const contextLimit = input.contextLimit === undefined ? (existing?.contextLimit ?? null) : cleanContextLimit(input.contextLimit);

  return {
    entry: {
      id: existing?.id ?? modelConfigId(provider, model),
      provider,
      model,
      displayName,
      enabled,
      capabilities,
      protocol,
      contextLimit,
      metadata,
      version: MODEL_CONFIG_SCHEMA_VERSION,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    },
    warnings: unknown.map((id) => `Ignored unknown capability "${id}"; this build does not understand it.`)
  };
}

export class ModelConfigStore {
  /**
   * @param file    local mirror path ("" keeps it in memory, as in tests)
   * @param remote  optional plain GitHub storage (see remote-storage.js). When
   *                set it is the source of truth; the local file is a mirror,
   *                because the disk may be wiped on every redeploy.
   */
  constructor({ file = null, remote = null, logger = console } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.remote = remote ?? null;
    this.logger = logger;
    this.entries = [];
    this.revision = crypto.randomUUID();
    this.updatedAt = Date.now();
    this.remoteReady = !remote;
    this.remoteRevision = null;
    this.lastRemoteError = null;
    // Set when the local file is valid but was written by a newer schema. In
    // local-only mode that file is the source of truth, so a save must refuse
    // instead of replacing fields this build does not understand.
    this.localBlocked = null;
    this.skipped = [];
    this.warnings = [];
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.retryTimer = null;
    this.loadLocal();
  }

  // -------------------------------------------------------------------------
  // Loading and persistence
  // -------------------------------------------------------------------------

  loadLocal() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.applyDocument(parsed);
    } catch (error) {
      if (error instanceof ModelConfigError && error.type === "schema_too_new") {
        this.localBlocked = { status: error.status, message: error.message, type: error.type };
      }
      this.warnings = [`Ignored the local model configuration: ${error?.message ?? error}`];
      this.logger?.warn?.(`model config: ignoring ${this.file} (${error?.message ?? error})`);
    }
  }

  /**
   * Validates a whole document and adopts it atomically. Nothing is assigned
   * until the version, revision and every entry have been read, so a malformed
   * document cannot half-adopt.
   */
  applyDocument(parsed) {
    if (!isObject(parsed)) throw new ModelConfigError(400, "The model configuration is not a JSON object", "invalid_document");
    const version = Number(parsed.version ?? 1);
    if (!Number.isInteger(version) || version < 1) {
      throw new ModelConfigError(400, "The model configuration has no valid schema version", "invalid_document");
    }
    if (version > MODEL_CONFIG_SCHEMA_VERSION) {
      throw new ModelConfigError(
        409,
        `The saved model configuration uses schema ${version}; this build understands ${MODEL_CONFIG_SCHEMA_VERSION}. Upgrade the gateway instead of overwriting it.`,
        "schema_too_new"
      );
    }

    const entries = [];
    const skipped = [];
    const seenIds = new Set();
    const seenModels = new Set();
    let models = [];
    if (parsed.models !== undefined) {
      if (!Array.isArray(parsed.models)) throw new ModelConfigError(400, "models must be an array", "invalid_document");
      models = parsed.models;
    }
    for (const raw of models) {
      const entry = normalizeStoredEntry(raw);
      if (!entry) { skipped.push("malformed entry"); continue; }
      if (seenIds.has(entry.id)) { skipped.push(`duplicate id ${entry.id}`); continue; }
      const key = `${entry.provider}/${entry.model}`;
      if (seenModels.has(key)) { skipped.push(`duplicate ${key}`); continue; }
      if (entries.length >= MAX_MODEL_CONFIG_ENTRIES) { skipped.push("too many entries"); break; }
      seenIds.add(entry.id);
      seenModels.add(key);
      entries.push(entry);
    }

    const revision = typeof parsed.revision === "string" && parsed.revision.trim() ? parsed.revision.trim().slice(0, 120) : crypto.randomUUID();
    const parsedAt = Date.parse(parsed.updatedAt);
    this.entries = entries;
    this.revision = revision;
    this.updatedAt = Number.isFinite(parsedAt) ? parsedAt : Date.now();
    this.skipped = skipped;
    this.warnings = skipped.map((reason) => `Ignored a saved model entry: ${reason}`);
  }

  serialize({ entries = this.entries, revision = this.revision, updatedAt = this.updatedAt } = {}) {
    // A new document is always written at the version this build understands;
    // an older version is migrated by normalization, never by rewriting fields.
    return JSON.stringify({
      version: MODEL_CONFIG_SCHEMA_VERSION,
      revision,
      updatedAt: new Date(updatedAt).toISOString(),
      models: entries.map(cloneEntry)
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
   * Reads the remote copy. Remote wins over the local mirror (a fresh container
   * starts with an empty or stale file). When GitHub holds nothing yet, the
   * local entries are uploaded once, so an installation that configured models
   * before enabling persistence does not lose them.
   *
   * Never throws: an unavailable remote leaves the local configuration usable.
   * Returns true when the adopted entries changed.
   */
  async init() {
    if (!this.remote) return false;
    try {
      const snapshot = await this.remote.read();
      let changed = false;
      if (snapshot === null) {
        this.remoteRevision = null;
        if (this.entries.length > 0) {
          const result = await this.remote.write(this.serialize(), { expectedRevision: null });
          this.remoteRevision = result?.revision ?? null;
          try { this.writeLocal(this.serialize()); } catch { /* the mirror is optional */ }
        }
      } else {
        const before = JSON.stringify(this.entries);
        this.applyDocument(JSON.parse(snapshot.text));
        changed = JSON.stringify(this.entries) !== before;
        this.remoteRevision = snapshot.revision;
        try { this.writeLocal(this.serialize()); } catch { /* the mirror is optional */ }
      }
      this.remoteReady = true;
      this.lastRemoteError = null;
      return changed;
    } catch (error) {
      this.remoteReady = false;
      this.lastRemoteError = error?.message ?? String(error);
      this.logger?.warn?.(`model config: remote storage not available (${this.lastRemoteError}); using the local configuration until it answers`);
      return false;
    }
  }

  /**
   * Re-reads the remote copy through the same queue as writes. Without this a
   * background refresh could adopt an older snapshot and then a queued save
   * could persist it over the newer document it never saw.
   */
  refresh() {
    return this.exclusive(async () => {
      const previous = this.entries;
      const changed = await this.init();
      if (changed) this.emit(previous);
      return changed;
    });
  }

  /** Keeps trying to reach GitHub, then hot-loads what it holds. */
  startRetry() {
    if (!this.remote || this.retryTimer) return;
    this.retryTimer = setInterval(async () => {
      if (this.remoteReady) { clearInterval(this.retryTimer); this.retryTimer = null; return; }
      await this.refresh();
      if (this.remoteReady) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
      }
    }, RETRY_INTERVAL_MS);
    this.retryTimer.unref?.();
  }

  stopRetry() {
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
  }

  storageInfo() {
    if (!this.remote) {
      return { mode: "file", location: this.file || "memory", ready: true, error: null, localOnly: true };
    }
    return {
      mode: this.remote.name ?? "github",
      location: this.remote.location,
      ready: this.remoteReady,
      error: this.remoteReady ? null : this.lastRemoteError,
      localOnly: false
    };
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Observers receive the new list and the previous one. The previous list is
   * how the Model Switch can be reconciled for entries a refresh removed; it is
   * a copy, so a listener cannot mutate store state.
   */
  emit(previousEntries = []) {
    const current = this.list();
    const previous = previousEntries.map(cloneEntry);
    for (const listener of this.listeners) {
      try { listener(current, previous); } catch { /* observers must never break a save */ }
    }
  }

  /**
   * With a remote configured, a change is refused while it cannot be read:
   * writing then could replace a newer configuration with one that never saw it.
   */
  async ensureReady() {
    if (this.remoteReady) return;
    const previous = this.entries;
    const changed = await this.init();
    if (!this.remoteReady) {
      throw new ModelConfigError(
        503,
        `Remote storage is not reachable (${this.lastRemoteError ?? "unknown error"}). Nothing was saved.`,
        "unavailable"
      );
    }
    if (changed) this.emit(previous);
  }

  /**
   * Durable state first: the document is written to GitHub (when configured),
   * then mirrored locally, and only afterwards adopted in memory. A failed
   * write therefore leaves the running configuration and the saved one in
   * agreement.
   */
  async persist(nextEntries) {
    const revision = crypto.randomUUID();
    const updatedAt = Date.now();
    const text = this.serialize({ entries: nextEntries, revision, updatedAt });

    if (this.remote) {
      try {
        const result = await this.remote.write(text, { expectedRevision: this.remoteRevision });
        this.remoteRevision = result?.revision ?? this.remoteRevision;
      } catch (error) {
        if (error?.code === "conflict" || error?.status === 409) {
          throw new ModelConfigError(409, error.message, "conflict");
        }
        throw new ModelConfigError(
          503,
          `Could not save the model configuration (${error?.message ?? "remote storage unavailable"}). Nothing was saved.`,
          "unavailable"
        );
      }
      try { this.writeLocal(text); } catch { /* the mirror is optional when GitHub holds the truth */ }
    } else {
      if (this.localBlocked) {
        throw new ModelConfigError(this.localBlocked.status, this.localBlocked.message, this.localBlocked.type);
      }
      try {
        this.writeLocal(text);
      } catch (error) {
        throw new ModelConfigError(500, `Could not save the model configuration (${error?.message ?? "local write failed"})`, "server_error");
      }
    }

    this.entries = nextEntries;
    this.revision = revision;
    this.updatedAt = updatedAt;
    this.lastRemoteError = null;
    return { revision, updatedAt };
  }

  /** Resolves once every queued write/refresh has finished, so a read never shows a half-applied change. */
  idle() {
    return this.queue.catch(() => {});
  }

  exclusive(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The persisted overrides only. Copies, never live references. */
  list() {
    return this.entries.map(cloneEntry);
  }

  get(id) {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  overrideFor(provider, model) {
    const wantedProvider = String(provider ?? "").trim().toLowerCase();
    const wantedModel = String(model ?? "").trim();
    return this.entries.find((entry) => entry.provider === wantedProvider && entry.model === wantedModel) ?? null;
  }

  /**
   * THE effective model index. One row per provider/model, built from the live
   * targets (the environment) and overlaid with the persisted overrides. Every
   * routing and UI decision reads this, so a checkbox, a stored flag and a
   * routing filter cannot disagree.
   *
   * The returned Map is keyed `provider/model`.
   */
  index(targets = []) {
    const groups = new Map();
    const touch = (provider, model) => {
      const id = `${provider}/${model}`;
      if (!groups.has(id)) {
        groups.set(id, {
          provider,
          model,
          protocols: new Set(),
          keyCount: 0,
          configuredInEnvironment: false
        });
      }
      return groups.get(id);
    };

    for (const target of Array.isArray(targets) ? targets : []) {
      if (!target?.provider || !target?.model) continue;
      const group = touch(target.provider, target.model);
      for (const protocol of target.protocols ?? []) group.protocols.add(protocol);
      group.keyCount += 1;
      group.configuredInEnvironment = true;
    }

    // A persisted entry whose model is not configured here is kept visible: it
    // may be restored on another device that does have the provider, and it must
    // be possible to see and remove it rather than have it vanish.
    for (const entry of this.entries) touch(entry.provider, entry.model);

    const index = new Map();
    for (const [id, group] of groups) {
      const stored = this.overrideFor(group.provider, group.model);
      const protocols = [...group.protocols];
      // Capabilities come from the stored declaration, or default to
      // text_input + text_output for models nobody has declared yet.
      const capabilities = stored ? [...stored.capabilities] : inferCapabilities({ protocols });
      const executable = protocols.length > 0
        ? capabilities.filter((capability) => !unsupportedCapabilities([capability], protocols).length)
        : [];
      const unsupported = protocols.length > 0
        ? unsupportedCapabilities(capabilities, protocols)
        : [];

      const warnings = [];
      if (stored && !group.configuredInEnvironment) {
        warnings.push("No provider currently configures this model, so it cannot be routed.");
      }
      if (stored && unsupported.length > 0) {
        warnings.push(`No adapter can execute: ${unsupported.join(", ")}.`);
      }
      if (stored?.protocol && protocols.length > 0 && !protocols.includes(stored.protocol)) {
        warnings.push(`The provider does not offer the configured ${stored.protocol} protocol.`);
      }
      if (stored && capabilities.length === 0) {
        warnings.push("No capabilities are declared, so this model is never selected.");
      }

      index.set(id, {
        id: stored?.id ?? legacyModelConfigId(group.provider, group.model),
        configId: stored?.id ?? null,
        stored: Boolean(stored),
        provider: group.provider,
        model: group.model,
        displayName: stored?.displayName ?? group.model,
        enabled: stored ? stored.enabled : true,
        // `enabled` here is the unified configuration's own flag. The Model
        // Switch is applied separately by its owner (see server.js/api.js), so
        // the two flags are never conflated.
        capabilities,
        capabilitiesSource: stored ? "configured" : "inferred",
        executableCapabilities: executable,
        unsupportedCapabilities: unsupported,
        protocol: stored?.protocol ?? null,
        // Tokens the model can hold, or null when nobody declared it. Routing
        // skips a model only when this is set AND the request is larger.
        contextLimit: stored?.contextLimit ?? null,
        metadata: stored ? structuredClone(stored.metadata ?? {}) : {},
        protocols,
        keyCount: group.keyCount,
        configuredInEnvironment: group.configuredInEnvironment,
        warnings,
        updatedAt: stored?.updatedAt ?? null,
        createdAt: stored?.createdAt ?? null
      });
    }

    return index;
  }

  /** One row per provider/model, sorted for a stable UI. */
  listEffective(targets = []) {
    return [...this.index(targets).values()].sort((a, b) =>
      a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  }

  /** True only when a persisted override switches this model off. */
  explicitlyDisabled(provider, model) {
    return this.overrideFor(provider, model)?.enabled === false;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * @param knownModels     optional Set of `provider/model` that the environment
   *                        actually configures. Enforced so a typo cannot create
   *                        an entry nobody can route to or see.
   * @param defaults        optional { capabilities } used when the caller did
   *                        not state any (derived from the provider's protocols).
   */
  create(input, { knownModels = null, defaults = null } = {}) {
    return this.exclusive(async () => {
      await this.ensureReady();
      const prepared = { ...input };
      if (prepared.capabilities === undefined && defaults?.capabilities) prepared.capabilities = defaults.capabilities;
      const { entry, warnings } = buildEntry(prepared);
      if (knownModels && !knownModels.has(`${entry.provider}/${entry.model}`)) {
        throw new ModelConfigError(400, `"${entry.provider}/${entry.model}" is not configured by any provider`, "unknown_model");
      }
      const existing = this.overrideFor(entry.provider, entry.model);
      if (existing) {
        throw new ModelConfigError(
          409,
          `"${entry.provider}/${entry.model}" already has a saved model configuration. Edit it instead.`,
          "conflict"
        );
      }
      if (this.entries.length >= MAX_MODEL_CONFIG_ENTRIES) {
        throw bad(`At most ${MAX_MODEL_CONFIG_ENTRIES} model configurations`);
      }
      const previous = this.entries;
      await this.persist([...this.entries, entry]);
      this.emit(previous);
      return { entry: cloneEntry(entry), warnings };
    });
  }

  update(id, input, { knownModels = null } = {}) {
    return this.exclusive(async () => {
      await this.ensureReady();
      const current = this.get(id);
      if (!current) throw new ModelConfigError(404, `no model configuration "${id}"`, "not_found");
      const { entry, warnings } = buildEntry(input, { existing: current });
      if (knownModels && !knownModels.has(`${entry.provider}/${entry.model}`)) {
        throw new ModelConfigError(400, `"${entry.provider}/${entry.model}" is not configured by any provider`, "unknown_model");
      }
      const other = this.overrideFor(entry.provider, entry.model);
      if (other && other.id !== current.id) {
        throw new ModelConfigError(409, `"${entry.provider}/${entry.model}" already has a saved model configuration`, "conflict");
      }
      const next = this.entries.map((item) => (item.id === current.id ? entry : item));
      const previous = this.entries;
      await this.persist(next);
      this.emit(previous);
      return { entry: cloneEntry(entry), warnings };
    });
  }

  /**
   * Adds and/or removes capabilities on MANY models in one persisted write.
   *
   * Saving model by model would mean one GitHub commit per model (and a 409
   * race on every one after the first), so the whole batch is validated first
   * and written once: either every model changes or none does.
   *
   * A model with a saved declaration keeps everything else it has (enabled
   * flag, protocol, context limit, display name, metadata) and only its
   * capability list changes. A model with no saved declaration gets one,
   * starting from the capabilities the environment implies for it.
   *
   * @param pairs       [{ provider, model }] the models to change
   * @param add         capability ids to declare
   * @param remove      capability ids to un-declare
   * @param knownModels optional Set of `provider/model` the environment configures
   * @param baseFor     (provider, model) => capabilities an undeclared model starts from
   * @param enabledFor  (provider, model) => enabled flag a NEW declaration starts with
   * @returns { entries (copies of every touched declaration), changed, unchanged, warnings }
   */
  bulkCapabilities(pairs, { add = [], remove = [], knownModels = null, baseFor = null, enabledFor = null } = {}) {
    return this.exclusive(async () => {
      await this.ensureReady();

      if (!Array.isArray(add) || !Array.isArray(remove)) throw bad("add and remove must be arrays of capability ids");
      const adding = normalizeCapabilities(add);
      const removing = normalizeCapabilities(remove);
      if (adding.capabilities.length === 0 && removing.capabilities.length === 0) {
        throw bad("Choose at least one known capability to add or remove");
      }
      const overlap = adding.capabilities.filter((id) => removing.capabilities.includes(id));
      if (overlap.length > 0) throw bad(`"${overlap[0]}" cannot be added and removed in the same request`);

      if (!Array.isArray(pairs) || pairs.length === 0) throw bad("models must be a non-empty list of { provider, model }");
      const seen = new Set();
      const wanted = [];
      for (const pair of pairs) {
        if (!isObject(pair)) throw bad("each model must be an object with provider and model");
        const provider = cleanProvider(pair.provider);
        const model = cleanModel(pair.model);
        const key = `${provider}/${model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (knownModels && !knownModels.has(key) && !this.overrideFor(provider, model)) {
          throw new ModelConfigError(400, `"${key}" is not configured by any provider`, "unknown_model");
        }
        wanted.push({ provider, model });
      }

      const now = Date.now();
      const created = [];
      const touched = new Map(); // id -> next entry
      let unchanged = 0;

      for (const { provider, model } of wanted) {
        const existing = this.overrideFor(provider, model);
        const base = existing
          ? existing.capabilities
          : (typeof baseFor === "function" ? baseFor(provider, model) : null) ?? DEFAULT_CAPABILITIES;
        const next = new Set(normalizeCapabilities(base).capabilities);
        for (const id of adding.capabilities) next.add(id);
        for (const id of removing.capabilities) next.delete(id);
        const capabilities = CAPABILITY_IDS.filter((id) => next.has(id));

        if (existing) {
          const same = capabilities.length === existing.capabilities.length
            && capabilities.every((id, index) => id === existing.capabilities[index]);
          if (same) { unchanged += 1; continue; }
          touched.set(existing.id, { ...existing, capabilities: [...capabilities], updatedAt: now });
        } else {
          const enabled = typeof enabledFor === "function" ? enabledFor(provider, model) !== false : true;
          created.push({
            id: modelConfigId(provider, model),
            provider,
            model,
            displayName: model,
            enabled,
            capabilities,
            protocol: null,
            contextLimit: null,
            metadata: {},
            version: MODEL_CONFIG_SCHEMA_VERSION,
            createdAt: now,
            updatedAt: now
          });
        }
      }

      if (this.entries.length + created.length > MAX_MODEL_CONFIG_ENTRIES) {
        throw bad(`At most ${MAX_MODEL_CONFIG_ENTRIES} model configurations`);
      }

      const warnings = [...adding.unknown, ...removing.unknown]
        .map((id) => `Ignored unknown capability "${id}"; this build does not understand it.`);

      if (touched.size === 0 && created.length === 0) {
        return { entries: [], changed: 0, unchanged, created: 0, warnings };
      }

      const previous = this.entries;
      const next = [...this.entries.map((entry) => touched.get(entry.id) ?? entry), ...created];
      await this.persist(next);
      this.emit(previous);
      return {
        entries: [...touched.values(), ...created].map(cloneEntry),
        changed: touched.size + created.length,
        created: created.length,
        unchanged,
        warnings
      };
    });
  }

  /**
   * Drops the saved declarations of models that no provider lists any more
   * (for example after they were removed on the Providers page). Without this
   * the declaration lingers as a "Configured" ghost row for a model that no
   * longer exists. One persisted write for the whole batch; a no-op (and no
   * write) when none of the pairs has a declaration.
   *
   * @param pairs  [{ provider, model }]
   * @returns the removed entries (copies)
   */
  removeForModels(pairs = []) {
    return this.exclusive(async () => {
      const wanted = new Set(
        (Array.isArray(pairs) ? pairs : [])
          .filter((pair) => pair?.provider && pair?.model)
          .map((pair) => `${String(pair.provider).trim().toLowerCase()}/${String(pair.model).trim()}`)
      );
      if (wanted.size === 0) return [];
      const doomed = this.entries.filter((entry) => wanted.has(`${entry.provider}/${entry.model}`));
      if (doomed.length === 0) return [];
      await this.ensureReady();
      const doomedIds = new Set(doomed.map((entry) => entry.id));
      const previous = this.entries;
      await this.persist(this.entries.filter((entry) => !doomedIds.has(entry.id)));
      this.emit(previous);
      return doomed.map(cloneEntry);
    });
  }

  remove(id) {
    return this.exclusive(async () => {
      await this.ensureReady();
      const current = this.get(id);
      if (!current) throw new ModelConfigError(404, `no model configuration "${id}"`, "not_found");
      // Another request may have edited the same document while this one waited.
      const latest = this.get(id);
      if (!latest) throw new ModelConfigError(404, `no model configuration "${id}"`, "not_found");
      const previous = this.entries;
      await this.persist(this.entries.filter((entry) => entry.id !== latest.id));
      this.emit(previous);
      return { removed: cloneEntry(latest) };
    });
  }
}

/** The capability ids the schema knows, for a caller that wants to validate first. */
export const MODEL_CONFIG_CAPABILITIES = CAPABILITY_IDS;
