# engine/render (W10)

Implements Bible **6.11** (`render`: HyperFrames cloud, idempotency key, render integrity), **14.1** (every paid call
authorized and reconciled), **5.1** (the render lease and resume) and **17.3** (recorded adapters). Phase E1, wave B.

## What is here

| Path | What it does |
| --- | --- |
| `hyperframesCloud.ts` | `RenderAdapter<Input>` interface; `HyperframesCloudAdapter` (upload, submit, poll, fetch) over an injected transport; `runRender()`, the flow every renderer shares (budget hold, idempotency, poll, integrity hook, reconciliation, storage); `renderComposition()`; `guardTransport()`, which turns a dropped connection into a retryable provider error. |
| `shotstack.ts` | E5 fallback (Bible 6.11, 9.3). `isComponentFree` / `assertComponentFree` (the refusal), `toShotstackTimeline()` (pure mapper from an EDL to the POST /render body), `ShotstackAdapter` (the same `RenderAdapter` interface over an injected transport), `renderEdlWithShotstack()`. |
| `fallback.ts` | E5 policy (Bible 6.11 as amended): HyperFrames twice, then Shotstack for a component-free EDL, else review. `nextRenderStep()` is pure; `renderWithFallback()` runs the injected attempts. |
| `zip.ts` | Deterministic ZIP writer for the cloud upload (fixed timestamps, sorted names, zlib deflate). |
| `recorded.ts` | Constructed responses for the HyperFrames adapter tests. Not captured from the live API (see below). |
| `test/shotstackHarness.ts`, `test/fixtures/shotstack-timeline.golden.json` | The component-free EDL, the component EDL, the scripted gateway for the Shotstack tests, and the golden mapping. Constructed from the documented shapes (see the Shotstack section). |
| `hyperframesCloud.test.ts`, `zip.test.ts`, `shotstack.test.ts`, `fallback.test.ts` | Scripted-transport tests: request order, headers, retries, budget, idempotency, integrity, the golden mapping, refusals and the fallback route. |
| `remotionLambda.ts` | Not built. Dropped by the owner on 2026-10-14 (it needs an S3 bucket). |

## The flow of `renderComposition()` and `renderEdlWithShotstack()`

Both call `runRender()`. Only steps 2 and 4 differ: HyperFrames checks the composition hashes and builds the zip, and
Shotstack checks the component-free rule and builds the timeline.

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

## The Shotstack fallback (E5, Bible 6.11 and 9.3)

Owner decision 2026-10-14: Shotstack is the only fallback. Remotion Lambda is dropped. The provider entry and the route
(`render.fallback`: provider `shotstack`, model `edit-v1`) are in `gateway/providers.ts` and `config/routes.ts`, added by
the lead. This module reads them, and a test ties its constants to them.

- **Scope.** Component-free EDLs only: media (video and image clips), audio (voice, music, sound effects) and plain text.
  `isComponentFree(edl)` is true only when no clip has a `component`. Any other EDL throws `ShotstackRefusal` (an
  `EngineError`, kind `invalid_input`, with `review: true` and the component names). It is thrown before any request.
- **Mapping.** `toShotstackTimeline(edl, sourceUrl)` is pure. It puts the picture tracks front first (Shotstack draws
  earlier tracks on top; the EDL stacks back to front), then the voice, the music, and the sound effects packed onto the
  fewest non-overlapping tracks. Times go out in seconds. Gains go out as linear volumes (`10^(dB/20)`, the same formula as
  the HyperFrames compiler). Each picture clip carries its EDL clip id as `alias`. Text is a `title` asset from
  `clip.props.text`. Effects, transitions and picture-in-picture boxes are not drawn; each one is listed in `dropped`, and
  the caller records it in the manifest.
- **Sources.** Shotstack fetches its media, so every EDL URI needs an https URL from `resolveSourceUrl` (signed storage
  URL). The idempotency key is computed from the EDL's own URIs, so a re-signed URL does not change it.
- **Adapter.** `ShotstackAdapter` implements `RenderAdapter<ShotstackSubmitInput>`. It takes `gateway.transportFor("shotstack",
  org)` and `gateway.connection("shotstack", org)`. It holds no key. The gateway attaches `x-api-key` on the provider host
  and sends the download URL with no key. `poll` maps `done` to `completed`, `failed` to `failed`, and leaves `queued`,
  `fetching`, `rendering` and `saving` as running.
- **The fallback policy (`fallback.ts`).** HyperFrames is attempted twice (`HYPERFRAMES_ATTEMPT_LIMIT`). A render failure
  is a provider error: a rejected or failed submit, a failed render, an integrity miss, or a dropped connection. After
  two failures, a component-free EDL goes to Shotstack once. Any other EDL goes to review (`custom_components`). A failed
  Shotstack render goes to review (`renderers_failed`). A budget refusal, a missing key, an invalid input or a bug is not
  a render failure: it is thrown at once, so no other renderer spends on it.

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
