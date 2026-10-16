# Provider API reference for engine agents

Agents cannot browse the web. These are the request and response shapes the lead read from each provider's official
documentation on 2026-10-14 (OpenRouter docs, pexels.com/api/documentation, pixabay.com/api/docs). Build adapters and
recorded fixtures to these shapes. Anything not listed here is unknown: leave it out or null, never guess. Every call goes
through `src/engine/gateway` (the gateway adds the key and base URL); paths below are relative to each provider's base URL
in `gateway/providers.ts`.

## OpenRouter (base `https://openrouter.ai/api/v1`, bearer key)

### Video: `POST /videos`, then `GET /videos/{id}`
Already wrapped by `gateway/openrouter.ts` (`submitVideo`, `pollVideo`). Request fields: `model`, `prompt`, `duration`
(seconds), `resolution` (`720p`, `1080p`), `aspect_ratio` (`9:16`, `16:9`), `generate_audio` (boolean), and
`frame_images`:
```json
[{ "type": "image_url", "image_url": { "url": "https://…/first.jpg" }, "frame_type": "first_frame" },
 { "type": "image_url", "image_url": { "url": "https://…/last.jpg" }, "frame_type": "last_frame" }]
```
Unsupported values return 400 listing the supported ones. Poll statuses: `pending`, `in_progress`, `completed`, `failed`,
`cancelled`, `expired`; completed carries `unsigned_urls[]` and `usage.cost` (USD).

### Video model capabilities: `GET /videos/models`
`data[]` of `{ id, canonical_slug, name, generate_audio, supported_durations[], supported_resolutions[],
supported_aspect_ratios[], supported_frame_images[] ("first_frame", "last_frame"), supported_sizes, pricing_skus{},
seed, allowed_passthrough_parameters[] }`. Use it for the first-and-last-frame test (Bible 20.3 item 2) and to fill
`ProviderCapabilities`. Ids seen in the docs (examples, not verified for our account): `google/veo-3.1`,
`google/veo-3.1-lite`, `kwaivgi/kling-v3.0-std`, `kwaivgi/kling-v3.0-pro`, `bytedance/seedance-2.0`,
`bytedance/seedance-2.0-fast`, `alibaba/wan-2.6`, `alibaba/wan-2.7`.

### Images: `POST /images`
Request: `model` (for example `bytedance-seed/seedream-4.5`), `prompt`, optional `n` (1-10), `resolution` (`512`, `1K`,
`2K`, `4K`), `aspect_ratio` (`1:1`, `9:16`, `16:9`, …), `size`, `quality`, `output_format` (`png`, `jpeg`, `webp`, `svg`),
`background`, `seed`, `input_references` (reference images for image-to-image). Response 200:
```json
{ "created": 1748372400, "data": [{ "b64_json": "<base64>", "media_type": "image/png" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 4175, "total_tokens": 4175, "cost": 0.04 } }
```

**Input references, checked 2026-10-15.** Source: OpenRouter image generation guide, https://openrouter.ai/docs/guides/overview/multimodal/image-generation
(the page covers generation and image-to-image on `POST /api/v1/images`; there is no separate edit endpoint and no mask field).
- Shape, as documented: `input_references` is an array. Each element is `{ "type": "image_url", "image_url": { "url": "<https URL or base64 data URL>" } }`.
  `src/engine/assets/providers/openrouterImage.ts` sends exactly this shape, so no change was needed.
- Limit: **not stated.** The page says only that the number accepted varies by provider. `IMAGE_REFERENCES_MAX` in that file is an
  initial bound, marked unverified, to be replaced by the owner's live run.
- Other fields the page documents: `aspect_ratio` (`auto`, or ratios such as `9:16`; the full set per provider is not stated),
  `n` (1 to 10), `seed` (integer; range not stated), `output_format` (`png`, `jpeg`, `webp`, `svg`).
- Image-input page (`https://openrouter.ai/docs/features/multimodal/image-inputs` and `.../guides/overview/multimodal/images`): both
  returned HTTP 404 on 2026-10-15 and were not read. The image generation guide above is the only source used for this check.

