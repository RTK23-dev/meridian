import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { usdSchema } from "../contracts/money.ts";
import { claudeRates, estimateClaudeUsd, estimateFromPriceUsd } from "./rates.ts";

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

describe("live-priced estimates round up to the ledger's four decimals", () => {
  it("rounds an estimate with a fifth or sixth decimal up to four, so the reservation accepts it", () => {
    // 1640 tokens at $0.000004 is $0.00656, which is 65.6 ten-thousandths, so it rounds up to $0.0066.
    const sixDecimals = estimateFromPriceUsd({ promptUsdPerToken: 0.000004, completionUsdPerToken: 0 }, { input: 1640, output: 0 });
    assert.equal(sixDecimals, 0.0066);
    // 8001 input tokens at $0.0000001 plus 4000 output tokens at $0.0000005 is $0.0028001, which is 28.001 ten-thousandths, so $0.0029.
    const mixed = estimateFromPriceUsd(
      { promptUsdPerToken: 0.0000001, completionUsdPerToken: 0.0000005 },
      { input: 8001, output: 4000 },
    );
    assert.equal(mixed, 0.0029);
    for (const usd of [sixDecimals, mixed]) assert.equal(usdSchema.safeParse(usd).success, true, String(usd));
  });

  it("never returns 0 for a paid call: a tiny positive estimate is at least $0.0001", () => {
    // 1 token at $0.00000001 is 0.0001 ten-thousandths, which rounds up to one unit.
    const tiny = estimateFromPriceUsd({ promptUsdPerToken: 0.00000001, completionUsdPerToken: 0 }, { input: 1, output: 0 });
    assert.equal(tiny, 0.0001);
    assert.equal(usdSchema.safeParse(tiny).success, true);
  });

  it("refuses a negative price, so the estimate never guesses", () => {
    assert.throws(
      () => estimateFromPriceUsd({ promptUsdPerToken: -0.000001, completionUsdPerToken: 0.000002 }, { input: 1, output: 1 }),
      (error: unknown) => error instanceof EngineError && error.kind === "unknown_price",
    );
  });
});
