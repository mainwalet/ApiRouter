/**
 * Shared URL construction rules for upstream provider endpoints.
 *
 * A configured base URL may or may not already carry the provider's API version
 * (`https://generativelanguage.googleapis.com` vs `.../v1beta`). Every caller
 * that appends a versioned path therefore has to strip a trailing version
 * segment first, or the request goes to `/v1beta/v1beta/models/...`.
 */

/**
 * A trailing API-version path segment: `/v1`, `/v1beta`, `/v2alpha1`.
 * Anchored to the end of the path so it never eats a real path segment such as
 * `/v1beta` inside something longer.
 */
export const API_VERSION_SUFFIX = /\/v\d+(?:alpha|beta)?\d*$/i;

/**
 * A base URL with any trailing API-version segment and trailing slashes removed.
 *
 * A query string or fragment is NOT supported: every caller appends its endpoint
 * path to this result as a plain string, so anything after a `?` would end up
 * with the path inside it. `loadConfig` refuses such a base URL at startup, so
 * this function never has to guess what one would mean — and it deliberately
 * does not try, because a half-handled query here is what lets the rest of the
 * pipeline produce a confidently malformed URL.
 */
export function stripApiVersion(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "").replace(API_VERSION_SUFFIX, "");
}

/**
 * The endpoint path for an OpenAI-compatible API under a configured base URL.
 *
 * Deliberately NOT `stripApiVersion`, and the difference is not an oversight:
 * an OpenAI-compatible base that already ends in a version is taken as the API
 * root WHATEVER that version is, because providers expose `/v1`, `/v2`,
 * `/openai/v1` and stranger paths. Stripping the version and forcing `v1/...`
 * back on would rewrite a working custom base URL into a different endpoint.
 *
 * The Gemini rule is the opposite: there the version segment is fixed
 * (`v1beta`) and a base that already carries it must not get a second copy, so
 * `stripApiVersion` is right. Both rules live here so the contrast is visible.
 */
export function openAiSuffixPath(baseUrl, suffix) {
  return OPENAI_API_ROOT.test(String(baseUrl || "")) ? suffix : "v1/" + suffix;
}

/**
 * An OpenAI-compatible API root: a base that already ends in a version (`/v1`,
 * `/v4`), or in Google's OpenAI-compatible root `/v1beta/openai`, where the
 * version comes BEFORE the `openai` segment and `/v1` must not be added again.
 */
const OPENAI_API_ROOT = /\/v\d+$|\/v\d+(?:alpha|beta)\d*\/openai$/i;