### Speech (TTS): `POST /audio/speech`
Request: `model`, `input` (text), `voice` (provider-specific; required unless the provider documents a default),
`response_format` (`mp3` or `pcm`, default `pcm`), `speed`, `input_references` (voice cloning; not used without the
owner's approval). Response 200: raw audio bytes (`audio/mpeg` for mp3), with the generation id in the `X-Generation-Id`
header. The response carries no cost: reconcile from the price table, flagged as an estimate.

### Chat with structured output
Already wrapped by `gateway/openrouter.ts` (`structuredChat`); used by `src/engine/claude`.

### Model ids in `config/routes.ts`: verification, 2026-10-15 (item d)
Recorded by route key, not by model name. Source, retrieved 2026-10-15: the models guide at
https://openrouter.ai/docs/guides/overview/models, which documents the list endpoint `GET /api/v1/models` and the single-model
endpoint `GET /api/v1/model/{author}/{slug}`.
- The list read returned 10 entries and `has_more: false`, but the guide says the catalogue has "400+ models". That read was
  incomplete, so it cannot show that an id is absent. No id is recorded as absent on that basis.
- The single-model endpoint returned a model object whose `id` matched exactly for each id checked below. The read went through
  a fetch tool that summarises the page, so the match is that tool's reading of the response. The owner's live run confirms it.

| Route key (`config/routes.ts`) | Target | Status |
| --- | --- | --- |
| `llm.direction`, `llm.analysis`, `llm.check` | first | Partly verified (single-model endpoint, exact id) |
| `video.cinematic` | first | Partly verified (same) |
| `video.budget` | third | Partly verified (same) |
| `image.keyframe` | second | Partly verified (same) |
| Every other OpenRouter target | any | Not verified. The id is null in `routes.ts`, so there is nothing to check |
| Stock, render, media-function and discovery routes | any | Not OpenRouter ids. See the Pexels, Pixabay, Shotstack and Apify sections |

The `verified` flags in `routes.ts` stay `false`. The owner's live run sets them.

## Pexels (base `https://api.pexels.com`, header `Authorization: <key>`, no scheme)
`GET /videos/search?query=…&orientation=portrait&size=medium&per_page=…&page=…`. Response: `{ page, per_page,
total_results, next_page, videos: [{ id, width, height, duration, url, image, user: { id, name, url },
video_files: [{ id, quality ("hd", "sd", "hls"), file_type, width, height, fps, link }] }] }`. Attribution and licence
terms for commercial social use are an owner check (E2.6); record `url` and `user` with every clip.

## Pixabay (base `https://pixabay.com/api`, key as the `key` query parameter, added by the gateway)
`GET /videos/?q=…&video_type=film&min_width=…&min_height=…&safesearch=true&per_page=3..200&page=…`. Response:
`{ total, totalHits, hits: [{ id, pageURL, type, tags, duration, user_id, user, videos: { large|medium|small|tiny:
{ url, width, height, size, thumbnail } } }] }`. Record `pageURL` and `user` with every clip.

## Shotstack (base `https://api.shotstack.io/edit/v1`, header `x-api-key: <key>`)
Fallback renderer for component-free EDLs (owner decision 2026-10-14). The docs use `{version}` in the path; `v1` is the
production environment (the sandbox is `stage`).

`POST /render` with JSON `{ timeline, output, callback? }`:
- `timeline`: `{ soundtrack?: { src, effect?, volume? }, background?: "#000000", fonts?: [{ src }], tracks: [{ clips: [clip] }] }`.
  Earlier tracks are drawn on top of later ones.
- `clip`: `{ asset, start (s), length (s), fit? ("cover", "contain", …), scale?, position? ("top", "center", "bottom", …),
  offset?: { x, y }, transition?: { in, out }, effect?, filter?, opacity?, alias? }`.
- `asset` types seen in the docs: `video` `{ type, src, trim?, volume?, speed?, crop? }`, `image` `{ type, src }`,
  `title` `{ type, text, style }`, `audio` (soundtrack-like). Anything else: verify before use.
- `output`: `{ format: "mp4", size: { width: 1080, height: 1920 }, fps, quality?, mute?, poster?, thumbnail? }`
  (`resolution`/`aspectRatio` are the alternative to `size`).
Response 200/201: `{ success, message, response: { id, message } }` (the docs also show `{ id, status }`; parse both).

`GET /render/{id}`: `{ success, message, response: { id, status, error, duration, renderTime, url, poster, thumbnail,
created, updated } }`. Status values seen: `queued`, `fetching`, `rendering`, `saving`, `done`, `failed`. `url` is a
temporary asset URL (download it to our storage).

## Apify (base `https://api.apify.com/v2`, `Authorization: Bearer <token>`)

Read on 2026-10-15 from docs.apify.com and the two actors' store pages. Nothing here was called live. Sources:
- Run an Actor synchronously and get its dataset items: https://docs.apify.com/api/v2/act-run-sync-get-dataset-items-post
- Authentication (the header is recommended; a `token` query parameter is also documented): https://docs.apify.com/platform/integrations/api
- The header form `Authorization: Bearer YOUR_API_TOKEN`: https://docs.apify.com/api/v2/getting-started
- Hashtag actor `apify/instagram-hashtag-scraper`: https://apify.com/apify/instagram-hashtag-scraper
- Reel actor `apify/instagram-reel-scraper`: https://apify.com/apify/instagram-reel-scraper
- Checked and not used: `apify/instagram-scraper` (https://apify.com/apify/instagram-scraper)

Gateway: provider `apify` in `gateway/providers.ts`, credential category `apify` (a workspace key in Settings; the deployment
key `APIFY_TOKEN` only with `APIFY_SHARED_DEFAULT=deployment`). Routes: `discovery.instagram` (hashtag actor) and
`discovery.instagram.creator` (reel actor) in `config/routes.ts`, with `verified: false`. Their price is null: no cost is
estimated until the owner confirms the plan.

### Run an actor synchronously and read its items
`POST /actors/{actorId}/run-sync-get-dataset-items`, where `actorId` is `owner~name` (for example `apify~instagram-reel-scraper`).
The body is the actor's input as JSON (`Content-Type: application/json`). Query parameters used: `maxItems` (caps the items
Apify charges for on a pay-per-result actor; it does not limit the items returned) and `timeout` (seconds). Documented answers:
201 with a JSON array of the dataset items (the client also accepts 200, which the part of the page read does not list); 400 invalid input; 401 missing or invalid token;
402 no credit or usage limit; 403 insufficient permissions; 408 when the run passes 300 seconds. The endpoint also takes
`maxTotalChargeUsd`, a USD cap for the run. It is not used, because no price is confirmed.

### Hashtag actor: `apify~instagram-hashtag-scraper` (niche search)
Input (documented): `hashtags` (array, one term per entry, with or without `#`), `resultsType` (the docs' example value is
`"posts"`; the description says posts or reels), `resultsLimit` (integer, per hashtag), `keywordSearch` (boolean, not used).
Sent: `{ hashtags: [term], resultsType: "posts", resultsLimit }`.
Output fields in the documented samples: `id`, `type` (`"Image"` or `"Video"`; reels are `"Video"`), `url` (the `/p/` or `/reel/`
form), `shortCode`, `ownerUsername`, `timestamp` (an ISO-style string in the samples; the time zone is not stated), `caption`, `hashtags`, `videoPlayCount` (on reel samples),
`likesCount` (`-1` when the creator hides it), `commentsCount`, `videoDuration`. `videoViewCount` appears only in the keyword-search
sample, so it is not used for hashtag results. One reading also listed `igPlayCount`; it is not used.
Price: the page header says "from $1.90 / 1,000 results" (pay per event); the README gives $2.60 per 1,000 on the Free plan and
$2.30 on Starter. The two disagree, so no price is set (null).

### Reel actor: `apify~instagram-reel-scraper` (creator baseline, and checkpoints)
Input (documented): `username` (array; accepts usernames, profile URLs, profile IDs, or direct reel URLs, each processed on its own),
`resultsLimit` (per profile or URL; ignored for direct reel URLs), `skipPinnedPosts` (boolean). Sent for a creator:
`{ username: [handle], resultsLimit: 30, skipPinnedPosts: true }`. Sent for one reel's checkpoint: `{ username: [permalink], resultsLimit: 1 }`.
Output fields in the documented samples: `id`, `type` (`"Video"` for reels), `url` (the `/p/` form in the sample), `shortCode`,
`ownerUsername`, `timestamp`, `caption`, `hashtags`, `videoViewCount` and `videoPlayCount` (both appear in the samples; the docs do not
define how they differ), `likesCount` (`-1` when hidden), `commentsCount`.
Price: the header says "from $1.00 / 1,000 reels", the README gives $2.60 per 1,000 on Free and $2.30 on Starter. Add-ons
(transcripts, video downloads) are billed separately, with no rate given. No price is set (null).

### What the code uses, and what is not confirmed
- The view count used for ratings is `videoPlayCount`. It is the field present on every reel sample of both actors. The docs do
  not say whether it is Instagram's view count, so the owner confirms this at the first live run. Candidate and baseline use the
  same field, so the ratio compares like with like.
- Creator follower counts are not in the documented output lists. They are stored as null, and a tier that depends on them is
  shown as not rated.
- Shares: `includeSharesCount` exists, but the output field name is not shown. Shares are null.
- Not confirmed: the `resultsType` value that returns reels only (the code asks for `"posts"` and keeps the `"Video"` items);
  whether a hashtag search returns reels as `"Video"` in every case; the plan price per 1,000 results.
- No field is read as a guess. An absent or unreadable field is null, and a `-1` like count is null.

### Verification status, 2026-10-15 (item a)
All sources above, retrieved 2026-10-15. "Verified" means the page states it. "Partly" means the name or an example is on the page,
but its meaning, or the full set of values, is not.

| Item | Status |
| --- | --- |
| `POST /actors/{actorId}/run-sync-get-dataset-items`, `actorId` as `owner~name` | Verified (act-run-sync page) |
| Body is the actor input as JSON; query `maxItems` and `timeout` | Verified (act-run-sync page) |
| `Authorization: Bearer <token>` | Verified (getting-started page) |
| Success 201 with the item array | Verified. 200 is not in the part of the page read; the client accepts it as a tolerance |
| 400, 401, 402, 403, and 408 for a run past 300 seconds | Verified (act-run-sync page) |
| Hashtag input `hashtags`, `resultsLimit` | Verified (hashtag actor page) |
| Hashtag `resultsType: "posts"` | Partly. `"posts"` is the page's example; the accepted values are not listed |
| Reel input `username` (array), `resultsLimit`, `skipPinnedPosts` | Verified (reel actor page) |
| Output `url`, `ownerUsername`, `timestamp`, `caption`, `hashtags`, `id`, `commentsCount` | Verified. The time zone of `timestamp` is not stated |
| `likesCount` of `-1` means hidden, read as null | Verified (hashtag actor FAQ) |
| `videoPlayCount` as the view count | Partly. Named in both samples. The hashtag table says "reel views/plays" without naming it; the reel table has the label "Video views and play count". How it differs from `videoViewCount` is not stated |
| `type` (`"Video"` for reels) | Partly. Sample only, with no description |
| `shortCode` | Partly. Sample only, with no description |
| Price per 1,000 results | Not verified. The pages give conflicting figures, so no price is set |

Decision, 2026-10-15: no code change. Every field the code reads is named in an actor's own output list or sample, so none is
absent from the docs. The partly verified fields are read as named. Nulling `videoPlayCount` would stop every rating, and nulling
`type` would drop every hashtag result. The owner confirms them at the first live run. Under a stricter reading, the fields to
null are `videoPlayCount`, `type` and `shortCode`.

