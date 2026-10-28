import { providerProtocols } from "./adapters.js";

const DEFAULT_RETRY_STATUS_CODES = [401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529];
/**
 * The single source of truth for which providers exist. Every other list —
 * `providers/catalog.js`, the `/health` payload, the env-var audit — hangs off
 * this one, so adding a provider cannot half-register it.
 */
export const PROVIDER_IDS = ["agentrouter", "gemini", "groq", "huggingface", "mistral", "openrouter", "cerebras", "cloudflare", "cohere", "zai", "vercel", "opencode", "nvidia", "pollinations", "llm7", "unorouter"];

const split = (value) => String(value || "").split(",").map((v) => v.trim()).filter(Boolean);

/**
 * Numeric env settings fail fast. An unset or empty variable keeps its default;
 * anything else must be a valid number inside the stated bounds, otherwise
 * startup stops with a clear message. A bad value must never degrade into NaN,
 * 0 or "no limit" (`size > NaN` is never true, which would disable the body cap).
 */
function readNumber(env, name, fallback, { integer = true, min, max = Infinity, expected }) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(String(raw).trim());
  const valid = Number.isFinite(value) && (!integer || Number.isSafeInteger(value)) && value >= min && value <= max;
  if (!valid) throw new Error(`Invalid ${name}: expected ${expected}, got "${String(raw).slice(0, 40)}"`);
  return value;
}

const CLOUDFLARE_API_ROOT = "https://api.cloudflare.com/client/v4/accounts";

/**
 * Cloudflare Workers AI is account-scoped: its OpenAI-compatible endpoint is
 * `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`, so an API
 * token alone is not enough. Accept either a full CLOUDFLARE_BASE_URL (which may
 * use an `{ACCOUNT_ID}` placeholder) or just CLOUDFLARE_ACCOUNT_ID.
 */
export function resolveCloudflareBaseUrl(baseUrl, accountId) {
  const base = String(baseUrl || "").trim();
  const account = String(accountId || "").trim();
  if (base) {
    return account ? base.replace(/\{\s*account[_-]?id\s*\}/gi, account) : base;
  }
  return account ? `${CLOUDFLARE_API_ROOT}/${encodeURIComponent(account)}/ai/v1` : "";
}

/**
 * Pairs each Cloudflare API key with its account id.
 *   CLOUDFLARE_API_KEYS=key1,key2   CLOUDFLARE_ACCOUNT_IDS=id1,id2   -> key1/id1, key2/id2
 * A single id is shared by every key (several tokens, one account). When there
 * are several ids, a key with no matching id is skipped rather than guessed.
 * CLOUDFLARE_ACCOUNT_ID (singular) is accepted as an alias.
 */
function applyCloudflareAccounts(provider, env, prefix = "CLOUDFLARE") {
  const accountIds = split(env[`${prefix}_ACCOUNT_IDS`] || env[`${prefix}_ACCOUNT_ID`]);
  const accountFor = (keyIndex) => (accountIds.length === 1 ? accountIds[0] : accountIds[keyIndex] || "");
  provider.accountIds = accountIds;
  provider.baseUrls = provider.apiKeys.map((_, keyIndex) =>
    resolveCloudflareBaseUrl(env[`${prefix}_BASE_URL`], accountFor(keyIndex)));
  provider.baseUrl = provider.baseUrls.find(Boolean) || resolveCloudflareBaseUrl(env[`${prefix}_BASE_URL`], accountIds[0]);
}

export function isProviderConfigured(provider) {
  return Boolean(provider && provider.apiKeys.length > 0 && provider.models.length > 0 && provider.baseUrl);
}

/**
 * Every reachable `provider + model + keyIndex` combination, from the ONE
 * provider configuration. There is no text/vision split: a model is simply a
 * model, and whether it can serve a request is decided by its declared
 * capabilities in the Model Configurator.
 */
export function buildTargets(providers) {
  const targets = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isProviderConfigured(provider)) continue;
    for (const model of provider.models) {
      for (let keyIndex = 0; keyIndex < provider.apiKeys.length; keyIndex += 1) {
        const baseUrl = Array.isArray(provider.baseUrls) ? provider.baseUrls[keyIndex] : provider.baseUrl;
        if (!baseUrl) continue;
        targets.push({
          provider: providerId,
          model,
          baseUrl,
          apiKey: provider.apiKeys[keyIndex],
          protocols: Array.isArray(provider.protocols) && provider.protocols.length > 0 ? [...provider.protocols] : providerProtocols(providerId),
          clientHeaders: provider.clientHeaders || {},
          keyIndex
        });
      }
    }
  }
  return targets;
}

