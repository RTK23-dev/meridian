// The downgrade replan (Bible 5.3, 7.1): a generated or stock shot whose take could not be made moves to the first target of its 7.1 chain
// that it can take now. Only that shot changes, the plan's gate runs on the whole new plan, and the estimate is never allowed to rise.
// Recorded answers only. A component fallback (coded_graphics) needs no planner call; a fallback that needs written text (product_hero)
// makes exactly one planner call, for that shot.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ScenePlan } from "../contracts/index.ts";
import type { HttpResponse } from "../gateway/types.ts";
import { planScene, replanDowngrade, type PlanSceneInput } from "./build.ts";
import { planInputWith, recordedAnswer, recordedPlannerAnswerFor } from "./test/helpers.ts";

const PLANNER = "openrouter-planner-ok";
const DIRECTOR = "openrouter-director-ok";
/** A product_hero shot whose 7.1 fallback is a component (coded_graphics): replanned with no planner call. */
const PRODUCT_SHOT = "shot_2PS5J74HZEQ3ZRM229HZ5CNPYK";
/** A stock shot whose fallback is product_hero, which needs written text: replanned with one planner call for this shot. */
const STOCK_SHOT = "shot_4RH3FQVKBRZFMS5P5ZYN5CMADS";

async function firstPlan(extra: HttpResponse[] = []): Promise<{ plan: ScenePlan; input: PlanSceneInput }> {
  const { input } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR), ...extra]);
  const outcome = await planScene(input);
  assert.ok(outcome.plan, "the fixture plan is built");
  assert.equal(outcome.gate.pass, true, JSON.stringify(outcome.gate.checks.filter((check) => !check.pass)));
  return { plan: outcome.plan, input };
}

describe("a downgrade replan moves one shot to its 7.1 fallback", () => {
  it("moves a product shot to its component fallback with no planner call, changing only that shot", async () => {
    const { plan, input } = await firstPlan();
    const before = plan.shots.find((shot) => shot.shotId === PRODUCT_SHOT);
    assert.equal(before?.downgradeTo, "coded_graphics", "the plan names a component fallback for this shot");

    const outcome = await replanDowngrade({ ...input, previous: plan, shotId: PRODUCT_SHOT });
    assert.equal(outcome.gate.pass, true, JSON.stringify(outcome.gate.checks.filter((check) => !check.pass)));
    assert.ok(outcome.plan && outcome.shot, "the replanned plan and shot are built");
    assert.equal(outcome.shot.visualType, "coded_graphics", "the shot takes the fallback the plan named");
    assert.deepEqual(outcome.calls, [], "a component fallback needs no planner call");

    for (const shot of plan.shots) {
      if (shot.shotId === PRODUCT_SHOT) continue;
      assert.deepEqual(
        outcome.plan.shots.find((item) => item.shotId === shot.shotId),
        shot,
        `${shot.shotId} is unchanged by the replan`,
      );
    }
    assert.notEqual(outcome.plan.planId, plan.planId, "a changed plan has a new id");
    assert.ok(outcome.plan.estimatedUsd <= plan.estimatedUsd, "a downgrade does not raise the estimate");
    const decision = outcome.plan.decisions.at(-1);
    assert.equal(decision?.by, "scorer", "the replan is recorded as the visual decision");
    assert.equal(decision?.chose, "coded_graphics");
  });

  it("moves a stock shot to a generated fallback with exactly one planner call, for that shot", async () => {
    const { plan, input } = await firstPlan([recordedPlannerAnswerFor([STOCK_SHOT])]);
    const before = plan.shots.find((shot) => shot.shotId === STOCK_SHOT);
    assert.equal(before?.downgradeTo, "product_hero", "the plan names product_hero as this shot's fallback");

    const outcome = await replanDowngrade({ ...input, previous: plan, shotId: STOCK_SHOT });
    assert.equal(outcome.calls.length, 1, "one planner call, for the replanned shot");
    assert.ok(outcome.shot, "the shot is rebuilt");
    assert.equal(outcome.shot.visualType, "product_hero");
  });

  it("refuses a shot that names no downgrade, and a shot the plan does not have", async () => {
    const { plan, input } = await firstPlan();
    const component = plan.shots.find((shot) => shot.visualType === "coded_graphics");
    assert.ok(component, "the fixture has a coded_graphics shot, which names no downgrade");

    const noDowngrade = await replanDowngrade({ ...input, previous: plan, shotId: component.shotId });
    assert.equal(noDowngrade.plan, null, "no plan is written for a shot with no downgrade");
    assert.equal(noDowngrade.shot, null);
    assert.equal(noDowngrade.gate.pass, false);
    assert.match(JSON.stringify(noDowngrade.gate.checks), /names no downgrade target in 7\.1/);

    const missing = await replanDowngrade({ ...input, previous: plan, shotId: "shot_00000000000000000000000000" });
    assert.equal(missing.plan, null);
    assert.equal(missing.gate.pass, false);
    assert.match(JSON.stringify(missing.gate.checks), /is not in the plan/);
  });

  it("fails the gate, and is kept for review rather than passed, when the downgrade would cost more than the plan's estimate", async () => {
    const { plan, input } = await firstPlan();
    const outcome = await replanDowngrade({ ...input, previous: { ...plan, estimatedUsd: 0 }, shotId: PRODUCT_SHOT });
    assert.equal(outcome.gate.pass, false, "a plan above its estimate does not pass");
    assert.match(JSON.stringify(outcome.gate.checks), /"rule":"replan_within_estimate","pass":false/);
    assert.ok(outcome.plan, "the replanned plan is kept so the review can show it");
  });
});
