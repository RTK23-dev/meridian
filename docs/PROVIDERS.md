# Providers and keys

Provider keys belong to a workspace. A key is saved in Settings, encrypted, and used only for that workspace. A deployment may
also supply a key for everyone, but only when an operator opts in with the variable named below. See ARCHITECTURE_CONTRACTS.md,
section 1, for the rules.

## Per-workspace provider keys

| Provider | Used for | Saved in Settings | Deployment key (opt-in) | Without a key |
| --- | --- | --- | --- | --- |
| TypeSafe JEV | Decisions (the JEV engine) | JEV | `TYPESAFE_JEV_API_KEY` or `TYPESAFE_API_KEY`, with `JEV_SHARED_DEFAULT=deployment` | Not configured. No decision is made |
| OpenAI | Decisions (the OpenAI engine) | OpenAI | `OPENAI_API_KEY`, with `OPENAI_SHARED_DEFAULT=deployment` | Not configured. No decision is made |
| OpenRouter | Decisions (the OpenRouter engine, and JEV when its backend is OpenRouter), and video, image and speech generation | OpenRouter | `OPENROUTER_API_KEY`, with `OPENROUTER_SHARED_DEFAULT=deployment` | Not configured. No decision is made and nothing is generated |
| Deepgram | Speech-to-text for the video engine: reference analysis and the held-call reconciler | Deepgram | `DEEPGRAM_API_KEY`, with `DEEPGRAM_SHARED_DEFAULT=deployment` | Not configured. No speech-to-text request is sent |
| Gemini perception | Reading images and video | Perception | Google key aliases in `config/resolver.ts`, with `PERCEPTION_SHARED_DEFAULT=gemini` | Not configured |
| Gemini production | Omni video and image generation | Production | `MERIDIAN_GEMINI_API_KEY` or the Google aliases, with `PRODUCTION_SHARED_DEFAULT=deployment` | Not configured. Nothing is generated |
| Higgsfield | Video generation | Production | `HIGGSFIELD_API_KEY`, with `PRODUCTION_SHARED_DEFAULT=deployment` | Not configured |
| Hypit | Video runtime (the Hypit handoff; see SETUP.md) | Hypit | `HYPIT_API_TOKEN` or `HYPIT_API_KEY`, with `HYPIT_SHARED_DEFAULT=deployment` | Not connected. The production route refuses with `NOT_CONNECTED`. The handoff needs `HYPIT_BASE_URL` pointing at a bridge you run |
| Shopify | Order webhooks, for sales attribution (see below) | Shopify | `SHOPIFY_WEBHOOK_SECRET`, with `SHOPIFY_SHARED_DEFAULT=deployment` | Not configured. Orders are refused with `NOT_CONNECTED` (503) and nothing is stored |
| Apify | Instagram volume discovery for Factory Gather (see below) | Apify | `APIFY_TOKEN`, with `APIFY_SHARED_DEFAULT=deployment` | Not configured. No Apify request is sent |

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

OpenRouter's ordinary chat (copy generation) uses a deployment-only key: `OPENROUTER_API_KEY`, with
`OPENROUTER_SHARED_DEFAULT=deployment`. A workspace cannot save that key. A workspace's own OpenRouter key is saved in Settings and
is used for decisions and generation. OPENROUTER.md lists every path that calls OpenRouter.

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

Status, 2026-10-15. Verified: the signature, the headers, the `orders/create` topic and the `myshopify.com` shop domain.
Partly verified: `landing_site`, `referring_site`, `source_name` and `note_attributes` are named, with example values, in the
`orders/create` sample, but no page says what they hold. The UTM values read from `landing_site` therefore have no documented
meaning, and the first live order confirms them. `discount_codes` is described as "a list of discounts applied to the order", with
`code`, `amount` and `type`. No code changed.

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
- A stored order is answered `200` with `recorded`, and a repeat with `200` with `already received`. Shopify's page says "Only a 200
  response confirms receipt", so any other status would make Shopify retry a stored order. This was a `202` before the fix on
  2026-10-15 (`src/lib/meridian/shopify/handler.ts`), and the tests now assert 200.

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

