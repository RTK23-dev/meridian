# Engine test helpers and fixtures (W4)

Implements Video Engine Bible **section 17.1** (`test/fixtures/`: reference reels, scripts, kits and recorded API
responses) and **section 17.3** (the recorded-adapter level of the test pyramid). Only W4's fixtures are here so far; the
other workstreams add theirs.

## Files

- `media-fixture.ts`: a test helper. It generates media with ffmpeg into a temporary directory that is removed when the
  test process exits:
  - `reelPath()`: 3 s, 1080 x 1920, 30 fps, H.264 with mono AAC. `testsrc2` for the first second, then two solid colour
    cuts at exactly 1000 ms and 2000 ms. It is about 347 KB, above the 300 KB limit for committed fixtures, so it is
    generated for each run and never committed.
  - `tonePath()`: a 3 s mono 1 kHz sine at amplitude 0.1 as WAV.
  - `videoOnlyPath()`: 1 s of video with no audio stream.
  - `ffmpegSkipReason()`: why ffmpeg tests cannot run, or null. Tests pass it as their skip option.
- `fixtures/recorded/ffmpeg-output.ts`: real stdout and stderr of ffprobe and ffmpeg 6.1.1, captured from the reel and
  tone above on 2026-10-14. Temporary paths are redacted. The parser tests use these strings, so they need no tool.
- `fixtures/recorded/media-http.ts`: HTTP answers of the media functions. The `CAPTURED_*` entries are the handler's
  own answers, captured in-process on the reel. The `SYNTHETIC_*` entries are hand-written stand-ins for the rate-limit
  and gateway-timeout replies, which can only be seen once the function is deployed.
- `fixtures/recorded/stt.ts`: speech-to-text recordings in the vendor-neutral shape. All are **synthetic**. No vendor
  has been chosen (Bible 20.2), so these are hand-written, not captured.

## Rules

- A recording says where it came from. Captured entries come from a real run of the code; synthetic entries are labelled
  as such and must be replaced by the owner's live recordings before a live claim is made.
- Captured bodies are never edited by hand. Regenerate them from a new capture.
- Generated media is written only under the OS temporary directory. Nothing in the repository is written during tests.
