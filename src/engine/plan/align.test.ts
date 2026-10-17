import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError, idSchema } from "../contracts/index.ts";
import { videoDnaFixture, voiceTrackFixture, productionRequestFixture, FIXTURE_IDS } from "../contracts/fixtures/index.ts";
import { alignBeat, alignmentDecisions, alignShots, DEFAULT_SHOT_LENGTH, shotIdFor, splitBeat, timedWordsOfShot, wordsOfShot, type AlignInput } from "./align.ts";
import { BLENDER } from "./test/helpers.ts";
import { scriptOf } from "../script/resolve.ts";

const LIMITS = { minMs: 400, maxMs: 6000 };

function fixtureAlignInput(overrides: Partial<AlignInput> = {}): AlignInput {
  return {
    requestId: FIXTURE_IDS.request,
    beats: scriptOf(productionRequestFixture, null).beats.map((beat) => ({ beatId: beat.beatId, role: beat.role, emphasis: beat.emphasis })),
    visualRequests: productionRequestFixture.visualRequests,
    classifications: [{ beatId: "b3", want: BLENDER, properties: ["real_product"] }],
    voice: { durationMs: voiceTrackFixture.durationMs, beatSpans: voiceTrackFixture.beatSpans, words: voiceTrackFixture.words },
    reference: {
      durationMs: videoDnaFixture.durationMs,
      segments: videoDnaFixture.segments.map((segment) => ({
        segId: segment.segId,
        startMs: segment.startMs,
        endMs: segment.endMs,
        shotType: segment.shotType,
        beatRole: segment.beatRole,
      })),
      shotLengthCurveMs: videoDnaFixture.editGrammar.shotLengthMs.curve,
    },
    ...overrides,
  };
}

describe("step 2: splitting a beat along the shot-length curve", () => {
  it("tiles the beat exactly: the pieces sum to its duration, in whole milliseconds", () => {
    for (const [start, end] of [[0, 3000], [3000, 9000], [9000, 9001], [5000, 14137]]) {
      const split = splitBeat({ beatId: "x", startMs: start, endMs: end }, 24000, [2100, 2000, 1900, 1800, 1800, 1700, 1900, 2000, 1700, 1600], LIMITS);
      assert.equal(split.durationsMs.reduce((sum, ms) => sum + ms, 0), end - start, `tiles ${start}-${end}`);
      assert.ok(split.durationsMs.every((ms) => Number.isInteger(ms)));
    }
  });

  it("keeps every piece inside the shot-length limits when the beat allows it", () => {
    const split = splitBeat({ beatId: "x", startMs: 0, endMs: 12000 }, 24000, [1500], LIMITS);
    assert.ok(split.durationsMs.every((ms) => ms >= LIMITS.minMs && ms <= LIMITS.maxMs));
  });

  it("cuts a long beat into the number of shots nearest its target length", () => {
    // The centre of 6000 to 12000 is 9000 of 24000, which is 37.5%: tenth index 3, whose curve value is 1800 ms.
    // Six seconds at 1800 ms is three shots (6000 / 1800 rounds to 3), of 2000 ms each.
    const split = splitBeat({ beatId: "x", startMs: 6000, endMs: 12000 }, 24000, [2100, 2000, 1900, 1800, 1800, 1700, 1900, 2000, 1700, 1600], LIMITS);
    assert.equal(split.shotCount, 3);
    assert.deepEqual(split.durationsMs, [2000, 2000, 2000]);
    assert.equal(split.curveTenth, 3, "the beat's centre is in the fourth tenth");
    assert.equal(split.targetMs, 1800);
  });

  it("keeps a short beat as one shot", () => {
    const split = splitBeat({ beatId: "x", startMs: 0, endMs: 1200 }, 24000, [2100], LIMITS);
    assert.equal(split.shotCount, 1);
    assert.deepEqual(split.durationsMs, [1200]);
  });

  it("holds the target within the configured limits", () => {
    const split = splitBeat({ beatId: "x", startMs: 0, endMs: 10000 }, 10000, [9000], LIMITS);
    assert.equal(split.targetMs, LIMITS.maxMs, "a curve value over the maximum is held to the maximum");
  });

  it("uses the configured defaults from config/thresholds.ts", () => {
    assert.equal(DEFAULT_SHOT_LENGTH.minMs, 400);
    assert.equal(DEFAULT_SHOT_LENGTH.maxMs, 6000);
  });
});

