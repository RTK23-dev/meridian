import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startsBelowLine } from "../budget/line.ts";
import { lineOf, planAskNote } from "./envelope.ts";

describe("the run's line (owner direction 2026-10-23, D12)", () => {
  it("a plan's line is the lower of its own budget and the budget the user set", () => {
    assert.equal(lineOf(3, 2), 2);
    assert.equal(lineOf(2, 3), 2);
    assert.equal(lineOf(2, 2), 2);
  });

  it("the line is the budget itself: a spend at it has reached it, with no tolerance past it", () => {
    const line = lineOf(3, 0.5);
    assert.equal(startsBelowLine(0.5, line), false, "a spend at the line does not start a paid step");
    assert.equal(startsBelowLine(0.49, line), true);
  });

  it("a plan that asks for more than the user set gets a note that the run stops at the user's budget, and no note otherwise", () => {
    assert.equal(planAskNote(3, 2), "the plan asks for $3.0000; the run stops at the $2.0000 budget you set");
    assert.equal(planAskNote(2, 2), null);
    assert.equal(planAskNote(1, 2), null);
  });
});
