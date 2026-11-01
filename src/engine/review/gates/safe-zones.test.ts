import assert from "node:assert/strict";
import test from "node:test";
import { validateReelsSafeZones } from "./safe-zones.ts";

test("validateReelsSafeZones detects text clipping in Instagram overlay zones", () => {
  // Test case 1: Top header violation (y < 0.12)
  const topViolation = validateReelsSafeZones([
    {
      text: "Title in top header",
      box: { x: 0.2, y: 0.05, width: 0.5, height: 0.05 },
    },
  ]);
  assert.equal(topViolation.isSafe, false);
  assert.equal(topViolation.violations[0].zone, "top_header");

  // Test case 2: Bottom controls violation (y + height > 0.78)
  const bottomViolation = validateReelsSafeZones([
    {
      text: "Caption in bottom bar",
      box: { x: 0.2, y: 0.76, width: 0.5, height: 0.08 },
    },
  ]);
  assert.equal(bottomViolation.isSafe, false);
  assert.equal(bottomViolation.violations[0].zone, "bottom_controls");

  // Test case 3: Right rail violation (x + width > 0.86)
  const rightViolation = validateReelsSafeZones([
    {
      text: "Sticker in right buttons",
      box: { x: 0.82, y: 0.4, width: 0.15, height: 0.1 },
    },
  ]);
  assert.equal(rightViolation.isSafe, false);
  assert.equal(rightViolation.violations[0].zone, "right_action_rail");

  // Test case 4: Perfectly safe central placement
  const safeOverlay = validateReelsSafeZones([
    {
      text: "Centered punchline",
      box: { x: 0.2, y: 0.35, width: 0.6, height: 0.1 },
    },
  ]);
  assert.equal(safeOverlay.isSafe, true);
  assert.equal(safeOverlay.violations.length, 0);
});
