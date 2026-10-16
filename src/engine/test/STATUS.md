# STATUS: engine test helpers and fixtures (W4), `src/engine/test/`

Phase E1, wave B. Branch `engine/e1-w4`. Covers `src/engine/test/`. See `README.md`.

## Done

- `media-fixture.ts`: generates the test reel (3 s, 1080 x 1920, 30 fps, testsrc2 then two colour cuts at 1000 and 2000
  ms, mono AAC), a 1 kHz tone at amplitude 0.1 (WAV), and a video-only clip. Written to a per-process temporary
  directory. `ffmpegSkipReason()` reports a missing ffmpeg as a skip reason. `src/engine/media/ffmpeg-required.test.ts`
  fails the run when `MERIDIAN_REQUIRE_FFMPEG=1` is set and ffmpeg is missing.
- `fixtures/recorded/ffmpeg-output.ts`: real ffprobe and ffmpeg output (ffmpeg 6.1.1, 2026-10-14). Temporary paths are
  redacted to `/tmp/recorded`.
- `fixtures/recorded/media-http.ts`: nine captured handler answers, produced in-process on the reel, plus two synthetic
  ones (rate limit 429 and gateway timeout 504).
- `fixtures/recorded/stt.ts`: six **synthetic** speech-to-text recordings in the vendor-neutral shape. No vendor has been
  chosen (Bible 20.2), so nothing here came from a provider.

## Size of the reel

The reel is 346,808 bytes at crf 30, above the 300 KB limit for committed fixtures. It is generated for each run and not
committed. Nothing binary is added to the repository.

## Owner: what to replace

- Replace the synthetic speech-to-text recordings with the owner's live recordings (`source: "live"`) once a vendor is
  chosen (`src/engine/media/STATUS.md`, live steps).
- Re-capture the media HTTP answers from the deployed function, not in-process, once it is deployed.
- Captured entries are regenerated, never edited by hand.
