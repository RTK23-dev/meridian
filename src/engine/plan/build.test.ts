import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError, VISUAL_TYPES, type ScenePlan, type ShotSpec } from "../contracts/index.ts";
import { RoleAnswerError } from "../claude/errors.ts";
import { promptAsksForText } from "../review/gates/promptText.ts";
import { planScene } from "./build.ts";
import { mustAllowedTypes } from "./filter.ts";
import { recordedAnswer, planInputWith, sentText, SCRIPT_WORDS } from "./test/helpers.ts";

const PLANNER = "openrouter-planner-ok";
const PLANNER_STOCK = "openrouter-planner-stock-only";
const PLANNER_SIGN = "openrouter-planner-sign";
const DIRECTOR = "openrouter-director-ok";
const DIRECTOR_SWAP = "openrouter-director-swap";
const DIRECTOR_OUT_OF_BOUNDS = "openrouter-director-out-of-bounds";
const DIRECTOR_PROSE = "openrouter-director-prose";

const BLENDER_MUST = "the blender on a clean kitchen counter";
const B1 = "shot_7WNRE941244J54X29NQ1PTHHW0";
const B2A = "shot_4RH3FQVKBRZFMS5P5ZYN5CMADS";
const B3A = "shot_2PS5J74HZEQ3ZRM229HZ5CNPYK";
const B4A = "shot_0976TJT1BZZG39MGQ7ZZYF7H9Y";

function generated(plan: ScenePlan): ShotSpec[] {
  return plan.shots.filter((shot) => shot.source.kind === "generate");
}

function shotById(plan: ScenePlan, shotId: string): ShotSpec {
  const found = plan.shots.find((shot) => shot.shotId === shotId);
  assert.ok(found, `shot ${shotId} is in the plan`);
  return found;
}

function decisionsBy(plan: ScenePlan, by: "director" | "scorer") {
  return plan.decisions.filter((decision) => decision.by === by);
}

