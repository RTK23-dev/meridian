// When a run sets MERIDIAN_REQUIRE_FFMPEG=1 (CI should), a missing ffmpeg fails the run here instead of silently skipping
// the ffmpeg-dependent tests. Without the switch this test is skipped with a visible reason. The switch is read in a test
// file on purpose: test files are outside the environment contract scan (src/lib/meridian/config/env-example.test.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ffmpegSkipReason } from "../test/media-fixture.ts";

const REQUIRED = process.env.MERIDIAN_REQUIRE_FFMPEG === "1";

describe("ffmpeg is installed when the run requires it", { skip: !REQUIRED && "not required in this run" }, () => {
  it("finds ffmpeg and ffprobe on PATH", () => {
    assert.equal(ffmpegSkipReason(), null);
  });
});
