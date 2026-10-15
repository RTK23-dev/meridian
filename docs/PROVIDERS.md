# Providers and keys

Provider keys belong to a workspace. A key is saved in Settings, encrypted, and used only for that workspace. A deployment may
also supply a key for everyone, but only when an operator opts in with the variable named below. See ARCHITECTURE_CONTRACTS.md,
section 1, for the rules.

## Per-workspace provider keys

| Provider | Used for | Saved in Settings | Deployment key (opt-in) | Without a key |
| --- | --- | --- | --- | --- |
| TypeSafe JEV | Decisions (the JEV engine) | JEV | `TYPESAFE_JEV_API_KEY` or `TYPESAFE_API_KEY`, with `JEV_SHARED_DEFAULT=deployment` | Not configured. No decision is made |
| OpenAI | Decisions (the OpenAI engine) | OpenAI | `OPENAI_API_KEY`, with `OPENAI_SHARED_DEFAULT=deployment` | Not configured. No decision is made |
| Gemini perception | Reading images and video | Perception | Google key aliases in `config/resolver.ts`, with `PERCEPTION_SHARED_DEFAULT=gemini` | Not configured |
| Gemini production | Omni video and image generation | Production | `MERIDIAN_GEMINI_API_KEY` or the Google aliases, with `PRODUCTION_SHARED_DEFAULT=deployment` | Not configured. Nothing is generated |
| Higgsfield | Video generation | Production | `HIGGSFIELD_API_KEY`, with `PRODUCTION_SHARED_DEFAULT=deployment` | Not configured |
| Hypit | Video runtime | Hypit | `HYPIT_API_TOKEN` or `HYPIT_API_KEY`, with `HYPIT_SHARED_DEFAULT=deployment` | Not connected. Set `HYPIT_BASE_URL` for the runtime itself |
| Shopify | Order webhooks, for sales attribution (see below) | Shopify | `SHOPIFY_WEBHOOK_SECRET`, with `SHOPIFY_SHARED_DEFAULT=deployment` | Not configured. Orders are refused with `NOT_CONNECTED` (503) and nothing is stored |

Sources keep one key per connector. Each has its own opt-in, named `<CATEGORY>_SHARED_DEFAULT`:

| Source | Environment names (first one set wins) | Opt-in |
| --- | --- | --- |
| Meta Ad Library | `META_AD_LIBRARY_TOKEN` | `META_AD_LIBRARY_SHARED_DEFAULT` |
| Meta Graph | `META_ACCESS_TOKEN`, `FACEBOOK_ACCESS_TOKEN` | `META_GRAPH_SHARED_DEFAULT` |
| Instagram | `INSTAGRAM_ACCESS_TOKEN` | `INSTAGRAM_SHARED_DEFAULT` |
| YouTube | `YOUTUBE_API_KEY` | `YOUTUBE_SHARED_DEFAULT` |
| Search | `SERPAPI_API_KEY` | `SEARCH_SHARED_DEFAULT` |
| X (Twitter) | `TWITTER_BEARER_TOKEN`, `X_API_KEY` | `TWITTER_SHARED_DEFAULT` |
| LinkedIn | `LINKEDIN_ACCESS_TOKEN` | `LINKEDIN_SHARED_DEFAULT` |
| Pinterest | `PINTEREST_ACCESS_TOKEN` | `PINTEREST_SHARED_DEFAULT` |
| TikTok | `TIKTOK_ACCESS_TOKEN` | `TIKTOK_SHARED_DEFAULT` |
| Licensed data | `LICENSED_DATA_API_KEY`, `SENSOR_TOWER_API_KEY` | `LICENSED_SHARED_DEFAULT` |

A source with no usable key is listed as not configured, with the reason. Public web pages need no key.
Reddit's API is not connected in this release; direct post URLs are still read from their public pages.

OpenRouter is used only for copy generation, and only from the deployment: `OPENROUTER_API_KEY`, with
`OPENROUTER_SHARED_DEFAULT=deployment`. It is never a decision engine.

## Shopify orders (sales attribution)

What the Shopify documentation says, checked on 2026-10-15:

- Each HTTPS delivery is signed. `X-Shopify-Hmac-Sha256` holds the base64 of HMAC-SHA256 over the raw request body, keyed with the
  app's client secret. Compute it over the raw body before any parser runs, and compare it in constant time. Source:
  https://shopify.dev/docs/apps/build/webhooks/subscribe/https and https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
