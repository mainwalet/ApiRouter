# ApiRouter — Full Architecture

## Overview

ApiRouter is a protocol-aware multi-provider AI gateway.

```text
Client
  ↓
HTTP Gateway
  ↓
Authentication
  ↓
Protocol Detection
  ↓
Compatible Targets
  ↓
Health Ranking
  ↓
Sticky Session
  ↓
Fallback Router
  ↓
Provider Adapter
  ↓
AI Provider
```

## Core Flow

1. Client sends a request to one of the supported gateway endpoints.
2. The gateway optionally authenticates the client.
3. The request protocol is detected from the endpoint.
4. Configured provider/model/key combinations are expanded into independent targets.
5. Targets incompatible with the client protocol are excluded.
6. The request's required capabilities are detected from its content; only targets that declare and can execute them are eligible. The request's input size is estimated too (`estimateRequestTokens`, `src/request-profile.js`): a model whose declared `contextLimit` is smaller is excluded with reason `context_limit_exceeded`, so the fallback walk only visits models that can hold the request. A model with no declared limit is never excluded; when every model is too small the gateway answers `400 context_length_exceeded`.
7. A route plan is built (see "The Fallback Chain"): the remembered target, then the operator's Manual Model Selection when there is one, or the automatic health-and-latency order when nothing is selected.
8. Targets cooling down in the health registry, and targets already attempted in this request, are skipped. A failure cools down only the key + model that was tried: 401/402/403 and 400/404/413/422 never cool the key's sibling models (each is attempted on its own), and a 429 cools that key + model for the upstream `Retry-After` (60s when absent), not the 12 minute default. A 429 whose wording says it is a *daily* or *monthly* quota (OpenRouter `free-models-per-day`, Cloudflare's daily neuron allocation, Cohere's 1000 calls / month) is not a rate limit and gets a window-sized cooldown instead (`quotaCooldown` in `router.js`): until the reset time the upstream reported, else the next 00:00 UTC for daily, 6 hours for monthly, never more than 24 hours. Such a target is not retried within the same request.
9. The router calls targets sequentially.
10. Every failure puts the exact target (key + model) into cooldown and moves routing forward to the next key or model — whatever the status. Only a client disconnect ends the request early.
11. A successful target becomes the session's remembered target.
12. The upstream response is streamed back to the client.

## The Fallback Chain

Implemented in `src/fallback-chain.js` (the persisted configuration),
`src/fallback-plan.js` (the planner) and `withFallback` in `src/router.js` (the
walker). One code path serves all routing.

```text
REQUEST -> ROUTING (capability-based)
  REMEMBERED  the session's last successful target, while its 20-minute TTL is
              valid; it leads the selection only when it is one of the selected
              models
  MANUAL      the operator's saved Manual Model Selection, entry by entry, when
              the selection is not empty
  HEALTH      every model the selection does not name, ordered by measured
              health and latency — reached only after the selection is walked
  AUTO        every configured target ordered by measured health and latency,
              when nothing is selected
```

A saved selection is the order between the models it names, and health never
re-sorts it; health only decides eligibility while the plan is walked. It is not
the whole order: a model the operator left out is reached by the `health`
batch once every eligible selected target has failed, so a failure of the
selection degrades to the automatic order rather than to an outage. Disabled
entries and entries narrowed to no usable key are never routed to, in either
batch. The automatic order alone is used when nothing is selected.

### Entries

An entry is one provider/model GROUP with an optional key subset and an enabled
flag:

```text
{ provider, model, keys: null | [0, 2], enabled: true }
```

- `keys: null` means every key the provider has for that model, tried in key
  order. It is the only form that means "unrestricted", and it is what an absent
  field normalizes to.
