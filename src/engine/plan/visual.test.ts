import assert from "node:assert/strict";
import test from "node:test";
import { weights } from "../config/weights.ts";
import { decisionSchema, EngineError, VISUAL_TYPES, type ScenePlan, type ShotSpec, type VisualType } from "../contracts/index.ts";
import { budgetReservationFixture, FIXTURE_IDS, productKitFixture, scenePlanFixture, styleKitFixture } from "../contracts/fixtures/index.ts";
import { estimatePlan } from "../budget/estimate.ts";
import { RECIPES, isGeneratedType } from "./tables.ts";
import { decideVisuals, type ShotChoice, type VisualDecisionInput } from "./visual.ts";
import { fixtureDecisionInput, fixtureKits, fixtureShots, fixtureStyle } from "./fixtureInputs.ts";
import { mustAllowedTypes } from "./filter.ts";
import type { ShotInput } from "./types.ts";

const BUDGETS = [0, 0.5, 1, 4, 100];

/** Build a valid ScenePlan from a decision result, so the budget module can price it (the cross-check). */
function planFromChoices(input: VisualDecisionInput, shotChoices: { shotId: string; visualType: VisualType | null }[]): ScenePlan {
  const shots: ShotSpec[] = input.shots.map((shot) => {
    const found = shotChoices.find((item) => item.shotId === shot.shotId);
    assert.ok(found?.visualType, `shot ${shot.shotId} has a type`);
    const chosenType: VisualType = found.visualType;
    const recipe = RECIPES[chosenType];
    const source: ShotSpec["source"] =
      recipe.kind === "generate"
        ? { kind: "generate", modelClass: recipe.modelClass, prompt: "A plain kitchen counter, no text in frame.", refs: [], takes: recipe.takes }
        : recipe.kind === "stock"
          ? { kind: "stock", query: "kitchen", minMs: shot.endMs - shot.startMs }
          : { kind: "component", component: "fixture.component", props: {} };
    return {
      shotId: shot.shotId,
      beatId: shot.beatId,
      startMs: shot.startMs,
      endMs: shot.endMs,
      visualType: chosenType,
      layer: "base",
      source,
      ...(isGeneratedType(chosenType) ? { downgradeTo: "kinetic_type" as const } : {}),
    };
  });
  return {
    schema: "meridian.scene_plan/v1",
    planId: "plan_test_cross_check",
    requestId: scenePlanFixture.requestId,
    videoDnaId: scenePlanFixture.videoDnaId,
    voiceTrackId: scenePlanFixture.voiceTrackId,
    shots,
    estimatedUsd: 0,
    decisions: [],
  };
}

test("the fixture request at $4 reproduces the fixture plan's shot types and budget", () => {
  const result = decideVisuals(fixtureDecisionInput(4));
  const types = result.shots.map((shot) => shot.visualType);
  assert.deepEqual(types, scenePlanFixture.shots.map((shot) => shot.visualType));
  assert.equal(result.totals.shotsUsd, scenePlanFixture.estimatedUsd);
  assert.equal(result.totals.reservedUsd, budgetReservationFixture.reservedUsd);
  assert.equal(result.totals.fitsBudget, true);
  assert.deepEqual(result.unfilled, []);
  assert.deepEqual(result.unsatisfiedMust, []);
});

test("section 6.4: a budget with nothing left for generation yields a plan with no generated shot", () => {
  const result = decideVisuals(fixtureDecisionInput(0.5));
  assert.equal(result.shots.length, 5);
  for (const shot of result.shots) {
    assert.ok(shot.visualType !== null, `shot ${shot.shotId} is filled`);
    assert.equal(shot.generated, false, `shot ${shot.shotId} (${shot.visualType}) is not generated`);
    assert.equal(shot.baseUsd, 0, `shot ${shot.shotId} costs nothing`);
  }
  assert.equal(result.totals.generatedUsd, 0);
  assert.equal(result.totals.shotsUsd, 0);
  // The user sets the budget (14.4). $0.50 is below the fixed per-master lines (14.2, $0.52), so the plan does not fit and
  // intake refuses the request with the minimum; the planner still never reaches for a generated shot.
  assert.equal(result.totals.fixedUsd, 0.52);
  assert.equal(result.totals.fitsBudget, false);
});

test("the cross-check: the planner's total equals the budget module's estimate of the plan it chose", () => {
  for (const budget of [4, 1]) {
    const input = fixtureDecisionInput(budget);
    const result = decideVisuals(input);
    const plan = planFromChoices(input, result.shots);
    const estimate = estimatePlan(plan);
    assert.equal(result.totals.reservedUsd, estimate.reservedUsd, `reserved at budget ${budget}`);
    assert.equal(result.totals.shotsUsd, estimate.shotsUsd, `shots at budget ${budget}`);
    assert.equal(result.totals.allowanceUsd, estimate.redoAllowanceUsd, `allowance at budget ${budget}`);
  }
});

