# Providers

A provider client builds a real HTTP request and reads ids only from the response. If the response has no id, Meridian stores no external id.

Connection phases, in order of what the screen may show:

`NOT_CONFIGURED`, `CONNECTING`, `CONNECTED`, `SYNCING`, `HEALTHY`, `DEGRADED`, `FAILED`, `DISCONNECTED`.

Credentials without a successful request stay `NOT_CONFIGURED`. `HEALTHY` means the last probe succeeded. `DISCONNECTED` is a local stop; stored external ids are kept and no further request is sent until reconnect.

## Live clients

### TypeSafe JEV (Decisions API)
JEV uses OpenRouter's native Decisions API at `POST https://openrouter.ai/api/alpha/decisions` with model `typesafe/jev-1.13`. It provides typed probabilistic judgments (`choice`, `noul`, `score`). Generic chat completion endpoints (`/chat/completions`) are never used as a fallback for JEV judgments.

### Binary Storage (Google Drive Primary)
Google Drive is the primary binary artifact store for Meridian. Assets are organized by tenant, brand, and lifecycle hierarchy:
- Key lookup resolves provider file IDs via Postgres `storage_objects`.
- Direct binary downloads use `alt=media` on Google Drive file IDs.
- Uploads `<= 5MB` use multipart uploads; files `> 5MB` use resumable upload sessions.

### Multimodal Perception (Gemini)
Gemini Multimodal Perception (`gemini-2.5-flash`) extracts factual visual observations (shot types, face presence, product presence, OCR, setting) from keyframe images and video media. Perception produces factual observations only; it does not make policy or ranking decisions.

### Production Video Engines
Meridian supports provider-neutral video rendering through `ProductionRouter`:
1. **ManualCloudProvider (Zero Spend)**: Generates structured creative manifests and Google Drive drop folders (`production/inputs/{jobId}/manifest.json`). Ingests finished MP4s dropped by editors without third-party API fees. Fails closed with `PREFLIGHT_FAILED` if Drive is not configured.
2. **Google Veo Provider**: Submits asynchronous video generation jobs via Google Veo (`MERIDIAN_VEO_MODEL`, default `veo-3.1-generate-preview`) using `predictLongRunning`. Unconfigured credentials return `NOT_CONFIGURED`.
3. **Higgsfield Provider**: Generates video via Higgsfield AI camera and video models when `HIGGSFIELD_API_KEY` is configured.
4. **Hypit Provider**: Assembles multi-segment UGC video timelines when `HYPIT_BASE_URL` runtime is configured.

| Provider | Probe / Health | Publish / Execution |
| --- | --- | --- |
| TypeSafe JEV | POST `/decisions` with test question | Semantic decisions (`choice`, `noul`, `score`) |
| Google Drive | `GET /drive/v3/about` | Primary binary object store (`<= 5MB` multipart, `> 5MB` resumable) |
| Gemini Perception | `POST /models/{model}:generateContent` | Factual multimodal feature extraction |
| Google Veo | `POST /models/{model}:predictLongRunning` | Asynchronous generative video |
| Higgsfield | `POST /v1/generate` | Generative video |
| ManualCloud | Google Drive health check | Manifest generation & drop folder sync |
| Hypit | `HYPIT_BASE_URL` health | UGC video assembly timeline |
| Meta | `GET /me`, ad accounts, granted permissions | Paused campaign, ad set, creative, and ad on Graph API v21.0 |
| TikTok | `GET /user/info/` and advertiser list | Paused campaign, ad group, then ad |
| Google Ads | `customers:listAccessibleCustomers` | Budget, paused search campaign, responsive search ad |

Publishing is idempotent on a stored external id: a retry returns that id and does not call the create endpoint again. Placeholder or unverified media artifacts are rejected before publication dispatch.

## What is still external

- OAuth starts at `/api/oauth/callback`. The server checks state, exchanges the code, and seals the access token and any refresh token. `META_APP_ID`, `META_APP_SECRET`, `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, and `TOKEN_ENCRYPTION_KEY` have to exist or nothing is stored.
- Webhooks at `POST /api/webhooks/receive` verify signatures, payload hashes, and tenant scopes.
- Studio video uses a separate Hypit process or ManualCloud / Veo / Higgsfield. Unconfigured providers return `NOT_CONFIGURED`. No fake job IDs or simulated completions are produced.
