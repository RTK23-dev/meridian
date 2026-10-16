// Tests for stopmotion.player (Bible 7.1 stop_motion, 9.2): prop limits with reasons, the frame timing, the rule that every
// frame is one of the shot's own sources (through the compiler), and determinism. The golden frames are checked by the
// golden suite (test/golden), not here.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EditDecisionList } from "../../contracts/index.ts";
import { edlFixture, styleKitFixture } from "../../contracts/fixtures/index.ts";
import { compile } from "../compiler.ts";
import { COMPONENT_LIBRARY } from "./index.ts";
import { stopmotionPlayer } from "./stopmotion.player/index.ts";
import {
  MAX_STOP_MOTION_FPS,
  MAX_STOP_MOTION_FRAMES,
  MIN_STOP_MOTION_FPS,
  MIN_STOP_MOTION_FRAMES,
  frameStartMs,
  frameWindows,
  framesNeeded,
  propsSchema,
} from "./stopmotion.player/props.ts";

/** Take URIs of one shot: store://shot/take-01.png and up. None of them is in the golden fixtures. */
function takes(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `store://shot/take-${String(index + 1).padStart(2, "0")}.png`);
}

/** The refusal messages of props as the compiler would see them (the reserved durationMs is added). */
function refusals(props: Record<string, unknown>, durationMs: number): string[] {
  const parsed = propsSchema.safeParse({ ...props, durationMs });
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

function accepts(props: Record<string, unknown>, durationMs: number): boolean {
  return refusals(props, durationMs).length === 0;
}

function textOf(files: Array<{ path: string; bytes: Uint8Array }>, path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) {
    throw new Error(`composition has no file ${path}`);
  }
  return new TextDecoder().decode(file.bytes);
}

