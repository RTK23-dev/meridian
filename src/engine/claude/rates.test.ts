import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { claudeRates, estimateClaudeUsd } from "./rates.ts";

describe("Claude token rates (Bible 11.1)", () => {
  it("carries the Opus, Sonnet and Haiku rates the Bible states", () => {
    assert.deepEqual(claudeRates["anthropic/claude-opus-5.5"], { inputUsdPerMillion: 4, outputUsdPerMillion: 20 });
    assert.deepEqual(claudeRates["anthropic/claude-sonnet-5.5"], { inputUsdPerMillion: 2, outputUsdPerMillion: 10 });
    assert.deepEqual(claudeRates["anthropic/claude-haiku-5.5"], { inputUsdPerMillion: 1, outputUsdPerMillion: 5 });
  });

  it("prices a call in USD with 4 decimals", () => {
    assert.equal(estimateClaudeUsd("anthropic/claude-sonnet-5.5", { input: 26000, output: 3000 }), 0.082);
    assert.equal(estimateClaudeUsd("anthropic/claude-haiku-5.5", { input: 1000, output: 200 }), 0.002);
    assert.equal(estimateClaudeUsd("anthropic/claude-opus-5.5", { input: 8000, output: 1000 }), 0.052);
  });

  it("refuses a model with no rate, and never returns 0 for it", () => {
    for (const model of ["vendor/unknown", "constructor", "__proto__"]) {
      assert.throws(
        () => estimateClaudeUsd(model, { input: 1, output: 1 }),
        (error: unknown) => error instanceof EngineError && error.kind === "unknown_price",
        model,
      );
    }
  });
});
