import assert from "node:assert/strict";
import test from "node:test";
import { autoReason, isStyleChoice, presetById, presetsForBatch, STYLE_PRESETS, styleInstruction } from "./style-presets.ts";

test("the library has distinct presets, each with a use, a look, an instruction and the safety line", () => {
  assert.ok(STYLE_PRESETS.length >= 8);
  assert.equal(new Set(STYLE_PRESETS.map((preset) => preset.id)).size, STYLE_PRESETS.length);
  assert.equal(new Set(STYLE_PRESETS.map((preset) => preset.label)).size, STYLE_PRESETS.length);
  for (const preset of STYLE_PRESETS) {
    assert.ok(preset.id.length <= 40 && /^[a-z_]+$/.test(preset.id));
    assert.ok(preset.bestFor.length > 15 && preset.look.length > 15 && preset.instruction.length > 40);
    const text = styleInstruction(preset);
    assert.match(text, /^Style preset: /);
    assert.match(text, /steers the brief only/);
    assert.match(text, /no real person's likeness/);
  }
});

test("a choice is Auto, the Super preset or one known preset, and nothing else", () => {
  assert.ok(isStyleChoice("auto") && isStyleChoice("super") && isStyleChoice("explainer"));
  assert.ok(!isStyleChoice("") && !isStyleChoice("cinematic") && !isStyleChoice("EXPLAINER"));
  assert.equal(presetById("nope"), null);
});

test("one preset repeats for every video, the Super preset walks the library, and an unknown choice is refused", () => {
  const one = presetsForBatch("explainer", 3, null);
  assert.deepEqual(one?.map((preset) => preset.id), ["explainer", "explainer", "explainer"]);
  const mix = presetsForBatch("super", 10, null);
  assert.equal(mix?.length, 10);
  assert.deepEqual(mix?.slice(0, STYLE_PRESETS.length).map((preset) => preset.id), STYLE_PRESETS.map((preset) => preset.id));
  assert.equal(mix?.[STYLE_PRESETS.length]?.id, STYLE_PRESETS[0]?.id, "a batch longer than the library starts over");
  assert.equal(presetsForBatch("unknown", 3, null), null);
});

test("Auto follows the most common research structure by a fixed table, and mixes when there is none", () => {
  assert.deepEqual(presetsForBatch("auto", 2, "listicle")?.map((preset) => preset.id), ["tips_list", "tips_list"]);
  assert.deepEqual(presetsForBatch("auto", 2, "story_payoff")?.map((preset) => preset.id), ["cinematic_story", "cinematic_story"]);
  assert.equal(presetsForBatch("auto", 4, null)?.length, 4);
  assert.notEqual(new Set(presetsForBatch("auto", 4, null)?.map((preset) => preset.id)).size, 1, "no research: a mix");
  assert.notEqual(new Set(presetsForBatch("auto", 4, "other")?.map((preset) => preset.id)).size, 1, "an unmapped structure: a mix");
  assert.match(autoReason("listicle"), /Auto picked Tips list because "listicle"/);
  assert.match(autoReason(null), /mixes every style/);
});