- **Facebook Page** and **Instagram**: a token for the Page or account, saved on the brand's account. A repurposed variation can also be posted to one Facebook Page, by an admin's explicit action, and its metrics read on request. Both use this connection. The token must be able to publish to the Page and to read its video insights; this build has not verified those permissions against a live Page, so the first real post is an owner check (FACTORY.md, "Repurposing a delivered video"). Instagram needs a public https
  route for the media (see the roadmap).
- **YouTube Shorts**: a token that grants the upload scope (`https://www.googleapis.com/auth/youtube.upload`). A token that declares
  scopes without it is not connected, and the reason says so.
- **TikTok (regular video)**: a token that grants `video.publish`. A token that declares scopes without it is not connected. TikTok
  posts are sent as private (`SELF_ONLY`) until TikTok approves the app for public posting. The publish is reported as done only when
  TikTok reports `PUBLISH_COMPLETE`. Scheduling is refused. This is not run against TikTok's live service in this release.

## Instagram trial reels

Checked 2026-10-15 against Meta's developer documentation. Nothing here was run against a live account. Verified: `trial_params`,
its two strategy values, the publish response and the read-back fields. Partly verified: the request host (below).

- **Trial parameter.** The IG User Media reference lists `trial_params` for `media_type=REELS`. Its `graduation_strategy` is `MANUAL` (the
  reel is graduated by hand in the native app) or `SS_PERFORMANCE` (the reel graduates automatically if it performs well).
  https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- **Request shape.** The Trial Reels section of the content publishing guide says trial reels are "only shared to non-followers". Its
  example sends a JSON body with `trial_params` as a nested object. It posts to graph.instagram.com/v25.0, while this build uses
  graph.facebook.com. The IG User Media reference's image sample posts to graph.facebook.com, and the pages read do not say which
  host a token type must use. Partly verified. https://developers.facebook.com/docs/instagram-platform/content-publishing
- **Container status.** The IG Container reference documents `status_code` as `FINISHED` (ready to publish), `ERROR` (failed to complete
  publishing), `EXPIRED` (not published within 24 hours), `IN_PROGRESS` and `PUBLISHED`. It has no trial field.
  https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container
- **Read-back.** The IG Media reference has no field that reports trial state or graduation. `is_shared_to_feed` (Reels only) says a
  reel "can appear in both the Feed and Reels tabs" when true, and Meta warns that neither value determines whether it appears there.
  It is stored as observed and is never read as graduation. https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media
- **Media type.** `media_product_type` (`AD`, `FEED`, `STORY` or `REELS`) is available for the Instagram API with Facebook Login only.
  With another kind of token it may be absent, and the build keeps it unknown. Same page.
- **Graduation by API.** Not documented. The docs say a MANUAL trial is graduated "in the native app". Meridian does not graduate a
  reel, and it does not record a feed step unless an observation says so. Today no observation exists.
- **Publish response.** `media_publish` returns `{"id": "<IG_MEDIA_ID>"}` and nothing about trial state.
  https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish
- **Strategy note, fixed 2026-10-15.** The docs say a `SS_PERFORMANCE` reel graduates by itself if it performs well, and a `MANUAL`
  reel is graduated by hand in the native app. The note in `trial.ts` (`GRADUATION_NOT_DOCUMENTED`) and the publish dialog hint now say
  so for each strategy. Meridian still records the feed step only when it observes a graduation.