describe("step 1: aligning a beat to the reference", () => {
  it("aligns by role first, then by relative position", () => {
    const input = fixtureAlignInput();
    const hook = alignBeat(
      { beatId: "b1", role: "hook" },
      { startMs: 0, endMs: 3000 },
      input,
    );
    assert.equal(hook.segId, "seg_1", "the only hook segment");
    assert.equal(hook.refShot, "talking_head");
    assert.equal(hook.byPositionOnly, false);
  });

  it("falls back to position alone when no reference segment has the beat's role", () => {
    const input = fixtureAlignInput();
    const alignment = alignBeat({ beatId: "b2", role: "twist" }, { startMs: 3000, endMs: 9000 }, input);
    assert.equal(alignment.byPositionOnly, true);
    assert.equal(alignment.segId, "seg_2", "the segment nearest the beat's centre");
  });

  it("lists the other candidates of the pool with their scores, best first", () => {
    const input = fixtureAlignInput();
    const onlySetup = alignBeat({ beatId: "b2", role: "setup" }, { startMs: 3000, endMs: 9000 }, input);
    assert.equal(onlySetup.segId, "seg_2");
    assert.deepEqual(onlySetup.alternatives, [], "one segment has the setup role, so there is nothing else in its pool");
    const byPosition = alignBeat({ beatId: "b2", role: "twist" }, { startMs: 3000, endMs: 9000 }, input);
    assert.ok(byPosition.alternatives.length === input.reference.segments.length - 1, "position alone ranks every segment");
    const scores = byPosition.alternatives.map((item) => item.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "alternatives are ordered by score");
  });
});

