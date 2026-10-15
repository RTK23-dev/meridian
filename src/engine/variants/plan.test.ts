import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError, scenePlanSchema, type Persona, type ProductKit, type ScenePlan } from "../contracts/index.ts";
import { FIXTURE_IDS, personaFixture, productKitFixture, scenePlanFixture } from "../contracts/fixtures/index.ts";
import { personaReferenceOf, productReferenceOf, variantScenePlan, type VariantPlanInput } from "./plan.ts";

const master = scenePlanFixture as ScenePlan;
const HOOK_SHOT = FIXTURE_IDS.shot1;
const PRODUCT_SHOT = FIXTURE_IDS.shot3;
const NEW_PRODUCT_FRONT = "store://products/variant-blender-front.png";
const NEW_PORTRAIT = "store://personas/variant/portrait-1.png";

function input(overrides: Partial<VariantPlanInput> = {}): VariantPlanInput {
  return { key: "product:SKU-2", attribute: "product", reference: NEW_PRODUCT_FRONT, shotIds: [PRODUCT_SHOT], chose: "product:SKU-2", ...overrides };
}

describe("the variant scene plan: one change against the master (Bible 6.13)", () => {
  it("a product swap changes the references of the product shot only, and every other shot stays the master's object", () => {
    const { plan, changedShotIds } = variantScenePlan(master, input());
    assert.deepEqual(changedShotIds, [PRODUCT_SHOT]);
    assert.equal(plan.shots.length, master.shots.length);
    for (const [index, shot] of master.shots.entries()) {
      if (shot.shotId === PRODUCT_SHOT) {
        assert.equal(shot.source.kind, "generate");
        assert.deepEqual(plan.shots[index]?.source, { ...shot.source, refs: [NEW_PRODUCT_FRONT] });
        assert.equal(plan.shots[index]?.shotId, shot.shotId);
        assert.equal(plan.shots[index]?.startMs, shot.startMs);
      } else {
        assert.deepEqual(plan.shots[index], shot, `shot ${shot.shotId} must be unchanged`);
      }
    }
  });

  it("a persona change gives the presenter shot the persona's portrait, and leaves the other shots alone", () => {
    const { plan, changedShotIds } = variantScenePlan(master, input({ key: "persona:persona_variant", attribute: "persona", reference: NEW_PORTRAIT, shotIds: [HOOK_SHOT] }));
    assert.deepEqual(changedShotIds, [HOOK_SHOT]);
    const shot = plan.shots.find((candidate) => candidate.shotId === HOOK_SHOT);
    assert.deepEqual(shot?.source.kind === "generate" ? shot.source.refs : null, [NEW_PORTRAIT]);
    master.shots.forEach((masterShot, index) => {
      if (masterShot.shotId !== HOOK_SHOT) assert.deepEqual(plan.shots[index], masterShot);
    });
  });

  it("a hook keeps the references of the shots it touches, which are made again, and takes the variant's voice track", () => {
    const { plan, changedShotIds } = variantScenePlan(master, input({ key: "hook:1", attribute: "hook", reference: null, shotIds: [HOOK_SHOT], voiceTrackId: "vt_variant_hook_1", chose: "hook:1" }));
    assert.deepEqual(changedShotIds, [HOOK_SHOT]);
    assert.equal(plan.voiceTrackId, "vt_variant_hook_1");
    assert.deepEqual(plan.shots.find((shot) => shot.shotId === HOOK_SHOT), master.shots.find((shot) => shot.shotId === HOOK_SHOT));
  });

  it("a variant with no shot to make again keeps every shot, and the master's voice track when it has none of its own", () => {
    const { plan, changedShotIds } = variantScenePlan(master, input({ key: "language:de", attribute: "language", reference: null, shotIds: [], chose: "language:de" }));
    assert.deepEqual(changedShotIds, []);
    assert.equal(plan.voiceTrackId, master.voiceTrackId);
    assert.deepEqual(plan.shots, master.shots);
  });

  it("records one decision for the variant, by the request, and gives the plan its own id", () => {
    const { plan } = variantScenePlan(master, input());
    assert.equal(plan.planId, `${master.planId}.product-SKU-2`);
    assert.equal(plan.decisions.length, master.decisions.length + 1);
    const decision = plan.decisions[plan.decisions.length - 1];
    assert.equal(decision?.at, "variant:product:SKU-2");
    assert.equal(decision?.by, "human");
    assert.doesNotThrow(() => scenePlanSchema.parse(plan));
  });

  it("refuses a touched shot that is not generated, since only a generated shot has a take to make again", () => {
    assert.throws(
      () => variantScenePlan(master, input({ shotIds: [FIXTURE_IDS.shot4] })),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /is not generated/.test(error.message),
    );
  });

  it("refuses a touched shot that the master plan does not have", () => {
    assert.throws(
      () => variantScenePlan(master, input({ shotIds: ["shot_01JABCDEFGHJKMNPQRSTVWXYZ9"] })),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && /is not in the master plan/.test(error.message),
    );
  });

  it("is pure: the same input gives the same plan", () => {
    assert.deepEqual(variantScenePlan(master, input()), variantScenePlan(master, input()));
  });
});

describe("the references a variant takes from its kits (Bible 13)", () => {
  it("a product swap uses the kit's front hero image, else its first one, and no reference when the kit has none", () => {
    assert.equal(productReferenceOf(productKitFixture as ProductKit), "store://products/fixture-blender-front.png");
    const detailOnly: ProductKit = { ...(productKitFixture as ProductKit), heroImages: [{ uri: "store://products/detail.png", angle: "detail" }] };
    assert.equal(productReferenceOf(detailOnly), "store://products/detail.png");
    assert.equal(productReferenceOf({ ...(productKitFixture as ProductKit), heroImages: [] }), null);
  });

  it("a persona change uses the persona's first portrait", () => {
    assert.equal(personaReferenceOf(personaFixture as Persona), "store://personas/fixture/portrait-1.png");
  });
});
