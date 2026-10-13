import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, scenePlanSchema, type ScenePlan } from "../contracts/index.ts";
import { budgetReservationFixture, scenePlanFixture } from "../contracts/fixtures/index.ts";
import { estimatePlan, UnknownPriceError } from "./estimate.ts";

function planWith(change: (plan: ScenePlan) => void): ScenePlan {
  const plan = structuredClone(scenePlanFixture);
  change(plan);
  return plan;
}

test("the fixture plan estimates to the reservation fixture, line for line", () => {
  const estimate = estimatePlan(scenePlanFixture);
  assert.deepEqual(estimate.lines, budgetReservationFixture.lines);
  assert.equal(estimate.estimateUsd, budgetReservationFixture.estimateUsd);
  assert.equal(estimate.redoAllowanceUsd, budgetReservationFixture.redoAllowanceUsd);
  assert.equal(estimate.reservedUsd, budgetReservationFixture.reservedUsd);
});

test("the shot total equals the plan's own estimatedUsd", () => {
  const estimate = estimatePlan(scenePlanFixture);
  assert.equal(estimate.shotsUsd, scenePlanFixture.estimatedUsd);
});

test("the fixed per-master costs add up to about $0.52", () => {
  const estimate = estimatePlan(scenePlanFixture);
  assert.equal(estimate.fixedUsd, 0.52);
});

test("the redo allowance is 25 per cent of the generated shots only", () => {
  const onlyAvatar = planWith((plan) => {
    plan.shots[2] = {
      ...plan.shots[2],
      source: { kind: "component", component: "product.card", props: {} },
      visualType: "coded_graphics",
      downgradeTo: undefined,
    };
  });
  const estimate = estimatePlan(onlyAvatar);
  assert.equal(estimate.generatedUsd, 0.15);
  assert.equal(estimate.redoAllowanceUsd, 0.0375);
});

test("a plan with no generated shots carries no redo allowance", () => {
  const codeOnly = planWith((plan) => {
    plan.shots = plan.shots.map((shot) =>
      shot.source.kind === "generate"
        ? { ...shot, source: { kind: "stock", query: "kitchen", minMs: 1000 }, visualType: "stock_footage", downgradeTo: undefined }
        : shot,
    );
  });
  const estimate = estimatePlan(codeOnly);
  assert.equal(estimate.generatedUsd, 0);
  assert.equal(estimate.redoAllowanceUsd, 0);
});

test("a plan of components only costs the fixed per-master lines", () => {
  const components = planWith((plan) => {
    plan.shots = plan.shots.map((shot) => ({
      ...shot,
      source: { kind: "component", component: "kinetic.punchline", props: {} },
      visualType: "kinetic_type",
      downgradeTo: undefined,
    }));
  });
  const estimate = estimatePlan(components);
  assert.equal(estimate.shotsUsd, 0);
  assert.equal(estimate.estimateUsd, 0.52);
});

test("per-second generation is priced by the shot's length and its takes", () => {
  const cinematic = planWith((plan) => {
    plan.shots[2] = {
      ...plan.shots[2],
      visualType: "cinematic",
      source: { kind: "generate", modelClass: "video.cinematic", prompt: "A slow crane shot over a kitchen.", refs: [], takes: 2 },
    };
  });
  // Kling v3.0 Standard is $0.126 per second: 6 s, two takes.
  assert.equal(estimatePlan(cinematic).lines[2].estimateUsd, 1.512);
});

test("per-image generation is priced per image and per take", () => {
  const keyframe = planWith((plan) => {
    plan.shots[0] = {
      ...plan.shots[0],
      visualType: "cartoon_generated",
      source: { kind: "generate", modelClass: "image.keyframe", prompt: "A keyframe of the mascot.", refs: [], takes: 2 },
    };
  });
  // Seedream 5.0 Flash is $0.018 per image: two takes.
  assert.equal(estimatePlan(keyframe).lines[0].estimateUsd, 0.036);
});

test("a shot whose price is unknown fails the estimate with a typed error that names the shot", () => {
  const unknown = planWith((plan) => {
    plan.shots[2] = {
      ...plan.shots[2],
      visualType: "cinematic",
      source: { kind: "generate", modelClass: "video.i2v_pinned", prompt: "A pinned frame move.", refs: [], takes: 1 },
    };
  });
  assert.throws(
    () => estimatePlan(unknown),
    (error: unknown) => {
      assert.ok(error instanceof UnknownPriceError, "expected UnknownPriceError");
      assert.ok(error instanceof EngineError);
      assert.equal(error.kind, "unknown_price");
      assert.equal(error.shotId, scenePlanFixture.shots[2].shotId);
      assert.ok(error.message.includes(scenePlanFixture.shots[2].shotId));
      return true;
    },
  );
});

test("a token-priced model (image.edit) fails the estimate rather than costing 0", () => {
  const tokenPriced = planWith((plan) => {
    plan.shots[0] = {
      ...plan.shots[0],
      visualType: "product_hero",
      source: { kind: "generate", modelClass: "image.edit", prompt: "Edit the hero image.", refs: [], takes: 1 },
    };
  });
  assert.throws(() => estimatePlan(tokenPriced), UnknownPriceError);
});

test("a price unit that cannot price one shot (per character) fails the estimate", () => {
  const tts = planWith((plan) => {
    plan.shots[0] = {
      ...plan.shots[0],
      source: { kind: "generate", modelClass: "tts", prompt: "Read the line.", refs: [], takes: 1 },
    };
  });
  assert.throws(() => estimatePlan(tts), UnknownPriceError);
});

test("an invalid plan is refused with invalid_input before any price is read", () => {
  const broken = structuredClone(scenePlanFixture) as unknown as Record<string, unknown>;
  delete broken.shots;
  assert.throws(
    () => estimatePlan(broken as unknown as ScenePlan),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
  );
  assert.equal(scenePlanSchema.safeParse(broken).success, false);
});

test("the estimate is deterministic for the same plan", () => {
  assert.deepEqual(estimatePlan(scenePlanFixture), estimatePlan(scenePlanFixture));
});
