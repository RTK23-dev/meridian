import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { thresholds } from "../../config/thresholds.ts";
import type { EditDecisionList, ScenePlan, ShotSpec } from "../../contracts/index.ts";
import { fixtureId } from "../../contracts/fixtures/index.ts";
import * as fx from "../../contracts/fixtures/index.ts";
import { shotIdOf } from "../../edit/rules.ts";
import { scriptOf } from "../../script/resolve.ts";
import { decideGate, goldMetricsForCheck } from "../gold.ts";
import {
  PRODUCT_IMAGES,
  cleanKit,
  cleanPreRenderInput,
  cleanRender,
  cleanTakes,
  cleanValidated,
  provenMetrics,
  unprovenMetrics,
  type CleanRender,
} from "../test/render.ts";
import { checkPreRender, mediaUrisOf, type PreRenderInput } from "./preRender.ts";

function failing(result: { checks: { rule: string; pass: boolean }[] }): string[] {
  return result.checks.filter((check) => !check.pass).map((check) => check.rule);
}

function check(result: { checks: { rule: string; pass: boolean; detail?: string }[] }, rule: string) {
  const found = result.checks.find((item) => item.rule === rule);
  assert.ok(found, `no check ${rule} in the result`);
  return found;
}

/** A copy of the clean EDL that the test can change. */
function editedEdl(render: CleanRender, change: (edl: EditDecisionList) => void): EditDecisionList {
  const copy = structuredClone(render.edl);
  change(copy);
  return copy;
}

/** A plan of five coded shots in a row, each on a beat of the request, covering the voice (Bible 12.3 acceptance). */
function fiveCodedPlan(plan: ScenePlan): ScenePlan {
  const beats = scriptOf(cleanValidated.request, null).beats;
  const span = Math.floor(fx.VOICE_DURATION_MS / 5);
  const shots: ShotSpec[] = [1, 2, 3, 4, 5].map((n, index) => ({
    shotId: fixtureId("shot_", 90 + n),
    beatId: beats[index % beats.length]?.beatId ?? "b1",
    startMs: index * span,
    endMs: index === 4 ? fx.VOICE_DURATION_MS : (index + 1) * span,
    visualType: index % 2 === 0 ? "coded_graphics" : "kinetic_type",
    layer: "graphics",
    source: { kind: "component", component: index % 2 === 0 ? "list.tierBoard" : "kinetic.punchline", props: { title: "tier board" } },
  }));
  return { ...plan, shots };
}

describe("pre_render gate: the clean chain passes (Bible 6.10, 12.3)", () => {
  it("a clean EDL with its composition, plan, kits and budget passes every check", () => {
    const result = checkPreRender(cleanPreRenderInput());
    assert.equal(result.gate, "pre_render");
    assert.equal(result.pass, true, failing(result).join(", "));
    assert.deepEqual(result.failingShotIds ?? [], []);
    assert.equal(decideGate(result, {}).verdict, "pass");
  });

  it("the EDL rules run inside the gate: the same rule names the edit stage reports", () => {
    const result = checkPreRender(cleanPreRenderInput());
    for (const rule of ["cut_outside_words", "captions_in_safe_zone", "voice_reaches_master_loudness", "same_shot_type_run", "drawable_by_compiler"]) {
      assert.equal(check(result, rule)?.pass, true, rule);
    }
  });
});

