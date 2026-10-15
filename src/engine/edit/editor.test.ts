import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "../compose/compiler.ts";
import { thresholds } from "../config/thresholds.ts";
import { contentHash, edlSchema, idSchema, type EditDecisionList, type EdlClip, type StyleKit } from "../contracts/index.ts";
import * as fx from "../contracts/fixtures/index.ts";
import { buildEdl, editIdentity, type EditBuild, type EditInput } from "./editor.ts";
import { shotId, synthInput, takeId, type SynthOptions } from "./test/inputs.ts";

/** The E1 acceptance chain: five shots over a 24 s voice, three takes, the fixture grammar and the fixture style kit. */
function chainInput(overrides: Partial<EditInput> = {}): EditInput {
  return {
    requestId: fx.productionRequestFixture.requestId,
    plan: fx.scenePlanFixture,
    voice: fx.voiceTrackFixture,
    grammar: fx.videoDnaFixture.editGrammar,
    referenceDurationMs: fx.videoDnaFixture.durationMs,
    takes: [fx.take1Fixture, fx.take2Fixture, fx.take3bFixture],
    kit: fx.styleKitFixture,
    emphasis: [
      { beatId: "b1", term: "lying" },
      { beatId: "b3", term: "one" },
    ],
    ...overrides,
  };
}

function failingChecks(build: EditBuild): string[] {
  return build.checks.filter((check) => !check.pass).map((check) => `${check.rule}: ${check.detail ?? ""}`);
}

function clipsOf(edl: EditDecisionList, layer: string): EdlClip[] {
  return edl.tracks.find((track) => track.layer === layer)?.clips ?? [];
}

function clipsOfShot(edl: EditDecisionList, shot: string): EdlClip[] {
  return edl.tracks.flatMap((track) => track.clips).filter((clip) => clip.clipId === shot || clip.clipId.startsWith(`${shot}-p`));
}

function passing(build: EditBuild): EditDecisionList {
  assert.equal(build.pass, true, `the build passes; failing: ${failingChecks(build).join(" | ")}`);
  assert.ok(build.edl !== null, "a passing build has an EDL");
  return build.edl;
}

// --- the E1 chain fixture ----------------------------------------------------------------------------------------------

test("the E1 chain fixture builds an EDL that passes every check, parses against the contract, and spans the voice", () => {
  const build = buildEdl(chainInput());
  const edl = passing(build);
  assert.deepEqual(edlSchema.parse(edl), edl);
  assert.equal(edl.durationMs, fx.VOICE_DURATION_MS);
  assert.equal(edl.requestId, fx.productionRequestFixture.requestId);
  assert.equal(edl.audio.voice.gainDb, 1.2, "the voice is set to -14 LUFS from its measured -15.2");
  assert.equal(build.failingShotIds.length, 0);
});

test("the hook cut lands at the grammar's first cut scaled to our length, inside the word it falls in", () => {
  const build = buildEdl(chainInput());
  const edl = passing(build);
  // 1100 ms scaled by 24000 / 28000 is 943 ms, which is inside the first word ("kitchen", 429 to 857 ms and "counter" from 857).
  const first = clipsOf(edl, "presenter").map((clip) => clip.endMs)[0];
  assert.equal(first, 857, "the first cut is on a word edge, the nearest to the target");
  assert.ok(build.notes.some((note) => note.startsWith("hook first cut placed at 857 ms (target 943 ms)")), build.notes.join(" | "));
});

test("every voice word appears in a caption, in order, and every caption holds two or three words", () => {
  const edl = passing(buildEdl(chainInput()));
  const captions = clipsOf(edl, "captions");
  assert.ok(captions.length >= 1);
  const shown = captions.flatMap((clip) =>
    ((clip.props?.captions ?? []) as { words: { text: string }[] }[]).flatMap((caption) => caption.words.map((word) => word.text)),
  );
  assert.deepEqual(shown, fx.voiceTrackFixture.words.map((word) => word.text));
  for (const clip of captions) {
    for (const caption of clip.props?.captions as { words: unknown[] }[]) {
      assert.ok(caption.words.length >= 2 && caption.words.length <= 3);
    }
  }
});

