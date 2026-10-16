import assert from "node:assert/strict";
import test from "node:test";
import { gateResultSchema, productionRequestSchema, type GateResult, type ProductionRequest, type ScenePlan } from "../../contracts/index.ts";
import {
  BLENDER_FRONT_URI,
  cartoonChainShotFixture,
  productKitFixture,
  productionRequestFixture,
  scenePlanChainFixture,
  scenePlanFixture,
  voiceTrackFixture,
} from "../../contracts/fixtures/index.ts";
import { checkPlan, type PlanGateInput } from "./plan.ts";
import type { VisualClassification } from "./request.ts";

const BLENDER: VisualClassification = {
  beatId: "b3",
  want: "the blender on a clean kitchen counter",
  properties: ["real_product"],
};

const PRODUCT_URIS = [
  ...productKitFixture.heroImages.map((image) => image.uri),
  ...productKitFixture.cutouts,
];

function fixtureInput(overrides: Partial<PlanGateInput> = {}): PlanGateInput {
  return {
    plan: structuredClone(scenePlanFixture),
    voice: structuredClone(voiceTrackFixture),
    request: structuredClone(productionRequestFixture),
    classifications: [BLENDER],
    productImageUris: PRODUCT_URIS,
    ...overrides,
  };
}

function check(result: GateResult, rule: string) {
  const found = result.checks.find((item) => item.rule === rule);
  assert.ok(found, `check ${rule} is present`);
  return found;
}

const SHOT1 = scenePlanFixture.shots[0].shotId;
const SHOT2 = scenePlanFixture.shots[1].shotId;
const SHOT3 = scenePlanFixture.shots[2].shotId;

test("the fixture plan passes every check, and the result is a valid GateResult", () => {
  const result = checkPlan(fixtureInput());
  assert.equal(result.gate, "plan");
  assert.equal(result.pass, true, JSON.stringify(result.checks.filter((item) => !item.pass)));
  assert.equal(gateResultSchema.safeParse(result).success, true);
  assert.equal(result.failingShotIds, undefined);
});

test("an invalid plan fails schema_valid, names nothing, and every other check is not evaluated", () => {
  const plan = structuredClone(scenePlanFixture) as unknown as Record<string, unknown>;
  delete plan.planId;
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(result.pass, false);
  assert.equal(check(result, "schema_valid").pass, false);
  assert.match(check(result, "shots_tile_voice_duration").detail ?? "", /not evaluated/);
  assert.equal(result.failingShotIds, undefined);
});

test("tiling: a gap of more than one frame fails and names the shots either side of it", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  plan.shots[1] = { ...plan.shots[1], startMs: 3100 };
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "shots_tile_voice_duration").pass, false);
  assert.match(check(result, "shots_tile_voice_duration").detail ?? "", /gap of 100 ms/);
  assert.deepEqual(result.failingShotIds, [SHOT1, SHOT2]);
});

test("tiling: a gap or overlap within one frame (33.3 ms at 30 fps) passes; just over it fails", () => {
  const within = structuredClone(scenePlanFixture);
  within.shots[1] = { ...within.shots[1], startMs: 3030 };
  assert.equal(check(checkPlan(fixtureInput({ plan: within })), "shots_tile_voice_duration").pass, true);
  const over = structuredClone(scenePlanFixture);
  over.shots[1] = { ...over.shots[1], startMs: 3034 };
  assert.equal(check(checkPlan(fixtureInput({ plan: over })), "shots_tile_voice_duration").pass, false);
});

test("tiling: an overlap fails and names the two shots", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  plan.shots[2] = { ...plan.shots[2], startMs: 8000 };
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "shots_tile_voice_duration").pass, false);
  assert.match(check(result, "shots_tile_voice_duration").detail ?? "", /overlap of 1000 ms/);
  assert.ok(result.failingShotIds?.includes(SHOT2));
});

test("tiling: a plan that ends before the voice does fails and names the last shot", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  const last = plan.shots[plan.shots.length - 1];
  plan.shots[plan.shots.length - 1] = { ...last, endMs: 23000 };
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "shots_tile_voice_duration").pass, false);
  assert.deepEqual(result.failingShotIds, [last.shotId]);
});

test("must: a must shot that is not one the must allows fails and names the shot", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  plan.shots[2] = {
    ...plan.shots[2],
    visualType: "stock_footage",
    source: { kind: "stock", query: "kitchen counter", minMs: 6000 },
    downgradeTo: undefined,
  };
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "must_satisfied").pass, false);
  assert.deepEqual(result.failingShotIds, [SHOT3]);
});

test("must: a must shot that does not say what it satisfies fails", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  const { mustSatisfy: _dropped, ...rest } = plan.shots[2];
  plan.shots[2] = rest;
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "must_satisfied").pass, false);
  assert.deepEqual(result.failingShotIds, [SHOT3]);
});

test("must: a must with no classification cannot be checked, so it fails both must checks", () => {
  const result = checkPlan(fixtureInput({ classifications: [] }));
  assert.equal(check(result, "must_classified").pass, false);
  assert.equal(check(result, "must_satisfied").pass, false);
});

test("text: a generation prompt that asks for rendered text fails and names its shot", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  const first = plan.shots[0];
  if (first.source.kind !== "generate") {
    assert.fail("fixture shot 1 is generated");
  }
  plan.shots[0] = { ...first, source: { ...first.source, prompt: 'A card reading "SALE 50% OFF" in the corner.' } };
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "no_text_in_generation_prompts").pass, false);
  assert.deepEqual(result.failingShotIds, [SHOT1]);
});

