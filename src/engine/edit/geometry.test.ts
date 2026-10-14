import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assumedFaceRect, captionBandRect, pixelBoxToRect, rectsOverlap, touchesUnsafeZone } from "./geometry.ts";
import { EDIT_TUNING } from "./tuning.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, "..", "compose", "components", "captions.karaoke", "component.html");

test("every caption band sits inside the safe zones (Bible 8.3)", () => {
  for (const band of ["upper", "middle", "lower"] as const) {
    assert.equal(touchesUnsafeZone(captionBandRect(band)), false, `the ${band} band is clear of the margins`);
  }
});

test("a rectangle is unsafe when it reaches the top 10%, the bottom 20% or the right 12%", () => {
  assert.equal(touchesUnsafeZone({ x: 0.1, y: 0.05, w: 0.5, h: 0.05 }), true, "top");
  assert.equal(touchesUnsafeZone({ x: 0.1, y: 0.7, w: 0.5, h: 0.12 }), true, "bottom, the bottom edge at 0.82");
  assert.equal(touchesUnsafeZone({ x: 0.5, y: 0.5, w: 0.45, h: 0.1 }), true, "right, the right edge at 0.95");
  assert.equal(touchesUnsafeZone({ x: 0.06, y: 0.1, w: 0.82, h: 0.7 }), false, "the edges exactly on the limits are inside");
});

test("two rectangles overlap only when they share area; touching edges do not count", () => {
  const middle = captionBandRect("middle");
  assert.equal(rectsOverlap(middle, assumedFaceRect()), true, "the middle band (47%) is inside the assumed face area (10% to 50%)");
  assert.equal(rectsOverlap(captionBandRect("lower"), assumedFaceRect()), false, "the lower band is under the face area");
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }), false, "shared edge only");
});

test("a pixel box becomes fractions of the 1080 x 1920 frame", () => {
  assert.deepEqual(pixelBoxToRect({ x: 108, y: 192, w: 540, h: 960 }), { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
});

test("the caption layout numbers match the captions.karaoke template (a drift fails this test)", () => {
  const template = readFileSync(TEMPLATE, "utf8");
  const geometry = EDIT_TUNING.geometry;
  const percent = (share: number): string => `${Math.round(share * 1000) / 10}%`;
  assert.ok(template.includes(`left: ${percent(geometry.captionLeftShare)};`), "left");
  assert.ok(template.includes(`width: ${percent(geometry.captionWidthShare)};`), "width");
  assert.ok(template.includes(`.kc-band-upper .kc-caption { top: ${percent(geometry.captionTopShare.upper)}; }`), "upper band top");
  assert.ok(template.includes(`.kc-band-middle .kc-caption { top: ${percent(geometry.captionTopShare.middle)}; }`), "middle band top");
  assert.ok(template.includes(`.kc-band-lower .kc-caption { top: ${percent(geometry.captionTopShare.lower)}; }`), "lower band top");
  const fontSize = /font-size: (\d+)px;/.exec(template)?.[1];
  const lineHeight = /line-height: ([\d.]+);/.exec(template)?.[1];
  assert.ok(fontSize !== undefined && lineHeight !== undefined, "the template states the font size and line height");
  const oneLine = (Number(fontSize) * Number(lineHeight)) / 1920;
  assert.ok(geometry.captionHeightShare >= oneLine, `the box height ${geometry.captionHeightShare} holds one line of ${oneLine.toFixed(4)}`);
});
