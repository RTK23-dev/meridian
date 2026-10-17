# Gateway fixtures

Recorded OpenRouter answers, in the shapes of the OpenRouter API reference (chat completions with `usage.cost`; video
submit and poll, `openrouter.ai/docs/api/api-reference/video-generation`). The values are examples from that reference,
not results of a live call. They are replaced with recorded live answers in the owner's live run.

## Catalog listings (Bible 10.5, `catalog.ts`)

`openrouter-catalog-videos.json`, `openrouter-catalog-image.json` and `openrouter-catalog-speech.json` stand for
`GET /videos/models`, `GET /models?output_modalities=image` and `GET /models?output_modalities=speech`. They are written from
the documented shape (PROVIDER_APIS.md for the video fields; the lead's brief of 2026-10-16 for the `pricing_skus` keys
`per-video-second` and `per-video-second-1080p` and for the `pricing` strings `prompt`, `completion`, `image_output` and
`request`). **Unverified live**: no live answer was recorded. Each file mixes usable rows with rows the catalog must drop (no
price, a zero or variable price, token-only pricing, a malformed row), so the parse tests cover every drop reason.

## Generation stats (contract v9, `gateway/generation.ts`)

`openrouter-generation.json` (`total_cost` 0.0031) and `openrouter-generation-no-cost.json` (no `total_cost`) stand for `GET /api/v1/generation?id=` after a speech call. They are synthetic, written to the documented shape. **Unverified live**: the owner's live run records one real stats answer.
