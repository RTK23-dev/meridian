// The plan stage with the E5 follow-up in place (Bible 6.4 step 4, 7.1, 7.2 rule 6): the voice's word spans and the page's rig reach
// the sources, a sketch beat is drawn as character.rig only when the rig can be drawn, stock shots name their fallback, and a
// shot the sources cannot draw is refused before the planner writes anything. Recorded answers only; no live call.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { characterSheetFixture, videoDnaFixture } from "../contracts/fixtures/index.ts";
import type { CharacterSheet, ScenePlan, ShotSpec, VideoDNA } from "../contracts/index.ts";
import { planScene } from "./build.ts";
import { planInputWith, recordedAnswer } from "./test/helpers.ts";

const PLANNER = "openrouter-planner-ok";
const PLANNER_STOCK = "openrouter-planner-stock-only";
const DIRECTOR = "openrouter-director-ok";

/** The page's rig: the fixture sheet with the rig's own pose and mouth names (the fixture's phonemes cannot drive character.rig). */
const RIG_SHEET: CharacterSheet = { ...characterSheetFixture, poses: ["idle", "point", "shrug"], visemes: ["closed", "open", "wide", "round"] };

/** The fixture reference with segment 4 read as a sketch. Beats b4 and b5 align to it, and their shots may then be rigged. */
function sketchReference(): VideoDNA {
  const dna = structuredClone(videoDnaFixture);
  dna.segments = dna.segments.map((segment) => (segment.segId === "seg_4" ? { ...segment, shotType: "sketch_joke" as const } : segment));
  return dna;
}

function shotsOf(plan: ScenePlan, beatId: string): ShotSpec[] {
  return plan.shots.filter((shot) => shot.beatId === beatId).sort((a, b) => a.startMs - b.startMs);
}

describe("a sketch beat is drawn by character.rig, from the page's rig and the voice's word spans", () => {
  it("draws each rigged shot of b4 with the beat's pose, and times every mouth from the voice's words inside the shot", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR)]);
    input.dna = sketchReference();
    input.kits.characters = [structuredClone(RIG_SHEET)];
    const outcome = await planScene(input);
    assert.ok(outcome.plan, `no plan: ${JSON.stringify(outcome.gate.checks.filter((check) => !check.pass))}`);
    const [first] = shotsOf(outcome.plan, "b4");
    assert.equal(first.visualType, "cartoon_rigged");
    assert.equal(first.source.kind, "component");
    if (first.source.kind !== "component") return;
    assert.equal(first.source.component, "character.rig");
    assert.deepEqual(first.source.props.poses, [{ atMs: 0, pose: "shrug", expression: "neutral" }], "proof plays shrug, which the sheet lists");
    // The voice words of shot 1 of b4 (15000 to 17000): "It" at 15000, "makes" at 15750, "four" at 16500 (voice clock). Each mouth
    // opens at its word's time from the shot's start, closes when the next word opens, and the last one closes at the shot's end.
    assert.deepEqual(first.source.props.mouth, [
      { atMs: 0, shape: "wide" },
      { atMs: 750, shape: "closed" },
      { atMs: 750, shape: "open" },
      { atMs: 1500, shape: "closed" },
      { atMs: 1500, shape: "round" },
      { atMs: 1999, shape: "closed" },
    ]);
  });

  it("keeps every mouth event inside its shot and in time order, for every rigged shot", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR)]);
    input.dna = sketchReference();
    input.kits.characters = [structuredClone(RIG_SHEET)];
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    for (const shot of outcome.plan.shots.filter((item) => item.visualType === "cartoon_rigged")) {
      if (shot.source.kind !== "component") continue;
      const mouth = shot.source.props.mouth as Array<{ atMs: number }>;
      const duration = shot.endMs - shot.startMs;
      assert.ok(mouth.every((event) => event.atMs >= 0 && event.atMs < duration), `${shot.shotId} mouth inside the shot`);
      assert.ok(mouth.every((event, index) => index === 0 || event.atMs >= mouth[index - 1].atMs), `${shot.shotId} mouth in order`);
    }
  });

  it("names kinetic_type as the fallback of every rigged shot, as 7.1 does", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR)]);
    input.dna = sketchReference();
    input.kits.characters = [structuredClone(RIG_SHEET)];
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    const rigged = outcome.plan.shots.filter((shot) => shot.visualType === "cartoon_rigged");
    assert.equal(rigged.length, 5, "the five shots of b4 and b5");
    assert.ok(rigged.every((shot) => shot.downgradeTo === "kinetic_type"));
  });

  it("refuses the plan before any call when the page has no rig that can draw the mouth: the sketch beat has no candidate", async () => {
    // The contract fixture's sheet names phonemes (A, E, O, M, rest), so the rig cannot draw it. The sketch beats are then unfilled.
    const { input, requests } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR)]);
    input.dna = sketchReference();
    const outcome = await planScene(input);
    assert.equal(outcome.plan, null);
    assert.equal(outcome.gate.pass, false);
    const filled = outcome.gate.checks.find((check) => check.rule === "every_shot_has_a_candidate");
    assert.equal(filled?.pass, false, "the refusal is the filter's, not a failure at sources_built");
    assert.equal(outcome.gate.checks.some((check) => check.rule === "sources_built"), false);
    assert.equal(requests.length, 0, "nothing is sent to a model for a plan that cannot be filled");
    assert.equal(outcome.calls.length, 0);
    assert.ok(outcome.gate.failingShotIds?.length, "the unfilled shots are named");
  });
});