export function readProviders(env) {
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const key = id.toUpperCase();
    providers[id] = {
      apiKeys: split(env[key + "_API_KEYS"]),
      models: split(env[key + "_MODELS"]),
      baseUrl: id === "cloudflare" ? "" : String(env[key + "_BASE_URL"] || "").trim(),
      envPrefix: key,
      clientHeaders: id === "agentrouter" ? {
        originator: String(env.AGENTROUTER_ORIGINATOR || "").trim(),
        version: String(env.AGENTROUTER_VERSION || "").trim(),
        "user-agent": String(env.AGENTROUTER_USER_AGENT || "").trim()
      } : {}
    };
  }
  applyCloudflareAccounts(providers.cloudflare, env, "CLOUDFLARE");
  return providers;
}

/**
 * Provider prefixes that carry the retired `*_VISION_*` configuration. They are
 * read only to warn the operator: no route, key, model or base URL is taken
 * from them any more. The variables themselves are left untouched in `.env`.
 */
export function legacyVisionPrefixes(env = {}) {
  return PROVIDER_IDS
    .map((id) => id.toUpperCase())
    .filter((prefix) => Object.keys(env ?? {}).some((name) =>
      name.startsWith(prefix + "_VISION_") || name === prefix + "_VISION"));
}

/**
 * A configured base URL must be a plain URL: no query string, no fragment.
 *
 * Every request builder appends its endpoint path to the base URL as a plain
 * string, so `https://gw.example.com/v1?key=abc` becomes
 * `https://gw.example.com/v1?key=abc/v1/chat/completions` — the path lands
 * inside the query value and the provider receives a malformed request. Nothing
 * in the router can express "append to the path, keep the query", so such a base
 * URL cannot work, and it is refused at startup rather than failing every
 * request later with a confusing 404.
 *
 * The URL itself is never echoed: a base URL is the one place an operator is
 * most likely to have pasted a credential, and a startup error must not be the
 * thing that writes it to the logs.
 */
