# STATUS: media clients, integrity and speech-to-text (W4), `src/engine/media/`

## Ffmpeg on the worker and Deepgram speech-to-text (owner decisions 2026-10-16)

Branch `worktree-agent-a251b7ad049432bbf`, fast-forwarded to main's owner-decision commit (6bf831f) first. Fixture-tested code only:
no live call was made, and no key was held. The composition root wiring is NOT in this branch: it lives in files outside this
workstream (see "Needed outside this folder"). Until it lands, the in-process mode is not selectable and the stt route is NOT_CONNECTED.

### What changed here

- **`local.ts`**: `inProcessMediaFunctions()` replaces `localMediaFunctions`. It runs the same handlers, with the same limits from
  `functions/ffmpeg/limits.ts` (unchanged), and returns the `HttpMediaFunctions` shape (picture and detectors included), so the
  composition root can pass either form where production takes the media functions. URL sources are refused before any handler
  runs: the handlers would fetch a URL with the global `fetch`, and the engine never calls fetch outside `gateway/transport.ts`.
  Production passes bytes. Temporary directories: `withWorkdir` removes each run's directory in a `finally`; `local.test.ts` checks
  it on success and on failure with `TMPDIR` set to a fresh directory.
- **`mode.ts`**: `parseMediaFunctionsMode(raw)`. Unset or blank is `http` (NOT_CONNECTED without a base URL, so nothing runs by
  default). `in_process` selects the worker form. Any other value is a config error, so a typo never picks a mode silently.
- **`boundaries.test.ts`**: only `src/engine/jobs/runtime.ts` (the composition root) may import `local.ts` outside media. The test
  also fails if that file moves.
- **`stt.ts`** (contract v6 settlement, Bible 10.4): a refusal the vendor made before any work is settled as `confirmed_absent`
  with an actual of 0: `invalid_input` and `content_policy` (recorded adapter), and HTTP 400, 401 and 403 (Deepgram). The next
  attempt under the same input takes a new key, `attemptKey(base, n)` (`...:a2`), up to `mediaConfig.speechToText.maxRefusedAttempts`
  (5). Every other failure keeps its hold: rate limit, timeout, server error, unknown status, and an answer the validation refuses.
  Changed test: the recorded policy-refusal test used to assert a held call; it now asserts confirmed absent, because v6 settles
  refusals before any work.
- **`stt-deepgram.ts`**: the Deepgram adapter. `POST /v1/listen?model=<route model>&smart_format=true&language=<primary tag>` for the
  transcript, then `GET /v1/projects/{project_id}/requests/{request_id}` for the bill. Both go through `gateway.call` with provider
  `deepgram`, so the gateway attaches the key and holds the host. The file names neither. The transcript goes through
  `normaliseTranscript`; the transcribed audio may not exceed the requested duration by more than 500 ms (it may be shorter, since a
  video track can run longer than its audio). The bill is `request.response.details.usd`, rounded to four decimals (the ledger's
  precision). A bill that cannot be read (failed, unusable, or for another request) leaves the call unsettled, and the transcript is
  still returned with `billNote`. `deepgramForRoute` is the resolver for `speechToTextConnection`.
