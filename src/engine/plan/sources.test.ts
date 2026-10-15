import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { personaFixture, productKitFixture } from "../contracts/fixtures/index.ts";
import type { CharacterSheet } from "../contracts/index.ts";
import { stopMotionTiming } from "./chains.ts";
import {
  COMPONENT_BUILD_TYPES,
  buildSource,
  cartoonGeneratedChain,
  checkComponentProps,
  chainKitRefusal,
  componentBuildRefusals,
  componentRefusals,
  emphasisIn,
  kineticLinesOf,
  mouthShapeFor,
  mouthTimelineOf,
  sentencesOf,
  stopMotionChain,
  timedLinesOf,
  wordSpanOf,
  type BuildSourceInput,
} from "./sources.ts";
import { PROMPT_STYLE } from "./tables.ts";

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
    const result = buildSource(input({ visualType: "react_clip" }));
    assert.equal(result.ok, false);
  });
});

// --- E5 -----------------------------------------------------------------------------------------------------------------

const RIG_SHEET: CharacterSheet = {
  characterId: "char_rig_test",
  version: 1,
  kind: "rigged_svg",
  rigUri: "store://rigs/test.svg",
  poses: ["idle", "point", "shrug", "cheer", "think", "surprise"],
  visemes: ["closed", "open", "wide", "round", "teeth"],
};

const GENERATED_SHEET: CharacterSheet = {
  characterId: "char_gen_test",
  version: 1,
  kind: "generated",
  references: ["store://characters/front.png", "store://characters/side.png"],
  styleNotes: "Rounded shapes",
};

describe("cinematic: the code's look goes in front of the planner's scene", () => {
  it("prefixes the cinematic style to the prompt, and keeps the scene after it", () => {
    const result = buildSource(input({ visualType: "cinematic", prompt: "A kitchen at dawn, slow push-in." }));
    assert.ok(result.ok);
    if (!result.ok || result.built.source.kind !== "generate") return;
    assert.equal(result.built.source.prompt, `${PROMPT_STYLE.cinematic} A kitchen at dawn, slow push-in.`);
    assert.equal(result.built.source.modelClass, "video.cinematic");
    assert.equal(result.built.source.takes, 2);
  });
});

describe("kinetic.type: emphasis words make a kinetic shot, and each line starts at its word's time", () => {
  it("draws kinetic.type with the lines' start times from the voice spans, and the emphasis the shot speaks", () => {
    const spans = [
      { startMs: 0, endMs: 300 },
      { startMs: 300, endMs: 600 },
      { startMs: 600, endMs: 700 },
      { startMs: 700, endMs: 1100 },
      { startMs: 1200, endMs: 1500 },
    ];
    const result = buildSource(
      input({
        visualType: "kinetic_type",
        words: ["Stop", "buying", "the", "expensive", "blender"],
        shot: { emphasis: ["Expensive", "later"], durationMs: 2000, spans },
      }),
    );
    assert.ok(result.ok);
    if (!result.ok || result.built.source.kind !== "component") return;
    assert.equal(result.built.source.component, "kinetic.type");
    assert.deepEqual(result.built.source.props, {
      lines: [
        { text: "Stop buying the expensive", atMs: 0 },
        { text: "blender", atMs: 1200 },
      ],
      emphasis: ["Expensive"],
      entrance: "stagger",
      band: "middle",
    });
  });

  it("shares the shot's length evenly between the words when the voice spans are not given", () => {
    const result = buildSource(
      input({ visualType: "kinetic_type", words: ["Stop", "buying", "the", "expensive", "blender"], shot: { emphasis: ["blender"], durationMs: 2000 } }),
    );
    assert.ok(result.ok && result.built.source.kind === "component");
    if (!result.ok || result.built.source.kind !== "component") return;
    assert.deepEqual((result.built.source.props as { lines: unknown[] }).lines, [
      { text: "Stop buying the expensive", atMs: 0 },
      { text: "blender", atMs: 1600 },
    ]);
  });

  it("refuses word timings that do not line up with the words, for any type", () => {
    const result = buildSource(
      input({ visualType: "kinetic_type", words: ["a", "b"], shot: { spans: [{ startMs: 0, endMs: 100 }] } }),
    );
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /word timings/);
  });

  it("refuses kinetic type with more emphasis words than the component holds (four)", () => {
    const refusals = componentRefusals({
      durationMs: 3000,
      beatRole: "item",
      showsProduct: false,
      words: ["one", "two", "three", "four", "five"],
      emphasis: ["one", "two", "three", "four", "five"],
    });
    assert.ok(refusals.kinetic_type, "five emphasis words are too many for kinetic.type");
  });

  it("refuses kinetic type, and does not read past the end, when the word timings do not match the words", () => {
    const refusals = componentRefusals({
      durationMs: 2000,
      beatRole: "item",
      showsProduct: false,
      words: ["a", "b"],
      emphasis: ["a"],
      spans: [{ startMs: 0, endMs: 100 }],
    });
    assert.match(refusals.kinetic_type ?? "", /word timings/);
  });
});

