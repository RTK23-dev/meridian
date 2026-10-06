# Providers

A provider client builds a real HTTP request and reads ids only from the response. If the response has no id, Meridian stores no external id.

Connection phases, in order of what the screen may show:

`NOT_CONFIGURED`, `CONNECTING`, `CONNECTED`, `SYNCING`, `HEALTHY`, `DEGRADED`, `FAILED`, `DISCONNECTED`.

Credentials without a successful request stay `NOT_CONFIGURED`. `HEALTHY` means the last probe succeeded. `DISCONNECTED` is a local stop; stored external ids are kept and no further request is sent until reconnect.

## Live clients

JEV uses OpenRouter as its only external LLM gateway (`OPENROUTER_API_KEY` and `OPENROUTER_MODEL`). Research transcription runs locally through WhisperX after local ffmpeg extraction. Optional Google AI Studio / Nano Banana image generation uses `GOOGLE_AI_STUDIO_API_KEY`; missing configuration does not block JEV or Hypit. Hypit is the only production video engine.

| Provider | Probe | Publish |
| --- | --- | --- |
| Meta | `GET /me`, ad accounts, granted permissions | Paused campaign, ad set, creative, and ad on Graph API v21.0 |
| Ad Library | `GET /ads_archive` with a data array | Does not publish |
| TikTok | `GET /user/info/` and, when app credentials exist, advertiser list | Paused campaign, ad group, then ad. An ad is not requested until an uploaded image or video id is supplied. Insights use the integrated report for one ad id |
| Google Ads | `customers:listAccessibleCustomers` | Budget, paused search campaign, ad group, and responsive search ad. Insights use a GAQL search for one ad resource. A retry starts at the first stage without a confirmed resource. A headline over 30 characters is not sent |

Publishing is idempotent on a stored external id: a retry returns that id and does not call the create endpoint again.

### Meta video from Hypit

For a creative whose stored artifact is a Hypit MP4, Meta publishing first verifies the tenant/brand ownership, approved JEV decision, Hypit job and brief lineage, and the stored bytes/checksum. It uploads those bytes with a deterministic upload marker, saves the confirmed Meta video id, then uses that id in the existing paused campaign/ad-set/creative/ad path. Campaign, ad set, and ad are created as `PAUSED`; this flow does not turn delivery on.

The upload reservation is stored per organization and creative. A retry first reconciles Meta's video list for the exact marker; if the prior attempt is still ambiguous and no matching id is visible, Meridian leaves the upload pending and does not send a second upload. It reports success only after Meta returns or reconciliation finds an id. The confirmed id and Hypit/JEV/storage lineage are written to provider objects and the audit log. Missing account/token configuration returns `NOT_CONNECTED` without a publication receipt.

Meta performance sync resolves the credential for the job's organization and verifies that the selected external ad is accessible through that credential and belongs to an ad account available to it before observations are stored. Scheduling and worker execution both validate that the selected creative and ad are owned by the same organization and brand. Missing tenant credentials remain `NOT_CONNECTED`; production performance jobs do not borrow another tenant's credential.

Rate limits: HTTP 429 and 5xx are retried up to three times, honoring `Retry-After` up to two seconds. Other 4xx responses are the provider's answer.

## Test provider

`testProviderPublish` and `testProviderPerformance` throw unless the caller passes `allowTestProvider`. Ids are prefixed `test:`. Production server functions do not pass that flag.

## What is still external

- OAuth starts at `/api/oauth/callback`. The server checks state, exchanges the code, and seals the access token and any refresh token. `META_APP_ID`, `META_APP_SECRET`, `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, and `TOKEN_ENCRYPTION_KEY` have to exist or nothing is stored. The token is not put in the redirect. Meta video publishing also requires a configured ad account, a connected credential with the permissions Meta requires for the requested API operations, and the publishing inputs (including a Page id and destination link).
- `POST /api/webhooks/receive` verifies `WEBHOOK_SECRET`, a timestamp window, the signature, JSON, a new event id, and a known account, then enqueues `webhook.received`. Creating the subscription in Meta, TikTok, or Google is still an external step.
- Performance sync is a worker job. The learning page can save a schedule only after a connection probe has succeeded. Disconnect disables that provider's schedule. Reconnect enables it again only if the probe succeeds.
- Studio video uses a separate Hypit process. Set `HYPIT_BASE_URL`. Meridian does not vendor Hypit and does not fall back to another video provider. The job is stored only after the process returns MP4 bytes. `HYPIT_NOT_CONNECTED` means no bytes were requested. Missing vision evidence stays in human review. No transcript is invented.
- JEV Research uses the Meta Ad Library as its first external advertising source. `META_AD_LIBRARY_TOKEN` is required; requests are bounded to 100 video records and are deduplicated. A snapshot is only ingested when it exposes an explicit downloadable video URL on an allowed public Meta media host. Missing media is marked unavailable, not substituted. Stored MP4 bytes are verified and checksummed; each source video is limited to 24 MB and each run to 100 MB of media.
- JEV Research transcription uses local WhisperX (`WHISPERX_PATH`, default executable `whisperx`; `WHISPERX_MODEL` defaults to `small`; `WHISPERX_DEVICE` defaults to `cpu`) after `ffprobe` validation and `ffmpeg` audio extraction on the worker host. JEV structured analysis uses OpenRouter. Missing local transcription runtime or OpenRouter credentials remain explicit `NOT_CONNECTED` states; no hosted transcription fallback is used.
- Optional image generation uses Google AI Studio / Nano Banana (`GOOGLE_AI_STUDIO_API_KEY`, default model `gemini-3.1-flash-image`). Missing image configuration skips optional image creation and does not block JEV or Hypit.
- No live call is made by the unit tests. Parser tests use a scripted transport in the test file.