- An explicitly supplied key list is read as a restriction, so one that cannot
  be read is treated as permitting **nothing** rather than everything: a
  persisted or hand-edited `keys: [true]`, `keys: ["1"]`, `keys: []` or a
  non-array `keys` normalizes to `[]`, which resolves to zero eligible keys. The
  entry keeps its place, is walked as unusable, and the pool fails closed.
  Reading it as `null` would grant every key — the opposite of what the file
  asked for. A partly readable list keeps exactly the indexes it could read.
- Every eligible key of an entry is attempted, in key order, before the walk
  advances to the next entry.
- A disabled entry keeps its position and is simply not routed to, and it is
  never used as a fallback either. Disabling every entry leaves the selection
  with nothing walkable, so the selection fails closed rather than substituting
  models the operator parked.

The file holds ids, key indexes and flags — never credentials.

### Derived modes

There is no mode switch to set. The mode is derived from the saved
Manual Model Selection:

| Selection | Mode | Order |
|---|---|---|
| empty | `auto` | health and latency |
| non-empty | `manual` | the saved selection, then health and latency |

A successful target is always remembered: it is stored on the session
(`RouteSession`), keyed by protocol + session id. In `manual` it leads the next
request only when it is one of the selected models; in `auto` it leads outright.
An older client or persisted file that still says `fixed` or `last-success` is
accepted and read as the derived mode, so no configuration is broken by the removal.

Reset Fallback clears those session records and the automatic-order cache. It
touches nothing else: not the selection, the providers, the keys, the
configured models, valid health measurements or any cooldown.

### Automatic ordering

`orderGroupsByHealth` sorts model groups by:

1. a group with an available key, before one whose every key is cooling down;
2. lower measured latency first;
3. higher health score first;
4. the order the group appears in the target list — the deterministic tiebreak
   that makes an unmeasured router stable rather than arbitrary.

A group with no measurement sorts after every measured one. Latency is
`requestLatencyMs` (a real generation, timed end to end) when there is one, else
`probeLatencyMs` (a health probe), else nothing at all — the order never invents
a number. The result is cached against the health registry's version counter and
a 30-second time bucket, so a real health change takes effect immediately, a
lapsed cooldown is picked up within the bucket, and a request never recomputes
the order for no reason.

### Precedence

```text
pin (strict: no chain, no automatic order, no memory)  >  remembered  >  chain  >  automatic
```

### Failure scope

A failure cools down what it actually describes. `classifyFailure` reads an
explicit `error.scope` when a provider adapter could determine one from the
upstream error body, and otherwise decides from the status code:

| Scope | Status codes | Effect |
|---|---|---|
| `key` | 401, 402, 403 | every model of that provider using that key |
| `target` | 400, 404, 413, 422 | only that target |
| `target` (default) | everything else | only that target |

A 404 means "this model is gone", not "this key is bad", so it must never reach
a sibling on the same key. Anything unrecognised is treated as `target`-scoped —
the narrow answer, which can cost a retry but never a needlessly disabled model.
`provider` scope exists in the vocabulary and is applied only when an adapter
states it outright.

## Supported Endpoints

| Method | Endpoint | Protocol |
|---|---|---|
| GET | `/health` | Router health |
| GET | `/v1/models` | Model discovery |
| POST | `/v1/messages` | Anthropic |
| POST | `/v1/responses` | OpenAI Responses |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |

## Provider Target Model

Every configured provider/model/key combination becomes an independent target:

```text
provider + model + keyIndex
```

Example:

```text
Groq / model-a / key-0
Groq / model-a / key-1
Groq / model-b / key-0
Groq / model-b / key-1
```

This allows one failed API key to enter cooldown while sibling keys remain available.

### Saved custom endpoints

Providers normally come from the environment (`PROVIDER_IDS` in `src/config.js`). A **saved custom endpoint** is a provider the operator adds at runtime from the control panel (the Custom Endpoints page, `/custom-endpoints`). The Playground only tests an endpoint once and never saves it. It is stored as one record:

```text
id (custom-<name>) + name + baseUrl + protocol + models[] + apiKeys[]
```