test("the same inputs give the same EDL, the same id, the same seed and the same content hash, every time", () => {
  const first = buildEdl(chainInput());
  const second = buildEdl(chainInput());
  assert.deepEqual(second.edl, first.edl);
  assert.equal(second.edlId, first.edlId);
  assert.equal(second.inputHash, first.inputHash);
  assert.equal(second.seed, first.seed);
  assert.equal(contentHash(second.edl), contentHash(first.edl));
  assert.match(first.edlId, /^edl_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
});

test("the EDL id is named by thresholds.version, so a config change gives every EDL a new id (Bible 16.3)", () => {
  const input = chainInput();
  const built = buildEdl(input);
  const expected = editIdentity({ tuning: thresholds.version, input });
  assert.equal(built.edlId, expected.edlId, "the id is the identity of the configuration version and the input");
  assert.equal(built.inputHash, expected.inputHash);
  assert.notEqual(editIdentity({ tuning: "thresholds@0", input }).edlId, built.edlId, "another configuration version names another EDL");
});

test("a different request gives a different seed and EDL id, and the input is not changed", () => {
  const input = chainInput();
  const snapshot = structuredClone(input);
  const base = buildEdl(input);
  assert.deepEqual(input, snapshot, "the editor does not change its input");
  const other = buildEdl(chainInput({ requestId: fx.productionRequestFixture.requestId.replace(/.$/, "Z") }));
  assert.notEqual(other.seed, base.seed);
  assert.notEqual(other.edlId, base.edlId);
});

test("the compiler accepts the EDL built from the E1 chain, and the E1 hand-written EDL, byte for byte the same on repeat", () => {
  const edl = passing(buildEdl(chainInput()));
  const compiled = compile(edl, fx.styleKitFixture);
  assert.ok(compiled.files.some((file) => file.path === "index.html"));
  assert.equal(compile(edl, fx.styleKitFixture).composition.contentHash, compiled.composition.contentHash);
  assert.doesNotThrow(() => compile(fx.edlFixture, fx.styleKitFixture));
});

// --- Bible 8.2 steps, on synthetic inputs ------------------------------------------------------------------------------

test("step 1: an outro holds the last shot, so the timeline is the voice plus the outro", () => {
  const input = synthInput({
    beats: [
      { beatId: "b1", durationMs: 3000 },
      { beatId: "b2", durationMs: 3000 },
    ],
    shots: [
      { n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" },
      { n: 2, beatId: "b2", visualType: "stock_footage", layer: "base", kind: "stock", takeMs: 4200 },
    ],
    kit: { outroMs: 1200 },
    curve: 4000,
  });
  const edl = passing(buildEdl(input));
  assert.equal(edl.durationMs, 7200);
  const last = clipsOfShot(edl, shotId(2)).sort((a, b) => a.startMs - b.startMs).pop();
  assert.equal(last?.endMs, 7200, "the last clip is held through the outro");
});

test("step 4: a shot shorter than half its target merges into a neighbour of the same type that can show the footage", () => {
  const input = synthInput({
    beats: [
      { beatId: "b1", durationMs: 3000 },
      { beatId: "b2", durationMs: 300 },
      { beatId: "b3", durationMs: 3000 },
    ],
    shots: [
      { n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock", takeMs: 3500 },
      { n: 2, beatId: "b2", visualType: "stock_footage", layer: "base", kind: "stock", takeMs: 300 },
      { n: 3, beatId: "b3", visualType: "stock_footage", layer: "base", kind: "stock" },
    ],
    curve: 2000,
  });
  const build = buildEdl(input);
  const edl = passing(build);
  assert.equal(clipsOfShot(edl, shotId(2)).length, 0, "the short shot is merged away");
  assert.ok(clipsOfShot(edl, shotId(1)).length >= 2, "the neighbour keeps its footage");
  assert.ok(build.notes.some((note) => note.startsWith("merged 1 short shot")));
  for (const clip of clipsOf(edl, "base")) assert.ok(clip.endMs - clip.startMs >= 400);
});

test("step 4: a long media shot splits into equal parts, each with a punch-in at its cut, and the parts continue one take", () => {
  const input = synthInput({
    beats: [{ beatId: "b1", durationMs: 9000 }],
    shots: [{ n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" }],
    curve: 2000,
  });
  const edl = passing(buildEdl(input));
  const parts = clipsOfShot(edl, shotId(1)).sort((a, b) => a.startMs - b.startMs);
  assert.ok(parts.length >= 4, `a 9 s shot at a 2 s target splits (got ${parts.length})`);
  for (const part of parts) {
    assert.ok(part.endMs - part.startMs <= 6000 && part.endMs - part.startMs >= 400);
  }
  for (let index = 1; index < parts.length; index += 1) {
    const before = parts[index - 1] as EdlClip;
    const after = parts[index] as EdlClip;
    assert.equal(after.srcInMs, (before.srcInMs ?? 0) + (before.endMs - before.startMs), "the source continues where the last part stopped");
    assert.ok(edl.effects.some((effect) => effect.atMs === after.startMs && effect.kind === "punch_in"), `a punch-in at ${after.startMs} ms`);
  }
});

test("step 4: a presenter shot is not held to the 6 s maximum, but a stock shot is", () => {
  const curve = 10000;
  const presenter = passing(
    buildEdl(
      synthInput({
        beats: [{ beatId: "b1", durationMs: 9000 }],
        shots: [{ n: 1, beatId: "b1", visualType: "ugc_presenter", layer: "presenter", kind: "stock" }],
        curve,
        grammar: { hookFirstCutMs: 9000 },
        referenceDurationMs: 9000,
      }),
    ),
  );
  assert.equal(clipsOfShot(presenter, shotId(1)).length, 1, "9 s is under 1.5 times a 10 s target, so it is not split");

  const stock = buildEdl(
    synthInput({
      beats: [{ beatId: "b1", durationMs: 9000 }],
      shots: [{ n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" }],
      curve,
      grammar: { hookFirstCutMs: 9000 },
      referenceDurationMs: 9000,
    }),
  );
  const parts = clipsOfShot(passing(stock), shotId(1));
  assert.ok(parts.length >= 2, "a stock shot over 6 s is split");
});

test("a component is never split, so a component over 6 s fails the shot-length rule and names its shot", () => {
  const input = synthInput({
    beats: [{ beatId: "b1", durationMs: 7000 }],
    shots: [{ n: 1, beatId: "b1", visualType: "coded_graphics", layer: "graphics", kind: "component", component: "cta.card", props: { text: "Send it" } }],
    curve: 10000,
  });
  const build = buildEdl(input);
  assert.equal(build.pass, false);
  assert.ok(build.failingShotIds.includes(shotId(1)));
  assert.ok(failingChecks(build).some((line) => line.startsWith("shot_length_bounds")));
  assert.ok(build.notes.some((note) => note.includes("components are not split")));
});

test("step 9: captions end on the beat boundary when the size range allows, and a presenter's captions sit in the lower band", () => {
  const input = synthInput({
    beats: [
      { beatId: "b1", durationMs: 1500, words: ["a", "b", "c"] },
      { beatId: "b2", durationMs: 1500, words: ["d", "e", "f"] },
    ],
    shots: [
      { n: 1, beatId: "b1", visualType: "ugc_presenter", layer: "presenter", kind: "stock" },
      { n: 2, beatId: "b2", visualType: "stock_footage", layer: "base", kind: "stock" },
    ],
    grammar: { captions: { wordsPerCaption: [2, 3], position: "upper", style: "karaoke-bold", highlightCurrentWord: true } },
  });
  const edl = passing(buildEdl(input));
  const captionClips = clipsOf(edl, "captions");
  assert.equal(captionClips.length, 2, "a band change starts a new captions clip");
  assert.deepEqual(
    captionClips.map((clip) => (clip.props as { band: string }).band),
    ["lower", "upper"],
    "the presenter's caption moves off the face",
  );
  assert.equal(captionClips[0]?.endMs, 1500, "the first caption ends on the beat");
});

test("step 12: an endsOnLoop reference adds a loop clip of the first take on the cutaway layer, with a fade", () => {
  const input = synthInput({
    beats: [
      { beatId: "b1", durationMs: 2000 },
      { beatId: "b2", durationMs: 2000 },
    ],
    shots: [
      { n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock", takeMs: 2000 },
      { n: 2, beatId: "b2", visualType: "stock_footage", layer: "base", kind: "stock", takeMs: 2000 },
    ],
    curve: 4000,
    grammar: { endsOnLoop: true },
  });
  const edl = passing(buildEdl(input));
  const loop = clipsOf(edl, "cutaway").find((clip) => clip.clipId === "loop_first");
  assert.ok(loop, "the loop clip exists");
  assert.equal(loop.endMs, edl.durationMs);
  assert.equal(loop.srcUri, "store://takes/shot-1.mp4", "it shows the first take");
  assert.equal(loop.transitionIn, "fade");
});

test("step 12: a loop is skipped, with a note, when the first shot is a component", () => {
  const input = synthInput({
    beats: [{ beatId: "b1", durationMs: 2000 }],
    shots: [{ n: 1, beatId: "b1", visualType: "coded_graphics", layer: "graphics", kind: "component", component: "product.card", props: { name: "x" } }],
    curve: 4000,
    grammar: { endsOnLoop: true },
  });
  const build = buildEdl(input);
  assert.ok(build.notes.some((note) => note.startsWith("loop skipped")));
  assert.equal(clipsOf(passing(build), "cutaway").length, 0);
});

test("step 11: with a music track, the music sits under the speech ducked by 18 dB; without a bpm the cuts are not beat-snapped, and that is said", () => {
  const input = synthInput({
    beats: [{ beatId: "b1", durationMs: 3000 }],
    shots: [{ n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" }],
    curve: 2000,
    music: { uri: "store://music/bed.wav", durationMs: 4000 },
  });
  const build = buildEdl(input);
  const edl = passing(build);
  assert.equal(edl.audio.music?.duckDb, -18);
  assert.equal(edl.audio.music?.endMs, 3000);
  assert.ok(build.notes.some((note) => note.includes("music has no bpm")));

  const withBpm = passing(buildEdl({ ...input, music: { uri: "store://music/bed.wav", durationMs: 4000, bpm: 120 } }));
  assert.equal(withBpm.audio.music?.duckDb, -18);
});

test("step 11: music shorter than the timeline is refused, not silently cut", () => {
  const build = buildEdl(
    synthInput({
      beats: [{ beatId: "b1", durationMs: 3000 }],
      shots: [{ n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" }],
      music: { uri: "store://music/short.wav", durationMs: 2000, bpm: 120 },
    }),
  );
  assert.equal(build.pass, false);
  assert.ok(failingChecks(build).some((line) => line.startsWith("music_covers_timeline")));
});

test("steps 6 and 10: an emphasis word gets a punch-in at its start, unless another effect is within 300 ms", () => {
  const input = synthInput({
    beats: [
      { beatId: "b1", durationMs: 1500, words: ["x", "y", "z"] },
      { beatId: "b2", durationMs: 1500, words: ["p", "fox", "q"] },
    ],
    shots: [
      { n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" },
      { n: 2, beatId: "b2", visualType: "stock_footage", layer: "base", kind: "stock" },
    ],
    curve: 4000,
    emphasis: [{ beatId: "b2", term: "fox" }],
  });
  const edl = passing(buildEdl(input));
  const foxStart = 1500 + 500;
  assert.ok(edl.effects.some((effect) => effect.atMs === foxStart && effect.kind === "punch_in"), "a punch-in on the emphasis word");
});

test("step 7 and 8: a kit with no motion keeps whip and flash transitions out; a kit with motion draws them", () => {
  const mix = [{ kind: "whip", share: 1 }];
  const shots = [
    { n: 1, beatId: "b1", visualType: "stock_footage" as const, layer: "base" as const, kind: "stock" as const, takeMs: 2000 },
    { n: 2, beatId: "b2", visualType: "stock_footage" as const, layer: "base" as const, kind: "stock" as const, takeMs: 2000 },
  ];
  const beats = [
    { beatId: "b1", durationMs: 2000 },
    { beatId: "b2", durationMs: 2000 },
  ];
  const still = buildEdl(synthInput({ beats, shots, curve: 4000, grammar: { transitions: mix }, kit: { motionIntensity: 0 } }));
  const stillEdl = passing(still);
  assert.ok(clipsOf(stillEdl, "base").every((clip) => clip.transitionIn !== "whip"));
  assert.ok(still.notes.some((note) => note.includes("whip")), "the dropped kind is named");

  const moving = passing(buildEdl(synthInput({ beats, shots, curve: 4000, grammar: { transitions: mix }, kit: { motionIntensity: 2 } })));
  assert.ok(clipsOf(moving, "base").some((clip) => clip.transitionIn === "whip"));

  const flashes = passing(
    buildEdl(synthInput({ beats, shots, curve: 4000, grammar: { transitions: [{ kind: "flash", share: 1 }] }, kit: { motionIntensity: 2 } })),
  );
  assert.ok(flashes.effects.some((effect) => effect.kind === "flash"), "a flash transition is drawn as a flash effect");
});

test("the effects the editor writes are ones the compiler draws, with scales above 1 and at most 1.5", () => {
  const edl = passing(buildEdl(chainInput()));
  for (const effect of edl.effects) {
    assert.ok(["punch_in", "flash"].includes(effect.kind), `${effect.kind} is drawn`);
    if (effect.kind === "punch_in") {
      assert.ok((effect.params.scale ?? 0) > 1 && (effect.params.scale ?? 0) <= 1.5);
    }
  }
});

test("the notes say what the editor could not place: J and L cuts are always named, and so are sound effects and silence", () => {
  const build = buildEdl(chainInput());
  assert.ok(build.notes.some((note) => note.startsWith("J and L cuts")));
  assert.ok(build.notes.some((note) => note.startsWith("no music track was supplied")));
});

// --- the stage fails closed on what the editor cannot do -------------------------------------------------------------

function synthFailure(options: SynthOptions): EditBuild {
  return buildEdl(synthInput(options));
}

test("a beat with no shot fails the edit, and the check names the beat", () => {
  const build = synthFailure({
    beats: [
      { beatId: "b1", durationMs: 1000 },
      { beatId: "b2", durationMs: 1000 },
    ],
    shots: [{ n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" }],
  });
  assert.equal(build.pass, false);
  assert.ok(failingChecks(build).some((line) => line.startsWith("every_beat_has_shot") && line.includes("b2")));
});

test("a media shot with no chosen take fails the edit and names the shot", () => {
  const build = synthFailure({
    beats: [{ beatId: "b1", durationMs: 1000 }],
    shots: [{ n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" }],
    takes: [],
  });
  assert.equal(build.pass, false);
  assert.deepEqual(build.failingShotIds, [shotId(1)]);
});

test("a take given to a component shot is refused, because a component draws itself", () => {
  const build = synthFailure({
    beats: [{ beatId: "b1", durationMs: 1000 }],
    shots: [{ n: 1, beatId: "b1", visualType: "coded_graphics", layer: "graphics", kind: "component", component: "product.card", props: { name: "x" } }],
    takes: [
      {
        schema: "meridian.take/v1",
        takeId: takeId(1),
        shotId: shotId(1),
        attempt: 1,
        provider: "fixture",
        model: "m",
        uri: "store://takes/stray.mp4",
        durationMs: 1000,
        width: 1080,
        height: 1920,
        promptHash: contentHash("x"),
        costUsd: 0,
        latencyMs: 1,
      },
    ],
  });
  assert.equal(build.pass, false);
  assert.ok(failingChecks(build).some((line) => line.startsWith("takes_match_plan")));
});

test("a take shorter than its shot fails the source rule and names the shot, because the source would run out", () => {
  const build = synthFailure({
    beats: [{ beatId: "b1", durationMs: 6000 }],
    shots: [{ n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock", takeMs: 5000 }],
    curve: 2000,
  });
  assert.equal(build.pass, false);
  assert.ok(build.failingShotIds.includes(shotId(1)));
  assert.ok(failingChecks(build).some((line) => line.startsWith("sources_cover_clips")));
});

test("four shots of one type in a row fail the run rule and name all four", () => {
  // Each shot is 1 s. A 0.8 s target keeps them from merging (they are over half the target), so the run survives the steps.
  const shots = [1, 2, 3, 4].map((n) => ({ n, beatId: `b${n}`, visualType: "coded_graphics" as const, layer: "graphics" as const, kind: "component" as const, component: "product.card", props: { name: "x" } }));
  const beats = [1, 2, 3, 4].map((n) => ({ beatId: `b${n}`, durationMs: 1000 }));
  const build = synthFailure({ beats, shots, curve: 800 });
  assert.equal(build.pass, false);
  assert.deepEqual(build.failingShotIds, [1, 2, 3, 4].map((n) => shotId(n)));
});

test("captions that cannot be split into the grammar's range fail the edit", () => {
  const build = synthFailure({
    beats: [{ beatId: "b1", durationMs: 2500, words: ["a", "b", "c", "d", "e"] }],
    shots: [{ n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" }],
    grammar: { captions: { wordsPerCaption: [2, 2], position: "lower", style: "karaoke-bold", highlightCurrentWord: true } },
  });
  assert.equal(build.pass, false);
  assert.ok(failingChecks(build).some((line) => line.startsWith("captions_grouped_in_range")));
});

test("a voice that needs more than +12 dB to reach -14 LUFS fails: the compiler cannot play that gain", () => {
  const build = synthFailure({
    beats: [{ beatId: "b1", durationMs: 2000 }],
    shots: [{ n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" }],
    voiceLufs: -30,
    curve: 4000,
  });
  assert.equal(build.pass, false);
  assert.ok(failingChecks(build).some((line) => line.startsWith("voice_gain_drawable")));
});

test("a kit whose captions are not the karaoke component fails the style check", () => {
  const style: Partial<StyleKit> = { captionStyle: { component: "captions.boxed", highlight: "#FFD60A", weight: 700, case: "upper" } };
  const build = synthFailure({
    beats: [{ beatId: "b1", durationMs: 1000 }],
    shots: [{ n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" }],
    kit: style,
  });
  assert.equal(build.pass, false);
  assert.ok(failingChecks(build).some((line) => line.startsWith("style_kit_drawable")));
});

test("an asset shot is refused, because the editor cannot check that an existing asset covers its clip", () => {
  const input = synthInput({
    beats: [{ beatId: "b1", durationMs: 1000 }],
    shots: [{ n: 1, beatId: "b1", visualType: "stock_footage", layer: "base", kind: "stock" }],
  });
  const plan = { ...input.plan, shots: input.plan.shots.map((shot) => ({ ...shot, source: { kind: "asset" as const, assetUri: "store://a.mp4" } })) };
  const build = buildEdl({ ...input, plan });
  assert.equal(build.pass, false);
  assert.ok(failingChecks(build).some((line) => line.startsWith("shot_sources_available")));
});

test("the synthetic shot and take ids are valid prefixed ids, so failing shot names pass the gate's schema", () => {
  assert.ok(idSchema("shot_").safeParse(shotId(1)).success);
  assert.ok(idSchema("take_").safeParse(takeId(1)).success);
});
