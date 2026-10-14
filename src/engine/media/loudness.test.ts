// loudness: the pure summary parser and argument builder, on recorded ffmpeg ebur128 output.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { buildArgs, parse } from "../../../functions/ffmpeg/loudness.ts";
import {
  RECORDED_EBUR128_SILENCE_SUMMARY,
  RECORDED_EBUR128_TONE_SUMMARY,
} from "../test/fixtures/recorded/ffmpeg-output.ts";

describe("loudness.parse on recorded ebur128 summaries", () => {
  it("reads the integrated loudness, true peak and loudness range of a 1 kHz tone", () => {
    assert.deepEqual(parse(RECORDED_EBUR128_TONE_SUMMARY), {
      integratedLufs: -23,
      truePeakDbtp: -20,
      loudnessRangeLu: 20,
    });
  });

  it("returns null, not -70, for silence: nothing was above the absolute gate", () => {
    const result = parse(RECORDED_EBUR128_SILENCE_SUMMARY);
    assert.equal(result.integratedLufs, null);
    assert.equal(result.truePeakDbtp, null);
    assert.equal(result.loudnessRangeLu, 0);
  });

  it("refuses output with no ebur128 summary as a provider error, never as a zero", () => {
    assert.throws(
      () => parse("[Parsed_ebur128_0 @ 0x1] something else\n"),
      (error: unknown) => error instanceof EngineError && error.kind === "provider",
    );
  });

  it("reads -inf true peak as null", () => {
    const summary = RECORDED_EBUR128_TONE_SUMMARY.replace(
      "Peak:      -20.0 dBFS",
      "Peak:       -inf dBFS",
    );
    assert.equal(parse(summary).truePeakDbtp, null);
  });
});

describe("loudness.buildArgs", () => {
  it("measures the first audio stream with ebur128 and discards the output", () => {
    const args = buildArgs({ inputPath: "/tmp/x/input.media" });
    assert.ok(args.includes("[0:a:0]ebur128=peak=true:framelog=quiet[measured]"));
    assert.deepEqual(args.slice(-3), ["-f", "null", "-"]);
    assert.ok(args.includes("-nostats"));
  });
});
