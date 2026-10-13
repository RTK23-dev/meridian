import assert from "node:assert/strict";
import test from "node:test";
import { BRAIN_FIELDS, type BrainKey } from "../brain.ts";
import { dnaField, emptyCreativeDna, type AdFormat, type CreativeDna } from "./creative-dna.ts";
import {
  brainEntriesOf,
  controlAttributesOf,
  creativePlanFor,
  parseStoredPlan,
  PLAN_ATTRIBUTES,
  storedPlanOf,
  variantsOf,
  type PlanAttributes,
  type PlanInput,
} from "./plan.ts";
import { conceptOf, type Concept } from "./pick.ts";

const ALL_KEYS: Array<keyof PlanAttributes> = ["hook", "angle", "format", "proof", "cta", "presenter", "lengthMs"];

function brainWith(overrides: Partial<Record<BrainKey, string>> = {}): Record<BrainKey, string> {
  const values = Object.fromEntries(BRAIN_FIELDS.map((field) => [field.key, ""])) as Record<BrainKey, string>;
  return { ...values, positioning: "Gentle daily serums for dry skin", tone: "warm and plain", ...overrides };
}

/** A winning ad's DNA. Its hook text is the competitor's own words, which the plan must never carry. */
function winningDna(): CreativeDna {
  const dna = emptyCreativeDna("ad-1", 15000);
  dna.format = dnaField<AdFormat>("demo", 0.8, { kind: "transcript" });
  dna.hook.type = dnaField("question", 0.8, { kind: "transcript" });
  dna.hook.text = dnaField("Ever wondered why your hands crack every winter?", 0.8, { kind: "transcript" });
  dna.angle = dnaField("problem-solution", 0.8, { kind: "transcript" });
  return dna;
}

function conceptFrom(dna: CreativeDna): Concept {
  const concept = conceptOf(dna);
  if (!concept) throw new Error("The test DNA names no angle, so it has no concept.");
  return concept;
}

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  const dna = winningDna();
  return {
    templateId: "tpl:run-1:ad-1",
    concept: conceptFrom(dna),
    attributes: controlAttributesOf(dna),
    decisionId: "gate-1",
    researchAdId: "ad-1",
    winnerScore: 0.7,
    productName: "Glow Serum",
    audience: "adults with dry skin",
    run: { formats: ["video"], automation: "manual", intent: "organic", capTotalCents: 0 },
    now: "2026-10-13T00:00:00.000Z",
    ...overrides,
  };
}

test("the control reads its attributes from the DNA's framework, and carries none of the winning ad's words", () => {
  const dna = winningDna();
  const control = controlAttributesOf(dna);
  assert.equal(control.hook, "question");
  assert.equal(control.angle, "problem-solution");
  assert.equal(control.format, "demo");
  assert.equal(control.lengthMs, 15000);
  assert.equal(control.proof, "", "the DNA does not classify a proof point, so the control has none");
  assert.equal(control.cta, "", "the DNA does not classify a call to action, so the control has none");
  assert.equal(control.presenter, "", "no scene names a presenter");
  assert.ok(!JSON.stringify(control).includes("winter"), "the winning ad's own words never reach the control");
});

test("a variant's values are the entries the brand wrote, one per line, with list markers removed", () => {
  const entries = brainEntriesOf(
    brainWith({
      problems: "Dry hands by 3pm\n- Cracked heels",
      differentiators: "Fragrance-free",
      preferredFormats: "UGC, demo, unknown-format",
      proofPoints: "Dermatologist tested",
      offers: "Free shipping on first order",
    }),
  );
  assert.deepEqual(entries.hook, ["Dry hands by 3pm", "Cracked heels"]);
  assert.deepEqual(entries.angle, ["Fragrance-free"]);
  assert.deepEqual(entries.format, ["ugc", "demo"], "only the formats the plan can name are kept");
  assert.deepEqual(entries.proof, ["Dermatologist tested"]);
  assert.deepEqual(entries.cta, ["Free shipping on first order"]);
});

