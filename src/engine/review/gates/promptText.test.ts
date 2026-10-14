import assert from "node:assert/strict";
import test from "node:test";
import { scenePlanFixture } from "../../contracts/fixtures/index.ts";
import { promptAsksForText } from "./promptText.ts";

test("the fixture prompts, which say 'no text in frame', do not ask for text", () => {
  for (const shot of scenePlanFixture.shots) {
    if (shot.source.kind === "generate") {
      assert.equal(promptAsksForText(shot.source.prompt).asksForText, false, shot.source.prompt);
    }
  }
});

test("negated text, logo and caption words do not count", () => {
  for (const prompt of [
    "Presenter in a bright kitchen, relaxed, no text in frame.",
    "A clean counter with no logos or captions.",
    "A blender on a counter, without any logo.",
    "Slow push-in, free of text and signs.",
    "A text-free product shot on a warm counter.",
    "Soft window light on a counter, nothing written anywhere.",
  ]) {
    assert.equal(promptAsksForText(prompt).asksForText, false, prompt);
  }
});

test("a prompt that asks for a word, a sign, a label, a caption or a logo is flagged", () => {
  for (const prompt of [
    "A sign reading OPEN on the shop door.",
    "The label on the jar says fresh.",
    "Text overlay saying BLEND across the screen.",
    "Show the words on the box in close-up.",
    "A caption that appears under the presenter.",
    "The company logo sits in the corner.",
  ]) {
    assert.equal(promptAsksForText(prompt).asksForText, true, prompt);
  }
});

test("a price figure or a quoted phrase is flagged unless the sentence negates it", () => {
  assert.equal(promptAsksForText("A tag with a price of $19.99 on the box.").asksForText, true);
  assert.equal(promptAsksForText("A tag, no price figures, just the box.").asksForText, false);
  assert.equal(promptAsksForText('The box shows "fresh juice" on the front.').asksForText, true);
});

test("the finding names the cues it found, and no cue when it finds none", () => {
  const found = promptAsksForText("A sign and a logo on the door.");
  assert.deepEqual(found.cues, ["sign", "logo"]);
  assert.deepEqual(promptAsksForText("Slow push-in on a clean counter.").cues, []);
});

test("an ordinary prompt with no text vocabulary passes", () => {
  assert.equal(promptAsksForText("Presenter laughs and points at the blender, warm morning light.").asksForText, false);
});
