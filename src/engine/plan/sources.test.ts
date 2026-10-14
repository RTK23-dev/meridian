import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { personaFixture, productKitFixture } from "../contracts/fixtures/index.ts";
import { buildSource, checkComponentProps, componentRefusals, emphasisIn, kineticLinesOf, type BuildSourceInput } from "./sources.ts";

const SHOT: Omit<BuildSourceInput["shot"], "words"> = {
  shotId: "shot_01JABCDEFGHJKMNPQRSTVWXYZ0",
  durationMs: 2000,
  beatRole: "item",
  showsProduct: false,
  emphasis: [],
};

function input(overrides: Omit<Partial<BuildSourceInput>, "shot"> & { words?: string[]; shot?: Partial<BuildSourceInput["shot"]> }): BuildSourceInput {
  const { words = ["Four", "smoothies", "in", "two", "minutes"], shot = {}, ...rest } = overrides;
  return {
    visualType: "coded_graphics",
    claimIds: [],
    shot: { ...SHOT, words, ...shot },
    ...rest,
  };
}

describe("kinetic lines and emphasis", () => {
  it("groups the shot's words four to a line, in order", () => {
    assert.deepEqual(kineticLinesOf(["a", "b", "c", "d", "e"]), ["a b c d", "e"]);
    assert.deepEqual(kineticLinesOf([]), []);
  });

  it("keeps only the emphasis words the shot speaks, ignoring case and punctuation", () => {
    assert.deepEqual(emphasisIn(["Stop", "now!"], ["stop", "later"]), ["stop"]);
  });
});

describe("component props are checked against the library's own schema", () => {
  it("accepts props that fit, and names the path of the first problem that does not", () => {
    assert.deepEqual(checkComponentProps("kinetic.punchline", { lines: ["one"] }, 1000), { ok: true });
    const bad = checkComponentProps("kinetic.punchline", { lines: [] }, 1000);
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? "" : bad.reason, /lines/);
  });

  it("refuses a component the library does not have", () => {
    const result = checkComponentProps("map.route", {}, 1000);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /not in the library/);
  });
});

describe("refusals from the shot's own words", () => {
  it("refuses kinetic type when the lines exceed the component's limit of six", () => {
    const words = Array.from({ length: 30 }, (_, index) => `w${index}`);
    const refusals = componentRefusals({ durationMs: 3000, beatRole: "item", showsProduct: false, words, emphasis: [] });
    assert.ok(refusals.kinetic_type);
  });

  it("refuses a title whose text is over its limit, and never refuses a product card on text", () => {
    const longText = Array.from({ length: 20 }, () => "lengthy").join(" ");
    const title = componentRefusals({ durationMs: 3000, beatRole: "item", showsProduct: false, words: longText.split(" "), emphasis: [] });
    assert.ok(title.coded_graphics, "over the title limit");
    const product = componentRefusals({ durationMs: 3000, beatRole: "item", showsProduct: true, words: longText.split(" "), emphasis: [] });
    assert.equal(product.coded_graphics, undefined, "a product card draws from the kit, not the words");
  });
});

describe("buildSource: each type's source from its inputs", () => {
  it("builds a presenter from the persona's first portrait and the planner's prompt, on the presenter layer", () => {
    const result = buildSource(input({ visualType: "ugc_presenter", prompt: "Home cook, relaxed, no text in frame.", persona: personaFixture }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.built.layer, "presenter");
    assert.deepEqual(result.built.source, {
      kind: "generate",
      modelClass: "avatar",
      prompt: "Home cook, relaxed, no text in frame.",
      refs: [personaFixture.portraits[0]],
      takes: 1,
    });
  });

  it("refuses a presenter with no persona, and a generated shot with no prompt", () => {
    assert.equal(buildSource(input({ visualType: "ugc_presenter", prompt: "x" })).ok, false);
    assert.equal(buildSource(input({ visualType: "ugc_presenter", persona: personaFixture })).ok, false);
    const noPrompt = buildSource(input({ visualType: "cinematic" }));
    assert.equal(noPrompt.ok, false);
    assert.match(noPrompt.ok ? "" : noPrompt.reason, /no prompt/);
  });

  it("pins the hero image as the first frame of a product hero and of a cinematic product shot", () => {
    const hero = buildSource(input({ visualType: "product_hero", prompt: "Slow push-in.", productKit: productKitFixture }));
    assert.equal(hero.ok && hero.built.source.kind === "generate" ? hero.built.source.firstFrame : undefined, productKitFixture.heroImages[0].uri);
    const cinematic = buildSource(input({ visualType: "cinematic", prompt: "Slow push-in.", productKit: productKitFixture, shot: { showsProduct: true } }));
    assert.ok(cinematic.ok);
    if (cinematic.ok && cinematic.built.source.kind === "generate") {
      assert.equal(cinematic.built.source.takes, 2);
      assert.equal(cinematic.built.source.firstFrame, productKitFixture.heroImages[0].uri);
    }
    const plain = buildSource(input({ visualType: "cinematic", prompt: "Slow push-in." }));
    assert.ok(plain.ok && plain.built.source.kind === "generate" && plain.built.source.firstFrame === undefined, "an unpinned cinematic shot has no first frame");
  });

  it("refuses a product hero when the kit has no image to pin", () => {
    const noImages = { ...productKitFixture, heroImages: [], cutouts: [] };
    const result = buildSource(input({ visualType: "product_hero", prompt: "x", productKit: noImages }));
    assert.equal(result.ok, false);
  });

  it("builds stock from the planner's query, with the shot's duration as its minimum", () => {
    const result = buildSource(input({ visualType: "stock_footage", query: "kitchen counter" }));
    assert.deepEqual(result.ok ? result.built.source : null, { kind: "stock", query: "kitchen counter", minMs: 2000 });
    assert.equal(buildSource(input({ visualType: "stock_footage" })).ok, false);
  });

  it("draws a product card from the kit, its approved claims and the hero image, with no text from the model", () => {
    const result = buildSource(
      input({ visualType: "coded_graphics", productKit: productKitFixture, claimIds: ["claim_fixture_1"], shot: { showsProduct: true } }),
    );
    assert.ok(result.ok);
    if (!result.ok || result.built.source.kind !== "component") return;
    assert.equal(result.built.source.component, "product.card");
    assert.deepEqual(result.built.source.props, {
      name: productKitFixture.name,
      bullets: ["Makes four smoothies in under two minutes"],
      heroUri: productKitFixture.heroImages[0].uri,
    });
    assert.equal(result.built.layer, "graphics");
  });

  it("draws a call to action with its keyword from the beat's emphasis, when the shot speaks it", () => {
    const result = buildSource(
      input({
        visualType: "coded_graphics",
        words: ["Send", "BLEND", "to", "get", "the", "link"],
        shot: { beatRole: "cta", emphasis: ["BLEND"] },
      }),
    );
    assert.ok(result.ok);
    if (!result.ok || result.built.source.kind !== "component") return;
    assert.equal(result.built.source.component, "cta.card");
    assert.equal((result.built.source.props as { keyword?: string }).keyword, "BLEND");
  });

  it("draws a kinetic punchline from the shot's words", () => {
    const result = buildSource(input({ visualType: "kinetic_type", words: ["Your", "counter", "is", "lying", "to", "you."] }));
    assert.ok(result.ok);
    if (!result.ok || result.built.source.kind !== "component") return;
    assert.deepEqual(result.built.source.props, { lines: ["Your counter is lying", "to you."] });
  });

  it("refuses a type the plan has no source for", () => {
    const result = buildSource(input({ visualType: "stop_motion" }));
    assert.equal(result.ok, false);
  });
});