/** Undoes escapeHtml for an attribute value (the compiler escapes the JSON it writes into data-variable-values). */
function unescapeAttribute(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** An EDL whose graphics track holds one clip with the given component, props and span. */
function clipEdl(clipId: string, durationMs: number, props: Record<string, unknown>): EditDecisionList {
  const edl = structuredClone(edlFixture);
  edl.tracks = [
    {
      layer: "graphics",
      clips: [{ clipId, startMs: 0, endMs: durationMs, component: "stopmotion.player", props }],
    },
  ];
  edl.durationMs = durationMs;
  edl.audio.voice.endMs = durationMs;
  delete edl.audio.music;
  edl.audio.sfx = [];
  edl.effects = [];
  return edl;
}

describe("stopmotion.player props: limits, with the reason for each refusal", () => {
  it("accepts the Bible's 24 frames at 8 fps for three seconds", () => {
    assert.equal(accepts({ fps: 8, frameUris: takes(24) }, 3000), true);
  });

  it("accepts the ceiling of 36 frames at 12 fps for three seconds: the clip needs exactly 36", () => {
    assert.equal(MAX_STOP_MOTION_FRAMES, 36);
    assert.equal(accepts({ fps: 12, frameUris: takes(36) }, 3000), true);
  });

  it("refuses 36 frames at 12 fps for two seconds: the clip needs 24, so 12 frames would never show (refused, not clamped)", () => {
    const reasons = refusals({ fps: 12, frameUris: takes(36) }, 2000);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /run to 3000 ms, past the 2000 ms clip/);
    assert.match(reasons[0], /12 of them start at or after the clip end/);
    assert.match(reasons[0], /refused, not clamped/);
    assert.match(reasons[0], /at 12 fps it needs 24 frames/);
    assert.equal(accepts({ fps: 12, frameUris: takes(24) }, 2000), true, "24 frames are exactly the clip");
  });

  it("refuses 37 frames, and the reason gives the count and the ceiling", () => {
    const reasons = refusals({ fps: 8, frameUris: takes(37) }, 4500);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /at most 36 frames/);
    assert.match(reasons[0], /this one has 37/);
  });

  it("refuses 23 frames, below the floor of 24, even where 23 frames would exactly fit the clip", () => {
    assert.equal(MIN_STOP_MOTION_FRAMES, 24);
    assert.equal(framesNeeded(2875, 8), 23);
    const reasons = refusals({ fps: 8, frameUris: takes(23) }, 2875);
    assert.ok(reasons.some((reason) => /at least 24 frames \(Bible 7\.1\); this one has 23/.test(reason)), reasons.join(" | "));
    assert.equal(accepts({ fps: 8, frameUris: takes(23) }, 2875), false);
  });

  it("refuses a clip that needs fewer than 24 frames at its fps, and says so", () => {
    const reasons = refusals({ fps: 10, frameUris: takes(24) }, 2000);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /at 10 fps the 2000 ms clip needs 20 frames, fewer than the 24 allowed/);
  });

  it("holds the frame rate to whole numbers from 8 to 12 (Bible 7.1)", () => {
    assert.equal(accepts({ fps: 8, frameUris: takes(24) }, 3000), true);
    assert.equal(accepts({ fps: 12, frameUris: takes(36) }, 3000), true);
    assert.equal(accepts({ fps: 7, frameUris: takes(24) }, 3000), false, "7 fps is below the range");
    assert.equal(accepts({ fps: 13, frameUris: takes(24) }, 3000), false, "13 fps is above the range");
    assert.equal(accepts({ fps: 8.5, frameUris: takes(24) }, 3000), false, "fractional fps");
    assert.equal(accepts({ frameUris: takes(24) }, 3000), false, "fps is required");
  });

  it("refuses a frame list that stops before the clip ends, and says how many frames it needs", () => {
    const reasons = refusals({ fps: 8, frameUris: takes(24) }, 3100);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /run to 3000 ms, short of the 3100 ms clip/);
    assert.match(reasons[0], /at 8 fps it needs 25 frames/);
    assert.equal(accepts({ fps: 8, frameUris: takes(25) }, 3100), true, "25 frames run to 3125 ms");
  });

  it("refuses a shot that would need more frames than the ceiling, and suggests a lower fps or a shorter shot", () => {
    const reasons = refusals({ fps: 8, frameUris: takes(36) }, 5000);
    assert.ok(reasons.some((reason) => /would need 40 frames, more than the 36 allowed/.test(reason)), reasons.join(" | "));
  });

  it("refuses a frame that is not an image (a video is not a frame)", () => {
    const frames = takes(24);
    frames[3] = "store://shot/take-04.mp4";
    assert.equal(accepts({ fps: 8, frameUris: frames }, 3000), false);
  });
});

describe("stopmotion.player frame timing: frame i shows from round(i * 1000 / fps) to the next frame's start", () => {
  it("rounds each start to whole milliseconds, so 12 fps frames tile without gaps", () => {
    assert.equal(frameStartMs(0, 12), 0);
    assert.equal(frameStartMs(1, 12), 83, "83.33 rounds down");
    assert.equal(frameStartMs(2, 12), 167, "166.67 rounds up");
    assert.equal(frameStartMs(3, 8), 375);
    assert.equal(frameStartMs(19, 10), 1900);
  });

  it("gives 24 frames at 8 fps exactly 125 ms each, and the last one ends with the clip", () => {
    const windows = frameWindows(24, 8, 3000);
    assert.equal(windows.length, 24);
    assert.deepEqual(windows[0], { index: 0, startMs: 0, endMs: 125 });
    assert.deepEqual(windows[8], { index: 8, startMs: 1000, endMs: 1125 });
    assert.deepEqual(windows[23], { index: 23, startMs: 2875, endMs: 3000 });
  });

  it("36 frames at 12 fps tile a three-second clip exactly, and the last frame ends with the clip", () => {
    const windows = frameWindows(36, 12, 3000);
    assert.equal(windows.length, 36);
    assert.deepEqual(windows[35], { index: 35, startMs: 2917, endMs: 3000 });
    assert.ok(windows.every((window) => window.startMs < 3000 && window.endMs <= 3000));
  });

  it("tiles the clip for every legal frame rate and clip length: contiguous from 0 to the clip end", () => {
    for (let fps = 8; fps <= 12; fps++) {
      for (let durationMs = 500; durationMs <= 4500; durationMs += 250) {
        const count = framesNeeded(durationMs, fps);
        const windows = frameWindows(count, fps, durationMs);
        assert.equal(windows[0].startMs, 0, `fps ${fps}, ${durationMs} ms`);
        for (let i = 1; i < windows.length; i++) {
          assert.equal(windows[i].startMs, windows[i - 1].endMs, `fps ${fps}, ${durationMs} ms, frame ${i}`);
        }
        assert.equal(windows[windows.length - 1].endMs, durationMs, `fps ${fps}, ${durationMs} ms ends with the clip`);
      }
    }
  });

  it("counts the frames a clip needs: the first frame whose start reaches the clip end", () => {
    assert.equal(framesNeeded(3000, 8), 24);
    assert.equal(framesNeeded(3100, 8), 25);
    assert.equal(framesNeeded(2000, 12), 24);
    assert.equal(framesNeeded(2000, 10), 20);
  });
});

