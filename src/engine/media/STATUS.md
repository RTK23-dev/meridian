# STATUS: media clients, integrity and speech-to-text (W4), `src/engine/media/`

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