- Headers: `X-Shopify-Topic` (for example `orders/create`), `X-Shopify-Shop-Domain` (the `myshopify.com` domain of the store),
  `X-Shopify-Hmac-Sha256`, `X-Shopify-Webhook-Id` (unique per delivery) and `X-Shopify-Event-Id` (shared by one merchant action).
  Source: https://shopify.dev/docs/apps/build/webhooks/delivery-structure
- The receiver must answer `200` within five seconds. Any other response, including 3xx, is an error, and Shopify retries eight
  times over four hours. Source: https://shopify.dev/docs/apps/build/webhooks/subscribe/https
- The `orders/create` sample payload is an Order object at the top level: `id`, `name`, `currency`, `total_price`,
  `subtotal_price`, `total_tax`, `created_at`, `landing_site`, `referring_site`, `source_name`, `note_attributes` (a list of
  `{name, value}`) and `discount_codes` (a list of `{code, amount, type}`). Sources: https://shopify.dev/docs/api/webhooks/2026-01
  (topic list and sample payloads) and https://shopify.dev/docs/api/admin-rest/2026-01/resources/order (sample payload). The
  reference pages do not describe `landing_site`, `referring_site`, `note_attributes` or `source_name` in words, so the reader
  relies on those sample shapes only.

How Meridian uses them:

- The endpoint is `POST /api/webhooks/shopify`. The shop is routed by its `myshopify.com` domain, which a brand connects in the
  Factory's sales panel. A shop that is not connected gets `401` with the same answer as a bad signature.
- A connected shop with no usable secret gets `503 NOT_CONNECTED` and nothing is stored. The secret is the workspace's own
  `shopify` credential, saved in Settings. `SHOPIFY_WEBHOOK_SECRET` is read only with `SHOPIFY_SHARED_DEFAULT=deployment`.
- A bad signature gets `401 HMAC validation failed.` A topic other than `orders/create` is acknowledged and not stored.
- An order is matched to a reel by `utm_content` in its landing site first, then by its DM keyword as a discount code or as a
  note attribute named `dm_keyword` or `meridian_keyword`. A tie or no match is stored unmatched. The rule that matched is stored.
- An order is stored once per shop and Shopify order id. Its totals are stored as the decimal text Shopify sends, and a total that
  is missing or malformed is stored as unknown. No customer details are stored.

## Infrastructure (environment only)

These are read by the code that owns them. They are not saved per workspace.

- `TOKEN_ENCRYPTION_KEY`: encrypts saved keys and connection tokens. Losing it makes saved keys unreadable.
- `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`: sign-in.
- `DATABASE_URL`: PostgreSQL.
- S3 is retired (NORTH_STAR decision 2). There are no `S3_*` settings. Artifacts and exports go to Google Drive.
- `EMAIL_API_URL`, `EMAIL_API_KEY`: optional email delivery.
- `WEBHOOK_SECRET`: the secret that inbound webhooks are checked against.
- `EXTERNAL_SEMANTIC_URL`, `EXTERNAL_SEMANTIC_KEY`: optional external embeddings. Without them, the local semantic store is used.
- `GOOGLE_SERVICE_ACCOUNT_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `MERIDIAN_DRIVE_FOLDER_ID`: Google Drive.

## Deployment configuration

Non-secret settings: `HYPIT_BASE_URL`, the model names (`MERIDIAN_OMNI_MODEL`, `MERIDIAN_IMAGE_MODEL`, `OPENAI_DECISIONS_MODEL`,
`TYPESAFE_JEV_MODEL`), timeouts, and the Cyclone device gateway (`CYCLONE_GATEWAY_URL`, `CYCLONE_DEVICE_ID`, `CYCLONE_API_KEY`).
Cyclone is one device owned by the deployment, so its key is read from the environment by design.

The sourcing sidecar is optional. `MERIDIAN_SOURCING_SIDECAR_URL` (for example `http://127.0.0.1:8765`) and `MERIDIAN_SIDECAR_TOKEN` turn it
on. The sidecar parses pages Meridian has already fetched and reads Agent Reach's public V2EX and RSS routes. It never fetches a URL
itself. See [SOURCING_SIDECAR.md](SOURCING_SIDECAR.md).

## Organic publishing accounts

Regular posts go through a connected account, saved per brand on Connected accounts with its platform account ID and an access token.

