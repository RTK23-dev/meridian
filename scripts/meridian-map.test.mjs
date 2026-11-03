import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BAYER4, ROUTE, billWeight, decodeBits, latitudeAt, lineAt, loopLatitudes, printFraction, printed, sampleIndex,
} from "../docs/design/prototype/meridian-map/map-model.mjs";
import { WORLD_LINES } from "../docs/design/prototype/meridian-map/world-lines.mjs";

const lats = loopLatitudes();

test("the loop screen is a half turn of the map on from the first stop, so it shows the same part of the world", () => {
  assert.equal(lats.length, ROUTE.length + 1);
  assert.equal(lats[0], ROUTE[0].lat);
  assert.equal(lats[ROUTE.length], ROUTE[0].lat - 180);
  assert.equal(((lats[ROUTE.length] - lats[0]) % 180 + 180) % 180, 0);
});

test("the latitude is the stop's own at rest, moves in a line between stops, and holds at the ends", () => {
  assert.equal(latitudeAt(0, lats), lats[0]);
  assert.equal(latitudeAt(-3, lats), lats[0]);
  assert.equal(latitudeAt(1, lats), lats[1]);
  assert.equal(latitudeAt(2, lats), lats[2]);
  assert.ok(Math.abs(latitudeAt(0.5, lats) - (lats[0] + lats[1]) / 2) < 1e-9);
  assert.equal(latitudeAt(ROUTE.length, lats), lats[ROUTE.length]);
  assert.equal(latitudeAt(99, lats), lats[ROUTE.length]);
});

test("a map cell is always inside the map, and a half turn of longitude or latitude shows the same cell", () => {
  const cols = 180;
  const rows = 113;
  for (let c = 0; c < cols; c += 17) {
    for (let r = 0; r < rows; r += 13) {
      const index = sampleIndex(c, r, 10, cols, rows);
      assert.ok(index >= 0 && index < 720 * 360, `cell ${c},${r}`);
      assert.equal(sampleIndex(c + 720, r, 10, cols, rows), index, "a full turn of longitude is the same cell");
      assert.equal(sampleIndex(c, r, 10 + 180, cols, rows), index, "a half turn of latitude is the same cell");
    }
  }
});

test("the line bits are read most significant first, and round-trip through base64", () => {
  const bits = decodeBits(Buffer.from([0b10100001]).toString("base64"));
  assert.equal(bits.length, 1);
  assert.equal(lineAt(bits, 0), 1);
  assert.equal(lineAt(bits, 1), 0);
  assert.equal(lineAt(bits, 2), 1);
  assert.equal(lineAt(bits, 7), 1);
});

test("the depth map has one bit per cell, and its line count matches the count the build reported", () => {
  const bits = decodeBits(WORLD_LINES.bits);
  assert.equal(bits.length, (720 * 360) / 8);
  let set = 0;
  for (let i = 0; i < 720 * 360; i += 1) set += lineAt(bits, i);
  assert.equal(set, WORLD_LINES.lineCells);
  const share = set / (720 * 360);
  assert.ok(share > 0.05 && share < 0.3, `line share ${share.toFixed(3)} is a topographic density, not a solid fill`);
});

test("the bill's art is a border, an inner frame, a cross, and a light hatch, and nothing else", () => {
  const w = 75;
  const h = 30;
  const weights = new Set();
  let border = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const weight = billWeight(x, y, w, h);
      weights.add(weight);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        assert.equal(weight, 1, `edge ${x},${y}`);
        border += 1;
      }
    }
  }
  assert.equal(border, 2 * (w + h) - 4);
  assert.deepEqual([...weights].sort(), [0, 0.55, 1]);
  assert.equal(billWeight(Math.floor(w / 2), Math.floor(h / 2), w, h), 1, "the cross is at the centre");
});

test("the dither prints a dot only when the amount reaches its threshold, and never prints a dot outside the art", () => {
  assert.equal(BAYER4.length, 16);
  for (const threshold of BAYER4) {
    assert.equal(printed(threshold, 0, 1), false, "nothing is printed at zero");
    assert.equal(printed(threshold, 1, 1), true, "everything in the art is printed at full");
    assert.equal(printed(threshold, 1, 0), false, "nothing outside the art is printed");
  }
});

test("a bill is printed most in the middle of the screen, and less as it moves away from it", () => {
  const h = 900;
  assert.equal(printFraction(h / 2, h), 1);
  assert.equal(printFraction(h / 2 + 540, h), 0);
  assert.equal(printFraction(h / 2 - 540, h), 0);
  const near = printFraction(h / 2 + 100, h);
  const far = printFraction(h / 2 + 300, h);
  assert.ok(near > far && far > 0, "fraction falls as the bill moves away");
  assert.ok(Math.abs(printFraction(h / 2 + 200, h) - printFraction(h / 2 - 200, h)) < 1e-12, "symmetric above and below");
});
