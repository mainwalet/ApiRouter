import { apiRequest } from "./client.js";

/**
 * The Unified Model Configurator.
 *
 * One declaration per provider/model: an enabled flag and the capabilities that
 * model really has. The document holds model ids and capability names only —
 * never a key, base URL or token — and is persisted by the gateway (locally and,
 * when configured, in GitHub) so it survives a redeploy.
 *
 * Reads are deliberately non-conditional: this page is usually opened right
 * after another surface changed a switch, and showing a cached ETag for a
 * second would contradict the checkbox the operator just clicked.
 */
export function getModelConfig({ signal } = {}) {
  return apiRequest("/api/model-config", { signal, conditional: false });
}

export function createModelConfig(input) {
  return apiRequest("/api/model-config", { method: "POST", body: input, retries: 0 });
}

export function updateModelConfig(id, input) {
  return apiRequest(`/api/model-config/${encodeURIComponent(id)}`, { method: "PUT", body: input, retries: 0 });
}

/**
 * Adds and/or removes capabilities on many models in one saved document.
 * `models` is a list of { provider, model } or the string "all".
 */
export function bulkUpdateModelCapabilities({ models, add = [], remove = [] }) {
  return apiRequest("/api/model-config/bulk", { method: "POST", body: { models, add, remove }, retries: 0 });
}

export function removeModelConfig(id) {
  return apiRequest(`/api/model-config/${encodeURIComponent(id)}`, { method: "DELETE", retries: 0 });
}

/** Re-reads the GitHub copy. A failure leaves the last known configuration in force. */
export function refreshModelConfig() {
  return apiRequest("/api/model-config/refresh", { method: "POST", retries: 0 });
}
