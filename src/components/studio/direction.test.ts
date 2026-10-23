import assert from "node:assert/strict";
import test from "node:test";
import { alternativeDirections, briefableDirection, type DirectionCandidate } from "./direction.ts";

function candidate(overrides: Partial<DirectionCandidate>): DirectionCandidate {
  return { id: "opp_1", label: "Label", angle: "angle", source: "discovered", status: "open", expectedValue: 0.5, ...overrides };
}

test("a discovered open direction can be chosen to brief", () => {
  assert.equal(briefableDirection(candidate({})), true);
});

test("a starting idea is shown for comparison but cannot be briefed, even when open", () => {
  assert.equal(briefableDirection(candidate({ source: "prior" })), false);
});

test("a discovered direction that is no longer open cannot be briefed", () => {
  assert.equal(briefableDirection(candidate({ status: "accepted" })), false);
  assert.equal(briefableDirection(candidate({ status: "dismissed" })), false);
});

test("alternatives leave out the recommendation and closed items, highest value first", () => {
  const list = [
    candidate({ id: "recommended", expectedValue: 0.9 }),
    candidate({ id: "low", expectedValue: 0.2 }),
    candidate({ id: "closed", expectedValue: 0.8, status: "dismissed" }),
    candidate({ id: "high", expectedValue: 0.6 }),
  ];
  assert.deepEqual(
    alternativeDirections(list, "recommended").map((item) => item.id),
    ["high", "low"],
  );
});
