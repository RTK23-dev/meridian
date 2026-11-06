import assert from "node:assert/strict";
import test from "node:test";
import { journeyPosition, scrollTravel } from "./scroll-journey.ts";
import { journeyPoint } from "./halftone.ts";

test("at the top of a page the map is at the page's stop, and scrolling up or no scroll leaves it there", () => {
  assert.equal(journeyPosition(-41, 0, 8), -41);
  assert.equal(journeyPosition(-41, -40, 8), -41);
  assert.equal(journeyPosition(-41, Number.NaN, 8), -41);
});

test("the map moves with the page one to one, all the way down: it never stops while the page still scrolls", () => {
  assert.equal(scrollTravel(8, 8), 1, "8 px of scroll is one degree at 8 px per degree");
  const positions = [0, 400, 4_000, 40_000].map((top) => journeyPosition(23, top, 8));
  for (let i = 1; i < positions.length; i += 1) assert.ok(positions[i] < positions[i - 1], `still moving at ${i}`);
  assert.equal(journeyPosition(23, 40_000, 8), 23 - 5_000);
});

test("past a pole the journey carries on down the far side of the world, without a jump", () => {
  // Just before and just after the South Pole, a point on the line is next to the pole on both sides.
  assert.deepEqual(journeyPoint(-89.5, 0), { lat: -89.5, lon: 0 });
  assert.deepEqual(journeyPoint(-90.5, 0), { lat: -89.5, lon: 180 });
  // A point to the right of the line stays in the same half of the world across the pole.
  assert.equal(journeyPoint(-89.9, 10).lon, 10);
  assert.equal(journeyPoint(-90.1, 10).lon, 170);
  // Going on, the journey climbs the far side, crosses the North Pole and comes back to the near side.
  assert.deepEqual(journeyPoint(-180, 0), { lat: 0, lon: 180 });
  assert.deepEqual(journeyPoint(-270.5, 5), { lat: 89.5, lon: 5 });
  assert.deepEqual(journeyPoint(47 - 360, 0), journeyPoint(47, 0), "a full circle is the same place");
});
