import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import {
  fitScale,
  gridArgs,
  lumaDistance,
  tailArgs,
  thumbnailSize,
} from "../../../functions/ffmpeg/picture.ts";
import { handleMediaRequest } from "../../../functions/ffmpeg/http.ts";
import { pictureResultSchema, type PictureResult } from "../../../functions/ffmpeg/types.ts";
import { pictureInProcess, pictureOverWire, PICTURE_PATH } from "./picture.ts";
import { CLIP, clipBytes } from "./test/picture-clips.ts";
import { ffmpegSkipReason } from "../test/media-fixture.ts";

const SKIP = ffmpegSkipReason() ?? false;
const W = 64;
const H = 114;

/** A continuous texture of integer coordinates: smooth waves, so a scale or a shift is visible everywhere in the frame. */
function base(x: number, y: number): number {
  return Math.round(128 + 60 * Math.sin(x / 3.1) * Math.cos(y / 4.7) + 40 * Math.sin((x + y) / 2.3));
}

/** The later thumbnail of a picture magnified by `scale` about the centre and moved by (shiftX, shiftY) fractions of the frame. */
function magnified(scale: number, shiftX: number, shiftY: number): Uint8Array {
  const out = new Uint8Array(W * H);
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.round(cx + (x - cx - shiftX * W) / scale);
      const sy = Math.round(cy + (y - cy - shiftY * H) / scale);
      out[y * W + x] = base(sx, sy);
    }
  }
  return out;
}

function earlier(): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = base(x, y);
  return out;
}

/** Deterministic noise, so two unrelated pictures have no scale in common. */
function noise(seed: number): Uint8Array {
  const out = new Uint8Array(W * H);
  let state = seed;
  for (let index = 0; index < out.length; index++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[index] = state % 256;
  }
  return out;
}

const good: PictureResult = {
  sampleMs: 100,
  width: W,
  height: H,
  pairs: [
    { atMs: 100, usable: true, scale: 1, fit: 1 },
    { atMs: 200, usable: false, scale: null, fit: null },
  ],
  loopDistance: 0.01,
};

describe("the picture arguments and sizes (pure)", () => {
  it("makes a 64 px wide thumbnail whose height follows the aspect ratio, and an even height", () => {
    assert.deepEqual(thumbnailSize(1080, 1920), { width: 64, height: 114 });
    assert.deepEqual(thumbnailSize(360, 640), { width: 64, height: 114 });
    assert.deepEqual(thumbnailSize(1920, 1080), { width: 64, height: 36 });
  });

  it("samples every 100 ms as raw grayscale, and reads the last 500 ms from the end for the last frame", () => {
    const grid = gridArgs({ inputPath: "/tmp/in.media", outPath: "/tmp/grid.gray", width: 64, height: 114 }).join(" ");
    assert.match(grid, /fps=10,scale=64:114,format=gray/);
    assert.match(grid, /-f rawvideo -pix_fmt gray \/tmp\/grid\.gray$/);
    const tail = tailArgs({ inputPath: "/tmp/in.media", outPath: "/tmp/tail.gray", width: 64, height: 114 });
    assert.equal(tail[tail.indexOf("-sseof") + 1], "-0.5");
    assert.ok(tail.indexOf("-sseof") < tail.indexOf("-i"), "the seek is an input option, before -i");
  });

  it("measures the luma distance of two thumbnails: 0 when equal, 1 when opposite, and refuses different sizes", () => {
    const black = new Uint8Array(10);
    const white = new Uint8Array(10).fill(255);
    assert.equal(lumaDistance(black, black), 0);
    assert.equal(lumaDistance(black, white), 1);
    assert.throws(
      () => lumaDistance(black, new Uint8Array(9)),
      (error: unknown) => error instanceof EngineError && error.kind === "provider",
    );
  });
});

