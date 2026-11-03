import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeBits, decodeField, lineAt, linesFromField, printFraction, printFractionFor, sampleIndex, PRINT_CURVES,
} from "../docs/design/prototype/meridian-map/map-model.mjs";
import { WORLD_FIELD } from "../docs/design/prototype/meridian-map/world-field.mjs";
import { WORLD_LINES } from "../docs/design/prototype/meridian-map/world-lines.mjs";

test("the depth lines rebuilt from the distance field are the published lines, cell for cell", () => {
  const field = decodeField(WORLD_FIELD.bits);
  const rebuilt = linesFromField(field, 720, 360, WORLD_LINES.step);
  const published = decodeBits(WORLD_LINES.bits);
  let mismatches = 0;
  for (let i = 0; i < 720 * 360; i += 1) if (lineAt(published, i) !== rebuilt[i]) mismatches += 1;
  assert.equal(mismatches, 0);
});

test("spacing changes the density of the lines, and wider spacing gives fewer lines", () => {
  const field = decodeField(WORLD_FIELD.bits);
  const share = (step) => linesFromField(field, 720, 360, step).reduce((a, b) => a + b, 0) / (720 * 360);
  assert.ok(share(6) > share(9) && share(9) > share(12) && share(12) > share(18));
  assert.ok(Math.abs(share(6) - 0.336) < 0.001, `six cells gives ${share(6)}`);
});

test("the default bill print is the published one, and each print curve starts at full print in the middle", () => {
  for (const y of [0, 200, 450, 700, 900]) {
    assert.equal(printFractionFor(y, 900), printFraction(y, 900), `y ${y}`);
  }
  for (const curve of PRINT_CURVES) {
    assert.equal(printFractionFor(450, 900, 0.6, curve), 1, `${curve} at the middle`);
    // With a band of 0.6 the print is gone 540 px from the middle, which is 90 px above the top of a 900 px window.
    assert.equal(printFractionFor(-90, 900, 0.6, curve), 0, `${curve} past the band`);
  }
});

test("a wider print band keeps a bill printed further from the middle", () => {
  assert.ok(printFractionFor(100, 900, 1, "smoothstep") > printFractionFor(100, 900, 0.4, "smoothstep"));
});

test("the default degrees per cell matches the explicit one, so the published map is unchanged", () => {
  for (const [c, r] of [[0, 0], [120, 40], [719, 224]]) {
    assert.equal(sampleIndex(c, r, 10, 360, 225), sampleIndex(c, r, 10, 360, 225, 720, 360, 0.5));
  }
});
