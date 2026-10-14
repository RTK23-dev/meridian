# engine/render (W10)

Implements Bible **6.11** (`render`: HyperFrames cloud, idempotency key, render integrity), **14.1** (every paid call
authorized and reconciled), **5.1** (the render lease and resume) and **17.3** (recorded adapters). Phase E1, wave B.

## What is here

| Path | What it does |
| --- | --- |
| `hyperframesCloud.ts` | `RenderAdapter` interface; `HyperframesCloudAdapter` (upload, submit, poll, fetch) over an injected transport; `renderComposition()`: budget hold, idempotency, integrity hook, reconciliation, storage. |
| `zip.ts` | Deterministic ZIP writer for the cloud upload (fixed timestamps, sorted names, zlib deflate). |
| `recorded.ts` | Constructed responses for the adapter tests. Not captured from the live API (see below). |
| `hyperframesCloud.test.ts`, `zip.test.ts` | Scripted-transport tests: request order, headers, retries, budget, idempotency, integrity. |
| `remotionLambda.ts`, `shotstack.ts` | Not built. They come with E5 (Bible 9.3). |

## The flow of `renderComposition()`

1. Check the adapter is ready: a usable key must exist. No key means no hold and no request.
2. Check the composition files match their hashes. Anything tampered is refused before a byte is sent.
3. `authorizeCall` on the reservation: the ledger entry is written before the call, keyed by `Composition.contentHash`.
   A refused budget (paused or over the line) makes no request. A repeated key with the same payload is re-sent (the
   provider should return the same render) and writes no second entry. A repeated key with a different payload is a
   conflict.
4. Build the zip (composition files plus assets resolved by `resolveAsset`). Refuse above 200 MB.
5. Submit with `Idempotency-Key` = `Composition.contentHash`. Poll until `completed` or `failed` (interval and poll
   count injected; defaults are the CLI's 10 s and 360 polls, one hour). A timeout is a retryable error and keeps the
   hold, so a resumed job re-sends the same key.
6. `failed`: the hold is reconciled as an estimate and a retryable provider error is thrown.
7. `completed`: download the video from its signed URL (no API key is sent there), reconcile the ledger, then run the
   injected `verifyIntegrity` hook. A failing gate throws (not retryable) and nothing is stored.
8. `storeVideo` returns the URI. The result is a `RenderedVideo` that passes `renderedVideoSchema`.

The integrity probe and rule come from eng-media-assets (ffprobe: 1080 × 1920, 30 fps, duration within
`thresholds.render.durationToleranceMs`, audio present). This module passes them the expected values (`RENDER_EXPECTATION`).

## The HTTP contract, and where it was read

Source: `node_modules/hyperframes/dist/` in `hyperframes@0.8.154` (the CLI's cloud client, as shipped).

| Step | Request | Source |
| --- | --- | --- |
| Base URL | `https://api.heygen.com` (`HEYGEN_API_URL` overrides it) | `chunk-NAMGMP3R.js` `apiBaseUrl`, `DEFAULT_BASE_URL` |
| Auth | `x-api-key: <key>` and `X-HeyGen-Client-Source: hyperframes` | `chunk-NAMGMP3R.js` `buildAuthHeaders` |
| Upload start | `POST /v3/assets/direct-uploads` with `{filename, content_type, size_bytes, checksum_sha256}` | `chunk-IYLHJV34.js` `createAssetUpload`; `render-LUAMJOON.js` `uploadZipViaDirectUpload` |
| Upload bytes | `PUT` to the presigned `upload_url` with `upload_headers` (no API key) | `render-LUAMJOON.js` `putBytesToPresignedUrl` |
| Upload complete | `POST /v3/assets/{asset_id}/complete` with `{checksum_sha256}`; retried on 409, 5 times, 500 ms × attempt | `chunk-IYLHJV34.js` `completeAssetUpload`; `render-LUAMJOON.js` `completeWithRetry` |
| Submit | `POST /v3/hyperframes/renders` with `Idempotency-Key`; body `project: {type:'asset_id', asset_id}`, `fps`, `quality`, `format`, `resolution`, `aspect_ratio`, `title` | `chunk-IYLHJV34.js` `createRender`; `render-LUAMJOON.js` `buildRenderBody` |
| Poll | `GET /v3/hyperframes/renders/{render_id}`; terminal statuses `completed` and `failed`; fields `video_url`, `failure_message`, `format` | `chunk-IYLHJV34.js` `getRender`, `pollUntilTerminal`; `render-LUAMJOON.js` `handleFailedRender` |
| Envelope | Success bodies are `{ data: … }`; errors are `{ error: { message, code } }` | `chunk-IYLHJV34.js` `request`, `toApiError` |
| Idempotency key rule | 1 to 255 characters from `[A-Za-z0-9_:.-]`. `sha256:<hex>` fits. | `render-LUAMJOON.js` `IDEMPOTENCY_KEY_RE` |
| Size limit | 200 MB direct upload | `render-LUAMJOON.js` `DIRECT_UPLOAD_LIMIT_BYTES` |

Settings sent: `fps` 30, `quality` standard, `format` mp4, `resolution` 1080p, `aspect_ratio` 9:16. `resolution` and
`aspect_ratio` are valid values in the CLI's own validation; their effect on an `asset_id` project is not verified.

## NOT-VERIFIED (must be checked in the owner's live run)

- Every endpoint above is read from the CLI source. None was called. `recorded.ts` is constructed from those shapes,
  so the tests check this adapter against its own reading of the contract, not against HeyGen.
- Whether HeyGen honours `Idempotency-Key` on renders (the retry and resume behaviour depends on it).
- Whether a failed render is billed, and whether any response carries a bill. None is known, so the ledger records the
  hold as an estimate (`actualIsEstimate: true`).
- The render price. `prices.ts` has `render_hyperframes_cloud` = null (verify). The render line uses
  `budgets.fixedPerMasterUsd.render` (0.05) as its estimate, passed in by the caller.
- Whether `resolution: "1080p"` with `aspect_ratio: "9:16"` on an `asset_id` project gives 1080 × 1920.

## Not done here, and why

- **`VideoEngine` (`src/lib/meridian/video/engine.ts`).** Not implemented. Its `submit` takes a `HypitJobContract`, and
  `poll` and `collect` return Hypit job and artifact types. A composition render does not map onto that shape without
  changing Meridian's interface, which this wave may not do. Wiring a `RenderAdapter` beside it is E2's job.
- **Credential category.** `credentials/contract.ts` has no HeyGen render category. The adapter takes an injected
  `credential()` and never reads `process.env`. E2 needs a category there (owned outside this folder).
- **Storage and asset resolution.** `resolveAsset`, `storeVideo` and `verifyIntegrity` are injected. They belong to
  eng-pipeline (storage) and eng-media-assets (probe and rule).
- **Constants.** Render settings and polling limits live in `hyperframesCloud.ts`, not in `engine/config/`. Bible 17.2
  rule 3 says config belongs there; W1 owns config, so the move is a follow-up.