function assertPlainBaseUrls(providers, envSuffix) {
  for (const [id, provider] of Object.entries(providers || {})) {
    const candidates = [provider?.baseUrl, ...(Array.isArray(provider?.baseUrls) ? provider.baseUrls : [])];
    for (const candidate of candidates) {
      const value = String(candidate || "").trim();
      if (!value) continue;
      if (/[?#]/.test(value)) {
        throw new Error(
          `Invalid ${id.toUpperCase()}_${envSuffix}: a base URL must not contain a query string or fragment. `
          + "Point it at the API root only (for example https://api.groq.com/openai/v1)."
        );
      }
    }
  }
}

export function loadConfig(env = process.env) {
  const providers = readProviders(env);
  // Refused before anything else is built: a base URL that cannot carry an
  // appended endpoint path would produce a malformed URL on every request.
  assertPlainBaseUrls(providers, "BASE_URL");
  const retryRaw = env.RETRY_STATUS_CODES;
  const retrySource = retryRaw === undefined || String(retryRaw).trim() === ""
    ? DEFAULT_RETRY_STATUS_CODES.join(",")
    : String(retryRaw);
  const retryParts = retrySource.split(",").map((v) => v.trim());
  if (retryParts.some((v) => !v)) {
    throw new Error(`Invalid RETRY_STATUS_CODES: expected comma-separated HTTP status codes from 100 to 599, got "${String(retryRaw).slice(0, 120)}"`);
  }
  const retryableValues = retryParts.map((raw) => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 100 || value > 599) {
      throw new Error(`Invalid RETRY_STATUS_CODES: expected comma-separated HTTP status codes from 100 to 599, got "${String(retryRaw).slice(0, 120)}"`);
    }
    return value;
  });
  return {
    routerApiKeys: split(env.APIROUTER_API_KEYS),
    // Loopback by default. Binding every interface is opt-in (HOST=0.0.0.0) and
    // refused at startup unless APIROUTER_API_KEYS is set (see server.js).
    host: String(env.HOST ?? "").trim() || "127.0.0.1",
    port: readNumber(env, "PORT", 8788, { min: 0, max: 65535, expected: "an integer from 0 to 65535" }),
    timeoutMs: readNumber(env, "REQUEST_TIMEOUT_MS", 120000, { min: 1, expected: "a positive integer" }),
    // 0 is meaningful here: server.js then uses the full request timeout for streams.
    connectTimeoutMs: readNumber(env, "STREAM_CONNECT_TIMEOUT_MS", 30000, { min: 0, expected: "a non-negative integer (0 disables the separate connect timeout)" }),
    // Longest a stream may go without a single byte AFTER its headers arrived. A provider that
    // answers 200 and then stalls would otherwise hold the request open until the runtime's own
    // 5 minute body timeout. 0 disables it.
    streamIdleTimeoutMs: readNumber(env, "STREAM_IDLE_TIMEOUT_MS", 180000, { min: 0, expected: "a non-negative integer (0 disables the idle timeout)" }),
    retryableStatus: new Set(retryableValues),
    // Sticky target lifetime after a success: 20 minutes (STICKY_TTL_MS only
    // exists so tests can use a short real-clock TTL).
    stickyTtlMs: readNumber(env, "STICKY_TTL_MS", 20 * 60 * 1000, { min: 1, expected: "a positive integer" }),
    // Custom-endpoint playground: let the operator test a base URL on a private
    // address (Ollama, LM Studio, a LAN gateway). Off by default because that
    // endpoint calls whatever URL it is given from the gateway's own network.
    playgroundAllowPrivateHosts: ["1", "true", "yes"].includes(String(env.PLAYGROUND_ALLOW_PRIVATE_HOSTS ?? "").trim().toLowerCase()),
    // The ApiRouter system prompt prepended to every chat request. On by default;
    // SYSTEM_PROMPT=off disables it, SYSTEM_PROMPT_FILE replaces the built-in text.
    systemPromptEnabled: !["off", "0", "false", "no"].includes(String(env.SYSTEM_PROMPT ?? "").trim().toLowerCase()),
    systemPromptFile: String(env.SYSTEM_PROMPT_FILE || "").trim(),
    maxBodyBytes: readNumber(env, "MAX_REQUEST_BODY_BYTES", 10 * 1024 * 1024, { min: 1, max: 100 * 1024 * 1024, expected: "an integer from 1 to 104857600" }),
    // The Fallback Chain: the single source of truth for routing order, plus
    // the selected operating mode. Written by the control panel.
    fallbackChainFile: String(env.FALLBACK_CHAIN_FILE || "").trim() || "data/fallback-chain.json",
    gatewayStateFile: String(env.GATEWAY_STATE_FILE || "").trim() || "data/gateway-state.json",
    // The model effort (low / medium / high / xhigh) chosen in the Control Panel.
    effortStateFile: String(env.EFFORT_STATE_FILE || "").trim() || "data/effort-state.json",
    // Models the operator switched OFF from the control panel (ids only). A
    // disabled model is removed from routing in every mode until switched on.
    disabledModelsFile: String(env.DISABLED_MODELS_FILE || "").trim() || "data/disabled-models.json",
    // One Provider Fallback: the chosen provider and its models, its on/off flag and the per-key
    // cooldowns the operator set (numbers and ids only), plus how long a request
    // may wait when every key it has left is cooling.
    oneModelFile: String(env.ONE_MODEL_FILE || "").trim() || "data/one-model.json",
    // Custom endpoints the operator saved permanently from the control panel:
    // each becomes a provider (id `custom-<name>`) with its own models and keys.
    customEndpointsFile: String(env.CUSTOM_ENDPOINTS_FILE || "").trim() || "data/custom-endpoints.json",
    // Where saved custom endpoints are kept when the disk is wiped on every
    // redeploy (a free Render service). Empty repo = disk only. Keys are
    // encrypted with the secret before they are written; see remote-storage.js.
    //
    // The repository, token, branch and API address fall back to the matching
    // MODEL_CONFIG_GITHUB_* value, so one GitHub setup serves both (the Model
    // Configurator already falls back the other way). Only the secret is its own:
    // API keys are encrypted with it, so it is never guessed or derived.
    // `inherited` is true when the repository came ONLY from MODEL_CONFIG_*: a
    // missing secret is then reported in the panel instead of stopping startup.
    customEndpointsRemote: {
      repo: String(env.CUSTOM_ENDPOINTS_GITHUB_REPO || env.MODEL_CONFIG_GITHUB_REPO || "").trim(),
      token: String(env.CUSTOM_ENDPOINTS_GITHUB_TOKEN || env.MODEL_CONFIG_GITHUB_TOKEN || "").trim(),
      branch: String(env.CUSTOM_ENDPOINTS_GITHUB_BRANCH || env.MODEL_CONFIG_GITHUB_BRANCH || "").trim() || "main",
      path: String(env.CUSTOM_ENDPOINTS_GITHUB_PATH || "").trim() || "custom-endpoints.enc.json",
      apiBase: String(env.CUSTOM_ENDPOINTS_GITHUB_API || env.MODEL_CONFIG_GITHUB_API || "").trim() || "https://api.github.com",
      secret: String(env.CUSTOM_ENDPOINTS_SECRET || "").trim(),
      inherited: !String(env.CUSTOM_ENDPOINTS_GITHUB_REPO || "").trim() && Boolean(String(env.MODEL_CONFIG_GITHUB_REPO || "").trim())
    },
    // The Unified Model Configurator: capability declarations, enabled flags and
    // model metadata (NEVER keys). Non-secret, so it may live in a public file;
    // it is mirrored in GitHub when a repository is configured.
    modelConfigFile: String(env.MODEL_CONFIG_FILE || "").trim() || "data/model-config.json",
    modelConfigRemote: {
      // Model configuration contains no secrets, so it needs no encryption
      // secret. It does reuse the custom-endpoint GitHub setup when no
      // MODEL_CONFIG_GITHUB_* variables are given, so one repository serves both.
      repo: String(env.MODEL_CONFIG_GITHUB_REPO || env.CUSTOM_ENDPOINTS_GITHUB_REPO || "").trim(),
      token: String(env.MODEL_CONFIG_GITHUB_TOKEN || env.CUSTOM_ENDPOINTS_GITHUB_TOKEN || "").trim(),
      branch: String(env.MODEL_CONFIG_GITHUB_BRANCH || env.CUSTOM_ENDPOINTS_GITHUB_BRANCH || "").trim() || "main",
      path: String(env.MODEL_CONFIG_GITHUB_PATH || "").trim() || "model-config.json",
      apiBase: String(env.MODEL_CONFIG_GITHUB_API || env.CUSTOM_ENDPOINTS_GITHUB_API || "").trim() || "https://api.github.com"
    },
    // Model lists chosen on the Providers page ("Fetch Models"), per built-in provider. They replace
    // that provider's <PROVIDER>_MODELS list until reset. Ids only, no secrets, so it is plain JSON and
    // is mirrored in the same GitHub repository as the model configuration (a different file).
    providerModelsFile: String(env.PROVIDER_MODELS_FILE || "").trim() || "data/provider-models.json",
    providerModelsRemote: {
      repo: String(env.PROVIDER_MODELS_GITHUB_REPO || env.MODEL_CONFIG_GITHUB_REPO || env.CUSTOM_ENDPOINTS_GITHUB_REPO || "").trim(),
      token: String(env.PROVIDER_MODELS_GITHUB_TOKEN || env.MODEL_CONFIG_GITHUB_TOKEN || env.CUSTOM_ENDPOINTS_GITHUB_TOKEN || "").trim(),
      branch: String(env.PROVIDER_MODELS_GITHUB_BRANCH || env.MODEL_CONFIG_GITHUB_BRANCH || env.CUSTOM_ENDPOINTS_GITHUB_BRANCH || "").trim() || "main",
      path: String(env.PROVIDER_MODELS_GITHUB_PATH || "").trim() || "provider-models.json",
      apiBase: String(env.PROVIDER_MODELS_GITHUB_API || env.MODEL_CONFIG_GITHUB_API || env.CUSTOM_ENDPOINTS_GITHUB_API || "").trim() || "https://api.github.com"
    },
    // Legacy, read ONCE to seed the chain above when no chain has been saved
    // yet. Never consulted again afterwards: the old systems cannot override
    // the configured chain.
    legacyManualSelectionFile: String(env.MANUAL_SELECTION_FILE || "").trim() || "data/manual-selection.json",
    providers
  };
}