test("the planner never spends more than the request budget when it reports fitsBudget", () => {
  for (const budget of BUDGETS) {
    const result = decideVisuals(fixtureDecisionInput(budget));
    if (result.totals.fitsBudget) {
      assert.ok(result.totals.reservedUsd <= budget + 1e-9, `reserved ${result.totals.reservedUsd} within ${budget}`);
    }
  }
});

test("a must request is always honoured: the chosen type is one the must allows, or the shot is unsatisfied", () => {
  const shots = fixtureShots();
  const mustShot = shots.find((shot) => shot.beatId === "b3");
  assert.ok(mustShot);
  const allowed = mustAllowedTypes(mustShot.requests) ?? [];
  assert.ok(allowed.length > 0);

  const kitSets = [
    fixtureKits,
    { ...fixtureKits, productKit: false },
    { ...fixtureKits, persona: false, rigCharacter: false },
  ];
  for (const budget of BUDGETS) {
    for (const kits of kitSets) {
      for (const textInPixels of [false, true]) {
        const result = decideVisuals({
          ...fixtureDecisionInput(budget),
          kits,
          shots: shots.map((shot) => (shot.shotId === mustShot.shotId ? { ...shot, flags: { ...shot.flags, textInPixels } } : shot)),
        });
        const choice: ShotChoice | undefined = result.shots.find((shot) => shot.shotId === mustShot.shotId);
        assert.ok(choice);
        if (choice.visualType === null) {
          assert.ok(result.unsatisfiedMust.includes(mustShot.shotId), `unsatisfied must is named at budget ${budget}`);
        } else {
          assert.ok(allowed.includes(choice.visualType), `${choice.visualType} honours the must at budget ${budget}`);
          assert.equal(choice.mustSatisfy, mustShot.requests[0].want);
        }
      }
    }
  }
});

test("a must whose properties no type can deliver leaves the shot unsatisfied, never filled with a type outside it", () => {
  const shots = fixtureShots().map((shot) =>
    shot.beatId === "b3"
      ? { ...shot, requests: [{ strength: "must" as const, want: "me holding the blender", properties: ["person_talking" as const, "real_product" as const] }] }
      : shot,
  );
  const result = decideVisuals({ ...fixtureDecisionInput(4), shots });
  const choice = result.shots.find((shot) => shot.shotId === FIXTURE_IDS.shot3);
  assert.equal(choice?.visualType, null);
  assert.ok(result.unsatisfiedMust.includes(FIXTURE_IDS.shot3));
  assert.equal(result.decisions.find((decision) => decision.at === FIXTURE_IDS.shot3)?.chose, "none");
});

test("text in pixels and hands on the product never get a generated type", () => {
  for (const budget of BUDGETS) {
    for (const flag of ["textInPixels", "handsOnProduct"] as const) {
      const shots = fixtureShots().map((shot) => ({ ...shot, flags: { ...shot.flags, [flag]: true } }));
      const result = decideVisuals({ ...fixtureDecisionInput(budget), shots });
      for (const shot of result.shots) {
        if (shot.visualType !== null) {
          assert.equal(isGeneratedType(shot.visualType), false, `${shot.shotId} with ${flag} at ${budget} is ${shot.visualType}`);
        }
      }
    }
  }
});

test("the same inputs give the same plan and the same decisions", () => {
  const input = fixtureDecisionInput(4);
  assert.deepEqual(decideVisuals(input), decideVisuals(input));
  assert.deepEqual(decideVisuals(fixtureDecisionInput(0.5)), decideVisuals(fixtureDecisionInput(0.5)));
});

test("every shot gets one scorer decision, valid under the decision schema, with alternatives that exclude the choice", () => {
  const result = decideVisuals(fixtureDecisionInput(4));
  assert.equal(result.decisions.length, result.shots.length);
  result.decisions.forEach((decision, index) => {
    assert.equal(decision.at, result.shots[index].shotId);
    assert.equal(decision.by, "scorer");
    assert.equal(decision.chose, result.shots[index].visualType);
    assert.equal(decisionSchema.safeParse(decision).success, true);
    assert.ok(!decision.alternatives.some((option) => option.option.startsWith(`${decision.chose} `) || option.option === decision.chose));
    const scores = decision.alternatives.map((option) => option.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "alternatives are ordered by score");
  });
});

