import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, scenePlanSchema, type ChainCall, type ScenePlan } from "../contracts/index.ts";
import {
  budgetReservationFixture,
  cartoonChainShotFixture,
  scenePlanChainFixture,
  scenePlanFixture,
  stopMotionChainShotFixture,
} from "../contracts/fixtures/index.ts";
import { prices } from "../config/prices.ts";
import { estimatePlan, UnknownPriceError } from "./estimate.ts";

function planWith(change: (plan: ScenePlan) => void): ScenePlan {
  const plan = structuredClone(scenePlanFixture);
  change(plan);
  return plan;
}

/**
 * The cartoon chain's two lines on the fixture plan: the keyframe (one image at its route's price) and the 3 s clip (its route's
 * price a second, 3 seconds). The routes come from the price table, so no provider name is written here.
 */
const CARTOON_LINES = [
  { stage: "produce_shot", shotId: cartoonChainShotFixture.shotId, provider: prices.routeFor["image.keyframe"], estimateUsd: 0.018 },
  { stage: "produce_shot", shotId: cartoonChainShotFixture.shotId, provider: prices.routeFor["video.budget"], estimateUsd: 0.1008 },
];

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

test("a single-call shot is priced as before: one line at its own price, next to a chain in the same plan", () => {
  const estimate = estimatePlan(scenePlanChainFixture);
  const presenterShot = scenePlanFixture.shots[0];
  const hero = estimate.lines.filter((line) => line.shotId === scenePlanFixture.shots[2].shotId);
  assert.equal(hero.length, 1, "the product hero is one generate call, so one line");
  assert.equal(hero[0].estimateUsd, 0.2016, "6 s at $0.0336 a second, as in the fixture plan");
  assert.equal(estimatePlan(scenePlanFixture).lines.filter((line) => line.shotId === presenterShot.shotId).length, 1);
});

test("estimatePlan prices every link of a chain: one line per call, each at its own route and takes", () => {
  const estimate = estimatePlan(scenePlanChainFixture);
  const lines = estimate.lines.filter((line) => line.shotId === cartoonChainShotFixture.shotId);
  assert.deepEqual(lines, CARTOON_LINES);
  // The chain's links are generated, so the redo allowance is a share of them as well as of the hero clip.
  assert.equal(estimate.generatedUsd, 0.3204);
  assert.equal(estimate.redoAllowanceUsd, 0.0801);
  assert.equal(estimate.shotsUsd, scenePlanChainFixture.estimatedUsd);
});

test("every call of a chain is reserved: a 24-link chain of per-image calls costs 24 images", () => {
  const links: ChainCall[] = Array.from({ length: 24 }, (_, index): ChainCall => ({
    output: `link_${index}`,
    modelClass: "image.keyframe",
    prompt: "A keyframe in the same style, no text in frame.",
    refs: index === 0 ? [] : [{ kind: "output", output: `link_${index - 1}` }],
    takes: 1,
  }));
  const plan = planWith((draft) => {
    draft.shots[0] = { ...cartoonChainShotFixture, source: { kind: "chain", calls: links } };
  });
  const estimate = estimatePlan(plan);
  const lines = estimate.lines.filter((line) => line.shotId === cartoonChainShotFixture.shotId);
  assert.equal(lines.length, 24);
  assert.ok(lines.every((line) => line.estimateUsd === 0.018), "each image is priced once at $0.018");
  assert.equal(estimate.shotsUsd, 0.6336, "24 images at $0.018 (0.432) and the hero clip (0.2016), rounded to 4 decimals");
});

test("a link's takes multiply its own price", () => {
  const plan = planWith((draft) => {
    const [keyframe, clip] = cartoonChainShotFixture.source.kind === "chain" ? cartoonChainShotFixture.source.calls : [];
    draft.shots[0] = {
      ...cartoonChainShotFixture,
      source: { kind: "chain", calls: [{ ...keyframe, takes: 2 }, clip] },
    };
  });
  const lines = estimatePlan(plan).lines.filter((line) => line.shotId === cartoonChainShotFixture.shotId);
  assert.deepEqual(
    lines.map((line) => line.estimateUsd),
    [0.036, 0.1008],
  );
});

test("a chain whose link has no known price fails the estimate, naming the shot (stop_motion's frames are token-priced)", () => {
  const plan = planWith((draft) => {
    draft.shots[0] = stopMotionChainShotFixture;
  });
  assert.throws(
    () => estimatePlan(plan),
    (error: unknown) => {
      assert.ok(error instanceof UnknownPriceError, "expected UnknownPriceError");
      assert.equal(error.shotId, stopMotionChainShotFixture.shotId);
      assert.ok(error.message.includes(stopMotionChainShotFixture.shotId));
      return true;
    },
  );
});

test("a chain that refers to an unknown output is refused before any price is read", () => {
  const plan = planWith((draft) => {
    const [keyframe, clip] = cartoonChainShotFixture.source.kind === "chain" ? cartoonChainShotFixture.source.calls : [];
    draft.shots[0] = {
      ...cartoonChainShotFixture,
      source: { kind: "chain", calls: [keyframe, { ...clip, firstFrame: { kind: "output", output: "nope" } }] },
    };
  });
  assert.throws(
    () => estimatePlan(plan),
    (error: unknown) => error instanceof EngineError && error.kind === "invalid_input" && !(error instanceof UnknownPriceError),
  );
});

test("the chain fixture plan estimates to its own estimatedUsd", () => {
  assert.equal(estimatePlan(scenePlanChainFixture).shotsUsd, scenePlanChainFixture.estimatedUsd);
});
