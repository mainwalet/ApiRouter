import http from "node:http";
import https from "node:https";
import { stripApiVersion, openAiSuffixPath } from "./url-utils.js";
import {
  CUSTOM_PROTOCOLS, PlaygroundError, guardedLookup, scrub, describeUpstreamError, networkErrorMessage,
  validateEndpointBaseUrl
} from "./custom-playground.js";

/**
 * Model discovery for a custom endpoint.
 *
 * The operator types a base URL + API key, this asks the provider which models
 * it serves (the provider's own "list models" call), and the control panel lets
 * the operator tick the ones to save. Nothing is stored here: the key is held
 * in memory for the request, never logged, and scrubbed from any error text.
 *
 * It follows the same SSRF rules as the Playground (see custom-playground.js):
 * guarded DNS lookup on the address actually connected to, no redirects,
 * http(s) only, private hosts refused unless PLAYGROUND_ALLOW_PRIVATE_HOSTS.
 */

const MAX_PAGES = 5;
const MAX_MODELS = 2000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_KEY_LENGTH = 4096;

/**
 * Cloudflare Workers AI's OpenAI-compatible base is
 * `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`. That surface only serves
 * chat/embeddings/responses: `GET .../ai/v1/models` answers 405 ("GET not supported for
 * requested URI", code 7001). The model catalogue lives one level up, at
 * `.../ai/models/search`, which is paginated and answers `{ result: [...], result_info }`.
 */
const WORKERS_AI_BASE = /^(https?:\/\/[^/]+\/client\/v4\/accounts\/[^/]+\/ai)\/v1$/i;
export const isWorkersAiBase = (base) => WORKERS_AI_BASE.test(String(base ?? "").replace(/\/+$/, ""));

const join = (base, suffix) => `${String(base).replace(/\/+$/, "")}/${String(suffix).replace(/^\/+/, "")}`;

/** The "list models" request for one API style. `page` carries the pagination cursor, if any. */
export function buildModelsRequest({ protocol, baseUrl, apiKey, page = null }) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const headers = { accept: "application/json", "accept-encoding": "identity", "user-agent": "apirouter-discovery" };
  let url;

  if (protocol === "anthropic") {
    url = new URL(join(base, "v1/models"));
    url.searchParams.set("limit", "1000");
    if (page) url.searchParams.set("after_id", page);
    if (apiKey) { headers.authorization = `Bearer ${apiKey}`; headers["x-api-key"] = apiKey; }
    headers["anthropic-version"] = "2023-06-01";
  } else if (protocol === "gemini") {
    url = new URL(join(stripApiVersion(base), "v1beta/models"));
    url.searchParams.set("pageSize", "1000");
    if (page) url.searchParams.set("pageToken", page);
    if (apiKey) headers["x-goog-api-key"] = apiKey;
  } else if (isWorkersAiBase(base)) {
    // Chat models only: the router sends chat completions, so embeddings, image and speech
    // models would just clutter the list the operator ticks from.
    url = new URL(join(base.replace(/\/v1$/i, ""), "models/search"));
    url.searchParams.set("per_page", "100");
    url.searchParams.set("task", "Text Generation");
    if (page) url.searchParams.set("page", page);
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  } else {
    // openai-chat and openai-responses share the same model list.
    url = new URL(join(base, openAiSuffixPath(base, "models")));
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  }
  return { url, headers };
}

const cleanId = (value) => {
  const id = String(value ?? "").trim();
  return id && id.length <= MAX_ID_LENGTH && !/[\u0000-\u001F\u007F\s]/.test(id) ? id : null;
};

/**
 * Pulls model ids out of whatever shape the provider answered with. Returns
 * { ids, next } where `next` is the cursor for the following page (or null).
 */
