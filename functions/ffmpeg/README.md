# Media functions: serverless ffmpeg (W4)

Implements Video Engine Bible **section 6.2** (reference measurements: probe, cuts, frames, loudness), **section 6.11**
(render integrity inputs, through `src/engine/media/integrity.ts`), **section 8.1** (edit grammar inputs: cut times,
shot lengths, loudness), **sections 12.2 and 12.3** (take and post-render loudness and frames), and **section 15.2**
(stateless functions that scale to zero, cold-start budget 3 s). Bible principle 8: ffmpeg runs only here, in
stateless functions, never in a production worker.

## Handlers

Each handler is a module with three parts: `buildArgs(input)` (pure, returns the argument array for ffmpeg or ffprobe),
`parse(output)` (pure, turns recorded tool output into a typed result) and `run(request)` (spawns the tool on a file
inside a temporary directory, then always removes that directory).

| Module        | Tool                                   | Result                                                                                                                                                               |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe.ts`    | ffprobe, JSON                          | container, video and audio codecs, width, height, `fps` as `{num, den, value}`, duration in ms, `audioPresent`, bytes. Unknown values are `null`.                    |
| `frames.ts`   | ffmpeg, one PNG output per time        | PNG bytes at the asked times (first decoded frame at or after each time), optional `longSidePx` (no upscaling). A time at or past the last frame is `invalid_input`. |
| `cuts.ts`     | ffmpeg `select='gt(scene,T)',showinfo` | scene-change times in ms, ascending. `T` is an input (the client supplies the configured default).                                                                   |
| `loudness.ts` | ffmpeg `ebur128=peak=true`             | integrated LUFS, true peak dBTP, loudness range LU. Silence or a value at the absolute gate (-70 LUFS) is `null`.                                                    |
| `picture.ts`  | ffmpeg, raw grayscale thumbnails to files | per 100 ms pair: scale and shift fit (scale, fit ratio), a cut-straddling pair unmeasured; loop distance of the first and last frame (Bible 8.1, zoom and loop). Route `POST /picture`. |
| `detectors.ts` | ffmpeg `blackdetect`, `freezedetect`, `signalstats` (luma, frame difference), `silencedetect` | black and frozen runs in ms (Bible 12.2); flicker score, normalised 0 to 1 (12.2); mean motion energy, 0 to 1 (12.2); silent runs of at least 100 ms at -50 dBFS (8.1, 12.3). Routes `POST /black`, `/flicker`, `/motion`, `/silence`. |

The frame plan of section 6.2 (a frame at every cut, then 2 per second, capped at 60, cuts first) is applied by the
client, `src/engine/media/frames.ts`, so the handler receives explicit times.

## HTTP entry point

`http.ts` exports `handleMediaRequest(request: Request)`, a Web-standard handler that a serverless runtime can call.

- `POST /probe`, `/loudness`: body `{ "source": ... }`.
- `POST /cuts`: body `{ "source": ..., "sceneScore": 0.3 }`.
- `POST /frames`: body `{ "source": ..., "atMs": [...], "longSidePx": 768 }` (at most 60 times).
- `GET /health`: the first line of `ffmpeg -version` and `ffprobe -version`. Use it as the deployment check.
- A source is `{ "kind": "url", "url": "https://..." }` or `{ "kind": "bytes", "base64": "..." }`. Inline bytes are capped at
  4 MB; larger media must come by URL.
- Errors are `{ "error": { "kind", "retryable", "message", "stage" } }`. The status follows the kind: invalid_input 400,
  not_found 404, provider retryable 503, provider not retryable 502, config and internal 500. Stack traces and temporary
  paths are never returned.

The wire schemas are in `wire.ts` and are shared with the HTTP client in `src/engine/media/`.

## Input and safety rules

- Inputs are validated with zod before anything is written. Bad input is `invalid_input` with the failing field names.
- A URL is fetched by this function, never by ffmpeg. The default policy allows only public https URLs (no credentials,
  no localhost, no private or loopback IPv4 literals, no IPv6 literals). Redirects are refused. The fetch has a timeout
  and a size cap, and a declared size over the cap is refused before the body is read.
- Tools run with an argument array (no shell), a timeout and a bounded stdout. A timeout is retryable. A missing binary
  is `config`. Invalid media (for example "Invalid data found") is `invalid_input`.
- Everything is written to a directory created with `mkdtemp` under the OS temporary directory, and removed in a
  `finally`, also on error. Nothing is written anywhere else.
- Tool stderr in an error message has the temporary path redacted.
- No function reads `process.env` for keys. The only environment-dependent setting is the ffmpeg binary path, which the
  HTTP entry takes as an option (default: `ffmpeg` and `ffprobe` on PATH).

## Limits

`limits.ts` holds the infrastructure limits (input size 150 MB, inline 4 MB, PNG 8 MB, response 32 MB, tool timeouts).
They bound memory, time and response size. They are not Bible values, and they are not tuned.

## Where the tests are

Tests for these handlers live in `src/engine/media/`, not here. `npm test` globs `src/**/*.test.ts`, so a test file in
`functions/` would never run in CI. See `src/engine/media/README.md`. `functions/` is outside `tsconfig.json`'s
`include` (`src`, `server`). It is type-checked through its imports from `src/engine/media/`, and ESLint covers it.

See `STATUS.md` for what the owner must run and deploy.
