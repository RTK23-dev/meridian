// The server's bound on a text step's input (review 2026-10-22, item 3): a model's own input_tokens figure may raise a text step's price, never
// lower it. Pure: the catalog is the recorded fixture, and no call is made.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadCatalog } from "./catalog.ts";
import { examplePlan } from "./example.ts";
import { priceStep, textInputTokensOf } from "./validate.ts";

const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;

test("a text step is priced at no less than the server's bound, whatever input_tokens the model wrote", () => {
  const analysis = examplePlan.nodes.find((node) => node.kind === "analysis");
  assert.ok(analysis?.model, "the example plan has an analysis step with a model");
  const entry = catalog.get(analysis.model.id);
  assert.ok(entry, "the model is in the recorded catalog");
  const understated = { ...analysis, params: { ...analysis.params, input_tokens: 10 } };
  const claimed = priceStep(understated, entry);
  const bounded = priceStep(understated, entry, { textInputTokens: 50_000 });
  assert.ok("usd" in claimed && "usd" in bounded);
  if (!("usd" in claimed) || !("usd" in bounded)) return;
  assert.ok(bounded.usd > claimed.usd, "the server's bound raises an understated price");
  const larger = priceStep({ ...analysis, params: { ...analysis.params, input_tokens: 90_000 } }, entry, { textInputTokens: 50_000 });
  assert.ok("usd" in larger && "usd" in claimed && larger.usd > bounded.usd, "a larger figure the model wrote is not cut down to the bound");
});

test("the server's bound is the brief's size plus its instructions, and never more than the largest input a step may send", () => {
  const small = textInputTokensOf({ goal: "a short brief" });
  const large = textInputTokensOf({ goal: "x".repeat(60_000) });
  assert.ok(small >= 1000 && small < 2000, "a short brief is its instructions and a little more");
  assert.ok(large > small, "a longer brief is bounded higher");
  assert.equal(textInputTokensOf({ goal: "x".repeat(10_000_000) }), 200_000, "never above the largest input a step may send");
});