describe("cartoon_rigged: one rig, drawn from the page's character sheet", () => {
  const shot = { words: ["Four", "smoothies"], durationMs: 1000, beatRole: "twist" as const, showsProduct: false, emphasis: [] };

  it("refuses without a sheet, with a generated sheet, and with a sheet that lacks the idle pose or the open and closed mouths", () => {
    const none = buildSource({ visualType: "cartoon_rigged", shot: { shotId: "s", ...shot }, claimIds: [] });
    assert.match(none.ok ? "" : none.reason, /rigged character sheet/);
    const generated = buildSource({ visualType: "cartoon_rigged", shot: { shotId: "s", ...shot }, character: GENERATED_SHEET, claimIds: [] });
    assert.match(generated.ok ? "" : generated.reason, /not a rigged SVG sheet/);
    const noIdle = buildSource({
      visualType: "cartoon_rigged",
      shot: { shotId: "s", ...shot },
      character: { ...RIG_SHEET, poses: ["point"] },
      claimIds: [],
    });
    assert.match(noIdle.ok ? "" : noIdle.reason, /idle pose/);
    const fixtureSheet = buildSource({
      visualType: "cartoon_rigged",
      shot: { shotId: "s", ...shot },
      character: { ...RIG_SHEET, visemes: ["A", "E", "O", "M", "rest"] },
      claimIds: [],
    });
    assert.match(fixtureSheet.ok ? "" : fixtureSheet.reason, /closed and open/);
  });

  it("draws character.rig: the beat's pose and expression at 0, and one mouth shape per word from its first vowel", () => {
    const result = buildSource({ visualType: "cartoon_rigged", shot: { shotId: "s", ...shot }, character: RIG_SHEET, claimIds: [] });
    assert.ok(result.ok);
    if (!result.ok || result.built.source.kind !== "component") return;
    assert.equal(result.built.source.component, "character.rig");
    assert.equal(result.built.layer, "graphics");
    assert.deepEqual(result.built.source.props, {
      rigId: "bean.v1",
      characterId: "char_rig_test",
      position: "center",
      poses: [{ atMs: 0, pose: "think", expression: "annoyed" }],
      mouth: [
        { atMs: 0, shape: "round" },
        { atMs: 350, shape: "closed" },
        { atMs: 500, shape: "round" },
        { atMs: 850, shape: "closed" },
      ],
    });
  });

  it("falls back to the idle pose and the open mouth when the sheet does not list the role's pose or shape", () => {
    const sheet = { ...RIG_SHEET, poses: ["idle"], visemes: ["closed", "open"] };
    const result = buildSource({ visualType: "cartoon_rigged", shot: { shotId: "s", ...shot }, character: sheet, claimIds: [] });
    assert.ok(result.ok && result.built.source.kind === "component");
    if (!result.ok || result.built.source.kind !== "component") return;
    const props = result.built.source.props as { poses: Array<{ pose: string; expression: string }>; mouth: Array<{ shape: string }> };
    assert.equal(props.poses[0].pose, "idle");
    assert.equal(props.poses[0].expression, "annoyed", "the expression is the beat's; only the pose falls back");
    assert.ok(props.mouth.every((event) => event.shape === "open" || event.shape === "closed"));
  });
});

