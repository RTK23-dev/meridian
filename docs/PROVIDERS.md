# Providers

A provider client builds a real HTTP request and reads ids only from the response. If the response has no id, Meridian stores no external id.

Connection phases, in order of what the screen may show:

`NOT_CONFIGURED`, `CONNECTING`, `CONNECTED`, `SYNCING`, `HEALTHY`, `DEGRADED`, `FAILED`, `DISCONNECTED`.

Credentials without a successful request stay `NOT_CONFIGURED`. `HEALTHY` means the last probe succeeded. `DISCONNECTED` is a local stop; stored external ids are kept and no further request is sent until reconnect.

## Live clients

| Provider | Probe | Publish |
| --- | --- | --- |
| Meta | `GET /me`, ad accounts, granted permissions | Paused campaign, ad set, creative, and ad on Graph API v21.0 |
| Ad Library | `GET /ads_archive` with a data array | Does not publish |
| TikTok | `GET /user/info/` and, when app credentials exist, advertiser list | Paused campaign, ad group, then ad. An ad is not requested until an uploaded image or video id is supplied. Insights use the integrated report for one ad id |
| Google Ads | `customers:listAccessibleCustomers` | Budget, paused search campaign, ad group, and responsive search ad. Insights use a GAQL search for one ad resource. A retry starts at the first stage without a confirmed resource. A headline over 30 characters is not sent |

Publishing is idempotent on a stored external id: a retry returns that id and does not call the create endpoint again.

Rate limits: HTTP 429 and 5xx are retried up to three times, honoring `Retry-After` up to two seconds. Other 4xx responses are the provider's answer.

## Test provider

`testProviderPublish` and `testProviderPerformance` throw unless the caller passes `allowTestProvider`. Ids are prefixed `test:`. Production server functions do not pass that flag.

## What is still external

- OAuth starts at `/api/oauth/callback`. The server checks state, exchanges the code, and seals the access token and any refresh token. `META_APP_ID`, `META_APP_SECRET`, `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, and `TOKEN_ENCRYPTION_KEY` have to exist or nothing is stored. The token is not put in the redirect.
- `POST /api/webhooks/receive` verifies `WEBHOOK_SECRET`, a timestamp window, the signature, JSON, a new event id, and a known account, then enqueues `webhook.received`. Creating the subscription in Meta, TikTok, or Google is still an external step.
- Performance sync is a worker job. The learning page can save a schedule only after a connection probe has succeeded. Disconnect disables that provider's schedule. Reconnect enables it again only if the probe succeeds.
- Video generation stays `NOT_CONNECTED`. MP4 timing can be read from a file you already have. No transcript is invented.
- No live call is made by the unit tests. Parser tests use a scripted transport in the test file.