`applyCustomEndpoints` (`src/custom-endpoints.js`) merges each record into `config.providers` as a normal text provider (`custom: true`, one protocol). Its models are tried with its keys, in the order set in the Fallback Chain; image-capable models serve image requests through capability-based routing. The server hot-reloads targets so `buildTargets` produces the usual `provider + model + keyIndex` targets and everything downstream (Fallback Chain, health probes, cooldowns, sticky routing, the model switch) treats it like any other provider.

Changes apply without a restart. `server.js` listens to the store, removes the old `custom-*` targets from the live targets array in place, adds the new ones, rebuilds the model capability index, re-registers secrets for redaction, resets the automatic-order cache and probes the new targets at once. The health monitor, the router and the API all read those same arrays and the same `config` object, which is why in-place mutation is enough.

`/api/custom-endpoints` accepts keys but never returns them: the panel only gets a key count. The base URL passes the same checks as the Playground (http(s) only, no credentials, query or fragment, no private or reserved address, hostnames resolved at save time).

**Persistence.** The store writes a local file (`CUSTOM_ENDPOINTS_FILE`, default `data/custom-endpoints.json`). On a host that wipes its disk on every redeploy that is not enough, so with `CUSTOM_ENDPOINTS_GITHUB_REPO` set the source of truth is an **encrypted blob committed straight to a GitHub branch** (`src/remote-storage.js`, Contents API):

- Everything is encrypted with AES-256-GCM (key derived with scrypt from `CUSTOM_ENDPOINTS_SECRET`) before it leaves the process; the repository only holds ciphertext.
- The branch (`main` by default, override with `CUSTOM_ENDPOINTS_GITHUB_BRANCH`) receives a direct commit on every save, no PR needed. It is created from the default branch when missing. On the branch the host deploys from (`main`), every save redeploys the service; use a separate branch such as `apirouter-data` to avoid that.
- Startup: the remote wins over the local file; if the remote is empty, existing local endpoints are uploaded once.
- Safety: while the remote cannot be read (or decrypted with the current secret) every create, update and remove is refused with 503, so a stale list can never overwrite the saved one. A background retry loads the endpoints as soon as the remote answers.
- A change is written to the remote first; if that fails the in-memory change is rolled back. Changes are serialized, and a stale blob sha is retried once.
- A half-set configuration (repo without token or secret) stops startup.

## Protocol Mapping

```text
AgentRouter → Anthropic Messages, OpenAI Chat, OpenAI Responses
Gemini      → Gemini generateContent
Other       → OpenAI Chat Completions
```

Client protocol capabilities are matched explicitly. OpenAI Chat and OpenAI Responses are separate capabilities, so a chat-only provider cannot receive a Responses request.

Gemini uses the native `generateContent` protocol and standard model path.

The adapter converts the common gateway request into the provider request format.

### Image content across protocols

A bridge either carries an image or refuses the request. It never replaces one with text.

Each protocol has its own spelling for image content — `{type:"image_url"}` (Chat Completions), `{type:"input_image"}` (Responses), `{type:"image"}` with a `base64` or `url` source (Anthropic), `inlineData` / `fileData` (Gemini) — and they do not overlap completely:

| From | To | Carried | Refused |
|---|---|---|---|
| Chat / Responses | Gemini | inline base64 (`inlineData`) | remote `https:` URLs, an `input_image` with no URL |
| Gemini | OpenAI-compatible | `inlineData` / `inline_data` | `fileData` / `file_data` (a provider-private Files API URI), `inlineData` with no payload |
| Anthropic | Gemini | `source.type === "base64"` | `source.type === "url"` |
| Anthropic | OpenAI Chat | both source forms | — |

Three positions hold only text — a **system prompt**, an **assistant turn** and a **tool result**. An image there has no representation in any of these protocols, so the request is refused rather than sent with the literal string `"[image]"` standing in for it. A marker would be content the model never received, presented as though it had.

