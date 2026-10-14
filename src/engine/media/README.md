# Media clients and checks (W4)

Implements Video Engine Bible **section 6.2** (reference analysis: the frame plan, cut times and loudness from the
functions), **section 6.3** (speech-to-text for voice timings, step 3), **section 6.11** and **12.3** (render integrity),
**section 10.4** (failure classes: rate limit, timeout and server errors retry; policy refusals and invalid input do not),
**section 15.2** (the functions are deployed separately and reached over HTTP) and **section 20.2** (the speech-to-text
vendor is open, so no vendor is wired here).

## What is here

- `interface.ts`: `MediaFunctions`, the one interface production code takes. Its four methods (probe, frames, loudness,
  cuts) return validated results or reject with a typed `EngineError`. Nothing resolves with a default for a failure.
- `http.ts`: `httpMediaFunctions(baseUrl, transport)`, the production implementation. The transport is injected. Tests
  pass recorded responses, and production passes `fetchTransport()` from `wire-client.ts`.
- `wire-client.ts`: `wirePost`. Every response is untrusted: a 200 must match the result schema, and every failure
  becomes a typed error (a 429 or 5xx, a timeout, or an unreachable host is retryable; a bad request or a refused URL is
  not).
- `probe.ts`, `loudness.ts`, `cuts.ts`, `frames.ts`: one client per function, each with an in-process form (for tests)
  and a wire form (production). `frames.ts` also holds the frame plan of Bible 6.2: a frame at every cut, then 2 per
  second, capped at 60, cuts first. If the cuts alone exceed the cap, the plan says `cutsCovered: false`. Each returned
  PNG is checked against its request (order, structure and declared size).
- `local.ts`: `localMediaFunctions`, **for tests and CI only**. It runs the handlers in this process through the ffmpeg
  on the machine. `boundaries.test.ts` fails if any production file imports it.
- `integrity.ts`: `checkRenderIntegrity(input)`, the render-integrity gate (6.11, 12.3). Pure. It returns a `GateResult`
  for gate `render_integrity`. Unknown values fail (Bible 12), including a null platform size limit.
- `stt.ts`: the `SpeechToText` interface (returns `Word[]` with word ids and integer millisecond timings), the transcript
  validation every vendor's answer passes (`normaliseTranscript`), the metered wrapper `transcribeMetered`
  (estimate, authorise with an idempotency key, call, reconcile to the bill), and `recordedSpeechToText`, a replay
  adapter for tests. Production must not use the replay adapter, and `boundaries.test.ts` checks that.
- `config.ts`: the scene-cut score (initial 0.3, tunable), the EDL frame duration, call timeouts, and transcript limits.
  These should move to `src/engine/config/` (see `STATUS.md`).
- `index.ts`: the production surface. It exports no in-process or replay implementation.

## Rules this folder keeps

- Keys come only from the credential resolver. Nothing here reads `process.env` (checked by `boundaries.test.ts`).
- Provider and function outputs are untrusted: each is checked for type, size, duration and structure before it is
  returned. A transcript that runs past the audio, or whose words are out of order, is rejected as a whole.
- A paid call (speech-to-text) reserves budget, sends an idempotency key and writes a ledger entry. A repeat of a
  reconciled key is refused without a call. The media functions are not priced per call; their cost sits in the fixed
  per-master line (`budgets.fixedPerMasterUsd.speechAndFfmpeg`).
- No local model, embedding or ONNX code is imported. The legacy `research/` and `embeddings/` code is not reused.

## Tests

Run from the repo root (`npm test` runs `src/**/*.test.ts`, so these run in CI):

    NODE_ENV=development node --experimental-strip-types --test 'src/engine/media/**/*.test.ts'

- `probe.test.ts`, `loudness.test.ts`, `cuts.test.ts`, `frames.test.ts`: pure parser and argument tests on recorded tool
  output (`src/engine/test/fixtures/recorded/ffmpeg-output.ts`) and on PNGs written by `pngjs`. No tool is run.
- `handlers.test.ts`, `local.test.ts`: the real tools on generated media. The probe is exact. Cuts are found within two
  frames of 1000 and 2000 ms. A 1 kHz tone at amplitude 0.1 measures -23.0 LUFS (within 0.5 LU). Frames at 500, 1500 and
  2500 ms are valid PNGs whose colours match the segment at each time.
- `source.test.ts`: the URL policy, temporary-directory cleanup on error, size refusal, and fetch status mapping.
- `http-client.test.ts`, `http-handler.test.ts`: the client against recorded answers (success, rate limit, timeout,
  refused URL, malformed answer), the route table and error statuses, and an end-to-end round trip through the handler.
- `integrity.test.ts`: every check of 6.11, including the 100 ms boundary and the null platform limit.
- `stt.test.ts`: transcript validation, the four recorded outcome classes (success, rate limit, timeout, policy refusal),
  and the budget wrapper.
- `boundaries.test.ts`: static checks of the import rules above.

The tests that need ffmpeg are skipped with a visible reason when ffmpeg is not installed. With
`MERIDIAN_REQUIRE_FFMPEG=1`, `ffmpeg-required.test.ts` fails the run instead.

## Not in E1

OCR, motion and flicker metrics, the embedding wrapper, audio extraction for speech-to-text, and the lip-sync,
background-removal and upscaling wrappers. Each belongs to a later phase (E2 to E4) and to an owner decision in Bible
20.2.

See `STATUS.md` for the owner's live steps and the blockers.
