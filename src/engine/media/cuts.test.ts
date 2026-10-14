// cuts: the pure showinfo parser and filter builder, on recorded ffmpeg stderr.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { buildArgs, parse } from "../../../functions/ffmpeg/cuts.ts";
import { RECORDED_SHOWINFO_REEL_CUTS } from "../test/fixtures/recorded/ffmpeg-output.ts";

describe("cuts.parse on recorded showinfo output", () => {
  it("reads the two hard cuts of the reel at 1000 ms and 2000 ms", () => {
    assert.deepEqual(parse(RECORDED_SHOWINFO_REEL_CUTS), [1000, 2000]);
  });

  it("ignores showinfo's configuration lines, which carry no frame index", () => {
    const configOnly = RECORDED_SHOWINFO_REEL_CUTS.split("\n")
      .filter((line) => line.includes("config ") || line.includes("color_range"))
      .join("\n");
    assert.deepEqual(parse(configOnly), []);
  });

  it("returns an empty list when no frame passed the threshold: a single shot", () => {
    assert.deepEqual(parse("Input #0 ...\nno frames selected\n"), []);
  });

  it("sorts and de-duplicates the times it reads", () => {
    const frame = (n: number, time: string): string =>
      `[Parsed_showinfo_1 @ 0x1] n:   ${n} pts:  0 pts_time:${time}       duration:    512 duration_time:0.0333333\n`;
    assert.deepEqual(parse(frame(2, "2") + frame(1, "1") + frame(3, "2")), [1000, 2000]);
  });

  it("converts fractional seconds to whole milliseconds", () => {
    const line = "[Parsed_showinfo_1 @ 0x1] n:   1 pts:  1 pts_time:1.033333 duration: 1\n";
    assert.deepEqual(parse(line), [1033]);
  });

  it("refuses a kept frame that has no numeric presentation time", () => {
    const line = "[Parsed_showinfo_1 @ 0x1] n:   1 pts:  NOPTS pts_time:nan duration: 1\n";
    assert.throws(
      () => parse(line),
      (error: unknown) => error instanceof EngineError && error.kind === "provider",
    );
  });
});

describe("cuts.buildArgs", () => {
  it("selects frames whose scene score is above the threshold, prints them, and discards the video", () => {
    const args = buildArgs({ inputPath: "/tmp/x/input.media", sceneScore: 0.3 });
    const filter = args[args.indexOf("-vf") + 1];
    assert.equal(filter, "select='gt(scene\\,0.3000)',showinfo");
    assert.ok(args.includes("-an"));
    assert.deepEqual(args.slice(-3), ["-f", "null", "-"]);
  });
});