describe("the whole alignment", () => {
  it("returns shots that tile the voice from 0 to its duration, in timeline order", () => {
    const output = alignShots(fixtureAlignInput());
    assert.equal(output.shots[0].startMs, 0);
    for (let index = 1; index < output.shots.length; index++) {
      assert.equal(output.shots[index].startMs, output.shots[index - 1].endMs);
    }
    assert.equal(output.shots[output.shots.length - 1].endMs, voiceTrackFixture.durationMs);
    assert.ok(output.shots.every((shot) => idSchema("shot_").safeParse(shot.shotId).success), "every shot id is a shot_ ULID");
  });

  it("gives the same shot ids for the same request, and different ids for different pieces", () => {
    assert.equal(shotIdFor(FIXTURE_IDS.request, "b2", 0), shotIdFor(FIXTURE_IDS.request, "b2", 0));
    assert.notEqual(shotIdFor(FIXTURE_IDS.request, "b2", 0), shotIdFor(FIXTURE_IDS.request, "b2", 1));
    const ids = alignShots(fixtureAlignInput()).shots.map((shot) => shot.shotId);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("sets the product and text flags from the classified requests", () => {
    const shots = alignShots(fixtureAlignInput()).shots;
    assert.ok(shots.filter((shot) => shot.beatId === "b3").every((shot) => shot.flags.showsProduct));
    assert.ok(shots.filter((shot) => shot.beatId !== "b3").every((shot) => !shot.flags.showsProduct));
  });

  it("sets text in pixels when a request asks to see words in the picture, and hands on the product for a hands request", () => {
    const withSign = fixtureAlignInput({
      visualRequests: [{ beatId: "b3", want: "a sign reading OPEN on the counter", strength: "must" }],
      classifications: [{ beatId: "b3", want: "a sign reading OPEN on the counter", properties: ["real_product"] }],
    });
    assert.ok(alignShots(withSign).shots.filter((shot) => shot.beatId === "b3").every((shot) => shot.flags.textInPixels));
    const withHands = fixtureAlignInput({
      visualRequests: [{ beatId: "b3", want: "hands pour the blender", strength: "may" }],
      classifications: [{ beatId: "b3", want: "hands pour the blender", properties: ["real_product"] }],
    });
    assert.ok(alignShots(withHands).shots.filter((shot) => shot.beatId === "b3").every((shot) => shot.flags.handsOnProduct));
  });

  it("refuses a request with no classification", () => {
    assert.throws(() => alignShots(fixtureAlignInput({ classifications: [] })), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("refuses a voice whose beat spans leave a gap, overlap, or do not end at the voice", () => {
    const spans = voiceTrackFixture.beatSpans;
    const gap = fixtureAlignInput({ voice: { ...fixtureAlignInput().voice, beatSpans: [spans[0], { ...spans[1], startMs: 3100 }, ...spans.slice(2)] } });
    assert.throws(() => alignShots(gap), (error: unknown) => error instanceof EngineError && /gap or an overlap/.test(error.message));
    const short = fixtureAlignInput({ voice: { ...fixtureAlignInput().voice, durationMs: 23000 } });
    assert.throws(() => alignShots(short), (error: unknown) => error instanceof EngineError && /not at the voice/.test(error.message));
  });

  it("refuses a reference with no segments", () => {
    const input = fixtureAlignInput();
    assert.throws(() => alignShots({ ...input, reference: { ...input.reference, segments: [] } }), (error: unknown) => error instanceof EngineError);
  });

  it("marks the components whose text limit the shot's words exceed as refusals", () => {
    const longWords = Array.from({ length: 40 }, (_, index) => `word${index}`);
    const voice = fixtureAlignInput().voice;
    const input = fixtureAlignInput({
      voice: {
        ...voice,
        words: longWords.map((text, index) => ({ text, startMs: index * 100, endMs: index * 100 + 90 })),
      },
    });
    const first = alignShots(input).shots[0];
    assert.ok(first.refusals?.kinetic_type, "thirty words are too many lines for one kinetic shot");
    assert.ok(first.refusals?.coded_graphics, "thirty words are over the title's text limit");
    const second = alignShots(fixtureAlignInput()).shots[0];
    assert.equal(second.refusals?.kinetic_type, undefined, "a short shot is not refused");
    assert.equal(second.refusals?.coded_graphics, undefined, "a short title is not refused");
  });

  it("writes one decision per alignment and per split, each with its reason", () => {
    const decisions = alignmentDecisions(alignShots(fixtureAlignInput()));
    assert.equal(decisions.filter((decision) => /aligned to reference segment/.test(decision.reason)).length, 5);
    assert.equal(decisions.filter((decision) => /Split into/.test(decision.reason)).length, 5);
    assert.ok(decisions.every((decision) => decision.reason.length > 0 && decision.by === "scorer"));
  });
});

describe("the words a shot speaks", () => {
  const words = [
    { text: "one", startMs: 0, endMs: 400 },
    { text: "two", startMs: 1000, endMs: 1300 },
    { text: "three", startMs: 4000, endMs: 4500 },
  ];

  it("takes the words that start inside the shot, and falls back to the beat's words for a shot that speaks none", () => {
    assert.deepEqual(wordsOfShot(words, { startMs: 0, endMs: 2000 }, { startMs: 0, endMs: 5000 }), ["one", "two"]);
    assert.deepEqual(wordsOfShot(words, { startMs: 2000, endMs: 3000 }, { startMs: 0, endMs: 5000 }), ["one", "two", "three"]);
  });

  it("times the words a shot speaks from the shot's start, clamped to the shot", () => {
    const timed = timedWordsOfShot(words, { startMs: 500, endMs: 2000 }, { startMs: 0, endMs: 5000 });
    assert.deepEqual(timed, [{ text: "two", startMs: 500, endMs: 800 }], "one starts before the shot, so it is not spoken in it");
    const straddling = timedWordsOfShot([{ text: "long", startMs: 1200, endMs: 2600 }], { startMs: 1000, endMs: 2000 }, { startMs: 0, endMs: 3000 });
    assert.deepEqual(straddling, [{ text: "long", startMs: 200, endMs: 999 }], "the end is clamped to the shot's last millisecond");
  });

  it("spreads a fallback's beat words across the shot in order, so no time falls outside it", () => {
    // A shot of 2000 ms that speaks none of the beat's words (they all start before it): the beat's three words are spread.
    const beatWords = [
      { text: "alpha", startMs: 0, endMs: 300 },
      { text: "beta", startMs: 300, endMs: 600 },
      { text: "gamma", startMs: 600, endMs: 900 },
    ];
    const fallback = timedWordsOfShot(beatWords, { startMs: 2000, endMs: 4000 }, { startMs: 0, endMs: 1000 });
    assert.deepEqual(
      fallback.map((word) => word.text),
      ["alpha", "beta", "gamma"],
    );
    for (const word of fallback) {
      assert.ok(word.startMs >= 0 && word.endMs <= 1999 && word.startMs <= word.endMs, `${word.text} stays inside the shot`);
    }
    assert.deepEqual(
      fallback.map((word) => word.startMs),
      [0, 667, 1333],
      "even slots of a third of the shot, in script order",
    );
  });

  it("keeps wordsOfShot and timedWordsOfShot on the same words", () => {
    for (const shot of [{ startMs: 0, endMs: 2000 }, { startMs: 2000, endMs: 3000 }, { startMs: 3000, endMs: 5000 }]) {
      const beat = { startMs: 0, endMs: 5000 };
      assert.deepEqual(
        timedWordsOfShot(words, shot, beat).map((word) => word.text),
        wordsOfShot(words, shot, beat),
      );
    }
  });
});
