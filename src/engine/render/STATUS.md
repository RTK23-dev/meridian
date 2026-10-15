# STATUS: engine render (W10): HyperFrames cloud adapter, integrity hook, zip

## W2 wiring pass (branch `eng-e45-leftovers-2`)

Not run in this pass.
- `RenderPorts.renderEstimateUsd` takes the video's duration (`(scope, durationMs)`), since the render line is priced per minute.
- Production deps (`jobs/production-ports.ts`, `productionRenderPorts`): HyperFrames through `gateway.transportFor("heygen")` and
  `gateway.secretFor("heygen")`; Shotstack through `gateway.transportFor("shotstack")`, `gateway.connection("shotstack")`, and the
  15-minute source links from `sourceUrlResolver` (`jobs/media-link.ts`). Stored media in Meridian's Drive-backed store.
- The Shotstack source resolver fails closed: not connected (no `MEDIA_LINK_SECRET`, or no https origin) throws `NOT_CONNECTED:` with the
  reason before any render hold; a URI that is not an engine object of the organization is refused (invalid_input).
- The HyperFrames price is still null in `config/prices.ts`, so the production render stage fails `render_price_known` until the owner sets it.
Tests: `jobs/production-ports.test.ts` (+2), `jobs/media-link.test.ts` (+1), `lib/meridian/storage/engine-media-link.test.ts`.

Phase E1, wave B. Branch `engine/e1-w9-w10`, cut from `code/beautiful-cori-1zfk11` (7fd32ae). Covers `src/engine/render/`.
Details: `README.md` in this folder.

## E5: Shotstack fallback and the fallback policy (Bible 6.11, 9.3, 19 E5)

Branch `eng-e5-shotstack`, from `code/beautiful-cori-1zfk11` at 30097c4 (the lead's commit 4aef7d5 added the Shotstack
provider, the route and the API section). Not pushed; not merged. Nothing outside `src/engine/render/` was changed.

### Done

- `shotstack.ts`: `isComponentFree` / `assertComponentFree` and `ShotstackRefusal` (typed, `review: true`, names the
  components); `toShotstackTimeline(edl, sourceUrl)` (pure; golden-tested); `ShotstackAdapter` implementing
  `RenderAdapter<ShotstackSubmitInput>` over an injected transport; `renderEdlWithShotstack()`, which runs the same
  budget hold, idempotency, poll, download, reconciliation, integrity check and store as HyperFrames.
- `fallback.ts`: `nextRenderStep()` (pure) and `renderWithFallback(edl, attempts)`. HyperFrames twice, then Shotstack for a
  component-free EDL, else review. A failed Shotstack render is review.