A refusal is a `400` `UnsupportedMediaError` carrying `retryable` and `skipCooldown`. That combination is deliberate: the fallback walk records the attempt, moves on to a target that *can* carry the image, and does not cool the refusing provider down, because the limitation belongs to the request rather than the provider. Only when no target can carry the image does the client see the error.

## Health System

Each target tracks:

```text
status
score
successes
failures
consecutiveFailures
latencyMs
lastStatus
lastReason
cooldownUntil
updatedAt
```

States:

```text
unknown    no health claim has been established yet
healthy    the latest accepted observation succeeded
failed     the latest accepted observation failed
cooldown   a failed target that is still inside its cooldown window
```

`status` stores the outcome of the last accepted observation. `cooldown` is derived from `cooldownUntil` when health is reported, so routing never depends on it. Health is tracked per `provider + model + key`: a failed key or model never changes the state of a sibling target.

### Provider-aware probing

A generic `GET <baseUrl>` cannot establish that a provider is healthy, and it never exercises the API key. Each protocol capability therefore gets an explicit probe against the provider's own model-listing endpoint:

| Capability | Probe | Credential | Generation quota |
|---|---|---|---|
| Gemini | `GET {base}/v1beta/models` | `x-goog-api-key` | not consumed |
| OpenAI Chat / Responses | `GET {base}/v1/models` | `Authorization: Bearer` | not consumed |
| Cloudflare Workers AI | `GET {base}/models/search?per_page=1` | `Authorization: Bearer` | not consumed |
| Cohere | `GET {native root}/v1/models/{model}` ("Get a Model") | `Authorization: Bearer` | not consumed |
| Anthropic only | none | passive | not consumed |

Probes never send a credential in the query string.

Cohere needs its own probe. Its OpenAI Compatibility surface (`.../compatibility/v1`) has no model listing, so the generic `GET {base}/models` answers 404 there and a target would stay `unknown` for ever. It used to be probed with a 1-token chat completion instead, but that is a generation request: per model and key, every cycle, it spent the key's chat quota (a trial key allows 20 requests a minute and 1,000 calls a month) and answered `429` once that was gone. The probe is now Cohere's own "Get a Model" call, `GET https://api.cohere.com/v1/models/{model}` (docs.cohere.com/reference/get-model): the native root is the configured compatibility base without its `/compatibility[/v1]` suffix, the model id is path-encoded, and only the API key is needed. A `200` naming that model is `healthy` and confirms the model (`modelListed: true`); `401/402/403/429/5xx` and timeouts are failures as for every other provider; a `404` is `unknown` and never claims the model is missing, because it could as well be a wrong route. A Cohere base that is not a compatibility base (a custom gateway) uses the generic probe. Nothing in the system generates text to check health any more.

The models endpoint is also read, not just called: the probe looks for the target's configured model id in the listing to report `modelListed` (see below). A single-page catalogue therefore costs no extra request; a paginated one is walked within a strict budget, using the probe's own timeout.

Probe results are normalized to `{ ok, status, latencyMs, reason, modelListed }`:

```text
ok: true   2xx — reachable and the credential was accepted
ok: false  401, 402, 403, 408, 429, 5xx, timeout, unreachable
ok: null   passive — the endpoint is missing (404/405/501), or the provider
           has no safe probe. The previous state is preserved untouched, so
           the router never fabricates a health claim.
```

Authentication failures are never reported as healthy.

#### Connectivity and model availability are separate

`status` describes the **key and the endpoint**: was the credential accepted, was the provider reachable. It does not describe the configured **model**. A valid key against a reachable `/models` endpoint is reported `healthy` even when the configured model does not exist, was withdrawn, or is not entitled to the account — and the request only finds out at routing time.

`modelListed` is the separate, additive signal: whether the provider's own model catalogue named this target's model. The catalogue the probe already fetches is read for the model id, so this costs no extra request, and it is deliberately tri-state:

```text
true    a complete catalogue was read and it named the model
false   a complete catalogue was read and the model was not in it
null    the catalogue could not be inspected to the end — "not verified",
        never "missing"
```

`false` is a claim about a **complete** catalogue. A catalogue that was not read to the end never produces it: an unrecognized shape, a body past the byte limit, a non-200 response, an unreadable or unreachable page, or a page budget that ran out while the provider still advertised more pages all yield `null`. This matters because the catalogues are paginated — Gemini's `models.list` serves 50 models per page — so reading only the first page would report a real model as missing on any sizeable account.

The walk is bounded by `MAX_MODEL_LIST_PAGES` pages, `MAX_MODEL_LIST_BYTES` total bytes and the probe timeout. The byte limit is enforced **while the body is consumed**, not after it has been buffered, because a provider may omit or understate `Content-Length`; a body that crosses the limit is abandoned and its reader cancelled. Follow-up pages use the probe's own `fetch` signal, so the timeout bounds the whole walk, and any failure to finish it is `null` rather than a false negative.

##### Latest observation vs last confirmation

Because `null` is a real answer, the signal is reported as two separate facts rather than one:

```text
modelListed              what the MOST RECENT probe observed (tri-state)
modelListedAt            when that observation was taken
modelListedConfirmed     the last DEFINITE value seen, kept across
                         indeterminate probes
modelListedConfirmedAt   when that definite value was observed
```

Retaining the last confirmation is useful — "absent yesterday, unreadable today" is worth knowing — but it must never be presented as the latest result. `modelListed` is therefore *replaced* by `null` when a probe cannot inspect the catalogue, including when the probe throws or the provider has no probe at all, so a stale `false` can never appear freshly confirmed. The panel renders the two separately and dates both.

Only `false` is evidence. It is surfaced in the health payload and the panel, and neither field **ever changes `status`, the score or a cooldown**, so routing behaves exactly as before. Catalogue observations are also recorded while a target is cooling down, and carry their own ordering guard so a slow probe cannot overwrite a newer catalogue fact.

### Observation ordering

Every observation carries the timestamp at which it was taken. An observation is only applied when it is at least as new as the newest one already recorded. A slow health probe that started before a routing failure therefore cannot overwrite that failure or clear the cooldown it established, while a newer successful probe can still recover a cooled-down target.

Default failed-target cooldown:

```text
12 minutes
```

Default health refresh interval:

```text
12 minutes
```

The two are independent. The cooldown is how long a *failed* target is skipped by routing; the interval is how often probes run. Status-specific cooldowns are unchanged: HTTP 400 puts a target on an 8-minute cooldown, an HTTP 408 timeout on a 1-minute cooldown, and a 413 on 5 minutes. The remembered-session TTL (20 minutes) is a separate setting and is not affected.

The server starts the health monitor at startup and stops it cleanly on SIGINT/SIGTERM. Refresh cycles never overlap, run with bounded concurrency (4 probes at a time) so one slow provider cannot stall the cycle, and a failing provider never prevents the others from being checked.

Default `RETRY_STATUS_CODES` (kept for compatibility; it no longer limits fallback):

```text
401, 402, 403, 404, 408, 409, 425, 429, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 529
```

Any status — listed or not — falls back to the next key or model, because a
different key can succeed where this one failed. A client error with no rule of
its own (405, 410, 415, 422, 451 ...) cools only that key + model for one minute.
A generic 400 (unsupported parameter, schema quirk) does not cool the target
down, and if every target answers with the same client error (400, 422 ...) the
client receives that status instead of a 502.

## Pinned Requests

`x-multi-ai-pin-provider` (and optionally `x-multi-ai-pin-key-index`) narrow the
candidate targets before selection (`pinTargets` in
`src/observability/route-select.js`). Pinned requests are strict: no fallback to
another provider, key or model, and cooldown is bypassed so a specific key can
be tested. Outcomes still update the shared health registry. A pin matching no
target returns `404 no_route`.