- **Not verified.** Eligibility (a third-party guide cites about 1,000 followers; Meta publishes no threshold). Whether a trial's media
  id stays the same after graduation. Whether the trial parameter is accepted on v21.0. Trial calls use v25.0, and the rest of the
  Instagram flow stays on v21.0 (`TRIAL_GRAPH_BASE` in `src/lib/meridian/distribution/graph.ts`). A third-party summary says Meta does not
  expose graduation through the API. That is not Meta's statement, and it was not checked against Meta.

How the build uses this (`src/lib/meridian/distribution/trial.ts`, `instagram.ts`, `trial-check.ts`):

1. The trial step publishes a Reel with `trial_params`, and its receipt is an `organic_posts` row with the media id that `media_publish`
   returned. A refused or unconfirmed step is recorded as such, and no trial row is written.
2. A row in `organic_trial_reels` links the receipt to the media id. A `distribution.trial_check` job runs one day later, and then daily,
   for at most 7 checks. Each check reads `id`, `media_type`, `media_product_type`, `is_shared_to_feed` and `permalink` from the media.
3. The feed step is `graduated` only when an observed graduation is recorded. The live reader observes none, so each check leaves the
   feed step as `manual_action_required`, with the reason, until a person graduates the reel in the Instagram app. A failed read is
   recorded as the last error, and nothing is read as a state.

Owner live run (not done by an agent): on an Instagram account that is connected for a brand, publish one trial reel with
`MANUAL` and record the container id, the media id, Meta's response, and what the Instagram app shows after the first check. Then
graduate it by hand and record whether any later check observes it. Record both receipts in the run's Library.

## Apify: Instagram volume (Factory Gather)

Checked 2026-10-15 against the Apify pages. The request and output tables, with their statuses, are in
`docs/engine/PROVIDER_APIS.md` (Apify). Nothing was run against a live account.

- Request: `POST https://api.apify.com/v2/actors/{actorId}/run-sync-get-dataset-items`, with `actorId` as `owner~name`, and the header
  `Authorization: Bearer <token>`. Verified: https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post and
  https://docs.apify.com/api/v2/getting-started. A 201 response holds the item array. A 408 means the run passed 300 seconds.
- Actors: `apify~instagram-hashtag-scraper` for niche search and `apify~instagram-reel-scraper` for creator baselines. Their input
  names (`hashtags`, `resultsLimit`, `username`, `skipPinnedPosts`) are verified on https://apify.com/apify/instagram-hashtag-scraper
  and https://apify.com/apify/instagram-reel-scraper.
- Fields read and documented: `url`, `ownerUsername`, `timestamp`, `caption`, `hashtags`, `id` and `commentsCount`. A `likesCount`
  of `-1` means the count is hidden, and it is read as unknown.
- Partly verified: `videoPlayCount`, the view count used for ratings. It is named in the samples of both actors, and the docs describe
  views in words, but they do not say how it differs from `videoViewCount`. `type` and `shortCode` appear only in the samples. The
  accepted `resultsType` values are not listed.
- Not verified: the price. The pages give conflicting figures, so no cost is estimated.

No code changed. The owner confirms the partly verified fields at the first live run. Nulling `videoPlayCount` would stop every
rating, and nulling `type` would drop every hashtag result, so the fields are kept and flagged.

## Engine choice

Decisions use one engine per workspace (DECISIONS.md). `DECISION_ENGINE` sets the deployment default. OpenRouter Decisions uses the workspace's OpenRouter key. Its decision model is chosen in Settings from OpenRouter's live catalogue, and only models with a verified profile are offered (OPENROUTER.md, "Decision models: the live catalogue"). `OPENROUTER_DECISIONS_MODEL` is the deployment default, used only when a workspace has not chosen one. A workspace's own choice takes precedence. `OPENROUTER_DECISION_MAX_USD_PER_CALL` caps what one decision may cost before it is sent.

JEV has its own backend choice per workspace, also made in Settings: TypeSafe System One (the default) or OpenRouter Decisions. JEV
calls exactly one backend for a decision and never falls back to the other. Its questions and answer checks are the same either way.

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
