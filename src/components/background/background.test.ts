import assert from "node:assert/strict";
import test from "node:test";
import { HALFTONE_DEFAULTS, drawHalftone, inkAt, sampleField } from "./halftone.ts";
import { STOP_LATITUDES, decodeField, GLIDE, CELL_DEG } from "./map-model.ts";
import { WORLD_FIELD_BITS, WORLD_FIELD_HEIGHT, WORLD_FIELD_WIDTH } from "./world-field.ts";
import { stopForPath } from "./stops.ts";

// A canvas context that records what is drawn, so the blocks can be counted and measured without a browser.
function recordingContext() {
  const log: { background: unknown; fills: Array<{ alpha: number; rects: Array<{ x: number; y: number; w: number; h: number }> }> } = { background: null, fills: [] };
  let alpha = 1;
  let style: unknown = null;
  let path: Array<{ x: number; y: number; w: number; h: number }> = [];
  const ctx = {
    set fillStyle(value: unknown) { style = value; },
    get fillStyle() { return style; },
    set globalAlpha(value: number) { alpha = value; },
    get globalAlpha() { return alpha; },
    fillRect(x: number, y: number, w: number, h: number) { log.background = { x, y, w, h, style }; },
    beginPath() { path = []; },
    rect(x: number, y: number, w: number, h: number) { path.push({ x, y, w, h }); },
    fill() { log.fills.push({ alpha, rects: path }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}
const palette = { bg: "#0B0B0C", line: "#1C1C1F" };
const allRects = (log: ReturnType<typeof recordingContext>["log"]) => log.fills.flatMap((f) => f.rects);
const flat = (value: number) => new Int8Array(WORLD_FIELD_WIDTH * WORLD_FIELD_HEIGHT).fill(value);

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
});

test("the field is sampled between cells, and its columns wrap round the world", () => {
  const field = new Int8Array(WORLD_FIELD_WIDTH * WORLD_FIELD_HEIGHT);
  for (let i = 0; i < field.length; i += 1) field[i] = ((i * 7) % 61) - 30;
  assert.equal(sampleField(field, 5, 7), field[7 * 720 + 5]);
  assert.equal(sampleField(field, 5.5, 7), (field[7 * 720 + 5] + field[7 * 720 + 6]) / 2);
  assert.equal(sampleField(field, -0.5, 10), sampleField(field, 719.5, 10));
  assert.equal(sampleField(field, 720, 10), sampleField(field, 0, 10));
});

test("the field is held at the poles, so a row past either pole reads the edge row", () => {
  const field = new Int8Array(WORLD_FIELD_WIDTH * WORLD_FIELD_HEIGHT);
  for (let i = 0; i < field.length; i += 1) field[i] = ((i * 11) % 53) - 20;
  assert.equal(sampleField(field, 100, -3), sampleField(field, 100, 0));
  assert.equal(sampleField(field, 100, 500), sampleField(field, 100, 359));
});

test("the published field decodes to one signed byte per cell, for the whole world", () => {
  const field = decodeField(WORLD_FIELD_BITS);
  assert.equal(field.length, WORLD_FIELD_WIDTH * WORLD_FIELD_HEIGHT);
  assert.equal(WORLD_FIELD_WIDTH * CELL_DEG, 360, "720 half-degree cells cover the longitudes");
  assert.equal(WORLD_FIELD_HEIGHT * CELL_DEG, 180, "360 half-degree cells cover the latitudes");
  assert.ok(field.some((value) => value < 0) && field.some((value) => value > 0), "land and sea both appear");
});

test("a flat field of crests draws every block at the full size, and nothing is left out", () => {
  const { ctx, log } = recordingContext();
  const view = { width: 240, height: 120, centreLat: 0, zoom: 8 };
  const { blocks, coverage } = drawHalftone(ctx, flat(0), view, HALFTONE_DEFAULTS, palette);
  const side = HALFTONE_DEFAULTS.pitch * HALFTONE_DEFAULTS.block;
  const cells = Math.ceil(240 / HALFTONE_DEFAULTS.pitch) * Math.ceil(120 / HALFTONE_DEFAULTS.pitch);
  assert.equal(blocks, cells);
  assert.equal(allRects(log).length, cells);
  for (const r of allRects(log)) assert.ok(Math.abs(r.w - side) < 1e-9 && Math.abs(r.h - side) < 1e-9, `side ${r.w}`);
  assert.ok(Math.abs(coverage - (side * side) / (HALFTONE_DEFAULTS.pitch ** 2)) < 1e-9, `coverage ${coverage}`);
  assert.deepEqual(log.background, { x: 0, y: 0, w: 240, h: 120, style: palette.bg });
});

test("the blocks shrink with the tone: a square's side follows the square root of its ink", () => {
  const { ctx, log } = recordingContext();
  const distance = 3;
  const ink = inkAt(distance, HALFTONE_DEFAULTS.step, HALFTONE_DEFAULTS.sharp);
  const side = HALFTONE_DEFAULTS.pitch * HALFTONE_DEFAULTS.block * Math.sqrt(ink);
  const cells = Math.ceil(120 / HALFTONE_DEFAULTS.pitch) * Math.ceil(60 / HALFTONE_DEFAULTS.pitch);
  const { blocks } = drawHalftone(ctx, flat(distance), { width: 120, height: 60, centreLat: 0, zoom: 8 }, HALFTONE_DEFAULTS, palette);
  assert.equal(blocks, cells);
  for (const r of allRects(log)) assert.ok(Math.abs(r.w - side) < 1e-9, `side ${r.w}`);
  assert.ok(side < HALFTONE_DEFAULTS.pitch * HALFTONE_DEFAULTS.block, "smaller than a full block");
});

test("a field halfway between two crests draws no blocks at all", () => {
  const { ctx, log } = recordingContext();
  const { blocks, coverage } = drawHalftone(ctx, flat(Math.round(HALFTONE_DEFAULTS.step / 2)), { width: 120, height: 60, centreLat: 0, zoom: 8 }, HALFTONE_DEFAULTS, palette);
  assert.equal(blocks, 0);
  assert.equal(coverage, 0);
  assert.equal(allRects(log).length, 0);
});

test("each block's opacity varies a little, from block to block, in at most eight steps", () => {
  const { ctx, log } = recordingContext();
  drawHalftone(ctx, new Int8Array(WORLD_FIELD_WIDTH * WORLD_FIELD_HEIGHT), { width: 240, height: 120, centreLat: 0, zoom: 8 }, HALFTONE_DEFAULTS, palette);
  const alphas = new Set(log.fills.map((f) => f.alpha));
  assert.ok(alphas.size > 1, "more than one opacity");
  assert.ok(alphas.size <= 8, `at most eight opacities, got ${alphas.size}`);
  for (const a of alphas) assert.ok(a > 0 && a <= 1, `opacity ${a}`);
});

test("the glide closes a fixed share of the gap each frame, and the stops are the five places' latitudes", () => {
  assert.ok(GLIDE > 0 && GLIDE <= 1);
  assert.deepEqual(Object.values(STOP_LATITUDES), [47, 23, 0, -23, -41]);
});

test("a page is drawn at its place's stop, and a page outside the places at the first stop", () => {
  assert.equal(stopForPath("/"), "cover", "the workspace overview is Home");
  assert.equal(stopForPath("/alerts"), "cover", "Alerts is under Home");
  assert.equal(stopForPath("/content-factory"), "create");
  assert.equal(stopForPath("/exports"), "library");
  assert.equal(stopForPath("/brands/b1/market"), "insights");
  assert.equal(stopForPath("/billing"), "settings");
  assert.equal(stopForPath("/login"), "cover", "the sign-in page sits at the first stop");
  assert.equal(stopForPath("/product"), "cover");
});
