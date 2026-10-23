import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { categoryOf } from "./categories.ts";
import { loadCatalog } from "./catalog.ts";
import { orchestratorPlanSchema } from "./contracts.ts";
import { envelopeAt } from "./envelope.ts";
import { validatePlan, type ValidateOptions } from "./validate.ts";

const sample = orchestratorPlanSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/sample-plan.json", import.meta.url), "utf8")));
const catalog = loadCatalog(JSON.parse(readFileSync(new URL("./fixtures/openrouter-catalog-2026-10-20.json", import.meta.url), "utf8"))).byId;

/** The sample plan checked with the given options. The sample plan must check: the tests read its own prices. */
function checkedWith(options: ValidateOptions = {}) {
  const result = validatePlan(sample, catalog, options);
  if (!result.ok) throw new Error(`the sample plan must validate: ${result.reasons.join("; ")}`);
  return result;
}

/** What the plan's steps of one category cost, from the engine's own prices (the checked plan's estimates). */
function costOf(category: "copy" | "creative" | "voice"): number {
  return checkedWith().plan.nodes.reduce((sum, node) => (categoryOf(node.kind) === category ? sum + (node.estimateUsd ?? 0) : sum), 0);
}

describe("the validator's per-category sums (owner direction 2026-10-23, D3)", () => {
  it("a category the brief sets is summed from its own steps and placed against its own budget", () => {
    const copy = costOf("copy");
    assert.ok(copy > 0.01, "the sample plan has copy steps that cost more than a cent");
    const view = checkedWith({ categories: { copy: envelopeAt(copy) } }).categories.find((entry) => entry.category === "copy");
    assert.ok(view);
    assert.ok(Math.abs(view.estimateUsd - copy) < 1e-9, `the copy sum is ${view.estimateUsd}, expected ${copy}`);
    assert.equal(view.position, "within_target");
  });

  it("one cent over a category's budget is within its tolerance, so it is not a stop", () => {
    const copy = costOf("copy");
    const view = checkedWith({ categories: { copy: envelopeAt(copy - 0.01) } }).categories.find((entry) => entry.category === "copy");
    assert.equal(view?.position, "within_tolerance");
  });

  it("past a category's allowance the plan is still a plan, and the category needs an approval", () => {
    const copy = costOf("copy");
    const strict = { percent: 0, cents: 0 };
    const result = checkedWith({ categories: { copy: envelopeAt(copy - 0.01, strict) } });
    assert.equal(result.categories.find((entry) => entry.category === "copy")?.position, "needs_approval");
  });

  it("a category the brief does not set has no view of its own: the total applies to its steps (delegated)", () => {
    const result = checkedWith({ categories: { copy: envelopeAt(costOf("copy")) } });
    assert.deepEqual(
      result.categories.map((entry) => entry.category),
      ["copy"],
    );
  });

  it("with no category budgets the plan carries no category views", () => {
    assert.deepEqual(checkedWith().categories, []);
  });
});
