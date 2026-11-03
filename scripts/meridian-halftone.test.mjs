import assert from "node:assert/strict";
import { test } from "node:test";
import { HALFTONE_DEFAULTS, drawHalftone, inkAt, sampleField } from "../docs/design/prototype/meridian-map/halftone.mjs";

// A canvas context that records what is drawn, so the blocks can be counted and measured without a browser.
function recordingContext() {
  const log = { background: null, fills: [] };
  let alpha = 1;
  let style = null;
  let path = [];
  return {
    log,
    set fillStyle(value) { style = value; },
    get fillStyle() { return style; },
    set globalAlpha(value) { alpha = value; },
    get globalAlpha() { return alpha; },
    fillRect(x, y, w, h) { log.background = { x, y, w, h, style }; },
    beginPath() { path = []; },
    rect(x, y, w, h) { path.push({ x, y, w, h }); },
    fill() { log.fills.push({ alpha, rects: path }); },
  };
}
const palette = { bg: "#0B0B0C", line: "#1C1C1F" };
const allRects = (log) => log.fills.flatMap((f) => f.rects);

test("the ink follows the bands: full at each crest, none halfway between, and within 0 and 1 everywhere", () => {
  for (const d of [0, 12, -24, 36]) assert.ok(Math.abs(inkAt(d, 12, 2) - 1) < 1e-12, `crest at ${d}`);
  for (const d of [6, -18, 30]) assert.ok(Math.abs(inkAt(d, 12, 2)) < 1e-12, `trough at ${d}`);
  for (let d = -60; d <= 60; d += 0.37) {
    const ink = inkAt(d, 12, 2);
    assert.ok(ink >= 0 && ink <= 1, `ink ${ink} at ${d}`);
  }
});

test("a sharper band keeps less ink away from its crest", () => {
  assert.ok(inkAt(3, 12, 4) < inkAt(3, 12, 1));
  assert.equal(inkAt(0, 12, 4), 1);
});

test("the field is sampled between cells, and its columns wrap round the world", () => {
  const field = new Int8Array(720 * 360);
  for (let i = 0; i < field.length; i += 1) field[i] = ((i * 7) % 61) - 30;
  assert.equal(sampleField(field, 5, 7), field[7 * 720 + 5]);
  assert.equal(sampleField(field, 5.5, 7), (field[7 * 720 + 5] + field[7 * 720 + 6]) / 2);
  assert.equal(sampleField(field, -0.5, 10), sampleField(field, 719.5, 10));
  assert.equal(sampleField(field, 720, 10), sampleField(field, 0, 10));
});

test("the field is held at the poles, so a row past either pole reads the edge row", () => {
  const field = new Int8Array(720 * 360);
  for (let i = 0; i < field.length; i += 1) field[i] = ((i * 11) % 53) - 20;
  assert.equal(sampleField(field, 100, -3), sampleField(field, 100, 0));
  assert.equal(sampleField(field, 100, 500), sampleField(field, 100, 359));
});

test("a flat field of crests draws every block at the full size, and nothing is left out", () => {
  const ctx = recordingContext();
  const field = new Int8Array(720 * 360);
  const view = { width: 240, height: 120, centreLat: 0, zoom: 8 };
  const { blocks, coverage } = drawHalftone(ctx, field, view, HALFTONE_DEFAULTS, palette);
  const side = HALFTONE_DEFAULTS.pitch * HALFTONE_DEFAULTS.block;
  const rects = allRects(ctx.log);
  const cells = Math.ceil(240 / HALFTONE_DEFAULTS.pitch) * Math.ceil(120 / HALFTONE_DEFAULTS.pitch);
  assert.equal(blocks, cells);
  assert.equal(rects.length, cells);
  for (const r of rects) assert.ok(Math.abs(r.w - side) < 1e-9 && Math.abs(r.h - side) < 1e-9, `side ${r.w}`);
  assert.ok(Math.abs(coverage - (side * side) / (HALFTONE_DEFAULTS.pitch ** 2)) < 1e-9, `coverage ${coverage}`);
  assert.deepEqual(ctx.log.background, { x: 0, y: 0, w: 240, h: 120, style: palette.bg });
});

test("the blocks shrink with the tone: a square's side follows the square root of its ink", () => {
  const ctx = recordingContext();
  const distance = 3;
  const field = new Int8Array(720 * 360).fill(distance);
  const ink = inkAt(distance, HALFTONE_DEFAULTS.step, HALFTONE_DEFAULTS.sharp);
  const side = HALFTONE_DEFAULTS.pitch * HALFTONE_DEFAULTS.block * Math.sqrt(ink);
  const cells = Math.ceil(120 / HALFTONE_DEFAULTS.pitch) * Math.ceil(60 / HALFTONE_DEFAULTS.pitch);
  const { blocks, coverage } = drawHalftone(ctx, field, { width: 120, height: 60, centreLat: 0, zoom: 8 }, HALFTONE_DEFAULTS, palette);
  assert.equal(blocks, cells);
  for (const r of allRects(ctx.log)) assert.ok(Math.abs(r.w - side) < 1e-9, `side ${r.w}`);
  assert.ok(Math.abs(coverage - (cells * side * side) / (120 * 60)) < 1e-9, `coverage ${coverage}`);
  assert.ok(side < HALFTONE_DEFAULTS.pitch * HALFTONE_DEFAULTS.block, "smaller than a full block");
});

test("a field halfway between two crests draws no blocks at all", () => {
  const ctx = recordingContext();
  const field = new Int8Array(720 * 360).fill(Math.round(HALFTONE_DEFAULTS.step / 2));
  const { blocks, coverage } = drawHalftone(ctx, field, { width: 120, height: 60, centreLat: 0, zoom: 8 }, HALFTONE_DEFAULTS, palette);
  assert.equal(blocks, 0);
  assert.equal(coverage, 0);
  assert.equal(allRects(ctx.log).length, 0);
});

test("each block's opacity varies a little, from block to block, in eight steps", () => {
  const ctx = recordingContext();
  const field = new Int8Array(720 * 360);
  drawHalftone(ctx, field, { width: 240, height: 120, centreLat: 0, zoom: 8 }, HALFTONE_DEFAULTS, palette);
  const alphas = new Set(ctx.log.fills.map((f) => f.alpha));
  assert.ok(alphas.size > 1, "more than one opacity");
  assert.ok(alphas.size <= 8, `at most eight opacities, got ${alphas.size}`);
  for (const a of alphas) assert.ok(a > 0 && a <= 1, `opacity ${a}`);
});

test("drawing the same view twice gives the same blocks, so the picture does not shimmer between frames", () => {
  const field = new Int8Array(720 * 360);
  for (let i = 0; i < field.length; i += 1) field[i] = ((i * 13) % 41) - 20;
  const view = { width: 300, height: 180, centreLat: 23, zoom: 8 };
  const first = recordingContext();
  const second = recordingContext();
  const a = drawHalftone(first, field, view, HALFTONE_DEFAULTS, palette);
  const b = drawHalftone(second, field, view, HALFTONE_DEFAULTS, palette);
  assert.deepEqual(a, b);
  assert.deepEqual(first.log, second.log);
});
