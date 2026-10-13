import assert from "node:assert/strict";
import test from "node:test";
import { LONG_CONTEXT_INPUT_TOKENS, OPENAI_PRICING_READ_ON, OPENAI_PRICING_URL, PRICE_TABLE_VERSION, TOKEN_PRICES, decisionCostMicros, tokenPriceFor } from "./price-table.ts";
import { spendLinesOf, usdOfMicros } from "./spend-lines.ts";

const LUNA = TOKEN_PRICES.find((entry) => entry.model === "gpt-6-luna");

test("the gpt-6-luna entry is the OpenAI pricing page's Standard rates, with its source and the date it was read", () => {
  assert.ok(LUNA, "gpt-6-luna has an entry");
  if (!LUNA) return;
  assert.deepEqual(LUNA.short, { input: 0.1, cachedInput: 0.01, output: 0.5 });
  assert.deepEqual(LUNA.long, { input: 0.2, cachedInput: 0.02, output: 0.75 });
  assert.equal(LUNA.sourceUrl, OPENAI_PRICING_URL);
  assert.equal(LUNA.readOn, OPENAI_PRICING_READ_ON);
  assert.equal(OPENAI_PRICING_READ_ON, "2026-10-13");
  assert.match(OPENAI_PRICING_URL, /^https:\/\/developers\.openai\.com\//);
  assert.match(PRICE_TABLE_VERSION, /2026-10-13/);
});

test("a decision's cost is its input and output tokens at the published rates, in micro-dollars", () => {
  if (!LUNA) return assert.fail("gpt-6-luna has an entry");
  // 1,000 input tokens at $0.10 per million is 100 micro-dollars; 100 output tokens at $0.50 per million is 50.
  assert.equal(decisionCostMicros(LUNA, { inputTokens: 1000, outputTokens: 100 }), 150);
  // Cached input tokens are part of the input. 8,000 at $0.10, 2,000 cached at $0.01, 1,000 output at $0.50: 800 + 20 + 500.
  assert.equal(decisionCostMicros(LUNA, { inputTokens: 10_000, cachedInputTokens: 2000, outputTokens: 1000 }), 1320);
  // A cached count larger than the input is held to the input.
  assert.equal(decisionCostMicros(LUNA, { inputTokens: 100, cachedInputTokens: 500, outputTokens: 0 }), 1);
});

test("a request with more than 272,000 input tokens is priced at the long-context rates, and not at or below it", () => {
  if (!LUNA) return assert.fail("gpt-6-luna has an entry");
  assert.equal(LONG_CONTEXT_INPUT_TOKENS, 272_000);
  assert.equal(decisionCostMicros(LUNA, { inputTokens: 272_000, outputTokens: 0 }), 27_200, "at the threshold the short rate applies");
  assert.equal(decisionCostMicros(LUNA, { inputTokens: 300_000, outputTokens: 1000 }), 60_750, "300,000 at $0.20 plus 1,000 at $0.75");
  assert.equal(decisionCostMicros(LUNA, { inputTokens: 272_001, outputTokens: 0 }), 54_400, "above it the long rate applies");
});

test("a price is found only for the engine and model the table names, and a dated snapshot of that model", () => {
  assert.ok(tokenPriceFor("openai-decisions", "gpt-6-luna", "gpt-6-luna"));
  assert.ok(tokenPriceFor("openai-decisions", "gpt-6-luna", null), "a model the provider did not report is the one asked for");
  assert.ok(tokenPriceFor("openai-decisions", null, "gpt-6-luna-2026-09-22"), "a dated snapshot is priced under its model");
  assert.equal(tokenPriceFor("openai-decisions", "gpt-6-luna", "gpt-6-luna-mini"), null, "a different model with the same prefix has no price");
  assert.equal(tokenPriceFor("openai-decisions", "gpt-6-luna", "gpt-6-luna-2026-9-22"), null, "a suffix that is not a date is not a snapshot");
  assert.equal(tokenPriceFor("openai-decisions", "gpt-6-sol", "gpt-6-sol"), null, "a model with no entry has no price");
  assert.equal(tokenPriceFor("jev", "gpt-6-luna", "gpt-6-luna"), null, "the same model name under another engine has no price");
  assert.equal(tokenPriceFor("openai-decisions", null, null), null, "a decision with no model named has no price");
});

test("spend lines say a priced decision in dollars, a decision with no price as tokens only, and what caps count", () => {
  assert.equal(usdOfMicros(750), "$0.000750");
  const priced = spendLinesOf({ pricedMicros: 750, pricedDecisions: 1, tokenOnlyDecisions: 0, tokens: 5500, providerCents: 0 });
  assert.ok(priced.some((line) => line === "Priced spend $0.000750 over 1 decision."), priced.join(" | "));
  assert.equal(priced.some((line) => /tokens only, not priced/.test(line)), false);

  const unpriced = spendLinesOf({ pricedMicros: 0, pricedDecisions: 0, tokenOnlyDecisions: 2, tokens: 900, providerCents: 0 });
  assert.ok(unpriced.some((line) => /^2 decisions: tokens only, not priced\./.test(line)), unpriced.join(" | "));
  assert.ok(unpriced.includes("Unpriced spend is not counted by caps. A cap counts only priced cost."), "the caps rule is always stated");
  assert.equal(unpriced.some((line) => /\$0\.0/.test(line)), false, "an unpriced decision never shows a dollar figure");

  const none = spendLinesOf({ pricedMicros: 0, pricedDecisions: 0, tokenOnlyDecisions: 0, tokens: 0, providerCents: 0 });
  assert.ok(none.some((line) => /No metered spend yet/.test(line)));
});
