import assert from "node:assert/strict";
import test from "node:test";
import type { WhitespaceOpportunity } from "@/lib/meridian/jev/account-engine";
import { rankWhitespace } from "./whitespace-rank.ts";

function opportunity(angle: string, expectedWinProbability: number): WhitespaceOpportunity {
  return { unsaturatedAngle: angle, expectedWinProbability } as unknown as WhitespaceOpportunity;
}

test("the highest expected win probability ranks first, and an unknown value ranks last, never as zero", () => {
  const ranked = rankWhitespace([opportunity("low", 0.1), opportunity("unknown", Number.NaN), opportunity("high", 0.9)]);
  assert.deepEqual(ranked.map((item) => item.unsaturatedAngle), ["high", "low", "unknown"]);
});

test("equal probabilities are ordered by angle, and the input is not reordered in place", () => {
  const input = [opportunity("b", 0.5), opportunity("a", 0.5)];
  const ranked = rankWhitespace(input);
  assert.deepEqual(ranked.map((item) => item.unsaturatedAngle), ["a", "b"]);
  assert.deepEqual(input.map((item) => item.unsaturatedAngle), ["b", "a"]);
});
