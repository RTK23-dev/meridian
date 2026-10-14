import assert from "node:assert/strict";
import test from "node:test";
import { personaFixture, productionRequestFixture } from "../contracts/fixtures/index.ts";
import { EngineError, sumUsd, type VisualType } from "../contracts/index.ts";
import { shotCost, usdUnits } from "./cost.ts";
import { fixtureKits, fixtureShots, fixtureStyle } from "./fixtureInputs.ts";
import {
  cheapestOption,
  minimumMasterBudgetUsd,
  planKitsOf,
  spokenBeatMs,
  type MasterMinimum,
  type MinimumClassification,
  type MinimumInput,
} from "./minimum.ts";
import { isGeneratedType } from "./tables.ts";
import { decideVisuals, type VisualDecisionInput } from "./visual.ts";
import type { ClassifiedRequest, ShotInput } from "./types.ts";

// The fixture request: five beats, one `must` (the blender on b3, classified real_product), and the fixture kits. At 150 words a
// minute the beats last 2.8, 4.4, 4.0, 3.2 and 2.4 seconds (the words of each beat, from the contracts fixture).
const beats = productionRequestFixture.script.beats;
const WORDS_PER_MINUTE = personaFixture.wordsPerMinute;
const BLENDER = "the blender on a clean kitchen counter";
const blenderClassification: MinimumClassification = { beatId: "b3", want: BLENDER, properties: ["real_product"] };

function fixtureInput(overrides: Partial<MinimumInput> = {}): MinimumInput {
  return {
    beats,
    wordsPerMinute: WORDS_PER_MINUTE,
    visualRequests: productionRequestFixture.visualRequests,
    classifications: [blenderClassification],
    kits: fixtureKits,
    ...overrides,
  };
}

/** The planner's shots for the fixture beats, timed as the minimum times them, with the must requests given per beat. */
function shotsFor(requests: Record<string, ClassifiedRequest[]>): ShotInput[] {
  const durations = spokenBeatMs(beats, WORDS_PER_MINUTE);
  let startMs = 0;
  return fixtureShots().map((shot, index) => {
    const endMs = startMs + durations[index];
    const timed: ShotInput = {
      ...shot,
      startMs,
      endMs,
      requests: requests[shot.beatId] ?? [],
      flags: { textInPixels: false, handsOnProduct: false, showsProduct: false },
    };
    startMs = endMs;
    return timed;
  });
}

function decisionFor(requestBudgetUsd: number, shots: ShotInput[]) {
  const input: VisualDecisionInput = { shots, styleKit: fixtureStyle, kits: fixtureKits, requestBudgetUsd };
  return decideVisuals(input);
}

function assertLinesSum(minimum: MasterMinimum): void {
  assert.equal(usdUnits(sumUsd(minimum.lines.map((line) => line.usd))), usdUnits(minimum.minimumUsd), "lines sum to the minimum");
}