describe("the scale model on exact synthetic pictures (pure)", () => {
  it("finds a centred zoom-in of 1.2 and reports a poor fit for the identity", () => {
    const fit = fitScale(earlier(), magnified(1.2, 0, 0), W, H);
    assert.ok(Math.abs(fit.scale - 1.2) <= 0.01, `scale ${fit.scale}`);
    assert.ok(fit.fit < 0.15, `fit ${fit.fit}`);
  });

  it("finds a zoom-out of 0.9", () => {
    const fit = fitScale(earlier(), magnified(0.9, 0, 0), W, H);
    assert.ok(Math.abs(fit.scale - 0.9) <= 0.01, `scale ${fit.scale}`);
    assert.ok(fit.fit < 0.15, `fit ${fit.fit}`);
  });

  it("finds a zoom-in that is not about the centre: the shift is searched with the scale", () => {
    const fit = fitScale(earlier(), magnified(1.2, 0.1, 0), W, H);
    assert.ok(Math.abs(fit.scale - 1.2) <= 0.02, `scale ${fit.scale}`);
    assert.ok(fit.fit < 0.2, `fit ${fit.fit}`);
  });

  it("reads a pan as no zoom: the scale stays within 3% of 1, far below the 8% jump threshold", () => {
    // A shift of 0.05 of the width (3.2 px) falls between the fine shift steps, so the scale absorbs up to about 2%.
    const fit = fitScale(earlier(), magnified(1, 0.05, 0), W, H);
    assert.ok(Math.abs(fit.scale - 1) <= 0.03, `scale ${fit.scale}`);
    assert.ok(fit.fit < 0.2, `fit ${fit.fit}`);
  });

  it("reports the same picture as scale 1 and fit 1 (no change to explain)", () => {
    assert.deepEqual(fitScale(earlier(), earlier(), W, H), { scale: 1, fit: 1 });
  });

  it("gives an unrelated picture a fit near 1, so noise is never a zoom jump", () => {
    const fit = fitScale(noise(1), noise(2), W, H);
    assert.ok(fit.fit >= 0.8, `fit ${fit.fit}`);
  });
});

describe("the picture result contract", () => {
  it("accepts a measured pair and an unmeasured one", () => {
    assert.equal(pictureResultSchema.safeParse(good).success, true);
  });

  it("refuses a usable pair without a scale, and an unusable pair with one", () => {
    const usableNoScale = { ...good, pairs: [{ atMs: 100, usable: true, scale: null, fit: null }] };
    const unusableWithScale = { ...good, pairs: [{ atMs: 100, usable: false, scale: 1, fit: 1 }] };
    assert.equal(pictureResultSchema.safeParse(usableNoScale).success, false);
    assert.equal(pictureResultSchema.safeParse(unusableWithScale).success, false);
  });

  it("refuses pairs that do not run forward in time, a scale out of range, and a loop distance above 1", () => {
    const backwards = { ...good, pairs: [good.pairs[1], good.pairs[0]] };
    const extreme = { ...good, pairs: [{ atMs: 100, usable: true, scale: 3, fit: 0.5 }] };
    assert.equal(pictureResultSchema.safeParse(backwards).success, false);
    assert.equal(pictureResultSchema.safeParse(extreme).success, false);
    assert.equal(pictureResultSchema.safeParse({ ...good, loopDistance: 1.5 }).success, false);
  });
});

