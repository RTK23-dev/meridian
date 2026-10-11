# Providers

A provider client builds a real HTTP request and reads ids only from the response. If the response has no id, Meridian stores no external id.

Connection phases, in order of what the screen may show:

`NOT_CONFIGURED`, `CONNECTING`, `CONNECTED`, `SYNCING`, `HEALTHY`, `DEGRADED`, `FAILED`, `DISCONNECTED`.

Credentials without a successful request stay `NOT_CONFIGURED`. `HEALTHY` means the last probe succeeded. `DISCONNECTED` is a local stop; stored external ids are kept and no further request is sent until reconnect.

## Live clients

### TypeSafe JEV (Decisions API)
JEV uses OpenRouter's native Decisions API at `POST https://openrouter.ai/api/alpha/decisions` with model `typesafe/jev-1.13`. It provides typed probabilistic judgments (`choice`, `noul`, `score`). Generic chat completion endpoints (`/chat/completions`) are never used as a fallback for JEV judgments.

**Decision engines.** One engine is active per workspace: TypeSafe JEV (above) or the OpenAI Decisions API (`POST /v1/decisions`, public beta, model `gpt-6-luna` by default). Only the active engine receives decisions, and nothing falls back to the other engine. See [DECISION_ENGINES.md](DECISION_ENGINES.md) for configuration, image transport, and the status of each part.

### Binary Storage (Google Drive Primary)
Google Drive is the primary binary artifact store for Meridian. Assets are organized by tenant, brand, and lifecycle hierarchy:
- Key lookup resolves provider file IDs via Postgres `storage_objects`.
- Direct binary downloads use `alt=media` on Google Drive file IDs.
- Uploads `<= 5MB` use multipart uploads; files `> 5MB` use resumable upload sessions.

### Multimodal Perception (Gemini)
Gemini Multimodal Perception (`gemini-2.5-flash`) extracts factual visual observations (shot types, face presence, product presence, OCR, setting) from keyframe images and video media. Perception produces factual observations only; it does not make policy or ranking decisions.

### Production Video Engines (`ProductionRouter`)
Meridian executes creative specs through `ProductionRouter`:
- **Runtime Isolation**: `ProductionRouter` enforces strict runtime boundaries (`ProductionRuntime` vs `TestingRuntime`). In `ProductionRuntime`, `test:video` cannot be resolved and throws immediately. In `TestingRuntime`, `test:video` is injected via dependency injection for unit tests.
- **Model Capability & Lifecycle Registry**: All models and API families are tracked in `ModelCapabilityRegistry`. Deprecated preview endpoints (such as `veo-3.1-generate-preview` shutting down 2026-10-22) are flagged with warnings and pointed to active replacements (`gemini-omni-1.1-flash`). Expired models return `UNAVAILABLE`.
- **Durable PostgreSQL Persistence & Poller Worker**: Job metadata (`meridian_job_id`, `provider`, `provider_job_id`, `request_id`, `operation_name`, `status_url`, `cancel_url`, `spec_hash`, `attempt_count`, `submitted_at`, `last_polled_at`, `next_poll_at`, `error_code`, `artifact_id`) is stored in `production_jobs` (migration `0028`). The durable poller worker (`pollProductionJobs`) claims active jobs via `SELECT ... FOR UPDATE SKIP LOCKED`, polls provider status, downloads completed video bytes, executes postflight QC, and registers storage objects in Google Drive.
- **Provider Implementations**:
  1. **ManualCloudProvider (Zero Spend)**: Generates structured creative manifests and Google Drive drop folders (`production/inputs/{jobId}/manifest.json`). Job state is reconstructed directly from database metadata and drop folder scanning (zero in-memory Map authority). Fails closed with `PREFLIGHT_FAILED` if Drive is not configured.
  2. **Google Gemini Omni Provider**: Primary Google video generation engine using `gemini-omni-1.1-flash` via the official Gemini Interactions API (`POST https://generativelanguage.googleapis.com/v1beta/interactions`). Supports text-to-video, image-to-video, editing, and stateful multi-step interactions.
  3. **Google Veo Provider**: Specialist adapter for supported Veo models (`veo-2.0-generate-001` GA). Evaluates exact model-specific `VideoCapability` descriptions and polls `predictLongRunning` operations.
  4. **Higgsfield Provider**: Generates video via model registry (`HiggsfieldModelRegistry`) with model-specific paths and schemas (`higgsfield-video-v1`, `dop-v1`, `genjutsu-v1`, `seedance-v1`). Uses official `Authorization: Key <api_key>` headers, maps 401/403 to `AUTH_FAILED` and 429 to `RATE_LIMITED`, and preserves verbatim upstream `request_id`, `status_url`, and `cancel_url`.
  5. **Hypit Provider**: Assembles multi-segment UGC video timelines via `HypitProvider.submitJob()`. Studio executes strictly via the unified provider job lifecycle.

| Provider | Probe / Health | Publish / Execution |
| --- | --- | --- |
| TypeSafe JEV | POST `/decisions` with test question | Semantic decisions (`choice`, `noul`, `score`) via dual router |
| Google Drive | `GET /drive/v3/about` | Primary binary object store (`<= 5MB` multipart, `> 5MB` resumable) |
| Gemini Perception | `POST /models/{model}:generateContent` | Factual multimodal feature extraction |
| Google Gemini Omni | `POST /v1beta/interactions` | Primary generative video & editing via Interactions API |
| Google Veo | `POST /models/{model}:predictLongRunning` | Capability-specific video generation (`veo-2.0-generate-001`) |
| Higgsfield | `POST /v1/requests` | Model-specific camera & video generation (`Key` auth) |
| ManualCloud | Google Drive health check | Manifest generation & drop folder sync (zero spend) |
| Hypit | `HYPIT_BASE_URL` health | UGC video assembly timeline |
| Meta | `GET /me`, ad accounts, granted permissions | Paused campaign, ad set, creative, and ad on Graph API v21.0 |
| TikTok | `GET /user/info/` and advertiser list | Paused campaign, ad group, then ad |
| Google Ads | `customers:listAccessibleCustomers` | Budget, paused search campaign, responsive search ad |

Publishing is idempotent on a stored external id: a retry returns that id and does not call the create endpoint again. Placeholder or unverified media artifacts are rejected before publication dispatch.

## What is still external

- OAuth starts at `/api/oauth/callback`. The server checks state, exchanges the code, and seals the access token and any refresh token. `META_APP_ID`, `META_APP_SECRET`, `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, and `TOKEN_ENCRYPTION_KEY` have to exist or nothing is stored.
- Webhooks at `POST /api/webhooks/receive` verify signatures, payload hashes, and tenant scopes.
- Studio video uses a separate Hypit process or ManualCloud / Veo / Higgsfield. Unconfigured providers return `NOT_CONFIGURED`. No fake job IDs or simulated completions are produced.