- **Facebook Page** and **Instagram**: a token for the Page or account, saved on the brand's account. Instagram needs a public https
  route for the media (see the roadmap).
- **YouTube Shorts**: a token that grants the upload scope (`https://www.googleapis.com/auth/youtube.upload`). A token that declares
  scopes without it is not connected, and the reason says so.
- **TikTok (regular video)**: a token that grants `video.publish`. A token that declares scopes without it is not connected. TikTok
  posts are sent as private (`SELF_ONLY`) until TikTok approves the app for public posting. The publish is reported as done only when
  TikTok reports `PUBLISH_COMPLETE`. Scheduling is refused. This is not run against TikTok's live service in this release.

## Engine choice

Decisions use one engine per workspace (DECISIONS.md). `DECISION_ENGINE` sets the deployment default. A workspace's own choice,
made in Settings, takes precedence.

## Inbound webhooks

A provider (or a relay acting for one) posts each event to `POST /api/webhooks/receive`. Meridian verifies the delivery, then
records it in the workspace its account is connected to. Recording is all that happens: nothing downstream reads recorded
events yet. The webhook job's result is `recorded:<eventId>:no-downstream-processing`.

The secret is `WEBHOOK_SECRET` (see Infrastructure above). Senders must sign with it.

### Sender contract

Send `POST` with `Content-Type: application/json` (a charset parameter is accepted) and these headers:

| Header | Value |
| --- | --- |
| `x-meridian-provider` | The provider name, for example `meta` |
| `x-meridian-account` | The account id stored on the provider connection |
| `x-meridian-event` | The provider's event id. Unique per provider and account |
| `x-meridian-timestamp` | Unix time in milliseconds when the delivery was signed |
| `x-meridian-signature` | Lowercase hex HMAC-SHA256, described below |

The signature covers this canonical string. It has six lines, joined with a line feed (`\n`), with no trailing newline:

```
v2
<provider>
<account>
<eventId>
<timestamp>
<lowercase hex SHA-256 of the raw request body>
```

The signature is the lowercase hex HMAC-SHA256 of that string, keyed with `WEBHOOK_SECRET`. The body is hashed as the UTF-8
bytes sent, so sign the exact bytes you send. The header values must be the same values used in the canonical string. A
changed provider, account, event id or timestamp invalidates the signature. The timestamp must be within five minutes of
Meridian's clock.

A signature in the earlier form, over the timestamp and body only, is refused with 401. Senders must switch to v2.

Example (Node.js 18 or later):

```js
import { createHash, createHmac } from "node:crypto";

// Returns the value for x-meridian-signature. Pass the same values here and in the headers.
export function signMeridianWebhook({ secret, provider, account, eventId, timestamp, rawBody }) {
  const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
  const canonical = ["v2", provider, account, eventId, timestamp, bodyHash].join("\n");
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

const rawBody = JSON.stringify({ type: "ad.updated", id: "123" });
const timestamp = String(Date.now());
const signature = signMeridianWebhook({
  secret: process.env.WEBHOOK_SECRET,
  provider: "meta",
  account: "act_42",
  eventId: "evt_9001",
  timestamp,
  rawBody,
});

await fetch("https://<meridian-host>/api/webhooks/receive", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-meridian-provider": "meta",
    "x-meridian-account": "act_42",
    "x-meridian-event": "evt_9001",
    "x-meridian-timestamp": timestamp,
    "x-meridian-signature": signature,
  },
  body: rawBody,
});
```

### Responses

| Status | Body | Meaning |
| --- | --- | --- |
| 202 | `recorded` | A new event was stored and its job queued. Nothing else runs yet |
| 200 | `already received` | The workspace already holds this event. Nothing new is stored. Its job is ensured |
| 401 | The reason | The signature, timestamp, JSON, headers or account was refused. Nothing was stored |
| 400 | The reason | `Content-Length` is not a number |
| 408 | The reason | The body did not finish arriving within 10 seconds |
| 409 | The reason | The account is connected to more than one workspace, so the event cannot be routed. Nothing was stored |
| 413 | The reason | The body is over 256 KB |
| 415 | The reason | The media type is not `application/json` |

A repeated event id is a duplicate only within one workspace, and it is answered 200. The same event id can be recorded once for
each workspace it reaches. The 401 and 409 responses are decided before anything is written. A 401 for an unknown account is
returned only after the signature passes, so an unsigned caller cannot learn how an account is connected.
