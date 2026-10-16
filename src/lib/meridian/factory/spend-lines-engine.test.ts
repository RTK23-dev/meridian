import assert from "node:assert/strict";
import test from "node:test";
import { spendLinesOf } from "./spend-lines.ts";

test("engine actuals and engine calls with no actual yet are named in the run's spend, and the cap rule stays the last line", () => {
  const lines = spendLinesOf({
    pricedMicros: 0,
    pricedDecisions: 0,
    tokenOnlyDecisions: 0,
    tokens: 0,
    providerCents: 0,
    engineMicros: 1_250_000,
    enginePendingCalls: 2,
  });
  assert.ok(lines.some((line) => line === "The video engine's ledger records $1.250000 in actual cost. Caps count it with the rest."), lines.join(" | "));
  assert.ok(lines.some((line) => line.startsWith("2 video engine calls have no actual cost recorded yet.")), lines.join(" | "));
  assert.equal(lines.some((line) => line.startsWith("No metered spend yet")), false, "engine spend is spend, so no run reads as unmetered");
  assert.equal(lines.at(-1), "Unpriced spend is not counted by caps. A cap counts only priced cost.");
});

test("a run with no engine request names no engine spend", () => {
  const lines = spendLinesOf({ pricedMicros: 0, pricedDecisions: 0, tokenOnlyDecisions: 0, tokens: 0, providerCents: 0 });
  assert.ok(lines.some((line) => line.startsWith("No metered spend yet")));
  assert.equal(lines.some((line) => line.includes("video engine")), false);
});