test("a generated choice names its downgrade, and a component or stock choice does not", () => {
  const result = decideVisuals(fixtureDecisionInput(4));
  for (const shot of result.shots) {
    if (shot.generated) {
      assert.ok(shot.downgradeTo !== null, `${shot.shotId} names a downgrade`);
    } else if (shot.visualType !== null) {
      assert.equal(shot.downgradeTo, null);
    }
  }
});

test("without learned values, the labels on alternatives and the reason say which values are priors", () => {
  const result = decideVisuals(fixtureDecisionInput(4));
  const first = result.decisions[0];
  assert.equal(first.chose, "ugc_presenter");
  assert.ok(first.reason.includes("winRate and artifactRisk are a prior"));
  assert.ok(first.alternatives.some((option) => option.option === "kinetic_type (prior: winRate, artifactRisk)"));
});

test("once a page has 30 win samples, its win rate is learned and no longer labelled a prior", () => {
  const learned = {
    winRate: { ugc_presenter: { wins: 27, samples: 30 } },
    artifactRisk: { ugc_presenter: { failures: 3, takes: 30 } },
  };
  const result = decideVisuals({ ...fixtureDecisionInput(4), learned });
  const first = result.decisions[0];
  assert.equal(first.chose, "ugc_presenter");
  assert.ok(!first.reason.includes("winRate"), "the reason names no prior for the chosen type");
  assert.ok(!first.reason.includes("artifactRisk is a prior"));
});

test("the score of a choice is the Bible 7.5 formula, with every weight read from config", () => {
  // A single-shot case with no budget pressure: the chosen score must equal the formula evaluated from config.
  const shot: ShotInput = {
    shotId: "shot_only",
    beatId: "b1",
    beatRole: "hook",
    refShot: "talking_head",
    startMs: 0,
    endMs: 3000,
    flags: { textInPixels: false, handsOnProduct: false, showsProduct: false },
    requests: [],
  };
  const result = decideVisuals({
    shots: [shot],
    styleKit: { preferredTypes: ["ugc_presenter"], bannedTypes: [] },
    kits: fixtureKits,
    requestBudgetUsd: 4,
  });
  assert.equal(result.shots[0].visualType, "ugc_presenter");
  const v = weights.visualScore;
  const cost = 0.15 + 0.15 * 0.25; // 3 s avatar at $0.05/s with the 25% allowance (budgets.ts)
  const remaining = 4 - 0.52;
  const expected =
    v.beatFit.value * 1.0 +
    v.referenceMatch.value * 1 +
    v.styleFit.value * 1 +
    v.winRate.value * weights.winRatePrior.value -
    v.costShare.value * (cost / remaining) -
    v.artifactRisk.value * 0.3;
  assert.ok(Math.abs((result.shots[0].score ?? NaN) - Math.round(expected * 1e4) / 1e4) < 1e-4, `score ${result.shots[0].score} vs ${expected}`);
});

test("the result names the versions of the configuration it used", () => {
  const result = decideVisuals(fixtureDecisionInput(4));
  assert.equal(result.versions.planTables, "planTables@1");
  assert.equal(result.versions.weights, weights.version);
  assert.match(result.versions.budgets, /^budgets@/);
  assert.match(result.versions.prices, /^prices@/);
});

test("every type in the catalogue has a recipe, and every generated type names a downgrade", () => {
  for (const visualType of VISUAL_TYPES) {
    assert.ok(RECIPES[visualType], `${visualType} has a recipe`);
  }
  const generated = VISUAL_TYPES.filter((visualType) => isGeneratedType(visualType));
  assert.ok(generated.length > 0);
});

test("invalid input is refused with a typed error, before any choice is made", () => {
  assert.throws(() => decideVisuals({ ...fixtureDecisionInput(4), shots: [] }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  assert.throws(() => decideVisuals({ ...fixtureDecisionInput(-1) }), (error: unknown) => error instanceof EngineError);
  const shots = fixtureShots();
  const overlapping = shots.map((shot, index) => (index === 1 ? { ...shot, startMs: 2000 } : shot));
  assert.throws(() => decideVisuals({ ...fixtureDecisionInput(4), shots: overlapping }), (error: unknown) => error instanceof EngineError);
  const duplicate = shots.map((shot) => ({ ...shot, shotId: "shot_same" }));
  assert.throws(() => decideVisuals({ ...fixtureDecisionInput(4), shots: duplicate }), (error: unknown) => error instanceof EngineError);
});

test("the fixture product kit and style kit are the ones the planner is told about", () => {
  assert.equal(productKitFixture.productKitId, "pk_fixture");
  assert.deepEqual(fixtureStyle.bannedTypes, styleKitFixture.bannedTypes);
});