describe("the fixture request at $4", () => {
  it("yields a plan whose shots tile the voice duration exactly, and passes its gate", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR)]);
    const outcome = await planScene(input);
    assert.ok(outcome.plan, `no plan: ${JSON.stringify(outcome.gate.checks.filter((check) => !check.pass))}`);
    const plan = outcome.plan;
    const sorted = [...plan.shots].sort((a, b) => a.startMs - b.startMs);
    assert.equal(sorted[0].startMs, 0, "the first shot starts at 0");
    for (let index = 1; index < sorted.length; index++) {
      assert.equal(sorted[index].startMs, sorted[index - 1].endMs, `no gap or overlap before ${sorted[index].shotId}`);
    }
    assert.equal(sorted[sorted.length - 1].endMs, input.voice.durationMs, "the last shot ends with the voice");
    const total = plan.shots.reduce((sum, shot) => sum + (shot.endMs - shot.startMs), 0);
    assert.equal(total, input.voice.durationMs, "the shot durations sum to the voice exactly");
    assert.equal(outcome.gate.pass, true, JSON.stringify(outcome.gate.checks.filter((check) => !check.pass)));
    assert.equal(plan.estimatedUsd, 0.3516, "the shot cost matches the fixture's shot total");
  });

  it("honours the must: every shot of the must's beat is a type the must allows, and says it satisfies the request", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR)]);
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    const allowed = mustAllowedTypes([{ strength: "must", want: BLENDER_MUST, properties: ["real_product"] }]) ?? [];
    const beatShots = outcome.plan.shots.filter((shot) => shot.beatId === "b3");
    assert.ok(beatShots.length > 0);
    for (const shot of beatShots) {
      assert.ok(allowed.includes(shot.visualType), `${shot.shotId} is ${shot.visualType}, which the must does not allow`);
      assert.equal(shot.mustSatisfy, BLENDER_MUST);
    }
  });

  it("refuses a director swap that would break the must, and ignores it in the plan", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR_SWAP)]);
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    const ignored = decisionsBy(outcome.plan, "director").filter((decision) => decision.reason.startsWith("Director swap ignored"));
    assert.ok(
      ignored.some((decision) => decision.at === B3A && /not among the shot's filtered candidates/.test(decision.reason)),
      "the stock swap of the must shot is logged as ignored",
    );
    const beatShots = outcome.plan.shots.filter((shot) => shot.beatId === "b3");
    for (const shot of beatShots) {
      assert.notEqual(shot.visualType, "stock_footage");
    }
  });

  it("applies a swap that stays inside the shot's candidates, and logs it as a director Decision", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR_SWAP)]);
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    assert.equal(shotById(outcome.plan, B2A).visualType, "product_hero");
    const applied = decisionsBy(outcome.plan, "director").find((decision) => decision.at === B2A && decision.chose === "product_hero");
    assert.ok(applied, "the applied swap is a Decision");
    assert.equal(shotById(outcome.plan, B2A).downgradeTo, "coded_graphics", "a generated shot names its fallback");
  });

  it("ignores every out-of-bounds swap and edit, and logs each one", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR_OUT_OF_BOUNDS)]);
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    const plan = outcome.plan;
    const ignored = decisionsBy(plan, "director").filter((decision) => decision.reason.startsWith("Director swap ignored"));
    assert.equal(ignored.length, 5, "five swaps are out of bounds: unknown shot, non-candidate, unknown type, an unknown type name, and the shot's own type");
    assert.ok(ignored.some((decision) => /not in this plan/.test(decision.reason)));
    assert.ok(ignored.some((decision) => /not among the shot's filtered candidates/.test(decision.reason)));
    assert.ok(ignored.some((decision) => /not a visual type/.test(decision.reason)));
    assert.ok(ignored.some((decision) => /already ugc_presenter/.test(decision.reason)));
    assert.equal(shotById(plan, B1).visualType, "ugc_presenter", "the out-of-bounds swap to react_clip did not land");
    assert.equal(shotById(plan, B4A).visualType, "coded_graphics", "the out-of-bounds swap to cinematic did not land");
    assert.equal(plan.shots.some((shot) => shot.visualType === "react_clip"), false);
    assert.ok(
      decisionsBy(plan, "director").some((decision) => decision.chose === "prompt unchanged" && /not generated/.test(decision.reason)),
      "the prompt edit of a non-generated shot is logged",
    );
    assert.ok(
      decisionsBy(plan, "director").some((decision) => decision.chose === "prompt edited" && decision.at === B1),
      "the valid prompt edit of the generated shot is applied and logged",
    );
    const approval = decisionsBy(plan, "director").find((decision) => decision.chose === "approved" || decision.chose === "not approved");
    assert.equal(approval?.chose, "not approved", "the director's approval is recorded even when it is no");
  });

  it("writes every generation prompt without text to render, and never sends the script's words to a model", async () => {
    const { input, requests } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR)]);
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    for (const shot of generated(outcome.plan)) {
      if (shot.source.kind !== "generate") continue;
      assert.equal(promptAsksForText(shot.source.prompt).asksForText, false, `${shot.shotId} prompt asks for text`);
    }
    const planner = sentText(requests[0]?.body);
    const director = sentText(requests[1]?.body);
    for (const words of SCRIPT_WORDS) {
      assert.equal(planner.includes(words), false, `the planner was sent script words: ${words}`);
      assert.equal(director.includes(words), false, `the director was sent script words: ${words}`);
    }
  });

  it("refuses to send a prompt that asks for text: the retry names the rule and never repeats the model's words", async () => {
    const { input, requests } = await planInputWith([recordedAnswer(PLANNER_SIGN), recordedAnswer(PLANNER_SIGN)]);
    await assert.rejects(planScene(input), (error: unknown) => error instanceof RoleAnswerError && error.role === "planner");
    const retry = sentText(requests[1]?.body);
    assert.match(retry, /shots\.0\.prompt/, "the retry names the failing path");
    assert.match(retry, /no prompt asks for text, a sign, a logo, a caption or a price to be drawn/, "the retry states the rule");
    assert.equal(retry.includes("reading OPEN"), false, "the model's text is not sent back");
    assert.equal(retry.includes("$19"), false, "the model's price is not sent back");
  });

  it("refuses a director answer that carries a reason, and its retry does not repeat the discarded prose", async () => {
    const { input, requests } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR_PROSE), recordedAnswer(DIRECTOR_PROSE)]);
    await assert.rejects(planScene(input), (error: unknown) => error instanceof RoleAnswerError && error.role === "director_check");
    const retry = sentText(requests[2]?.body);
    assert.match(retry, /exactly three keys/, "the retry states the director's rule");
    assert.equal(retry.includes("presenter reads better"), false, "the model's reason is not sent back");
  });

  it("writes a decision for every alignment and split, and for every director choice, with its reason", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR)]);
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    const scorer = decisionsBy(outcome.plan, "scorer");
    for (const beatId of ["b1", "b2", "b3", "b4", "b5"]) {
      assert.ok(scorer.some((decision) => decision.at === beatId && /aligned to reference segment/.test(decision.reason)), `alignment of ${beatId}`);
      assert.ok(scorer.some((decision) => decision.at === beatId && /Split into/.test(decision.reason)), `split of ${beatId}`);
    }
    for (const decision of outcome.plan.decisions) {
      assert.ok(decision.reason.length > 0, "every decision has a reason");
    }
  });
});

