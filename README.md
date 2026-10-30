<div align="center">

<img src="assets/banner.svg" alt="ApiRouter" width="100%">

# ApiRouter

**Multi-provider AI gateway: one endpoint, UI-controlled fallback chain, key rotation and health-aware routing.**

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)
![providers](https://img.shields.io/badge/providers-16-orange)
![protocols](https://img.shields.io/badge/protocols-5-blue)
![deploy](https://img.shields.io/badge/deploy-Render-46E3B7?logo=render&logoColor=white)

[Client Setup](#-client-setup) • [Features](#-features) • [Quick Start](#quick-start) • [Deploy](render-setup.md) • [Routing](#routing) • [Persistence](#persistence-survive-redeploys) • [API](#api) • [Security](#security)

</div>

---

## 🔌 Client Setup

Point your client at the gateway (`http://localhost:8788`) using its guide:

| Client | Setup Guide |
|---|---|
| Claude Code | [docs/clients/CLAUDE_CODE.md](docs/clients/CLAUDE_CODE.md) |
| Codex | [docs/clients/CODEX.md](docs/clients/CODEX.md) |
| Qwen Code | [docs/clients/QWEN_CODE.md](docs/clients/QWEN_CODE.md) |
| OpenCode | [docs/clients/OPENCODE.md](docs/clients/OPENCODE.md) |
| Generic OpenAI-compatible | [docs/clients/GENERIC_OPENAI.md](docs/clients/GENERIC_OPENAI.md) |
| Other clients | [docs/clients/OTHER_CLIENTS.md](docs/clients/OTHER_CLIENTS.md) |
| Protocol reference | [docs/clients/CLIENTS.md](docs/clients/CLIENTS.md) |

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🔀 | **Fallback chain** | Ordered list set in the control panel and followed exactly; every eligible key of a model is tried before the next model |
| ❤️ | **Health-aware routing** | Automatic health/latency ordering when no chain is set; last working provider/model/key is tried first (20 min) |
| 🧩 | **Model Configurator** | Declare capabilities and a context limit per model; requests only reach models that support what they need and can hold the request |
| 🔑 | **Key rotation & cooldowns** | Per-key failure handling, so one bad key never disables the rest |
| 🌐 | **Multi-protocol** | Claude Messages, OpenAI Responses, OpenAI Chat, Gemini, generic OpenAI-compatible |
| 📊 | **Control panel** | Health, models, requests, Live Logs, analytics, playground, custom endpoints |

## Quick Start

```bash
git clone https://github.com/AkramHossain2004/ApiRouter.git
cd ApiRouter
npm install
cp .env.example .env      # Windows: Copy-Item .env.example .env
# add provider keys to .env
# for any non-local use, also set APIROUTER_API_KEYS (see Security)
```

```bash
npm run dev:all           # development (UI on http://localhost:5173)
npm run start:all         # production
```

Gateway: `http://localhost:8788`

### Deploy on Render

Want it online 24/7 on the free plan? Follow the step-by-step guide in [render-setup.md](render-setup.md) (GitHub connect, build/start commands, environment variables, keep-alive, troubleshooting).

**Or let Claude deploy it.** Connect Render to Claude (Render's MCP connector) and ask it to deploy this repo. Claude creates the service, sets the non-secret environment variables itself, asks you only for the secrets (gateway password and provider keys), then deploys and checks `/health`. Setup, what Claude can and cannot do, and which variables you provide are in [render-setup.md, section 12](render-setup.md#12-deploy-with-claude-render-connector). Hosted deployments must set `HOST=0.0.0.0` together with `APIROUTER_API_KEYS`.

### Router launcher

```bash
./bin/Router              # Linux / macOS
.\scripts\install-router.ps1   # Windows (once), then run: Router
Router --prod             # production mode
```

## Routing

- **Nothing selected:** automatic health/latency order.
- **Models selected (Configure → Fallback Chain):** your order first, then all unselected models by health; retried once per target after transient failures only.
- Disabled models (Models page Switch) are never tried; no cooldown or health change.
- **Context limit:** set a model's context limit (tokens) in the Model Configurator (`1m`, `500k` or `200000`). A request larger than that limit skips the model, and the walk goes on to the next model that can hold it, in your chain order. Example: with limits 1M, 500k, 200k and 700k in that chain order, a 600k-token request tries the 1M model, then the 700k one. A model with no limit set is never skipped for size. The request size is an estimate (about 4 characters per token, media counted separately); if every model is too small the gateway answers `400 context_length_exceeded` ("prompt is too long") without calling any provider.
- Sessions: send `X-Multi-AI-Session-ID` to keep the remembered target per session.
- **Reset Fallback** clears remembered targets only.

### Cooldowns

| Failure | Cools down |
|---|---|
| 401 / 402 / 403 | That key + model |
| 400 / 404 / 413 / 422 | That target only |
| 429 | That key + model (`Retry-After`, 5s–12min, default 60s) |
| Other 4xx | That key + model, 1 min |
| 5xx / timeout | That target |

## Persistence (survive redeploys)

Set on hosts with an ephemeral disk (e.g. free Render):

| Variable | Purpose |
|---|---|
| `MODEL_CONFIG_GITHUB_REPO` | `owner/name` |
| `MODEL_CONFIG_GITHUB_TOKEN` | Token with Contents read/write |
| `MODEL_CONFIG_GITHUB_BRANCH` | Data branch (default `main`; use `apirouter-data` to avoid redeploys) |
| `MODEL_CONFIG_GITHUB_PATH` | Default `model-config.json` |
| `CUSTOM_ENDPOINTS_GITHUB_*` | Same for saved custom endpoints (file `custom-endpoints.enc.json`). Each one falls back to the matching `MODEL_CONFIG_GITHUB_*`, so one repo, token and branch serve both |
| `CUSTOM_ENDPOINTS_SECRET` | 12+ char passphrase; endpoints are AES-256-GCM encrypted. **Required to store custom endpoints in GitHub**, even when the repo is shared with the Model Configurator; without it they stay on the local disk and the panel says so |

`MODEL_CONFIG_GITHUB_*` falls back to `CUSTOM_ENDPOINTS_GITHUB_*`. GitHub is the source of truth on startup; if unreachable, saves return `503`; conflicting saves return `409` (`POST /api/model-config/refresh`).

## API

**Gateway:** `GET /health`, `GET /v1/models`, `POST /v1/messages`, `/v1/responses`, `/v1/chat/completions`, `/v1beta/models/{model}:generateContent`

**Capability endpoints** (OpenAI-compatible): `POST /v1/embeddings`, `/v1/rerank`, `/v1/moderations`, `/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/audio/translations`, plus the WebSocket `GET /v1/realtime`. Each is served only by a model that *declares* the matching capability (`embeddings`, `reranking`, `moderation`, `image_output`, `audio_output`, `audio_transcription`, `audio_translation`, `realtime_audio`) in the Model Configurator and has a wire for it. Candidates are tried in health order with automatic fallback on retryable failures; a `model` naming a capable model pins the walk to it, the upstream always receives the target's own model id, and Manual Selection is not consulted. No capable model gives `503 no_capable_route`; a known model with no wire for the endpoint gives `400 model_capability_mismatch`.

| Target wire | Served |
|---|---|
| OpenAI-compatible, Responses-only | all eight, forwarded as-is to the provider's API root |
| Gemini (native REST, translated) | embeddings, images (`imagen*` via `:predict`, others via the image modality, one image per call), speech (24 kHz PCM returned as `audio/wav`; OpenAI voice names map to `Kore`, a Gemini voice name passes through), transcription / translation (audio sent inline, `json` / `text` / `verbose_json` only, no timestamps). No rerank, moderation or realtime |
| Anthropic | none: Anthropic has no embeddings, image, audio, rerank or moderation API |

`/v1/realtime` is a transparent WebSocket tunnel (frames are not parsed): the upgrade is performed with the target's key and model, fallback applies only while the handshake is in flight, and a session is never moved afterwards. Clients must send the router key as an `Authorization` / `x-api-key` header (browser WebSockets cannot). Gemini Live uses a different protocol and is not translated. Chat-type image models without `/images/generations` on an OpenAI-compatible provider answer 404 there, and the walk moves on.

**Control panel (`/api/*`):** `health`, `health/refresh`, `providers`, `models`, `requests`, `requests/stream`, `fallback` (GET/PUT), `fallback/reset`, `model-config` (GET/POST, `:id` PUT/PATCH/DELETE, `refresh`), `models/switch`, `router/preview`, `analytics`, `config`, `system`, `gateway` (`shutdown`, `resume`), `custom-endpoints`, `playground/custom`

Shutdown pauses the gateway (`503 gateway_paused`); state is kept in `data/gateway-state.json`.

## Custom Endpoints & Playground

- Add saved endpoints under Configure → Custom Endpoints (base URL, API style, models, keys). They become provider `custom-<name>`.
- Playground tests any base URL/key/model without saving. Private/loopback addresses are blocked unless `PLAYGROUND_ALLOW_PRIVATE_HOSTS=1`.
- Declare `image_input` etc. in the Model Configurator to use those capabilities.

## Security

- Keep keys in `.env`; never commit credentials. Keys are never sent to the browser.
- Set `APIROUTER_API_KEYS` for any non-local use. It protects `/v1/messages`, `/v1/responses`, `/v1/chat/completions`, `generateContent`, `count_tokens`, the capability endpoints above and `/api/*`; `/health` and `/v1/models` stay open (restrict at network level if needed).

## Development

```bash
npm run test:ui     # frontend tests
npm run test:all    # full suite
npm run ui:build    # build UI
npm run ui:dev      # UI only
```

## Structure

```text
assets/   Banner
bin/      Router launchers
docs/     Client guides
scripts/  Dev, prod, launcher scripts
src/      Gateway and backend
ui/       React + Vite control panel
```

## License

Released under the [MIT License](LICENSE).