describe("a shot's fallback (7.1): stock footage and the rigged cartoon name one, the way generated shots do", () => {
  it("names product_hero as the fallback of every stock shot, the video.budget type the lead chose (2026-10-15)", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER_STOCK), recordedAnswer(DIRECTOR)], {
      budgetUsd: 0.52,
      reservedUsd: 0.52,
    });
    const outcome = await planScene(input);
    assert.ok(outcome.plan, `no plan: ${JSON.stringify(outcome.gate.checks.filter((check) => !check.pass))}`);
    const stock = outcome.plan.shots.filter((shot) => shot.visualType === "stock_footage");
    assert.equal(stock.length, 3, "the three B-roll shots of b2");
    assert.ok(stock.every((shot) => shot.downgradeTo === "product_hero"));
  });

  it("gives a component shot with no 7.1 fallback no downgradeTo, and does not invent one", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER_STOCK), recordedAnswer(DIRECTOR)], {
      budgetUsd: 0.52,
      reservedUsd: 0.52,
    });
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    const kinetic = outcome.plan.shots.find((shot) => shot.visualType === "kinetic_type");
    assert.ok(kinetic, "beat b1 is drawn as kinetic type in the all-code plan");
    assert.equal(kinetic.downgradeTo, undefined, "kinetic_type has no fallback in 7.1");
    const card = outcome.plan.shots.find((shot) => shot.visualType === "coded_graphics");
    assert.equal(card?.downgradeTo, undefined, "coded_graphics has no fallback in 7.1");
  });
});

describe("the voice's words reach the kinetic line that emphasises them (E5 follow-up)", () => {
  it("starts the second kinetic line of b1 at the voice's time for 'lying', not at an even split", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER_STOCK), recordedAnswer(DIRECTOR)], {
      budgetUsd: 0.52,
      reservedUsd: 0.52,
    });
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    const [b1] = shotsOf(outcome.plan, "b1");
    assert.equal(b1.visualType, "kinetic_type");
    assert.equal(b1.source.kind, "component");
    if (b1.source.kind !== "component") return;
    const lines = (b1.source.props as { lines: Array<{ text: string; atMs: number }> }).lines;
    assert.deepEqual(lines, [
      { text: "Your kitchen counter is", atMs: 0 },
      { text: "lying to you", atMs: 1714 },
    ]);
  });
});