## Remember Last Successful

The client may send:

```http
X-Multi-AI-Session-ID: <session-id>
```

If absent, the router creates a UUID and returns:

```http
x-multi-ai-session-id: <session-id>
```

In the `last-success` and `auto` modes, a successful target is remembered for
that session for 20 minutes (refreshed by each success) and is tried first on the
next request. When it fails or is cooling down, the walk continues from the chain
in its saved order; the remembered target is never retried twice in one request,
and the chain itself is never modified by a success.

The record is scoped by protocol and session id: each client protocol keeps its
own remembered targets. Requests without the header share one default session per
protocol.

When nothing is selected the plan is built purely from health and latency, and
the remembered target leads the walk outright.


### Manual Model Selection (alternating batches)

`manual` is the mode a saved selection uses. It is the only mode
whose plan has more than one source, and it is built by `buildManualPlan` in
`fallback-plan.js`:

1. **`manual-selection`** — the saved entries in exactly the saved order. Groups
   are keyed by provider/model, so an interleaved selection (provider P model A,
   provider Q model B, provider P model C) stays interleaved; nothing groups or
   sorts by provider. Every eligible key of a model is tried before the next.
2. **`health-fallback`** — every reachable model that is *not* a saved entry,
   ordered by the existing health/latency ordering. Exclusion is by model, so an
   unselected model of a provider that appears in the selection stays eligible.
   Parked (disabled) entries and entries narrowed to no keys are excluded too,
   so a restriction can never leak a model's other keys into this phase.
3. **`manual-retry`, `health-retry`, ...** — the same two batches again, in the
   same order, every step flagged `retry` and numbered by `round`. The sequence
   is therefore MANUAL → HEALTH → MANUAL → HEALTH.

**The remembered target (last success) leads the batch it came from.** There is
one remembered target per session, whichever batch it answered in:

- a *selected* model leads the Manual batch: MANUAL → HEALTH → MANUAL → HEALTH;
- an *unselected* (Health) model leads the Health batch, and the Manual batch is
  walked only after every Health model and key has failed:
  HEALTH → MANUAL → HEALTH → MANUAL.

A later success from the other batch replaces it, so the order flips back.

Both batches are computed once when the request starts, so the Health order is
stable for the whole request. A health refresh (every 12 minutes) can change the
order the *next* request's plan gets; it never clears a cooldown.

The repetition is not a cycle counter. The plan only lists the targets again; the
walker (`withFallback` in `router.js`) decides, target by target and from
per-request state, whether a listed retry is permitted:

- the per-request "a target is invoked at most once" rule is unchanged for every
  other step and the automatic order;
- a target is retried at most `TARGET_RETRY_ALLOWANCE` (1) times per request, and
  the planner emits exactly that many retry rounds;
- a cooldown that existed when the request reached the target is never
  overridden;
- a credential-level or non-transient failure (400/401/402/403/404/413/422), a
  key- or provider-scoped failure, and a refusal that opted out of health
  tracking (`skipCooldown`) are never retried;
- the one cooldown a retry looks past is the one *this request* set through a
  transient, target-scoped failure (timeout, 429, 5xx, transport error), and only
  while it is still exactly that cooldown. A retry success clears it; a retry
  failure starts a fresh one;
- a retry step for a target this request never called is walked as a first
  attempt, and only if it is available right now.

Termination follows from that: every call spends the target's first attempt or
one unit of its retry allowance, so calls are bounded by `(1 + allowance) ×
distinct targets`, and a round with nothing permitted calls nothing. When nothing
is left that may legally be attempted the existing error is returned: `503` when
no target was ever eligible (everything cooling down), `502` when targets were
called and all failed, or the shared `400` when every one answered 400.

If the selection itself has nothing walkable for a request, the plan is empty and
the request fails closed (`fallback_chain_unusable`): the Health batch catches
failures of the operator's order, it does not stand in for an order that cannot
be honoured.