test("every variant changes exactly one attribute against its control, to a value the brand wrote", () => {
  const dna = winningDna();
  const control = controlAttributesOf(dna);
  const entries = brainEntriesOf(
    brainWith({
      problems: "Dry hands by 3pm\n- Cracked heels",
      differentiators: "Fragrance-free",
      preferredFormats: "UGC, demo",
      proofPoints: "Dermatologist tested",
      offers: "Free shipping on first order",
    }),
  );
  const variants = variantsOf(control, entries, 50);
  assert.ok(variants.length >= 5, "the brain supplies values for several attributes");
  for (const variant of variants) {
    const changed = ALL_KEYS.filter((key) => variant.attributes[key] !== control[key]);
    assert.deepEqual(changed, [variant.attribute], `a ${variant.attribute} variant changes only ${variant.attribute}`);
    assert.equal(variant.attributes[variant.attribute], variant.value);
    assert.ok(entries[variant.attribute].includes(variant.value), `${variant.value} is a line the brand wrote`);
  }
});

test("a brain that supplies no value for an attribute produces no variant for it", () => {
  const control = controlAttributesOf(winningDna());
  const onlyOffers = brainEntriesOf(brainWith({ offers: "Free shipping on first order" }));
  const variants = variantsOf(control, onlyOffers, 50);
  assert.equal(variants.length, 1);
  assert.deepEqual([...new Set(variants.map((variant) => variant.attribute))], ["cta"], "no hook, angle, format or proof variant exists");
});

test("a format entry equal to the control's format is not a variant, because nothing changes", () => {
  const control = controlAttributesOf(winningDna());
  const sameFormat = brainEntriesOf(brainWith({ preferredFormats: "demo" }));
  assert.deepEqual(variantsOf(control, sameFormat, 50), []);
});

test("the variant cap is taken round by round, so a cap does not leave the later attributes with none", () => {
  const control = controlAttributesOf(winningDna());
  const entries = brainEntriesOf(
    brainWith({ problems: "Dry hands by 3pm\n- Cracked heels", differentiators: "Fragrance-free", proofPoints: "Dermatologist tested" }),
  );
  const capped = variantsOf(control, entries, 3);
  assert.deepEqual(
    capped.map((variant) => variant.attribute),
    ["hook", "angle", "proof"],
    "the first line of each attribute comes before the second line of any",
  );
  assert.equal(variantsOf(control, entries, 0).length, 0);
});

test("a plan is made only under an engine decision, and names the product it is for", () => {
  assert.throws(() => creativePlanFor(planInput({ decisionId: "" })), /lineage/);
  assert.throws(() => creativePlanFor(planInput({ productName: "   " })), /no product/);
});

test("the plan is a draft for the brand's product, with its deliverables unpriced and no production step written", () => {
  const plan = creativePlanFor(planInput());
  assert.equal(plan.status, "draft");
  assert.equal(plan.lineage.decisionId, "gate-1");
  assert.equal(plan.scope, "video_only");
  assert.equal(plan.autonomy, "manual");
  assert.equal(plan.deliverables.length, 1);
  assert.equal(plan.deliverables[0]?.kind, "video");
  assert.equal(plan.deliverables[0]?.copy, "", "no words are taken from the winning ad");
  assert.deepEqual(plan.productionPlan, [], "production writes its steps, not the plan");
  assert.equal(plan.estimatedCost.totalEstimatedUsd, 0);
  assert.deepEqual(plan.estimatedCost.unpricedDeliverableIds, plan.deliverables.map((deliverable) => deliverable.id));
  assert.equal(plan.productionContext?.productName, "Glow Serum");
  assert.ok(plan.rationale.some((entry) => entry.groundedIn === "jev_answer" && entry.sourceId === "gate-1"));
});

test("a stored plan reads back with its control's attributes, and a missing one reads as none", () => {
  const input = planInput();
  const plan = creativePlanFor(input);
  const stored = parseStoredPlan(storedPlanOf(input.attributes, plan));
  assert.ok(stored);
  assert.deepEqual(stored.attributes, input.attributes);
  assert.equal(stored.creativePlan.id, plan.id);
  assert.equal(parseStoredPlan(""), null);
  assert.equal(parseStoredPlan("{}"), null);
});

test("the plan attributes list is the five the Plan stage varies", () => {
  assert.deepEqual([...PLAN_ATTRIBUTES], ["hook", "angle", "format", "proof", "cta"]);
});
