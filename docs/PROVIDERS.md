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
| TikTok | `GET /user/info/` and, when app credentials exist, advertiser list | Paused campaign via `/campaign/create/` |
| Google Ads | `customers:listAccessibleCustomers` | Budget mutate, then paused campaign mutate. No campaign is stored if the budget response has no resource name |

Publishing is idempotent on a stored external id: a retry returns that id and does not call the create endpoint again.

Rate limits: HTTP 429 and 5xx are retried up to three times, honoring `Retry-After` up to two seconds. Other 4xx responses are the provider's answer.

## Test provider

`testProviderPublish` and `testProviderPerformance` throw unless the caller passes `allowTestProvider`. Ids are prefixed `test:`. Production server functions do not pass that flag.

## What is still external

- OAuth consent screens are not hosted here. The host supplies tokens.
- Webhooks are not verified because no webhook subscription is configured.
- Video generation stays `NOT_CONNECTED`. MP4 timing can be read from a file you already have. No transcript is invented.
- No live call is made by the unit tests. Parser tests use a scripted transport in the test file.
