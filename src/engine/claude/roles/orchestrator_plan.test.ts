import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadPrompt } from "../../prompts/load.ts";
import { orchestratorBriefSchema, orchestratorPlan, orchestratorPlanInputSchema, orchestratorUserContent, type OrchestratorPlanInput } from "./orchestrator_plan.ts";

const input: OrchestratorPlanInput = {
  brief: {
    goal: "A 15 second product video",
    format: "a hook, a product shot, a call to action",
    userInputs: "the product is a water bottle",
    brand: { name: "Example", summary: "calm, blue, plain type" },
    budgetUsd: 2,
  },
  orchestratorModelId: "anthropic/claude-haiku-5.5",
  candidates: [{ id: "black-forest-labs/flux.2-pro", name: "FLUX.2 Pro", kind: "image" }],
};

describe("orchestrator_plan role", () => {
  it("runs on the direction tier at the plan stage, against orchestrator_plan@3, which has the four prompt parts", () => {
    assert.equal(orchestratorPlan.role, "orchestrator_plan");
    assert.equal(orchestratorPlan.capability, "llm.direction");
    assert.equal(orchestratorPlan.stage, "plan");
    const prompt = loadPrompt(orchestratorPlan.prompt);
    assert.equal(prompt.id, "orchestrator_plan@3");
    assert.match(prompt.text, /params\.model_class/, "the video class is named in the rules");
    assert.match(prompt.text, /copyBudgetUsd/, "the category budgets are named in the rules, so the split is delegated to the orchestrator");
    for (const heading of ["## Role and rules", "## Reference material", "## Task input", "## Output contract"]) {
      assert.match(prompt.text, new RegExp(`^${heading}$`, "m"));
    }
  });

  it("takes optional category budgets: each is a positive amount, and a category the user leaves unset is absent from the brief", () => {
    const set = orchestratorBriefSchema.parse({ ...input.brief, copyBudgetUsd: 0.5, creativeBudgetUsd: 1.25 });
    assert.equal(set.copyBudgetUsd, 0.5);
    assert.equal(set.voiceBudgetUsd, undefined);
    assert.equal(orchestratorBriefSchema.safeParse({ ...input.brief, copyBudgetUsd: 0 }).success, false);
    assert.equal(orchestratorBriefSchema.safeParse({ ...input.brief, voiceBudgetUsd: -1 }).success, false);
    assert.doesNotMatch(JSON.stringify(orchestratorUserContent(input)), /copyBudgetUsd/, "an unset category is not in the brief the orchestrator reads");
    const shown = orchestratorUserContent({ ...input, brief: { ...input.brief, copyBudgetUsd: 0.5 } });
    const text = shown.map((part) => ("text" in part ? part.text : "")).join("\n");
    assert.match(text, /"copyBudgetUsd":0\.5/);
  });

  it("takes a brief, the orchestrating model's id and at most 160 candidates", () => {
    assert.ok(orchestratorPlanInputSchema.safeParse(input).success);
    assert.equal(orchestratorPlanInputSchema.safeParse({ ...input, candidates: [] }).success, false);
  });

  it("answers only a plan that names the orchestrating model that was asked for", () => {
    const plan = {
      version: "orchestrator-plan@1",
      orchestrator: { provider: "openrouter", id: "anthropic/claude-haiku-5.5" },
      budgetUsd: 2,
      nodes: [{ id: "ref", kind: "reference", title: "Reference", why: "The upload.", dependsOn: [], model: null, params: {}, estimateUsd: null }],
    };
    assert.ok(orchestratorPlan.answer(input).safeParse(plan).success);
    const other = { ...plan, orchestrator: { provider: "openrouter", id: "anthropic/claude-opus-5.5" } };
    assert.equal(orchestratorPlan.answer(input).safeParse(other).success, false);
  });

  it("sends the brief and the candidates as two untrusted data blocks", () => {
    const content = orchestratorUserContent(input);
    const text = content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    assert.match(text, /<untrusted-data name="brief">/);
    assert.match(text, /<untrusted-data name="candidates">/);
  });
});
