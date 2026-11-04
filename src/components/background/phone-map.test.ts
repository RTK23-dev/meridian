import assert from "node:assert/strict";
import test from "node:test";
import { PHONE_MAP_MAX, PHONE_MAP_TRAVEL, phoneMapShift } from "./phone-map.ts";

test("the map is still at the top of the page, and when the page scrolls up", () => {
  assert.equal(phoneMapShift(0), 0);
  assert.equal(phoneMapShift(-40), 0);
  assert.equal(phoneMapShift(Number.NaN), 0);
});

test("the map moves up a quarter of the scroll, so it lags behind the text", () => {
  assert.equal(phoneMapShift(200), -200 * PHONE_MAP_TRAVEL);
  assert.ok(phoneMapShift(200) > -200, "it moves less than the page");
});

test("the map stops at the cap, so no gap opens at the bottom of the screen", () => {
  assert.equal(phoneMapShift(10_000), -PHONE_MAP_MAX);
  assert.equal(phoneMapShift(1_000_000), -PHONE_MAP_MAX);
});