describe("screen_mock: a screen from the shot's own words and the product kit, with no invented content", () => {
  const kitInput = { productKit: productKitFixture };

  it("shows two or more sentences as a chat, alternating sides, each message at its sentence's start", () => {
    const chat = buildSource(input({ visualType: "screen_mock", words: ["Is", "this", "loud?", "Not", "at", "all."], shot: { durationMs: 2000 } }));
    assert.ok(chat.ok && chat.built.source.kind === "component");
    if (!chat.ok || chat.built.source.kind !== "component") return;
    assert.equal(chat.built.source.component, "screen.mock");
    assert.deepEqual(chat.built.source.props, {
      screen: "chat",
      messages: [
        { side: "left", text: "Is this loud?", atMs: 0 },
        { side: "right", text: "Not at all.", atMs: 1000 },
      ],
    });
  });

  it("shows one sentence with approved claims as an app screen of those claims, with the product picture", () => {
    const result = buildSource(
      input({ visualType: "screen_mock", words: ["Four", "smoothies", "in", "two", "minutes"], claimIds: ["claim_fixture_1"], ...kitInput }),
    );
    assert.ok(result.ok && result.built.source.kind === "component");
    if (!result.ok || result.built.source.kind !== "component") return;
    assert.deepEqual(result.built.source.props, {
      screen: "app",
      title: productKitFixture.name,
      rows: [{ label: "Makes four smoothies in under two minutes" }],
      imageUri: productKitFixture.heroImages[0].uri,
    });
  });

  it("shows one sentence with no claims as a notification from the product's app", () => {
    const result = buildSource(input({ visualType: "screen_mock", words: ["Four", "smoothies", "in", "two", "minutes"], ...kitInput }));
    assert.ok(result.ok && result.built.source.kind === "component");
    if (!result.ok || result.built.source.kind !== "component") return;
    assert.deepEqual(result.built.source.props, {
      screen: "notification",
      app: productKitFixture.name,
      title: "Four smoothies in two minutes",
      timeLabel: "now",
      iconUri: productKitFixture.heroImages[0].uri,
    });
  });

  it("refuses a one-line notification with no product kit (no app name to show), an empty shot, and a chat over six messages", () => {
    const noApp = buildSource(input({ visualType: "screen_mock", words: ["Four", "smoothies"] }));
    assert.match(noApp.ok ? "" : noApp.reason, /product's name/);
    const silent = buildSource(input({ visualType: "screen_mock", words: [], ...kitInput }));
    assert.match(silent.ok ? "" : silent.reason, /no words/);
    const seven = Array.from({ length: 7 }, (_, index) => `Line ${index + 1}.`);
    const long = buildSource(input({ visualType: "screen_mock", words: seven, shot: { durationMs: 7000 } }));
    assert.match(long.ok ? "" : long.reason, /holds 6 messages/);
  });
});

describe("cartoon_generated and stop_motion: chains of calls (contract v5)", () => {
  it("buildSource returns a chain source for both, with the calls the builders make", () => {
    const cartoon = buildSource(input({ visualType: "cartoon_generated", prompt: "The bean jumps.", character: GENERATED_SHEET }));
    assert.ok(cartoon.ok);
    if (!cartoon.ok) return;
    assert.equal(cartoon.built.layer, "base");
    assert.equal(cartoon.built.source.kind, "chain");
    const stop = buildSource(input({ visualType: "stop_motion", prompt: "A bean hops.", productKit: productKitFixture, shot: { durationMs: 2500 } }));
    assert.ok(stop.ok);
    if (!stop.ok) return;
    assert.equal(stop.built.source.kind, "chain");
    assert.equal(stop.built.source.kind === "chain" ? stop.built.source.calls.length : 0, 30);
  });

  it("builds the cartoon chain: a keyframe with every reference, then a video that takes the keyframe, both in the code's look", () => {
    const chain = cartoonGeneratedChain(input({ visualType: "cartoon_generated", prompt: "The bean jumps.", character: GENERATED_SHEET }));
    assert.ok(chain.ok);
    if (!chain.ok) return;
    const style = `${PROMPT_STYLE.cartoon_generated} The bean jumps.`;
    const refs = (GENERATED_SHEET.references ?? []).map((uri) => ({ kind: "asset", uri }));
    assert.deepEqual(chain.value, [
      { output: "keyframe", modelClass: "image.keyframe", prompt: style, refs, takes: 1 },
      { output: "clip", modelClass: "video.budget", prompt: style, refs, firstFrame: { kind: "output", output: "keyframe" }, takes: 1 },
    ]);
  });

  it("refuses the cartoon chain without a generated sheet, without references, or without a prompt", () => {
    assert.equal(cartoonGeneratedChain(input({ visualType: "cartoon_generated", prompt: "x", character: RIG_SHEET })).ok, false);
    assert.equal(
      cartoonGeneratedChain(input({ visualType: "cartoon_generated", prompt: "x", character: { ...GENERATED_SHEET, references: [] } })).ok,
      false,
    );
    assert.equal(cartoonGeneratedChain(input({ visualType: "cartoon_generated", character: GENERATED_SHEET })).ok, false);
  });

  it("times stop-motion frames at 24 to 36 frames and 8 to 12 per second, and refuses shots outside about 2 to 4.5 seconds", () => {
    assert.deepEqual(stopMotionTiming(2000), { ok: true, value: { frames: 24, fps: 12 } });
    assert.deepEqual(stopMotionTiming(2500), { ok: true, value: { frames: 30, fps: 12 } });
    assert.deepEqual(stopMotionTiming(3000), { ok: true, value: { frames: 36, fps: 12 } });
    assert.deepEqual(stopMotionTiming(4500), { ok: true, value: { frames: 36, fps: 8 } });
    assert.equal(stopMotionTiming(4600).ok, false);
    assert.equal(stopMotionTiming(1900).ok, false);
  });

  it("builds the stop-motion chain: each frame reads the hero image and the frame before it, in order", () => {
    const hero = productKitFixture.heroImages[0].uri;
    const chain = stopMotionChain(input({ visualType: "stop_motion", prompt: "A bean hops.", productKit: productKitFixture, shot: { durationMs: 2500 } }));
    assert.ok(chain.ok);
    if (!chain.ok) return;
    assert.equal(chain.value.length, 30);
    const [first, second, last] = [chain.value[0], chain.value[1], chain.value[29]];
    assert.equal(first?.output, "frame_01");
    assert.deepEqual(first?.refs, [{ kind: "asset", uri: hero }]);
    assert.equal(second?.output, "frame_02");
    assert.deepEqual(second?.refs, [{ kind: "asset", uri: hero }, { kind: "output", output: "frame_01" }]);
    assert.equal(last?.output, "frame_30");
    assert.deepEqual(last?.refs, [{ kind: "asset", uri: hero }, { kind: "output", output: "frame_29" }]);
    assert.ok(chain.value.every((call) => call.modelClass === "image.edit" && call.takes === 1));
    assert.ok(chain.value.every((call) => call.prompt === `${PROMPT_STYLE.stop_motion} A bean hops.`));
  });

  it("refuses the stop-motion chain without a hero image, without a prompt, or at a length it cannot make", () => {
    assert.equal(stopMotionChain(input({ visualType: "stop_motion", prompt: "x", shot: { durationMs: 2500 } })).ok, false);
    assert.equal(stopMotionChain(input({ visualType: "stop_motion", productKit: productKitFixture, shot: { durationMs: 2500 } })).ok, false);
    const long = stopMotionChain(input({ visualType: "stop_motion", prompt: "x", productKit: productKitFixture, shot: { durationMs: 6000 } }));
    assert.equal(long.ok, false);
    assert.match(long.ok ? "" : long.reason, /2 to 4.5 seconds/);
  });

  it("chainKitRefusal names the kit a chain needs, without a prompt, so the filter can remove the type first", () => {
    assert.equal(chainKitRefusal("cartoon_generated", input({ character: GENERATED_SHEET })), null);
    assert.match(chainKitRefusal("cartoon_generated", input({ character: RIG_SHEET })) ?? "", /generated character sheet/);
    assert.equal(chainKitRefusal("stop_motion", input({ productKit: productKitFixture, shot: { durationMs: 2500 } })), null);
    assert.match(chainKitRefusal("stop_motion", input({ shot: { durationMs: 2500 } })) ?? "", /hero image/);
    assert.match(chainKitRefusal("stop_motion", input({ productKit: productKitFixture, shot: { durationMs: 6000 } })) ?? "", /2 to 4.5 seconds/);
  });

  it("componentBuildRefusals removes a chain whose kit or length it cannot make, and keeps one it can", () => {
    const base = { shot: input({}).shot, claimIds: [] as string[] };
    const withKits = componentBuildRefusals({ ...base, productKit: productKitFixture, character: GENERATED_SHEET, shot: { ...base.shot, durationMs: 2500 } });
    assert.equal(withKits.cartoon_generated, undefined);
    assert.equal(withKits.stop_motion, undefined);
    const bare = componentBuildRefusals({ ...base, shot: { ...base.shot, durationMs: 2500 } });
    assert.match(bare.cartoon_generated ?? "", /generated character sheet/);
    assert.match(bare.stop_motion ?? "", /hero image/);
  });
});

describe("word timing helpers", () => {
  it("opens the mouth on a round vowel for o and u, a wide one for e, i and y, and an open one otherwise", () => {
    assert.equal(mouthShapeFor("Four"), "round");
    assert.equal(mouthShapeFor("in"), "wide");
    assert.equal(mouthShapeFor("cat"), "open");
    assert.equal(mouthShapeFor("mmm"), "open");
  });

  it("splits sentences at . ! or ?, with the index of each sentence's first word", () => {
    const sentences = sentencesOf(["Stop.", "Now", "go!", "ok"]);
    assert.deepEqual(sentences, [
      { words: ["Stop."], start: 0 },
      { words: ["Now", "go!"], start: 1 },
      { words: ["ok"], start: 3 },
    ]);
  });

  it("places each word evenly when no spans are given, and uses the spans when they are", () => {
    const even = { durationMs: 1000, words: ["a", "b", "c", "d"] };
    assert.deepEqual(wordSpanOf(even, 2), { startMs: 500, endMs: 675 }, "250 ms a word, the word held for 70 per cent of it");
    const timed = { ...even, spans: [{ startMs: 0, endMs: 200 }, { startMs: 200, endMs: 400 }, { startMs: 500, endMs: 900 }, { startMs: 900, endMs: 1000 }] };
    assert.deepEqual(wordSpanOf(timed, 2), { startMs: 500, endMs: 900 });
    assert.deepEqual(mouthTimelineOf(timed).slice(4, 6), [
      { atMs: 500, shape: "open" },
      { atMs: 900, shape: "closed" },
    ]);
    assert.deepEqual(timedLinesOf(even).map((line) => line.atMs), [0]);
  });

  it("closes a mouth no later than the next word opens, so overlapping word spans keep the timeline in order", () => {
    const overlapping = { durationMs: 1000, words: ["a", "b"], spans: [{ startMs: 0, endMs: 600 }, { startMs: 400, endMs: 900 }] };
    assert.deepEqual(mouthTimelineOf(overlapping), [
      { atMs: 0, shape: "open" },
      { atMs: 400, shape: "closed" },
      { atMs: 400, shape: "open" },
      { atMs: 900, shape: "closed" },
    ]);
  });
});

// --- E5 follow-up: the spans and the page's sheet reach the sources; a shot the sources cannot draw is refused before planning ---

describe("the voice's spans and the page's rig reach the rig and the screen (E5 follow-up)", () => {
  it("times the rig's mouth from the spans the shot is given, not from an even split", () => {
    const shot = { words: ["Four", "smoothies"], durationMs: 1000, beatRole: "twist" as const, showsProduct: false, emphasis: [] };
    const result = buildSource({
      visualType: "cartoon_rigged",
      shot: { shotId: "s", ...shot, spans: [{ startMs: 100, endMs: 300 }, { startMs: 600, endMs: 700 }] },
      character: RIG_SHEET,
      claimIds: [],
    });
    assert.ok(result.ok && result.built.source.kind === "component");
    if (!result.ok || result.built.source.kind !== "component") return;
    assert.deepEqual((result.built.source.props as { mouth: unknown[] }).mouth, [
      { atMs: 100, shape: "round" },
      { atMs: 300, shape: "closed" },
      { atMs: 600, shape: "round" },
      { atMs: 700, shape: "closed" },
    ]);
  });

  it("starts each chat message at its first word's span, not at an even split of the shot", () => {
    const result = buildSource(
      input({
        visualType: "screen_mock",
        words: ["Is", "this", "loud?", "Not", "at", "all."],
        shot: { durationMs: 2000, spans: [0, 200, 400, 1500, 1600, 1700].map((startMs) => ({ startMs, endMs: startMs + 100 })) },
      }),
    );
    assert.ok(result.ok && result.built.source.kind === "component");
    if (!result.ok || result.built.source.kind !== "component") return;
    assert.deepEqual((result.built.source.props as { messages: Array<{ atMs: number }> }).messages.map((message) => message.atMs), [0, 1500]);
  });
});

describe("componentBuildRefusals: each component's source is built before the planner runs, and a refusal names the reason", () => {
  const SHOT_INPUT = { shot: { ...SHOT, words: ["Four", "smoothies", "in", "two", "minutes"] }, claimIds: ["claim_fixture_1"] };

  it("names the component types the shot can be drawn as, with no refusal when every source builds", () => {
    const refusals = componentBuildRefusals({ ...SHOT_INPUT, productKit: productKitFixture, character: RIG_SHEET });
    for (const type of COMPONENT_BUILD_TYPES) assert.equal(refusals[type], undefined, `${type} is drawable with its kits and sheet`);
    assert.match(refusals.cartoon_generated ?? "", /generated character sheet/, "a rig sheet is not the generated sheet a cartoon chain needs");
    assert.deepEqual(COMPONENT_BUILD_TYPES, ["kinetic_type", "coded_graphics", "cartoon_rigged", "screen_mock"]);
  });

  it("refuses cartoon_rigged without a sheet that lists the rig's names, with the reason from the sheet", () => {
    const none = componentBuildRefusals(SHOT_INPUT);
    assert.match(none.cartoon_rigged ?? "", /rigged character sheet/);
    const phonemes = componentBuildRefusals({ ...SHOT_INPUT, character: { ...RIG_SHEET, visemes: ["A", "E", "O", "M", "rest"] } });
    assert.match(phonemes.cartoon_rigged ?? "", /closed and open/);
  });

  it("refuses a one-line screen with no product name, and a chat whose messages are over the component's text limit", () => {
    const oneLine = componentBuildRefusals({ shot: { ...SHOT, words: ["Four", "smoothies"] }, claimIds: [] });
    assert.match(oneLine.screen_mock ?? "", /product's name/);
    const longSentence = Array.from({ length: 40 }, () => "smoothie").join(" ") + ".";
    const chat = componentBuildRefusals({
      shot: { ...SHOT, words: [...longSentence.split(" "), "Yes."], durationMs: 6000 },
      productKit: productKitFixture,
      claimIds: [],
    });
    assert.ok(chat.screen_mock, "a message of 40 words, about 360 characters, is over the chat's 160-character limit");
  });

  it("refuses kinetic type for a shot whose words the component cannot hold, and coded graphics for a product card with no kit", () => {
    const words = Array.from({ length: 30 }, (_, index) => `w${index}`);
    const kinetic = componentBuildRefusals({ shot: { ...SHOT, words, emphasis: [] }, claimIds: [] });
    assert.ok(kinetic.kinetic_type, "thirty words are over the six lines of kinetic.punchline");
    const product = componentBuildRefusals({ shot: { ...SHOT, showsProduct: true, words: ["Four"] }, claimIds: [] });
    assert.match(product.coded_graphics ?? "", /product kit/, "a product card needs the product kit and its hero image");
  });
});