- **`stt-connection.ts`**: `pricePerMinuteOf(route)`, and the not-routed reason no longer says "no vendor".
- **`config/routes.ts`** (stt route, the brief's allowed entry): `deepgram` / `nova-3` / `deepgram_nova3_prerecorded` / `verified: false`.
- **`config/prices.ts`** (the brief's allowed entry): `deepgram_nova3_prerecorded` at 0.0043 per minute, `source:
  "third_party_unverified"` (a new `Price.source` value). `stt_vendor` stays null, because `config.test.ts` pins it.
- **Root `Dockerfile`**: `apt-get update`, `apt-get install -y --no-install-recommends ffmpeg`, `rm -rf /var/lib/apt/lists/*`. The
  update is needed on the slim base image, where the lists are empty. `Dockerfile.worker` is not touched.

### What the Deepgram docs say (read 2026-10-16, Deepgram's API reference) and what is still unverified live

- Listen: `Authorization: Token <key>`; body `{"url": ...}` as `application/json`; `language` is a BCP-47 hint, default `en`; `smart_format`.
- Raw bytes: the reference's example uses `Content-Type: application/octet-stream` with `--data-binary`. The brief expected the
  media's own type, and the adapter follows the reference: octet-stream.
- Words at `results.channels[0].alternatives[0].words[]` (`word`, `start`, `end` in seconds, `confidence`), and
  `metadata.request_id` and `metadata.duration` (seconds). The transcript names no language, so the adapter uses the requested one.
- Bill: `GET /v1/projects/{project_id}/requests/{request_id}` answers `request.response.details.usd` (the reference's sample shows
  0.0075 for 30 s).
- The listen reference documents no idempotency header. The key is kept on the ledger and is not sent, so the ledger is the only
  dedupe. The owner's live run confirms whether Deepgram offers one.
- **Unverified live (every item above is from the docs, not from a call):** the bill path and amount on a real request, the raw-bytes
  content type, the `language=en` query for nova-3, the 400 and 401 body texts (the fixtures are synthetic in Deepgram's `err_code`
  shape), and the list price of $0.0043 a minute, which is third-party and marked unverified.

### Choices for review

- `language=<primary tag>` is added to the brief's URL. Without it, Deepgram transcribes English whatever the request names, and the
  adapter would store that as the requested language.
- A rate limit (429) keeps its hold. The router settles it as confirmed absent and retries under a new attempt key, but the wrapper has
  no retry yet, so settling it here would stop the same input from being sent again. The lead or owner decides whether 429 joins
  400, 401 and 403.
- An answer the validation refuses (out-of-order words, too long, no usable shape) keeps its hold, because the vendor processed the
  audio and may have billed it. The operator settles it from the invoice.
- A bill that lags or fails stays unsettled, and nothing re-reads it yet. A reconciliation job for held calls is needed before
  delivery depends on Deepgram bills (contract v6: delivery refuses while a call is unsettled).
- The fixtures in `test/deepgram-fixtures.ts` are SYNTHETIC: written to the documented shape, not captured. Nothing here is a live
  artifact.
- `functions/ffmpeg/source.ts` fetches a URL input with the global `fetch`. That is the serverless deployment's own egress, and
  nothing changes there. The in-process form refuses URL inputs, so the worker never fetches anything itself.

### Needed outside this folder (not done here; the brief keeps them out of this workstream)

1. **`src/engine/gateway/providers.ts`** (eng-pipeline): add `deepgram` to `PROVIDER_IDS` and `DEFAULT_PROVIDERS`:
   `baseUrl: "https://api.deepgram.com"`, `auth: { kind: "api_key", header: "Authorization", scheme: "Token" }`, `credentialId:
   "deepgram"`, `defaultHeaders: {}`. Until then `gateway.route("stt")` throws `unknown provider deepgram`, which
   `speechToTextConnection` turns into NOT_CONNECTED. Nothing is sent.
2. **`src/engine/gateway/types.ts`** (eng-pipeline): `AuthSpec`'s api-key `scheme` accepts only `"Bearer" | null`. Deepgram needs
   `"Token"`. Widen it to `"Bearer" | "Token" | null`. Without this, item 1 cannot express the scheme.
3. **`src/engine/gateway/meridian.ts`** and Meridian's credential categories (`src/lib/meridian/credentials/`): a `deepgram`
   workspace category in `CATEGORY_OF`, `LABEL` and `MeridianWorkspaceCategory`, so the key resolves through the credential resolver.
4. **The project id** (a non-secret setting). The gateway's `CredentialSource` returns only the key, so the id needs another path:
   a non-secret field on Meridian's `deepgram` credential, or a deployment setting such as `DEEPGRAM_PROJECT_ID`, read in
   `src/lib/meridian/storage/` the way `MEDIA_FUNCTIONS_BASE_URL` is, and passed into `productionComposition`. The owner chooses.
5. **The composition root** (`src/engine/jobs/runtime.ts`, and the analyze and voice ports): pass
   `speechToTextConnection(gateway, { resolve: (route) => deepgramForRoute(route, { gateway, organizationId, projectId }) })`, and
   price the call with `pricePerMinuteOf(route)`.
6. **In-process mode** (`src/engine/jobs/runtime.ts`, `src/engine/jobs/production-ports.ts`, `src/lib/meridian/storage/engine-media-functions.ts`):
   read `MEDIA_FUNCTIONS_MODE` there with `parseMediaFunctionsMode`. In `in_process`, `productionComposition` uses
   `inProcessMediaFunctions()` instead of `gatewayMediaFunctions(gateway)`. `mediaFunctionsProblem` checks the HTTP base URL and
   `productionShotConnection` calls it, so it must return null in `in_process` mode. Otherwise every shot stays NOT_CONNECTED.
7. **Tests that the stt route change breaks** (owned by other workstreams; not edited here): `src/engine/config/routes.test.ts`,
   "uses OpenRouter for every model API", must exempt `stt`, as it exempts render and stock (Deepgram is a direct API by owner
   decision). `src/engine/gateway/gateway.test.ts` line 22 expects `/speech-to-text vendor/` from `gateway.route("stt")`; the message is
   now `unknown provider deepgram` until item 1 lands. Each is a one-line change.

### Owner live steps (agents hold no keys)

1. Put a Deepgram key in Meridian's credentials for a workspace, once items 1 to 3 exist. Supply the project id (item 4).
2. Transcribe one real 30 s reference audio by URL, then the same audio as bytes (octet-stream). Check the words against the audio, the
   `request_id`, and the bill from the request lookup (`details.usd`). Record the artifacts and the ledger line.
3. Send the same input again: the ledger must refuse it without a call. Record one bad-key call (401) to check the refusal settles as
   confirmed absent.
4. Confirm the nova-3 list price on Deepgram's own page and the `language=en` query. Then set `verified` on the route and the price
   source, or correct them.
5. Set `MEDIA_FUNCTIONS_MODE=in_process` on the worker (and web, which runs the same runtime) once item 6 is applied. The image has
   ffmpeg. Run one probe and one frames call on a real reference through the worker, and record the ids and the temporary-directory
   check.

### Verification on this branch

See the result block at the end of this section.

## W2 wiring pass (branch `eng-e45-leftovers-2`)

Not run in this pass.
- The detectors (`MediaDetectors`: black frames, flicker, motion, silence) are wired into `check_take` (black, flicker, motion) and into
  `post_render_review` (black frames and silence) through `jobs/gate-measures.ts`. A detector's `invalid_input` is missing evidence (null);
  any other error throws, so the job retries.
- Production media functions: `jobs/production-ports.ts` `gatewayMediaFunctions(gateway)` gives the media functions (and the detectors and
  the picture client) over `gateway.transportFor("media_functions")`. They are NOT_CONNECTED while `media_functions` has no base URL in the
  gateway's provider table. No deployment source for that URL exists yet (lead decision). No env read is added in `src/engine`.

Phase E1, wave B. Branch `engine/e1-w4`, cut from `code/beautiful-cori-1zfk11` (7fd32ae). Covers `src/engine/media/` and
the tests and fixtures under `src/engine/test/`. See `README.md` for the file list and the Bible sections.

## Done

- `MediaFunctions` interface (`interface.ts`): probe, frames, loudness and cuts. Every call validates its input and its
  answer, and fails with a typed `EngineError`.
- `httpMediaFunctions(baseUrl, transport)` (`http.ts`, `wire-client.ts`): the production implementation over an injected
  transport. The network transport now lives in the API gateway (`src/engine/gateway`). Failures map as follows: 429, 5xx, timeouts and unreachable
  hosts are retryable provider errors; a refused URL or a bad request is invalid_input; a 200 that fails the result
  schema, a frame that is not the declared PNG, or a frame count that does not match the request, is a non-retryable
  provider error. Inline bytes over 4 MB are refused before any request is sent.
- `localMediaFunctions` (`local.ts`): in-process, for tests and CI only. A boundary test fails if production imports it.
- Per-function clients (`probe.ts`, `loudness.ts`, `cuts.ts`, `frames.ts`). The frame plan of Bible 6.2 is in `frames.ts`:
  a frame at every cut, then 2 per second, capped at 60, cuts first, with `cutsCovered` reported honestly.
- `checkRenderIntegrity` (`integrity.ts`): the 6.11 and 12.3 checks against an EDL, returning a `GateResult` for
  `render_integrity`. The 100 ms duration tolerance comes from `thresholds.render`. A null platform size limit fails.
- `SpeechToText` interface and `normaliseTranscript` (`stt.ts`): a transcript is refused as a whole when any word is
  out of order, runs past the audio, has a bad token, a confidence outside 0 to 1, or a language that does not match.
  Word ids are `w0001`, and times are integer milliseconds, checked against the `Word` contract.
- `transcribeMetered` (`stt.ts`): estimate from the per-minute price, refuse when the price is null, authorise with an
  idempotency key (sha256 of provider, model, language, duration and input), call, then reconcile to the bill or to the
  list price (flagged as an estimate). A reconciled key is never billed again. A failed call keeps its hold, and a retry
  reuses the same key.
- `recordedSpeechToText` (`stt.ts`): replays recorded responses in order, through the same validation. Covers success,
  rate limit, timeout and policy refusal, and fails closed when the recording has run out.
- Recorded fixtures under `src/engine/test/fixtures/recorded/`. The parser and HTTP recordings are real captures. The
  speech-to-text recordings are synthetic. See `src/engine/test/README.md`.

## Tests

Command (from the repo root):

    NODE_ENV=development node --experimental-strip-types --test 'src/engine/media/**/*.test.ts'

Files: `probe.test.ts`, `loudness.test.ts`, `cuts.test.ts`, `frames.test.ts` (pure parsers on recorded output),
`handlers.test.ts` and `local.test.ts` (real ffmpeg on generated media), `source.test.ts`, `http-client.test.ts`
(recorded HTTP answers), `http-handler.test.ts` (routes, plus a round trip through the handler), `integrity.test.ts`,
`stt.test.ts`, `boundaries.test.ts` (static import and environment rules).

Results on this machine (ffmpeg 6.1.1, Node 22.22.0): see the result block at the end of this file.

## Live steps: owner (the live parts of E1 need the owner; no agent holds keys)

1. **Choose the speech-to-text vendor (Bible 20.2). Not chosen; the lead asks the owner.** Once chosen, write one adapter
   `src/engine/media/stt-<vendor>.ts` with `transcribe(request, idempotencyKey)` that returns normalised words, and call
   `normaliseTranscript` on the vendor's answer. Map the vendor's errors to `SttCallError` with the Bible 10.1 kinds.
2. **Record one real transcription.** Make one call on a real reference audio (about 30 s, with music under speech).
   Save the response in the recorded shape as a `source: "live"` fixture. Check the word timings against the audio by
   ear, the billed amount, and that a repeat with the same key is not billed. Attach the artifacts and the ledger line
   to the phase PR.
3. **Price.** Put the vendor's price per minute into `prices.ts` (`stt_vendor`, currently null). Until then,
   `transcribeMetered` refuses every call with `unknown_price`, as the Bible requires.
4. **Deploy and record the media functions** (see `functions/ffmpeg/STATUS.md`). Then run the probe, cuts, loudness and
   frames through `httpMediaFunctions` against the deployed URL, and record the answers as `captured` entries.
5. **Set the platform size limit** (`thresholds.render.platformMaxBytes`, currently null). The integrity gate cannot
   pass on size until it is set.

### What the speech-to-text vendor must provide (Bible 20.2, 6.2 step 3, 6.3 step 3)

- Word-level timestamps: a start and an end for each word, monotonic, in seconds or milliseconds. The wrapper rounds to
  integer milliseconds and rejects a transcript that is out of order or runs past the audio by more than 500 ms.
- A confidence for each word, between 0 and 1. The `Word` contract requires it. A vendor without per-word confidence
  needs an owner decision, because the code will not invent a value.
- The language of the transcript, so the wrapper can compare it with the request.
- A price per minute of audio, in USD, from the vendor's list. Per-call billing is also acceptable if the response
  reports the bill.
- An idempotency key or equivalent, so a repeat of the same call is not billed twice.
- Input by URL or bytes, with a stated maximum duration that covers 60 s reels and 90 s references.
- Errors that can be told apart: rate limit, timeout, server error, content policy refusal and invalid input. The retry
  rules depend on it (Bible 10.4).
- Robustness on fast speech over music (Bible 20.3, item 4), tested on a real reference before the vendor is chosen.
- Terms that allow no training on submitted audio, and deletion on request. Reference media is deleted within 24 h
  (Bible 5.2, 20.1).

## Blockers

- **Speech-to-text vendor: owner decision (Bible 20.2).** It blocks the live STT wrapper and the reference analysis
  stage. The fixture adapter is complete, so the rest of E1 can proceed.
- **Platform file-size limit: owner decision.** Blocks the render-integrity pass on size (Bible 12).
- **Deployment target: owner decision.** Blocks the live probe, cuts, loudness and frames runs.
- **Config placement (for the lead).** Bible 17.2 says all configuration goes through `engine/config`, which eng-contracts
  owns, so I did not write there. Four values live in `config.ts` for now, each built with `tunable()`, and should move
  to `thresholds.ts` (with eng-contracts' review):
  - `sceneCutScore`: `tunable(0.3, 0.1, 0.9)`, the scene-cut threshold T of Bible 6.2.
  - `frameMs`: 1000 / 30, the EDL frame duration (Bible 8.2).
  - `callTimeoutMs`: transport timeouts for each function (probe 40 s, frames 80 s, loudness and cuts 140 s).
  - `transcript`: validation limits (3000 words, 64 characters, 500 ms end tolerance).
- **The config and the frame plan.** `thresholds.reference.framesPerSecond` (2) and `maxFrames` (60) are read from
  `thresholds.ts` as the Bible says.

## Interpretations (lead to confirm)

- `recordedSpeechToText` is in `stt.ts`, as the brief says, not in its own file. A test checks that no production file
  outside `stt.ts` uses it.
- Idempotency keys cover the input, so the same audio sent twice gets one bill. A different price for the same input is
  refused rather than silently re-billed.
- On a failed call the hold stays on the ledger and is not released, because the vendor may have billed the call. A hold
  counts against the reservation until its entry is reconciled, so a retry under a different key would be counted twice
  until then. The retry here reuses the same key, which avoids that. The budget module has no way to delete an entry. If
  the lead wants failed holds released, that needs a budget function (eng-contracts).
- Media functions are not priced per call. Their cost sits in the fixed `speechAndFfmpeg` line of `budgets.ts`.
- The `analyze_reference` stage needs an audio extraction step before speech-to-text (ffmpeg, `-vn`). It is not in E1's
  list, so it is not built. `transcribeMetered` takes an audio source; the caller provides it.
- Not in E1: OCR, motion and flicker metrics, the embedding wrapper, and the lip-sync, background-removal and upscaling
  wrappers (E2 to E4, and Bible 20.2).

## Result block

Final run, on the committed tree (ffmpeg 6.1.1 and ffprobe 6.1.1 on PATH, Node 22.22.0):

- `npm test` (full repo): exit 0. Scripts: 146 pass. `src/**`: 2647 tests, 2606 pass, 0 fail, 41 skipped. The 41
  skips are existing PostgreSQL and credential-gated tests (`MERIDIAN_PG_TEST_URL` and live keys are not set). No W4
  ffmpeg test was skipped. `ffmpeg-required.test.ts` is skipped because `MERIDIAN_REQUIRE_FFMPEG` is not set in this run.
- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/media/**/*.test.ts' 'functions/**/*.test.ts'`:
  171 pass, 0 fail. The `functions/**` glob matches no file, and Node accepts that.
- `node --test 'src/engine/**/*.test.ts'`: 365 pass, 0 fail (194 from E1 wave A and 171 from W4).
- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0 with 4 warnings. All four are in existing UI files I did not touch. None in `src/engine` or
  `functions/`.
- Prettier `--check` on `src/engine/media`, `src/engine/test` and `functions/ffmpeg`: clean.

Not run: a live anything. No vendor is chosen, and the functions are not deployed.

## E3 additions

- `timeline.ts` (client, in-process and over HTTP) and `MediaFunctions.timeline()`: brightness, motion, momentary loudness and
  the envelope in one call. The implementation is `functions/ffmpeg/timeline.ts`. `http.ts` and `local.ts` implement it; no
  other file implements `MediaFunctions`. Tests: `timeline.test.ts` (recorded lines, the client's order checks, and a real
  timeline on a generated reel when ffmpeg is present) and `http-handler.test.ts` (the route, and an end-to-end round trip).
- `stt-connection.ts`: `speechToTextConnection(gateway, options)`. It reads the `stt` route through the gateway and sends
  nothing. With no model, or with no wired adapter, it returns `not_connected` with a reason that starts `NOT_CONNECTED:`. The
  analyze and voice stages call it before any paid step. Tests: `stt-connection.test.ts`.
- The beat grid (`analyze/beats.ts`) is computed in the analyze folder from the envelope. It is not part of this folder, so the
  media index does not export it.

## Still not in this folder

OCR, zoom detection, the frame comparison for endsOnLoop, flicker metrics, the embedding wrapper, and the lip-sync,
background-removal and upscaling wrappers. Each needs an owner decision or a later phase (see `analyze/STATUS.md`).

## Owner live steps added in E3

Deploy the functions with `/timeline`, and record one timeline answer as `captured`. The speech-to-text steps of E1 still
apply (choose the vendor, record one transcription, price it). Nothing here chooses a vendor.

## Follow-up: the picture client (`picture.ts`, route `POST /picture`)

- `pictureInProcess()` and `pictureOverWire(post)` (path `PICTURE_PATH`, timeout `callTimeoutMs.picture`). The answer is checked
  against `pictureResultSchema` (out-of-time pairs, a usable pair without a scale, a loop distance above 1 are provider errors).
- `PictureClient` is on `HttpMediaFunctions` as `picture`, not on `MediaFunctions`. Adding it to the interface would have broken
  three fixtures outside this folder (voice and jobs), so the analyze readings take it directly.
- `test/picture-clips.ts` generates the clips the picture tests use (a centred and an off-centre 1.2x zoom-in at 1000 ms, a
  looping still, a drifting zoom), with ffmpeg in the fixture directory. `picture.test.ts` skips them without ffmpeg.
- `boundaries.test.ts`: the handler list now names `timeline` and `picture`, so no production file outside this folder runs them.

## Follow-up: the detectors (branch `eng-detectors`)

Bible 6.7 step 1, 12.2 and 12.3. Four stateless functions over one source: black and frozen runs, flicker, motion and silence. The
handlers are `functions/ffmpeg/detectors.ts`, routes `POST /black`, `/flicker`, `/motion` and `/silence`. The schemas, `DETECT_STEPS`
and the limits are in `functions/ffmpeg/types.ts` and `limits.ts`.

- **Client.** `detectors.ts`: `detectorsInProcess()` and `detectorsOverWire(post)`. Each answer is checked against its own schema, and
  a mismatch is a provider error. Each call validates the source first; inline bytes above 4 MB are refused before any request.
- **The interface.** `MediaDetectors` (in `interface.ts`) is a sibling of `MediaFunctions`, not a member of it. Adding four required
  members to `MediaFunctions` breaks the object literal in `jobs/handlers/voice.test.ts`, which is not this branch's. `httpMediaFunctions`
  and `localMediaFunctions` implement both. Consumers take `Pick<MediaDetectors, ...>`, as they take `Pick<MediaFunctions, ...>` today.
- **Measures (`measures.ts`).** `takeCodeMeasures` gives the take's three code values (`blackOrFrozenRunFrames`, `flickerScore`,
  `meanMotion`) for `review/take/code.ts`. `blackFrameMeasures` and `blackAt` give the post-render black-frame reading. `longestRunFrames`
  counts a run in frames at the probed rate, and a black run that reaches the end includes its last frame. Each null means the detector
  saw no video, or the frame rate is unknown.
- **What each measure is.** Black: `blackdetect` (pixel share 0.10, frame share 0.98) on a 160 px copy. Frozen: `freezedetect` (noise
  0.001). A flat picture is frozen, so a still take fails the frozen check (Bible 12.2 says so). Flicker: the mean reversal of the
  frame-to-frame brightness step, halved, after dropping the largest 10 per cent, over 0.05 luma, capped at 1. It is brightness only,
  not motion-compensated, so a flash can score. Motion: the mean absolute luma change between consecutive frames, 0 to 1. It is a
  frame difference, not optical flow. Silence: `silencedetect` at -50 dBFS, runs of at least 100 ms. With no audio, it says so and the
  longest silence is null (never 0).
- **Measured here (ffmpeg 6.1.1, generated clips).** Black block at 1000 to 1500 ms, found to the frame. Alternating brightness scores
  1.0; a steady picture 0. A panning picture has motion 0.093; a still picture 0; a 2-D test pattern with a small moving part 0.008,
  so a mostly still shot fails the motion check at the initial 0.05. Silence at 1000 to 2000 ms, with a 1 kHz tone either side.
- **Limits and interpretations (for the lead).** The motion scale is not the Bible's optical flow, so `take.motionMin` (0.05) must be
  calibrated on gold labels before the check may block. Flicker is brightness-only (Bible 12.2 says motion-compensated); the
  calibration covers it too. A run open at the end of a report is closed at the probed duration, and with no duration it is a
  provider error.
- **Tests.** `detectors.test.ts` (the parsers on recorded ffmpeg 6.1.1 lines, the scores on exact series, the client contract, and the
  real functions on generated clips: black-gap, steady, flicker, pan, tone-gap and no-audio), `detectors-http.test.ts` (the routes, the
  refusals, and the round trip through `httpMediaFunctions`), `measures.test.ts` (the null and end-of-media cases). The clips are made by
  `test/detector-clips.ts` in the fixture directory. They are never committed. The real-ffmpeg tests skip with a visible reason when
  ffmpeg is missing.
- **Owner live steps.** Deploy the four routes with the others (see `functions/ffmpeg/STATUS.md`). Then record one answer per route on
  one real take and one real reference, and check the calibration against the owner's labelled takes before the take gate may block on
  flicker or motion.
