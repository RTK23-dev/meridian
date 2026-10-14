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

### Speech (TTS): `POST /audio/speech`
Request: `model`, `input` (text), `voice` (provider-specific; required unless the provider documents a default),
`response_format` (`mp3` or `pcm`, default `pcm`), `speed`, `input_references` (voice cloning; not used without the
owner's approval). Response 200: raw audio bytes (`audio/mpeg` for mp3), with the generation id in the `X-Generation-Id`
header. The response carries no cost: reconcile from the price table, flagged as an estimate.

### Chat with structured output
Already wrapped by `gateway/openrouter.ts` (`structuredChat`); used by `src/engine/claude`.

## Pexels (base `https://api.pexels.com`, header `Authorization: <key>`, no scheme)
`GET /videos/search?query=…&orientation=portrait&size=medium&per_page=…&page=…`. Response: `{ page, per_page,
total_results, next_page, videos: [{ id, width, height, duration, url, image, user: { id, name, url },
video_files: [{ id, quality ("hd", "sd", "hls"), file_type, width, height, fps, link }] }] }`. Attribution and licence
terms for commercial social use are an owner check (E2.6); record `url` and `user` with every clip.

## Pixabay (base `https://pixabay.com/api`, key as the `key` query parameter, added by the gateway)
`GET /videos/?q=…&video_type=film&min_width=…&min_height=…&safesearch=true&per_page=3..200&page=…`. Response:
`{ total, totalHits, hits: [{ id, pageURL, type, tags, duration, user_id, user, videos: { large|medium|small|tiny:
{ url, width, height, size, thumbnail } } }] }`. Record `pageURL` and `user` with every clip.