describe("the picture client (recorded answers)", () => {
  it("posts the source and the cut times to the picture route and returns the validated answer", async () => {
    const posts: Array<{ path: string; body: unknown; timeoutMs: number }> = [];
    const client = pictureOverWire(async (path, body, schema, timeoutMs) => {
      posts.push({ path, body, timeoutMs });
      return schema.parse(good);
    });
    const result = await client({
      source: { kind: "url", url: "https://media.example.test/reel.mp4" },
      cutsMs: [1000],
    });
    assert.equal(result.pairs.length, 2);
    assert.deepEqual(posts, [
      {
        path: PICTURE_PATH,
        body: { source: { kind: "url", url: "https://media.example.test/reel.mp4" }, cutsMs: [1000] },
        timeoutMs: 200_000,
      },
    ]);
  });

  it("refuses a request with a negative cut time before anything is posted", async () => {
    let posted = false;
    const client = pictureOverWire(async () => {
      posted = true;
      throw new Error("not reached");
    });
    await assert.rejects(
      client({ source: { kind: "url", url: "https://media.example.test/reel.mp4" }, cutsMs: [-5] }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(posted, false);
  });
});

describe("the picture route of the function (no ffmpeg needed)", () => {
  it("refuses a body with a negative cut time with a 400 and an invalid_input error", async () => {
    const response = await handleMediaRequest(
      new Request("https://media.example.test/picture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "url", url: "https://media.example.test/a.mp4" }, cutsMs: [-1] }),
      }),
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { kind: string } };
    assert.equal(body.error.kind, "invalid_input");
  });

  it("answers GET on the picture route with 405", async () => {
    const response = await handleMediaRequest(new Request("https://media.example.test/picture", { method: "GET" }));
    assert.equal(response.status, 405);
  });
});

describe("the picture measures on generated clips (ffmpeg, skipped without it)", { skip: SKIP }, () => {
  it("finds the centred 1.2x zoom-in at its frame (1000 ms), and no other jump", async () => {
    const result = await pictureInProcess()({
      source: { kind: "bytes", bytes: await clipBytes("punch") },
      cutsMs: [],
    });
    const jumps = result.pairs.filter((pair) => pair.usable && pair.scale !== null && Math.abs(pair.scale - 1) > 0.08);
    assert.equal(jumps.length, 1, JSON.stringify(jumps));
    assert.equal(jumps[0]?.atMs, CLIP.jumpMs);
    assert.ok(Math.abs((jumps[0]?.scale ?? 0) - CLIP.jumpScale) <= 0.02, `scale ${jumps[0]?.scale}`);
    assert.ok((jumps[0]?.fit ?? 1) <= 0.6, `fit ${jumps[0]?.fit}`);
    assert.equal(result.width, W);
    assert.equal(result.height, H);
  });

  it("finds the zoom-in that is not about the centre, at its frame, with the right scale", async () => {
    const result = await pictureInProcess()({
      source: { kind: "bytes", bytes: await clipBytes("punch-offcentre") },
      cutsMs: [],
    });
    const jump = result.pairs.find((pair) => pair.usable && pair.scale !== null && Math.abs(pair.scale - 1) > 0.08);
    assert.equal(jump?.atMs, CLIP.jumpMs);
    assert.ok(Math.abs((jump?.scale ?? 0) - CLIP.jumpScale) <= 0.03, `scale ${jump?.scale}`);
  });

  it("does not measure the pair that straddles a cut at the jump, so the jump is not seen", async () => {
    const result = await pictureInProcess()({
      source: { kind: "bytes", bytes: await clipBytes("punch") },
      cutsMs: [CLIP.jumpMs],
    });
    const straddling = result.pairs.find((pair) => pair.atMs === CLIP.jumpMs);
    assert.equal(straddling?.usable, false);
    assert.equal(result.pairs.filter((pair) => pair.usable && pair.scale !== null && Math.abs(pair.scale - 1) > 0.08).length, 0);
  });

  it("measures a loop: the first and the last frame of a looping still are close, and of a drift are not", async () => {
    const loop = await pictureInProcess()({ source: { kind: "bytes", bytes: await clipBytes("loop") }, cutsMs: [] });
    const drift = await pictureInProcess()({ source: { kind: "bytes", bytes: await clipBytes("drift") }, cutsMs: [] });
    assert.ok((loop.loopDistance ?? 1) <= 0.04, `loop distance ${loop.loopDistance}`);
    assert.ok((drift.loopDistance ?? 0) > 0.04, `drift distance ${drift.loopDistance}`);
  });
});