- `hyperframesCloud.ts`, shared with HyperFrames and behaviour-preserving: `RenderSubmitBase`; `RenderAdapter<Input>`;
  `RenderFlowDeps<Input>` (`RenderDeps` = flow deps plus `resolveAsset`); `runRender()` (the flow `renderComposition`
  now calls); `guardTransport()`, which turns a transport throw (host unreachable, aborted) into a retryable
  `EngineError` provider error. The HyperFrames adapter uses the guard too, so the policy can see a dropped connection
  as a failure. A typed `EngineError` from the transport (the gateway's not-connected config) passes through unchanged.
- Tests: `shotstack.test.ts` (31), `fallback.test.ts` (15), next to the code. Fixtures: `test/shotstackHarness.ts`
  (component-free EDL, component EDL, scripted gateway, ledger), `test/fixtures/shotstack-timeline.golden.json`.
- The golden file was generated from the mapper and then read line by line against the EDL: the picture tracks run front
  first, the base layer is last, the two overlapping sound effects go to two tracks, and each dB gain is converted.

### Tests run in this worktree

- `NODE_ENV=development node --experimental-strip-types --test src/engine/render/*.test.ts`: **66 pass, 0 fail**
  (20 existing HyperFrames and zip, 46 new).
- `npm run typecheck` (`tsc --noEmit`): exit 0.
- `npm run lint` (`eslint .`): see the final run in the hand-off; the render folder alone is clean (`eslint src/engine/render`, exit 0).
- The recorded responses are constructed from the documented shapes. They are not captured from the live API.

### The provider entry and the route (for the lead)

Already on this branch from commit 4aef7d5. This module matches it, and a test checks the match:
`providers.ts` `shotstack`: base `https://api.shotstack.io/edit/v1`, auth `api_key` header `x-api-key`, credential id
`shotstack`. `routes.ts` `render.fallback`: provider `shotstack`, model `edit-v1`, price key `render_shotstack` (LIST,
$0.20 per minute, `prices.ts`). The adapter takes `gateway.transportFor("shotstack", org)`,
`gateway.connection("shotstack", org)` and `gateway.baseUrlFor("shotstack")`. It holds no key.
The estimate is the caller's `estimateUsd`. Compute it from `render_shotstack` times the EDL's minutes; this module does not.

### Verify against Shotstack docs (every marker in the code)

The coordinator's rule: no marker on a field the PROVIDER_APIS.md Shotstack section names; a marker on everything else.
Code locations: `shotstack.ts`, grep `verify against Shotstack docs`.

1. `Idempotency-Key` request header on `POST /render`. Not documented. It is sent anyway, and the server may ignore it.
2. `title` asset `style`: the value `"minimal"`. The field is named in the docs; the value is not.
3. `title` asset `color` (`"#ffffff"`). Not named in the docs.
4. `video` asset `trim`: the units (seconds assumed). The field is named.
5. `video` asset `volume: 0` as the mute. The field is named; the meaning of 0 is not.
6. `audio` asset `src` and `volume`. The docs name only the type `audio`. The volume scale (a linear multiplier) and its maximum are not known.
7. `GET /render/{id}` `response.error`: its type. A string or a `{ message }` object is read; anything else gets a generic message.
8. The failure body of a non-2xx response: `message` is read when present. No error body is documented.

Documented and used without a marker: `POST /render` body `{ timeline, output }`; `timeline.background`, `timeline.tracks`;
clip `asset`, `start`, `length`, `fit: "cover"`, `position: "center"`, `alias`; asset `video`, `image`; `output` with
`format`, `size`, `fps`; the POST response `{ success, message, response: { id } }` and the flat `{ id, status }`; the
GET response `response.status`, `response.url`, `response.error`; the statuses `queued`, `fetching`, `rendering`,
`saving`, `done`, `failed`; the base URL and the `x-api-key` header (from the gateway registry).

### Owner's live run (E5 acceptance, Bible 19; the owner runs it, the agent holds no key)

Acceptance: "a forced HyperFrames failure on a component-free EDL falls back to Shotstack and still delivers, and one on a
component EDL goes to review."

1. Build a component-free EDL from a real run: a stock or generated media clip, a TTS voice, a music bed, and a sound
   effect. Upload each source to storage and give `resolveSourceUrl` a signed https URL for it (Shotstack must fetch it).
2. Force a HyperFrames failure, for example a composition that fails to render, or a deliberately failing key. Then call
   `renderWithFallback(edl, { hyperframes, shotstack })`, where `shotstack` is `renderEdlWithShotstack` with
   `gateway.transportFor("shotstack", org)`, `gateway.connection("shotstack", org)` and a real `reserve()` reservation.
   Record: the render id, the POST body (save it), the ledger entry (`provider` `shotstack`, `model` `edit-v1`, estimate
   and actual; with no bill the actual is the hold, flagged `actualIsEstimate`), the video URI, the `dropped` list, and
   the `failures` list.
3. Run `ffprobe` on the output: 1080 × 1920, 30 fps, duration within 100 ms of the EDL, audio present.
4. Run the same EDL with one `captions.karaoke` component: expect `review` with `custom_components` and no Shotstack request.
5. Check the idempotency behaviour. POST the same body twice and see whether Shotstack makes two renders and bills twice.
   If it does, the Shotstack path can double-bill a retried POST. Record the answer and tell the lead before any retry logic is trusted.
6. Save the raw responses for one submit, the polls and a failed render (force an unfetchable source). Compare them with the
   shapes above. Resolve every marker in the list, and remove each marker whose field is confirmed.
7. Check the `trim` units with a 0.5 s trim, and the `volume` scale with a −6 dB sound effect, by listening or by ffprobe.

### NOT-VERIFIED and interpretations (lead to confirm)

- Shotstack's idempotency. None is documented. A lost POST response followed by a resubmit may create a second, billed
  render. The ledger dedupes only our own calls.
- Loudness. Shotstack does not normalise to −14 LUFS. The render-integrity check does not measure loudness; the post-render
  review (Bible 6.12) does.
- Music ducking. The mapper uses the music gain only; it assumes the ducked stem came from upstream (Bible 9.1 rule 5).
- Effects, transitions and picture-in-picture boxes are dropped and listed (`dropped`). Their Shotstack names are unverified.
- The duration. Shotstack derives the output length from its clips. The integrity check (`verifyIntegrity`, injected)
  confirms it against the EDL within 100 ms.
- The title is not sent: the Shotstack body has no title field, and `title` is used only in the input's type.
- The policy counts a provider error as a failure, whatever its `retryable` flag, because Bible 6.11 says "two failures".
  A non-retryable provider error (an authentication failure) therefore still gets the second HyperFrames attempt. That
  costs no money, since a refused call is not billed.
- A non-provider error (budget, config, invalid input, a bug) is thrown and does not start the fallback.
- A failed Shotstack render goes to review (`renderers_failed`), not to a third HyperFrames attempt.

### Blockers and questions for the lead

- **Captions (the main gap).** The editor writes captions as `captions.karaoke` component clips, so every captioned EDL
  is refused and goes to review. Bible 9.3 expects Shotstack to carry captions. The mapper carries plain text only
  (a clip with no `component`, no `srcUri`, and `props.text`), but the compiler refuses that clip today ("needs a srcUri
  or a component"). So a text EDL cannot reach the fallback through the compiler. Decide the text clip form, which the
  EDL contract and the compiler must both accept, before the fallback serves captioned videos. Contracts are unchanged here.
- **Credential category.** Credential id `shotstack` must exist in the credential resolver. This module never reads a key.
- **Source URLs.** `resolveSourceUrl` is injected. Storage (eng-pipeline) must return a signed https URL that Shotstack can fetch.
- **The review item.** `renderWithFallback` returns `review` and the failures. The orchestrator creates the review item.

## Done (E1)

- `HyperframesCloudAdapter` implements the `RenderAdapter` interface (ready, submit, poll, fetchResult) over an injected
  transport. Upload (direct-uploads, presigned PUT, complete with 409 retries), submit, poll and download. The API key
  goes only to the API, never to the presigned URL or the video URL.
- `renderComposition()`: checks the key first, then holds budget on the reservation (ledger written before the call,
  keyed by `Composition.contentHash`), submits with `Idempotency-Key` = `Composition.contentHash`, polls, downloads,
  reconciles, runs the injected integrity hook, and stores the video. Returns a `RenderedVideo` that passes
  `renderedVideoSchema`. A refused budget, a missing key or a tampered composition makes no request and writes no entry.
  A resumed or repeated render re-sends the same key and keeps one ledger entry.
- `zip.ts`: deterministic archive writer (sorted names, fixed timestamps, zlib deflate). Tested by an independent reader.
- `recorded.ts`: constructed responses for the adapter tests. They follow the CLI 0.8.154 client source. They are not
  captured from the live API.

## Tests run in this worktree

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/render/**/*.test.ts'`: **20 pass, 0 fail.**
  Scripted transport: request order and methods, the key header and its derived upload key, the presigned PUT carrying
  no key, 409 backoff, 429 and 401 mapping, the poll and download flow, budget refusal, no-key refusal, resume with the
  same key, integrity failure (nothing stored), tampered files, and poll timeout (hold kept).
- `npm run typecheck`: exit 0. `npm run lint`: exit 0, 0 errors, 4 warnings, all in existing `src/components/` files.
- Full `npm test` on the final state: exit 0 (see `../compose/STATUS.md`).
- Base: the branch was cut from `code/beautiful-cori-1zfk11` at 7fd32ae. The lead branch has moved on since; not rebased
  or merged here (the lead integrates). This code uses no `ENGINE_ERROR_KINDS` added later.

## Owner's live run (E1 acceptance, Bible 6.11 and 19)

1. Call `renderComposition` with `gateway.transportFor("heygen", organizationId)` and
   `gateway.secretFor("heygen", organizationId)` from the API gateway, and a real reservation from `reserve()`. Use the E1 acceptance EDL (one stock clip, one TTS voice, three components). Record the render id, the
   video id, the cost in the ledger, the artifact ids, and the output file.
2. Run `ffprobe` on the output: 1080 × 1920, 30 fps, duration within 100 ms of the EDL, audio present.
3. Ten test renders: record each bill. Set `render_hyperframes_cloud` in `prices.ts` to a verified price. Until then
   the render line is `budgets.fixedPerMasterUsd.render` (0.05), and each ledger entry says it is an estimate.
4. Submit the same composition twice. Check that HeyGen returns the same render id and bills once. The adapter assumes
   this, and it is not verified.
5. Check `resolution: "1080p"` and `aspect_ratio: "9:16"` on an `asset_id` project. If the output is not 1080 × 1920,
   change `RENDER_SETTINGS` in `hyperframesCloud.ts`.

## NOT-VERIFIED (read from the CLI source, never called)

- Every endpoint and body in the README table. Source: `node_modules/hyperframes/dist/chunk-NAMGMP3R.js`,
  `chunk-IYLHJV34.js`, `render-LUAMJOON.js`.
- The status words: `completed` and `failed` are terminal (the CLI's `pollUntilTerminal`). Any other word is treated as
  still running. A live status outside that set would loop until the poll limit.
- Whether `Idempotency-Key` deduplicates renders on HeyGen's side.
- Whether a failed render is billed, and whether any response carries a bill. Neither is known.
- The render price (`render_hyperframes_cloud` is null in `prices.ts`).

## Interpretations (lead to confirm)

- A failed render is reconciled at its hold, flagged as an estimate, and the error is retryable. The orchestrator
  decides when to fall back (Bible 6.11: after two failures).
- A poll that never finishes is a retryable error and keeps the hold. A resumed job re-sends the same key.
- The render-integrity rule is injected (`verifyIntegrity`). The adapter passes the expected 1080 × 1920, 30 fps, and the
  EDL duration. The tolerance comes from `thresholds.render.durationToleranceMs`, as the probe's responsibility.
- The adapter does not write the video itself: `storeVideo` (eng-pipeline) returns the URI.
- Render settings and polling limits are constants in `hyperframesCloud.ts`. Bible 17.2 rule 3 wants them in
  `engine/config/` (W1 owns config). Move them there in a follow-up.

## Not done

- `remotionLambda.ts`: dropped by the owner on 2026-10-14 (it needs an S3 bucket). `shotstack.ts`: built in E5 (above).
- `VideoEngine` (`src/lib/meridian/video/engine.ts`): not implemented. Its `submit`, `poll` and `collect` take and return
  Hypit job types, which a composition render does not map to. Wiring is E2's job, and the interface must not change here.
- A HeyGen credential category in `credentials/contract.ts` (outside this folder). Until it exists, the adapter gets its
  key from the injected `credential()` function only.

## Blockers

- Owner: the live run above (keys, the first bill, and the idempotency check).
- eng-media-assets: the render-integrity probe and rule (`verifyIntegrity`).
- eng-pipeline: `resolveAsset` and `storeVideo` (storage), and the ledger store (`LedgerStore`) on Postgres.
- Credentials (E2): a HeyGen category in the resolver.