test("text: the fixture prompts, which say 'no text in frame', pass", () => {
  assert.equal(check(checkPlan(fixtureInput()), "no_text_in_generation_prompts").pass, true);
});

test("product: a product beat with no real product imagery fails and names its shots", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  const shot3 = plan.shots[2];
  if (shot3.source.kind !== "generate") {
    assert.fail("fixture shot 3 is generated");
  }
  plan.shots[2] = {
    ...shot3,
    source: { ...shot3.source, firstFrame: "store://products/generic-stock.png", refs: ["store://products/generic-stock.png"] },
  };
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "product_beats_use_real_imagery").pass, false);
  assert.deepEqual(result.failingShotIds, [SHOT3]);
});

test("product: with no product kit resolved, a product beat cannot be checked and fails", () => {
  const result = checkPlan(fixtureInput({ productImageUris: undefined }));
  assert.equal(check(result, "product_beats_use_real_imagery").pass, false);
  assert.equal(check(checkPlan(fixtureInput({ productImageUris: [BLENDER_FRONT_URI] })), "product_beats_use_real_imagery").pass, true);
});

test("product: a component shot that names a product URI in its props counts as real imagery", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  plan.shots[2] = {
    ...plan.shots[2],
    visualType: "coded_graphics",
    source: { kind: "component", component: "product.card", props: { image: BLENDER_FRONT_URI, name: "Fixture Blender" } },
    downgradeTo: undefined,
  };
  assert.equal(check(checkPlan(fixtureInput({ plan })), "product_beats_use_real_imagery").pass, true);
});

test("downgrade: a generated shot with no downgradeTo fails and names it", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  plan.shots[0] = { ...plan.shots[0], downgradeTo: undefined };
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "generated_shots_have_downgrade").pass, false);
  assert.deepEqual(result.failingShotIds, [SHOT1]);
});

test("chains (contract v5): the chain fixture plan passes every check, with its shots estimated call by call", () => {
  const result = checkPlan(fixtureInput({ plan: structuredClone(scenePlanChainFixture) }));
  assert.equal(result.pass, true, JSON.stringify(result.checks.filter((item) => !item.pass)));
});

test("chains (contract v5): a call whose prompt asks for text fails the text check and names the chain's shot", () => {
  const plan: ScenePlan = structuredClone(scenePlanChainFixture);
  const chain = plan.shots[0].source;
  if (chain.kind !== "chain") assert.fail("the chain fixture's first shot is a chain");
  chain.calls[1] = { ...chain.calls[1], prompt: 'The clip ends on a card reading "SALE 50% OFF".' };
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "no_text_in_generation_prompts").pass, false);
  assert.ok(result.failingShotIds?.includes(cartoonChainShotFixture.shotId));
});

test("chains (contract v5): a chain with no downgradeTo fails the downgrade check, as a generated shot does", () => {
  const plan: ScenePlan = structuredClone(scenePlanChainFixture);
  plan.shots[0] = { ...plan.shots[0], downgradeTo: undefined };
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "generated_shots_have_downgrade").pass, false);
  assert.deepEqual(result.failingShotIds, [cartoonChainShotFixture.shotId]);
});

test("budget: a plan whose reservation exceeds the request budget fails estimate_within_budget", () => {
  const request: ProductionRequest = structuredClone(productionRequestFixture);
  request.constraints.budgetUsd = 0.5;
  const result = checkPlan(fixtureInput({ request }));
  const estimate = check(result, "estimate_within_budget");
  assert.equal(estimate.pass, false);
  assert.equal(estimate.value, 0.9595);
  assert.equal(estimate.limit, 0.5);
});

test("budget: an unknown price fails the estimate and names the shot that has no price", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  const shot3 = plan.shots[2];
  if (shot3.source.kind !== "generate") {
    assert.fail("fixture shot 3 is generated");
  }
  plan.shots[2] = { ...shot3, source: { ...shot3.source, modelClass: "image.edit" } };
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "estimate_within_budget").pass, false);
  assert.match(check(result, "estimate_within_budget").detail ?? "", /no known price/);
  assert.ok(result.failingShotIds?.includes(SHOT3));
});

test("budget: an estimatedUsd that does not match the shots fails estimated_usd_matches_shots", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  plan.estimatedUsd = 0.5;
  assert.equal(check(checkPlan(fixtureInput({ plan })), "estimated_usd_matches_shots").pass, false);
});

test("the request budget in the fixture is 4 USD, so the fixture plan's 0.9595 USD fits", () => {
  const request = productionRequestSchema.parse(productionRequestFixture);
  assert.equal(request.constraints.budgetUsd, 4);
  assert.equal(check(checkPlan(fixtureInput()), "estimate_within_budget").pass, true);
});

test("a failing check with no shot ids leaves failingShotIds unset", () => {
  const result = checkPlan(fixtureInput({ classifications: [] }));
  assert.equal(result.failingShotIds, undefined);
});

test("tiling: a plan with no shots fails shots_tile_voice_duration without crashing, and names no shot", () => {
  const plan: ScenePlan = structuredClone(scenePlanFixture);
  plan.shots = [];
  const result = checkPlan(fixtureInput({ plan }));
  assert.equal(check(result, "shots_tile_voice_duration").pass, false);
  assert.match(check(result, "shots_tile_voice_duration").detail ?? "", /no shots/);
  assert.equal(result.failingShotIds, undefined);
});