/** The EngineError of a throw, or a test failure when the call did not throw. */
function thrownBy(call: () => unknown): EngineError {
  try {
    call();
  } catch (error) {
    assert.ok(error instanceof EngineError, `expected an EngineError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to throw");
}

test("the fixture request's minimum is the fixed per-master cost, and its breakdown is an all-code plan", () => {
  const minimum = minimumMasterBudgetUsd(fixtureInput());
  assert.equal(minimum.minimumUsd, 0.52, "the fixed lines are about $0.52 (14.2)");
  assertLinesSum(minimum);

  const fixed = minimum.lines.filter((line) => line.beatId === undefined).map((line) => line.label);
  assert.deepEqual(fixed, ["claude_roles", "critic", "render", "media"]);

  const shots = minimum.lines.filter((line) => line.beatId !== undefined);
  assert.equal(shots.length, beats.length, "one line per beat");
  for (const line of shots) {
    assert.equal(line.usd, 0, `${line.label} is free`);
    assert.equal(isGeneratedType(line.visualType as VisualType), false, `${line.label} is code or stock`);
  }
  assert.equal(
    minimum.lines.some((line) => line.label === "redo_allowance"),
    false,
    "no generated shot, so no redo allowance",
  );
});

test("a budget at the exact minimum yields an all-code plan that fits and reserves the minimum", () => {
  const minimum = minimumMasterBudgetUsd(fixtureInput());
  const plan = decisionFor(minimum.minimumUsd, shotsFor({ b3: [{ strength: "must", want: BLENDER, properties: ["real_product"] }] }));

  assert.equal(plan.totals.fitsBudget, true);
  assert.equal(usdUnits(plan.totals.reservedUsd), usdUnits(minimum.minimumUsd));
  assert.deepEqual(plan.unfilled, []);
  assert.deepEqual(plan.unsatisfiedMust, []);
  for (const shot of plan.shots) {
    assert.equal(shot.generated, false, `${shot.shotId} is not generated at the minimum`);
  }
});

test("a must that only generation can deliver adds its cheapest generated shot, with the redo allowance", () => {
  const motion = "a blender launching through the frame";
  const input = fixtureInput({
    visualRequests: [{ beatId: "b3", want: motion, strength: "must" }],
    classifications: [{ beatId: "b3", want: motion, properties: ["motion_spectacle"] }],
  });
  const minimum = minimumMasterBudgetUsd(input);

  // product_hero on 4.0 s of seedance mini at $0.0336 a second is $0.1344, and its 25% redo allowance is $0.0336. Cinematic
  // costs two takes at $0.126 a second, and cartoon_generated needs a character kit the fixture does not have.
  assert.equal(minimum.minimumUsd, 0.688);
  assert.deepEqual(
    minimum.lines.find((line) => line.beatId === "b3"),
    { label: "b3: product_hero", usd: 0.1344, beatId: "b3", visualType: "product_hero" },
  );
  assert.deepEqual(
    minimum.lines.find((line) => line.label === "redo_allowance"),
    { label: "redo_allowance", usd: 0.0336 },
  );
  assertLinesSum(minimum);

  const must: ClassifiedRequest[] = [{ strength: "must", want: motion, properties: ["motion_spectacle"] }];
  const atMinimum = decisionFor(minimum.minimumUsd, shotsFor({ b3: must }));
  const b3AtMinimum = atMinimum.shots.find((shot) => shot.mustSatisfy !== null);
  assert.equal(b3AtMinimum?.visualType, "product_hero", "the must is honoured at the minimum");
  assert.equal(atMinimum.totals.fitsBudget, true);
  assert.deepEqual(atMinimum.unsatisfiedMust, []);

  // One unit (0.0001) below the minimum the must cannot be honoured: the planner has no way to fit it.
  const below = decisionFor(0.6879, shotsFor({ b3: must }));
  assert.equal(below.unsatisfiedMust.length, 1, "the must is unsatisfied one unit below the minimum");
});

test("the minimum never exceeds the planner's cheapest plan for the same beat durations", () => {
  const motion = "a blender launching through the frame";
  const scenarios: { input: MinimumInput; requests: Record<string, ClassifiedRequest[]> }[] = [
    { input: fixtureInput(), requests: { b3: [{ strength: "must", want: BLENDER, properties: ["real_product"] }] } },
    {
      input: fixtureInput({
        visualRequests: [{ beatId: "b3", want: motion, strength: "must" }],
        classifications: [{ beatId: "b3", want: motion, properties: ["motion_spectacle"] }],
      }),
      requests: { b3: [{ strength: "must", want: motion, properties: ["motion_spectacle"] }] },
    },
  ];
  for (const scenario of scenarios) {
    const minimum = minimumMasterBudgetUsd(scenario.input);
    const ample = decisionFor(4, shotsFor(scenario.requests));
    assert.ok(
      usdUnits(ample.totals.reservedUsd) >= usdUnits(minimum.minimumUsd),
      `planner ${ample.totals.reservedUsd} is at least the minimum ${minimum.minimumUsd}`,
    );
  }
});

test("an unknown price is refused with its name, never treated as 0", () => {
  const stop = "a looping stop-motion of the blender";
  const error = thrownBy(() =>
    minimumMasterBudgetUsd(
      fixtureInput({
        visualRequests: [{ beatId: "b3", want: stop, strength: "must" }],
        classifications: [{ beatId: "b3", want: stop, properties: ["stop_motion_style"] }],
      }),
    ),
  );
  assert.equal(error.kind, "unknown_price");
  assert.match(error.message, /stop_motion/);
  assert.match(error.message, /refuses to guess/);
});

test("an unknown price on one option does not refuse a beat that has a known free option", () => {
  // stop_motion has no known price, but the fixture's generic beats have code and stock routes at $0, which cannot be beaten.
  const minimum = minimumMasterBudgetUsd(fixtureInput());
  assert.equal(minimum.minimumUsd, 0.52);
});

test("cheapestOption refuses when an option with an unknown price could be cheaper than the cheapest known one", () => {
  const productHero = shotCost("product_hero", 3000);
  const stop = shotCost("stop_motion", 3000);
  assert.equal(productHero.known, true);
  assert.equal(stop.known, false);

  const refused = thrownBy(() =>
    cheapestOption("b1", [
      { visualType: "product_hero", cost: productHero },
      { visualType: "stop_motion", cost: stop },
    ]),
  );
  assert.equal(refused.kind, "unknown_price");
  assert.match(refused.message, /could be cheaper/);

  const allUnknown = thrownBy(() => cheapestOption("b1", [{ visualType: "stop_motion", cost: stop }]));
  assert.equal(allUnknown.kind, "unknown_price");
});

test("cheapestOption picks a free option, and breaks ties by how the type is made, then kit needs, then type order", () => {
  const options = (["stock_footage", "cartoon_rigged", "kinetic_type", "coded_graphics"] as const).map((visualType) => ({
    visualType,
    cost: shotCost(visualType, 3000),
  }));
  assert.equal(cheapestOption("b1", options).visualType, "coded_graphics", "code first, then the type with no kit needs");

  const free = cheapestOption("b1", [
    { visualType: "product_hero", cost: shotCost("product_hero", 3000) },
    { visualType: "stop_motion", cost: shotCost("stop_motion", 3000) },
    { visualType: "stock_footage", cost: shotCost("stock_footage", 3000) },
  ]);
  assert.equal(free.visualType, "stock_footage", "a known free option beats an unknown one and a priced one");
});

test("a must no type can deliver, or one without a classification, is refused as invalid input", () => {
  const person = "a presenter who talks to the camera";
  const noPersona = thrownBy(() =>
    minimumMasterBudgetUsd(
      fixtureInput({
        visualRequests: [{ beatId: "b1", want: person, strength: "must" }],
        classifications: [{ beatId: "b1", want: person, properties: ["person_talking"] }],
        kits: { ...fixtureKits, persona: false },
      }),
    ),
  );
  assert.equal(noPersona.kind, "invalid_input");
  assert.match(noPersona.message, /beat b1/);

  const unclassified = thrownBy(() =>
    minimumMasterBudgetUsd(fixtureInput({ classifications: [] })),
  );
  assert.equal(unclassified.kind, "invalid_input");
  assert.match(unclassified.message, /has no classification/);

  const noProperties = thrownBy(() =>
    minimumMasterBudgetUsd(
      fixtureInput({ classifications: [{ beatId: "b3", want: BLENDER, properties: [] }] }),
    ),
  );
  assert.equal(noProperties.kind, "invalid_input");
});

test("inputs the minimum cannot price are refused: speaking rate, empty beats, beats with no words, unknown must beats", () => {
  for (const wordsPerMinute of [0, -150, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(thrownBy(() => minimumMasterBudgetUsd(fixtureInput({ wordsPerMinute }))).kind, "invalid_input");
  }
  assert.equal(thrownBy(() => minimumMasterBudgetUsd(fixtureInput({ beats: [] }))).kind, "invalid_input");
  assert.equal(
    thrownBy(() => minimumMasterBudgetUsd(fixtureInput({ beats: [{ beatId: "b9", text: "   " }] }))).kind,
    "invalid_input",
  );
  const unknownBeat = thrownBy(() =>
    minimumMasterBudgetUsd(
      fixtureInput({ visualRequests: [{ beatId: "b9", want: BLENDER, strength: "must" }] }),
    ),
  );
  assert.equal(unknownBeat.kind, "invalid_input");
  assert.match(unknownBeat.message, /b9/);
});

test("spoken lengths are words divided by words per minute, in whole milliseconds", () => {
  assert.deepEqual(spokenBeatMs(beats, WORDS_PER_MINUTE), [2800, 4400, 4000, 3200, 2400]);
  assert.deepEqual(spokenBeatMs([{ beatId: "x", text: "one two three" }], 120), [1500]);
});

test("planKitsOf reads the kit bodies that loaded", () => {
  assert.deepEqual(planKitsOf({ characters: [] }), {
    persona: false,
    rigCharacter: false,
    generatedCharacter: false,
    productKit: false,
  });
  const generated = { characterId: "char_gen", version: 1, kind: "generated" as const };
  const rigged = { characterId: "char_rig", version: 1, kind: "rigged_svg" as const };
  assert.deepEqual(planKitsOf({ persona: personaFixture, characters: [generated, rigged] }), {
    persona: true,
    rigCharacter: true,
    generatedCharacter: true,
    productKit: false,
  });
});

test("the minimum is deterministic: the same input gives the same breakdown", () => {
  assert.deepEqual(minimumMasterBudgetUsd(fixtureInput()), minimumMasterBudgetUsd(fixtureInput()));
});