describe("pre_render gate: each input is checked, and a missing input never passes", () => {
  it("a style kit that did not load fails the gate, not just the kit check", () => {
    const result = checkPreRender({ ...cleanPreRenderInput(), styleKit: undefined });
    assert.equal(result.pass, false);
    assert.equal(check(result, "style_kit_matches_request").pass, false);
  });

  it("a style kit of another version is not the one the request names", () => {
    const result = checkPreRender({ ...cleanPreRenderInput(), styleKit: { ...cleanKit, version: cleanKit.version + 1 } });
    assert.equal(check(result, "style_kit_matches_request").pass, false);
    assert.match(check(result, "style_kit_matches_request").detail ?? "", /not the one the request names/);
  });

  it("an EDL rule that fails names the rule (a voice gain the compiler cannot play)", () => {
    const render = cleanRender();
    const edl = editedEdl(render, (copy) => {
      copy.audio.voice.gainDb = 20;
    });
    const result = checkPreRender({ ...cleanPreRenderInput(render), edl });
    assert.equal(result.pass, false);
    assert.equal(check(result, "voice_gain_drawable").pass, false);
  });

  it("a composition built from another EDL fails", () => {
    const render = cleanRender();
    const result = checkPreRender({ ...cleanPreRenderInput(render), composition: { ...render.composition, edlId: fixtureId("edl_", 99) } });
    assert.equal(check(result, "composition_matches_edl").pass, false);
    assert.match(check(result, "composition_matches_edl").detail ?? "", /is for/);
  });

  it("a media URI the EDL uses but the composition does not carry fails", () => {
    const render = cleanRender();
    const composition = { ...render.composition, assetUris: render.composition.assetUris.slice(1) };
    const result = checkPreRender({ ...cleanPreRenderInput(render), composition });
    assert.equal(check(result, "composition_matches_edl").pass, false);
  });

  it("a planned product shot with no real product imagery fails and names the shot", () => {
    const render = cleanRender();
    const product = render.plan.shots.find((shot) => shot.visualType === "product_hero");
    assert.ok(product);
    const result = checkPreRender({ ...cleanPreRenderInput(render), productImageUris: ["store://products/other-brand.png"] });
    assert.equal(check(result, "product_shots_real_imagery").pass, false);
    assert.ok(result.failingShotIds?.includes(product.shotId));
  });

  it("no product kit resolved is missing evidence for the product imagery, so the gate fails (never passes)", () => {
    const result = checkPreRender({ ...cleanPreRenderInput(), productImageUris: undefined });
    assert.equal(check(result, "product_shots_real_imagery").pass, false);
    assert.match(check(result, "product_shots_real_imagery").detail ?? "", /not evaluated/);
    assert.equal(result.pass, false);
  });

  it("an AI presenter on screen without its disclosure flag fails, and an unknown flag is not evaluated", () => {
    const flagOff = checkPreRender({ ...cleanPreRenderInput(), disclosures: { aiGeneratedPeople: false } });
    assert.equal(check(flagOff, "disclosure_ai_people").pass, false);
    const unknown = checkPreRender({ ...cleanPreRenderInput(), disclosures: undefined });
    assert.equal(check(unknown, "disclosure_ai_people").pass, false);
    assert.match(check(unknown, "disclosure_ai_people").detail ?? "", /not evaluated/);
  });

  it("no licence record source is missing evidence; a media URI without a record fails", () => {
    const unknown = checkPreRender({ ...cleanPreRenderInput(), licensedUris: undefined });
    assert.equal(check(unknown, "rights_licensed").pass, false);
    assert.match(check(unknown, "rights_licensed").detail ?? "", /not evaluated/);
    const render = cleanRender();
    const some = new Set(mediaUrisOf(render.edl).slice(1));
    const partial = checkPreRender({ ...cleanPreRenderInput(render), licensedUris: some });
    assert.equal(check(partial, "rights_licensed").pass, false);
  });

  it("the render budget: unconnected is not evaluated, an unknown price fails, and too little budget fails", () => {
    const unconnected = checkPreRender({ ...cleanPreRenderInput(), renderBudget: undefined });
    assert.equal(check(unconnected, "render_budget_covers_render").pass, false);
    assert.match(check(unconnected, "render_budget_covers_render").detail ?? "", /not evaluated/);
    const unknownPrice = checkPreRender({ ...cleanPreRenderInput(), renderBudget: { remainingUsd: 5, renderEstimateUsd: null } });
    assert.equal(check(unknownPrice, "render_budget_covers_render").pass, false);
    const short = checkPreRender({ ...cleanPreRenderInput(), renderBudget: { remainingUsd: 0.1, renderEstimateUsd: 0.5 } });
    assert.equal(check(short, "render_budget_covers_render").pass, false);
  });

  it("an input that does not parse fails at the schema check, and no other rule is claimed as passed", () => {
    const result = checkPreRender({ ...cleanPreRenderInput(), edl: { schema: "meridian.edl/v1" } });
    assert.equal(result.pass, false);
    assert.equal(check(result, "schema_valid").pass, false);
    assert.equal(result.checks.some((item) => item.pass && item.rule === "cut_outside_words"), false);
  });
});