describe("a budget that covers only the fixed per-master cost", () => {
  it("yields an all-code plan that still delivers: no generated shot, no generation cost", async () => {
    const { input, requests } = await planInputWith(
      [recordedAnswer(PLANNER_STOCK), recordedAnswer(DIRECTOR)],
      { budgetUsd: 0.52, reservedUsd: 0.52 },
    );
    const outcome = await planScene(input);
    assert.ok(outcome.plan, `no plan: ${JSON.stringify(outcome.gate.checks.filter((check) => !check.pass))}`);
    assert.equal(generated(outcome.plan).length, 0, "no shot is generated");
    assert.equal(outcome.plan.estimatedUsd, 0);
    assert.ok(
      outcome.plan.shots.every((shot) => ["component", "stock", "asset"].includes(shot.source.kind)),
      "every shot is a component or stock",
    );
    assert.equal(outcome.gate.pass, true, JSON.stringify(outcome.gate.checks.filter((check) => !check.pass)));
    assert.equal(requests.length, 2, "the planner (queries only) and the director were called, and nothing else");
  });

  it("draws the must with code: the product card carries the product's hero image", async () => {
    const { input } = await planInputWith(
      [recordedAnswer(PLANNER_STOCK), recordedAnswer(DIRECTOR)],
      { budgetUsd: 0.52, reservedUsd: 0.52 },
    );
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    const beat = outcome.plan.shots.filter((shot) => shot.beatId === "b3");
    assert.ok(beat.length > 0);
    for (const shot of beat) {
      assert.equal(shot.visualType, "coded_graphics");
      assert.equal(shot.source.kind, "component");
      if (shot.source.kind === "component") {
        assert.equal(shot.source.component, "product.card");
        assert.equal(shot.source.props.heroUri, "store://products/fixture-blender-front.png");
      }
    }
  });
});

describe("a plan that cannot be built", () => {
  it("refuses with no plan when the budget does not cover the planner call", async () => {
    const { input } = await planInputWith([], { reservedUsd: 0.1 });
    const outcome = await planScene(input);
    assert.equal(outcome.plan, null);
    assert.equal(outcome.gate.pass, false);
    const planner = outcome.gate.checks.find((check) => check.rule === "planner_answered");
    assert.equal(planner?.pass, false);
    assert.match(planner?.detail ?? "", /refused/);
  });

  it("refuses with no plan when a must has no classification", async () => {
    const { input } = await planInputWith([], { classifications: [] });
    await assert.rejects(planScene(input), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("uses only the visual types of the catalogue", async () => {
    const { input } = await planInputWith([recordedAnswer(PLANNER), recordedAnswer(DIRECTOR)]);
    const outcome = await planScene(input);
    assert.ok(outcome.plan);
    for (const shot of outcome.plan.shots) {
      assert.ok((VISUAL_TYPES as readonly string[]).includes(shot.visualType));
    }
  });
});