describe("stopmotion.player: a list is accepted only when it is the count its clip needs (refused, never clamped)", () => {
  it("accepts exactly the framesNeeded count for each rate and clip length, and refuses every other count from 24 to 36", () => {
    for (let fps = MIN_STOP_MOTION_FPS; fps <= MAX_STOP_MOTION_FPS; fps++) {
      for (let durationMs = 1000; durationMs <= 5000; durationMs += 50) {
        const needed = framesNeeded(durationMs, fps);
        for (let count = MIN_STOP_MOTION_FRAMES; count <= MAX_STOP_MOTION_FRAMES; count++) {
          assert.equal(
            accepts({ fps, frameUris: takes(count) }, durationMs),
            count === needed,
            `${count} frames at ${fps} fps for ${durationMs} ms (the clip needs ${needed})`,
          );
        }
      }
    }
  });

  it("refuses a list that runs past the clip by one frame, and the reason says how many frames are extra", () => {
    const reasons = refusals({ fps: 8, frameUris: takes(25) }, 3000);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /1 of them start at or after the clip end/);
    assert.match(reasons[0], /at 8 fps it needs 24 frames/);
  });

  it("refuses an overshooting list at compile time with the props reason, so no frame is silently dropped", () => {
    const frames = takes(36);
    const edl = clipEdl("c_stop", 2000, { fps: 12, frameUris: frames });
    assert.throws(
      () => compile(edl, styleKitFixture, COMPONENT_LIBRARY, { clipSourceUris: new Map([["c_stop", frames]]) }),
      /props for stopmotion\.player are invalid: frameUris: .*refused, not clamped/,
    );
  });

  it("accepts every fixture the library ships, so the golden frames are of lists the props accept", () => {
    for (const fixture of stopmotionPlayer.fixtures) {
      assert.deepEqual(refusals(fixture.props, fixture.durationMs), [], `${fixture.name} is accepted`);
    }
  });
});