describe("pre_render gate: the delivery promise (Bible 12.3)", () => {
  it("a planned shot that the EDL dropped fails and names the shot", () => {
    const render = cleanRender();
    const dropped = render.plan.shots.find((shot) => shot.visualType === "coded_graphics");
    assert.ok(dropped);
    const edl = editedEdl(render, (copy) => {
      for (const track of copy.tracks) {
        track.clips = track.clips.filter((clip) => shotIdOf(clip.clipId) !== dropped.shotId);
      }
    });
    const result = checkPreRender({ ...cleanPreRenderInput(render), edl });
    assert.equal(check(result, "promised_shots_in_edl").pass, false);
    assert.ok(result.failingShotIds?.includes(dropped.shotId));
  });

  it("a script beat that no planned shot covers fails", () => {
    const script = scriptOf(cleanValidated.request, null);
    const withExtra = { ...script, beats: [...script.beats, { beatId: "b9", role: "cta" as const, text: "buy now" }] };
    const result = checkPreRender({ ...cleanPreRenderInput(), script: withExtra });
    assert.equal(check(result, "promised_beats_covered").pass, false);
    assert.match(check(result, "promised_beats_covered").detail ?? "", /b9/);
  });
});

describe("pre_render gate: captions and the slideshow risk (Bible 8.3, 12.3)", () => {
  it("a caption of four words, over the configured legibility limit, fails", () => {
    const render = cleanRender();
    const edl = editedEdl(render, (copy) => {
      const captions = copy.tracks.find((track) => track.layer === "captions")?.clips[0];
      const first = (captions?.props?.captions as { words: unknown[] }[] | undefined)?.[0];
      assert.ok(first, "the fixture has a caption to change");
      first.words.push({ text: "extra", startMs: 0, endMs: 1 }, { text: "more", startMs: 1, endMs: 2 });
    });
    const result = checkPreRender({ ...cleanPreRenderInput(render), edl });
    assert.equal(check(result, "caption_words_legible").pass, false);
    assert.equal(thresholds.edit.captionWordsMax, 3);
  });

  it("five coded shots in a row are blocked by slideshow risk, and every one of them is named", () => {
    const render = cleanRender();
    const plan = fiveCodedPlan(render.plan);
    const result = checkPreRender({ ...cleanPreRenderInput(render), plan, validated: cleanValidated, takes: cleanTakes });
    const coded = check(result, "slideshow_coded_run");
    assert.equal(coded.pass, false);
    assert.equal(result.pass, false);
    for (const shot of plan.shots) {
      assert.ok(result.failingShotIds?.includes(shot.shotId), `${shot.shotId} is named`);
    }
  });

  it("the blocked five-coded plan routes to review with no gold set and to block with a proven one (Bible 12.4)", () => {
    const render = cleanRender();
    const result = checkPreRender({ ...cleanPreRenderInput(render), plan: fiveCodedPlan(render.plan) });
    assert.equal(decideGate(result, {}).verdict, "review", "no gold set: the failure goes to a human");
    const proven = decideGate(result, { "pre_render:slideshow_coded_run": provenMetrics() });
    assert.equal(proven.verdict, "block");
    assert.deepEqual(proven.provenFailures, ["pre_render:slideshow_coded_run"]);
    const unproven = decideGate(result, { "pre_render:slideshow_coded_run": unprovenMetrics() });
    assert.equal(unproven.verdict, "review", "a gold set below the target never blocks");
  });

  it("a gold set with too few labels never blocks, even when every label is right", () => {
    const render = cleanRender();
    const result = checkPreRender({ ...cleanPreRenderInput(render), plan: fiveCodedPlan(render.plan) });
    const few = goldMetricsForCheck([], "pre_render:slideshow_coded_run", () => true);
    assert.equal(decideGate(result, { "pre_render:slideshow_coded_run": few }).verdict, "review");
  });
});

describe("pre_render gate: the result is well formed", () => {
  it("every shot the gate names is a plan shot, and the failing shot list has no repeats", () => {
    const render = cleanRender();
    const result = checkPreRender({ ...cleanPreRenderInput(render), plan: fiveCodedPlan(render.plan) });
    const ids = result.failingShotIds ?? [];
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(id, /^shot_/);
    }
  });

  it("a fixture with no failing check reports pass with no failing shots, and no check is missing evidence", () => {
    const input: PreRenderInput = cleanPreRenderInput();
    const result = checkPreRender(input);
    assert.ok(result.checks.every((item) => item.pass || !(item.detail ?? "").startsWith("not evaluated")));
    assert.ok(PRODUCT_IMAGES.length > 0);
  });
});