export function parseModelsResponse(protocol, payload) {
  const ids = [];
  let next = null;

  if (protocol === "gemini") {
    for (const item of Array.isArray(payload?.models) ? payload.models : []) {
      const methods = item?.supportedGenerationMethods;
      if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
      const id = cleanId(String(item?.name ?? "").replace(/^models\//, ""));
      if (id) ids.push(id);
    }
    next = payload?.nextPageToken || null;
    return { ids, next };
  }

  // Workers AI catalogue: model ids are in `name` ("@cf/..."); `id` is an opaque UUID.
  if (Array.isArray(payload?.result)) {
    for (const item of payload.result) {
      const id = cleanId(item?.name);
      if (id) ids.push(id);
    }
    const info = payload?.result_info;
    const page = Number(info?.page);
    const perPage = Number(info?.per_page);
    const total = Number(info?.total_count);
    if (page >= 1 && perPage >= 1 && total > page * perPage) next = String(page + 1);
    return { ids, next };
  }

  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
    : [];
  for (const item of list) {
    const id = cleanId(typeof item === "string" ? item : item?.id ?? item?.name ?? item?.model);
    if (id) ids.push(id);
  }
  if (protocol === "anthropic" && payload?.has_more && payload?.last_id) next = String(payload.last_id);
  return { ids, next };
}

function fetchJson({ url, headers }, { lookup, timeoutMs, apiKey }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, { method: "GET", headers, lookup, timeout: timeoutMs });
    const fail = (status, type, message) => reject(new PlaygroundError(status, type, message));

    request.on("timeout", () => { const error = new Error("timeout"); error.code = "ETIMEDOUT"; request.destroy(error); });
    request.on("error", (error) => fail(502, "upstream_unreachable", networkErrorMessage(error)));
    request.on("response", (response) => {
      const status = response.statusCode ?? 502;
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { tooLarge = true; response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on("error", () => fail(502, "upstream_error", tooLarge ? "The model list is too large." : "The connection broke while reading the model list."));
      response.on("close", () => {
        if (tooLarge) return fail(502, "upstream_error", "The model list is too large.");
        const text = Buffer.concat(chunks).toString("utf8");
        if (status >= 300 && status < 400) {
          return fail(502, "upstream_redirect", `The host answered with a redirect (HTTP ${status}). Redirects are not followed — use the final URL as the base URL.`);
        }
        if (status === 401 || status === 403) {
          const detail = describeUpstreamError(text, apiKey);
          return fail(502, "upstream_auth", apiKey
            ? `The provider rejected the API key (HTTP ${status})${detail ? `: ${detail}` : ""}`
            : `This provider needs an API key to list its models (HTTP ${status}). Enter a key above and fetch again${detail ? `: ${detail}` : ""}`);
        }
        if (status === 404) {
          return fail(502, "upstream_not_found", "This base URL has no model list (HTTP 404). Check the base URL and API style, or type the model names by hand.");
        }
        if (status < 200 || status >= 300) {
          const detail = describeUpstreamError(text, apiKey);
          return fail(502, "upstream_error", `Upstream returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
        }
        try { resolve(JSON.parse(text)); }
        catch { fail(502, "upstream_error", "The host answered, but not with a JSON model list. Check the base URL and API style."); }
      });
    });
    request.end();
  });
}

/**
 * @returns async ({ protocol, baseUrl, apiKey }) => { models: string[], count, truncated }
 * `baseUrl` must already be validated (validateEndpointBaseUrl).
 */
export function createModelDiscovery({ allowPrivateHosts = false, timeoutMs = 20_000, lookup = null } = {}) {
  const guarded = lookup ?? guardedLookup(allowPrivateHosts);
  return async function discoverModels({ protocol, baseUrl, apiKey = "" }) {
    const seen = new Set();
    let page = null;
    let truncated = false;
    try {
      for (let index = 0; index < MAX_PAGES; index += 1) {
        const request = buildModelsRequest({ protocol, baseUrl, apiKey, page });
        const payload = await fetchJson(request, { lookup: guarded, timeoutMs, apiKey });
        const { ids, next } = parseModelsResponse(protocol, payload);
        for (const id of ids) {
          if (seen.size >= MAX_MODELS) { truncated = true; break; }
          seen.add(id);
        }
        page = next;
        if (!page || truncated || ids.length === 0) break;
      }
      if (page) truncated = true; // more pages exist than were read
    } catch (error) {
      if (error instanceof PlaygroundError) {
        throw new PlaygroundError(error.status, error.type, scrub(error.message, apiKey));
      }
      throw error;
    }
    const models = [...seen].sort((a, b) => a.localeCompare(b));
    if (models.length === 0) {
      throw new PlaygroundError(502, "no_models", "Connected, but the provider returned no models. Type the model names by hand.");
    }
    return { models, count: models.length, truncated };
  };
}

/**
 * Turns the request body of POST /api/custom-endpoints/discover into
 * { protocol, baseUrl, apiKey }. When `endpointId` names a saved endpoint, any
 * field the caller left out comes from it, so the Edit form can re-fetch the
 * model list with the key that is already saved (keys never reach the browser).
 */
export function resolveDiscoveryInput(input, { store = null, allowPrivateHosts = false } = {}) {
  const bad = (message) => new PlaygroundError(400, "invalid_request_error", message);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Request body must be a JSON object");

  let saved = null;
  if (input.endpointId !== undefined && input.endpointId !== null && input.endpointId !== "") {
    saved = store?.get(String(input.endpointId)) ?? null;
    if (!saved) throw new PlaygroundError(404, "not_found", `no custom endpoint "${String(input.endpointId).slice(0, 80)}"`);
  }

  const protocol = String(input.protocol ?? saved?.protocol ?? "openai-chat");
  if (!CUSTOM_PROTOCOLS.includes(protocol)) throw bad(`protocol must be one of: ${CUSTOM_PROTOCOLS.join(", ")}`);

  const rawBase = String(input.baseUrl ?? "").trim() || saved?.baseUrl || "";
  const baseUrl = validateEndpointBaseUrl(rawBase, { allowPrivateHosts });

  let apiKey = String(input.apiKey ?? "").trim();
  // A saved key is only ever sent to the host it was saved for.
  if (!apiKey && saved && baseUrl === saved.baseUrl) apiKey = saved.apiKeys[0] ?? "";
  if (apiKey.length > MAX_KEY_LENGTH || /[\u0000-\u001F\u007F]/.test(apiKey)) {
    throw bad("API key contains characters that cannot be sent in a header");
  }
  return { protocol, baseUrl, apiKey };
}

/**
 * Discovery input for a BUILT-IN provider (groq, gemini, openrouter, ...), from
 * the router's own configuration: its first API key and its base URL, both of
 * which stay on the server. The Providers page only names the provider.
 */
export function resolveProviderDiscoveryInput(providerId, providers, { allowPrivateHosts = false } = {}) {
  const id = String(providerId ?? "").trim().toLowerCase();
  const provider = providers?.[id];
  if (!id || !provider || provider.custom === true) {
    throw new PlaygroundError(404, "not_found", `no built-in provider "${id.slice(0, 80)}"`);
  }
  const envName = provider.envPrefix || id.toUpperCase();
  const apiKey = provider.apiKeys?.[0] ?? "";
  if (!apiKey) {
    throw new PlaygroundError(400, "invalid_request_error", `${envName}_API_KEYS is empty: add an API key first, then fetch the model list.`);
  }
  const rawBase = (Array.isArray(provider.baseUrls) ? provider.baseUrls[0] : "") || provider.baseUrl || "";
  if (!rawBase) {
    throw new PlaygroundError(400, "invalid_request_error", id === "cloudflare"
      ? "CLOUDFLARE_ACCOUNT_IDS is empty: add the account id first, then fetch the model list."
      : `${envName}_BASE_URL is empty: set the base URL first, then fetch the model list.`);
  }
  const baseUrl = validateEndpointBaseUrl(rawBase, { allowPrivateHosts });
  return { protocol: id === "gemini" ? "gemini" : "openai-chat", baseUrl, apiKey };
}