describe("stopmotion.player through the compiler: every frame is one of the shot's own takes", () => {
  it("refuses the clip when no source list is passed, so a stop-motion clip cannot draw free media", () => {
    const edl = clipEdl("c_stop", 3000, { fps: 8, frameUris: takes(24) });
    assert.throws(() => compile(edl, styleKitFixture), /draws only its own shot's media/);
  });

  it("refuses a frame outside the shot's takes, and names it", () => {
    const frames = takes(24);
    frames[5] = "https://cdn.example.com/free-image.png";
    const edl = clipEdl("c_stop", 3000, { fps: 8, frameUris: frames });
    const sources = new Map([["c_stop", takes(24)]]);
    assert.throws(
      () => compile(edl, styleKitFixture, COMPONENT_LIBRARY, { clipSourceUris: sources }),
      /https:\/\/cdn\.example\.com\/free-image\.png, which is not one of the shot's own sources/,
    );
  });

  it("refuses a sources list that belongs to another clip", () => {
    const edl = clipEdl("c_stop", 3000, { fps: 8, frameUris: takes(24) });
    const sources = new Map([["c_other", takes(24)]]);
    assert.throws(() => compile(edl, styleKitFixture, COMPONENT_LIBRARY, { clipSourceUris: sources }), /draws only its own shot's media/);
  });

  it("compiles when every frame is the shot's take: the frames play in order as local assets, never as EDL URIs", () => {
    const frames = takes(24);
    const edl = clipEdl("c_stop", 3000, { fps: 8, frameUris: frames });
    const result = compile(edl, styleKitFixture, COMPONENT_LIBRARY, { clipSourceUris: new Map([["c_stop", frames]]) });
    const html = textOf(result.files, "index.html");
    assert.equal(html.includes("store://shot/"), false, "no take URI reaches the page");
    assert.ok(textOf(result.files, "components/stopmotion.player.html").includes("stopmotion.player"), "the template is copied");

    const imageAssets = result.assets.filter((asset) => asset.kind === "image");
    assert.equal(imageAssets.length, 24, "one local image per frame");
    const pathOf = new Map(imageAssets.map((asset) => [asset.uri, asset.path]));
    const attribute = /data-variable-values='([^']*)'/.exec(html);
    assert.ok(attribute, "the clip carries its props as data");
    const values = JSON.parse(unescapeAttribute(attribute[1])) as { fps: number; frameUris: string[] };
    assert.equal(values.fps, 8);
    assert.deepEqual(values.frameUris, frames.map((uri) => pathOf.get(uri)), "the local paths are in frame order");
  });

  it("the same clip and the same takes compile to the same bytes and the same hash", () => {
    const frames = takes(25);
    const edl = clipEdl("c_stop", 2500, { fps: 10, frameUris: frames });
    const sources = new Map([["c_stop", frames]]);
    const first = compile(edl, styleKitFixture, COMPONENT_LIBRARY, { clipSourceUris: sources });
    const second = compile(edl, styleKitFixture, COMPONENT_LIBRARY, { clipSourceUris: sources });
    assert.equal(first.composition.contentHash, second.composition.contentHash);
  });

  it("refuses 37 frames at compile time, with the same reason as the schema", () => {
    const frames = takes(37);
    const edl = clipEdl("c_stop", 4500, { fps: 8, frameUris: frames });
    assert.throws(
      () => compile(edl, styleKitFixture, COMPONENT_LIBRARY, { clipSourceUris: new Map([["c_stop", frames]]) }),
      /props for stopmotion\.player are invalid: frameUris: .*at most 36 frames/,
    );
  });
});

describe("stopmotion.player: the library entry and its template", () => {
  it("is registered as a sourceBound component that takes fps and the frame list", () => {
    assert.equal(COMPONENT_LIBRARY["stopmotion.player"], stopmotionPlayer);
    assert.equal(stopmotionPlayer.sourceBound, true);
    assert.deepEqual([...stopmotionPlayer.declaredVariables].sort(), ["durationMs", "fps"]);
  });

  it("gives every fixture its own shot's sources, equal to the frames it plays", () => {
    for (const fixture of stopmotionPlayer.fixtures) {
      assert.deepEqual(fixture.sourceUris, fixture.props.frameUris, `${fixture.name} lists its own frames`);
    }
  });

  it("draws the frame timing with the same expression the props module uses", () => {
    assert.ok(stopmotionPlayer.template.includes("Math.round(index * 1000 / fps)"));
    assert.ok(stopmotionPlayer.template.includes("Math.min(Math.round((index + 1) * 1000 / fps), vars.durationMs)"));
    assert.equal(stopmotionPlayer.template.includes("startMs >= vars.durationMs"), false, "no frame is skipped in the page: the props refuse such a list");
  });
});
