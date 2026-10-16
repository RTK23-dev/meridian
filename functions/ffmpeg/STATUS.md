# STATUS: serverless media functions (W4), `functions/ffmpeg/`

Phase E1, wave B. Branch `engine/e1-w4`, cut from `code/beautiful-cori-1zfk11` (7fd32ae). Covers `functions/ffmpeg/`.
Bible sections implemented: 6.2, 6.11 (inputs), 8.1 (inputs), 12.2 and 12.3 (inputs), 15.2. See `README.md`.

## Done

- `probe`, `frames`, `loudness` and `cuts` handlers. Each has pure `buildArgs` and `parse` (on recorded tool output)
  and a `run` that works in a temporary directory removed on every path.
- Input as a URL (fetched by the function, never by ffmpeg) or as bytes. Zod validation before anything is written.
  Typed `EngineError`s: invalid_input, provider (retryable or not), config, not_found.
- `http.ts`: `handleMediaRequest(Request) -> Response` with `POST /probe`, `/loudness`, `/cuts`, `/frames` and
  `GET /health`. Errors map to statuses by kind. No stack traces or temporary paths in responses.
- Wire schemas (`wire.ts`) shared with the HTTP client in `src/engine/media/`.
- Checked on this machine with ffmpeg and ffprobe 6.1.1 (Ubuntu) on the generated reel: probe reports the generated
  properties exactly (1080 x 1920, h264, aac, 30/1, 3000 ms, audio present); cuts at 1000 and 2000 ms; a 1 kHz tone at
  amplitude 0.1 measures -23.0 LUFS and -20.0 dBTP; frames at 500, 1500 and 2500 ms are valid PNGs of the right
  colour; a time past the last frame and non-media bytes are invalid_input.

## Tests

The tests for these handlers are in `src/engine/media/` (`handlers.test.ts`, `local.test.ts`, `http-handler.test.ts`,
`source.test.ts`, and the parser tests). **Choice:** `npm test` globs `src/**/*.test.ts`, so a test under `functions/`
would never run in CI. There is no `*.test.ts` under `functions/`. The brief's command includes `functions/**/*.test.ts`;
it exits 0 because that glob matches nothing.

Results of the final run are in `src/engine/media/STATUS.md`.

## tsconfig

`functions/` is outside `tsconfig.json`'s `include` (`src`, `server`). It is not edited. Every module here is imported
by a module under `src/engine/media/`, so `tsc --noEmit` type-checks all of it. ESLint covers `functions/` through
`eslint .`. Nothing has been added to tsconfig.

## What the owner must run live (deployment; no keys are needed)

1. Build the function image or bundle with ffmpeg and ffprobe installed. Tested with 6.1.1. Any version with the
   `ebur128` and `showinfo` filters should work; confirm it with `GET /health`.
2. Deploy `handleMediaRequest` (or a thin wrapper that calls it) behind an https endpoint. Confirm `GET /health` returns
   the ffmpeg and ffprobe version lines.
3. Measure the cold start against the 3 s budget (Bible 15.2) with the real image.
4. Egress control. The URL policy checks host names and literal addresses, not the addresses a name resolves to.
   A name that resolves to a private address, or a DNS rebinding attack, is not stopped in code. Restrict egress to the
   storage hosts that hold reference media, at the platform level.
5. Decide how the endpoint is authenticated. This code adds no secret. If a shared secret is used, the caller takes it
   from the credential resolver and sends it in the transport; it is never read from `process.env` here.
6. Run each function on one real reference reel (by URL) and one 60-second reel. Record the probe, the cut times, the
   loudness, the frame times, the durations, the p50 and p95 latency, the peak memory, and the ffmpeg version. Attach
   them to the phase PR.
7. Check the limits in `limits.ts` against real reference sizes: input 150 MB, inline 4 MB, PNG 8 MB, response 32 MB,
   tool timeouts 30 s to 120 s. They are initial values.

## Blockers

- Deployment target and image are not chosen. The repo has no function deployment config. Owner decision.
- The platform file-size limit is null (`thresholds.render.platformMaxBytes`), so the render-integrity gate fails on
  size until the owner sets it (Bible 12). This is not a code problem.
- CI: `npm test` needs ffmpeg and ffprobe on the runner. `.github/workflows/ci.yml` does not install ffmpeg, and I
  could not confirm that `ubuntu-latest` includes it. Without it, the ffmpeg tests skip with a visible reason. Set
  `MERIDIAN_REQUIRE_FFMPEG=1` in CI to make a missing ffmpeg a failure (`src/engine/media/ffmpeg-required.test.ts`).

## Decisions and interpretations (lead to confirm)

- The frame plan of Bible 6.2 (a frame at every cut, then 2 per second, capped at 60, cuts first) is applied in
  `src/engine/media/frames.ts`, not in the handler. The handler takes explicit times. A caller that sends times to the
  HTTP function directly must apply the plan itself.
