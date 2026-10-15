import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PicturePair } from "../media/index.ts";
import { analyzeConfig } from "./config.ts";
import { loopOf, zoomJumps } from "./zoom.ts";

/** A measured pair at time atMs with a scale and a fit. */
const measured = (atMs: number, scale: number, fit = 0.2): PicturePair => ({ atMs, usable: true, scale, fit });
/** A pair that straddles a scene cut: not measured. */
const cut = (atMs: number): PicturePair => ({ atMs, usable: false, scale: null, fit: null });
/** A measured pair with no scale change. */
const still = (atMs: number): PicturePair => measured(atMs, 1, 1);

describe("zoom jumps from the picture pairs (Bible 8.1, analyze/zoom.ts)", () => {
  it("reads one zoom-in of 1.2 as one jump at the time of the pair that holds it", () => {
    const pairs = [still(100), still(200), still(300), measured(400, 1.2), still(500)];
    assert.deepEqual(zoomJumps(pairs), [{ atMs: 400, scale: 1.2 }]);
  });

  it("reads a zoom-out as a jump below 1, so the punch-in count can leave it out", () => {
    assert.deepEqual(zoomJumps([still(100), measured(200, 0.85)]), [{ atMs: 200, scale: 0.85 }]);
  });

  it("treats a change of 7% as no jump, and 9% as a jump (Bible 8.1: above 8%)", () => {
    assert.deepEqual(zoomJumps([still(100), measured(200, 1.07)]), []);
    assert.deepEqual(zoomJumps([still(100), measured(200, 1.09)]), [{ atMs: 200, scale: 1.09 }]);
  });

  it("does not read a jump the scale model does not explain (fit above the maximum)", () => {
    assert.deepEqual(zoomJumps([still(100), measured(200, 1.2, analyzeConfig.zoomFitMax + 0.05)]), []);
  });

  it("joins consecutive jump pairs of one direction into one jump: scale is their product, time the first pair's", () => {
    const jumps = zoomJumps([still(100), measured(200, 1.1), measured(300, 1.09)]);
    assert.equal(jumps?.length, 1);
    assert.equal(jumps?.[0]?.atMs, 200);
    assert.ok(Math.abs((jumps?.[0]?.scale ?? 0) - 1.1 * 1.09) < 1e-9);
  });

  it("keeps a zoom-in and a zoom-out next to each other as two jumps", () => {
    const jumps = zoomJumps([measured(100, 1.2), measured(200, 0.9)]);
    assert.deepEqual(jumps, [
      { atMs: 100, scale: 1.2 },
      { atMs: 200, scale: 0.9 },
    ]);
  });

  it("ends a run at a cut: a pair that straddles a cut is not a jump and splits two jumps", () => {
    const jumps = zoomJumps([measured(100, 1.2), cut(200), measured(300, 1.2)]);
    assert.deepEqual(jumps, [
      { atMs: 100, scale: 1.2 },
      { atMs: 300, scale: 1.2 },
    ]);
  });

  it("is null when no pair was measured: the zoom is not measured, so it is not zero", () => {
    assert.equal(zoomJumps([cut(100), cut(200)]), null);
    assert.equal(zoomJumps([]), null);
  });

  it("is an empty list when the picture was measured and has no jump", () => {
    assert.deepEqual(zoomJumps([still(100), still(200), measured(300, 1.02)]), []);
  });
});

describe("the loop reading (Bible 8.1 endsOnLoop)", () => {
  it("is true when the last frame is within the threshold of the first, inclusive", () => {
    assert.equal(loopOf(0.01), true);
    assert.equal(loopOf(analyzeConfig.loopMaxDistance), true);
  });

  it("is false above the threshold", () => {
    assert.equal(loopOf(analyzeConfig.loopMaxDistance + 0.01), false);
    assert.equal(loopOf(0.24), false);
  });

  it("is null when no distance was measured", () => {
    assert.equal(loopOf(null), null);
  });
});