- The frame at a time is the first decoded frame at or after that time (output seeking, frame accurate). A time at or
  past the last frame is an error, never a skipped frame.
- Frames can be scaled to a long side (`longSidePx`) to keep the response small. Scaling down only.
- Silence and a value at the -70 LUFS absolute gate are reported as `null`, not as -70.
- The integrity of a stream is judged by ffprobe only. Pixel content is not checked here.
- The URL policy is https only. Redirects are refused (`redirect: "error"`), so a redirect cannot reach an address the
  policy never saw.
- Tool errors are classified from stderr: "Invalid data found", "matches no streams" and similar are invalid_input.
  Other failures are a non-retryable provider error with the stderr tail, with temporary paths redacted.

## E3: the timeline (`timeline.ts`, route `POST /timeline`)

- One call, four ffmpeg passes after a probe: brightness and motion every 500 ms (signalstats on a 160 px copy; motion is the
  mean luma change to the sample 500 ms earlier), momentary loudness every 100 ms (ebur128 metadata; silence and values at or
  below -70 LUFS are null), and a mono RMS envelope every 10 ms from 8 kHz PCM. Constants are in `types.ts` (`TIMELINE_STEPS`).
- Limits: media up to 240 s (`FFMPEG_LIMITS.maxTimelineMs`), 90 s per pass (`toolTimeoutMs.timeline`), and PCM within the 4 MB
  stdout limit (about 16 kB per second).
- Parsers are pure and tested against the lines this ffmpeg build prints (6.1.1). A value with no time, or a time with no value,
  is a provider error.
- Captured: the timeline, cuts and probe of a generated 6 s reel (`src/engine/analyze/test/fixtures/reference-measurements.json`).
- Not deployed. The owner deploys this handler with the other routes and records one `/timeline` answer as `captured`.

## Follow-up: the picture measures (`picture.ts`, route `POST /picture`)

- Input: the source and the scene-cut times (`cutsMs`, at most 600). Output: a 64 px grayscale thumbnail every 100 ms
  (`PICTURE_STEPS`), one pair per neighbouring thumbnails (atMs is the later one, usable, scale, fit), and `loopDistance`, the
  mean luma difference of the first frame and the true last frame (read from the last 500 ms of the stream).
- The scale model: the later thumbnail is the earlier one magnified about the centre and moved by a shift. The search is a
  joint coarse grid (scale 0.80 to 1.30 in 0.02 steps, shift -0.08, 0, +0.08 in x and y), then a fine shift and a fine scale.
  Fit is the residual after the model over the identity residual (0 is a perfect fit). Pairs whose frames are within the noise
  floor (mean difference 0.01) are scale 1, fit 1.
- A pair that straddles a cut is `usable: false`. The response schema refuses a usable pair without a scale and an unusable one
  with one, and refuses pairs out of time order.
- Measured on this machine (ffmpeg 6.1.1, Node 22): the punch-in clip gives its jump at 1000 ms with scale 1.205 (true 1.2);
  an off-centre punch-in gives 1.21; a zoom that comes back gives a loop distance of 0.022, and a drifting zoom 0.24.
- Worst-case compute, measured in isolation on random pictures (every pair runs the full search): 600 pairs, about 2.1 s. This
  is compute only, not the function's cold start, which is not measured. Record both on the deployed function.
- Limits: media up to 240 s (`maxPictureMs`), 90 s per pass (`toolTimeoutMs.picture`), and the thumbnails go to a file in the
  temporary directory, not to stdout, so the 4 MB stdout limit does not apply. Three ffmpeg passes: the probe, the thumbnail
  grid and the tail.
- Not deployed. The owner deploys this route with the others and records one `/picture` answer as `captured`.

## Follow-up: the detectors (`detectors.ts`, routes `POST /black`, `/flicker`, `/motion`, `/silence`)

- Each route takes the same body as `/probe` (one source) and answers its own result schema (`types.ts`). Each runs one or two
  ffmpeg passes in a temporary directory that is removed on every path. `/black` runs blackdetect and freezedetect in one pass.
  `/flicker` and `/motion` read the luma of every frame on a 160 px copy (`signalstats`, and `tblend` for motion). `/silence` runs
  `silencedetect` on the first audio stream. Pure argument builders and parsers are exported, and tested on the lines of ffmpeg 6.1.1.
- Limits: media up to 240 s (`FFMPEG_LIMITS.maxDetectMs`), 90 s per pass (60 s for silence), and at most 2000 runs in one report.
  A span still open at the end is closed at the probed duration. With no duration, the report is a provider error.
- Parsers refuse a report whose spans are not start-then-end, or that overlap, rather than repair it.
- `/health` is unchanged. `GET` on these routes answers 405, as the others do.
- Not deployed. The owner deploys these four routes with the others, and records one answer per route on one real take and one real
  reference (the same live steps as `/timeline` and `/picture`). Measure the cold start again with the larger bundle.
