import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError, type EditDecisionList, type ProductionRequest, type VariantMatrix } from "../contracts/index.ts";
import { edlFixture, FIXTURE_IDS, productionRequestFixture, scenePlanFixture } from "../contracts/fixtures/index.ts";
import { thresholds } from "../config/thresholds.ts";
import { variantMusicMix } from "./config.ts";
import { expandVariants, masterBand, workFor, type ExpansionInput, type VariantMusicTrack } from "./expand.ts";

const HOOK_SHOT = FIXTURE_IDS.shot1;
const PRODUCT_SHOT = FIXTURE_IDS.shot3;
const ALL_BEATS = ["b1", "b2", "b3", "b4", "b5"];

function track(id: number, durationMs = 60_000): VariantMusicTrack {
  return { trackId: `trk_${id}`, uri: `store://music/track-${id}.wav`, durationMs };
}

function tracksOf(count: number, durationMs?: number): Map<string, VariantMusicTrack> {
  return new Map(Array.from({ length: count }, (_, index) => [`trk_${index + 1}`, track(index + 1, durationMs)]));
}

/** The chain fixture's master, with its captions split in two: one clip over the presenter, one after it. */
function masterWithCaptions(): EditDecisionList {
  const master = structuredClone(edlFixture);
  master.tracks = master.tracks.map((layer) =>
    layer.layer === "captions"
      ? {
          layer: "captions",
          clips: [
            { clipId: "c_cap_1", startMs: 0, endMs: 3000, component: "captions.karaoke", props: { band: "lower", captions: [] } },
            { clipId: "c_cap_2", startMs: 3000, endMs: 24000, component: "captions.karaoke", props: { band: "lower", captions: [] } },
          ],
        }
      : layer,
  );
  return master;
}

function input(matrix: Partial<VariantMatrix>, overrides: Partial<ExpansionInput> = {}): ExpansionInput {
  return {
    request: productionRequestFixture as ProductionRequest,
    plan: scenePlanFixture,
    master: masterWithCaptions(),
    matrix: { maxVariants: 20, budgetUsd: 5, ...matrix },
    tracks: tracksOf(3),
    headroomUsd: 5,
    ...overrides,
  };
}

describe("variant expansion: the matrix into planned variants (Bible 6.13, 14.3)", () => {
  it("a caption-only matrix plans re-render variants with no generation work", () => {
    const expansion = expandVariants(input({ captionStyles: ["upper", "middle"], maxVariants: 4, budgetUsd: 1 }));
    assert.deepEqual(
      expansion.planned.map((variant) => [variant.key, variant.build, variant.estimateUsd]),
      [
        ["caption:upper", "rerender", 0.07],
        ["caption:middle", "rerender", 0.07],
      ],
    );
    for (const variant of expansion.planned) {
      assert.deepEqual(variant.work, { produceShotIds: [], voiceBeatIds: [], writerBeatIds: [] });
    }
    assert.equal(expansion.estimateUsd, 0.14);
    assert.deepEqual(expansion.skipped, []);
  });

  it("records the one attribute each variant changes, against the master (its control)", () => {
    const expansion = expandVariants(input({ captionStyles: ["upper"], music: ["trk_1"] }));
    const caption = expansion.planned.find((variant) => variant.attribute === "caption");
    assert.deepEqual(caption?.control, { edlId: FIXTURE_IDS.edl, from: "lower", to: "upper" });
    const music = expansion.planned.find((variant) => variant.attribute === "music");
    assert.deepEqual(music?.control, { edlId: FIXTURE_IDS.edl, from: "store://music/fixture-bed.wav", to: "trk_1" });
  });

  it("twenty variants from one master plan their work without any generation for caption and music", () => {
    const expansion = expandVariants(
      input(
        { captionStyles: ["upper", "middle", "lower"], music: Array.from({ length: 17 }, (_, index) => `trk_${index + 1}`), maxVariants: 20, budgetUsd: 5 },
        { tracks: tracksOf(17) },
      ),
    );
    assert.equal(expansion.planned.length, 20, "twenty variants fit the matrix's count and budget");
    assert.equal(expansion.skipped.length, 0);
    for (const variant of expansion.planned) {
      assert.equal(variant.build, "rerender", `${variant.key} is re-render only`);
      assert.deepEqual(variant.work, { produceShotIds: [], voiceBeatIds: [], writerBeatIds: [] }, `${variant.key} plans no generation`);
    }
    assert.equal(expansion.estimateUsd, 1.23, "three captions at $0.07 and seventeen music swaps at $0.06");
  });

  it("a hook variant regenerates only the generated shots of the hook beat, and writes and speaks only the hook beat", () => {
    const expansion = expandVariants(input({ hooks: 2, maxVariants: 4, budgetUsd: 1 }));
    const hooks = expansion.planned.filter((variant) => variant.attribute === "hook");
    assert.deepEqual(
      hooks.map((variant) => variant.key),
      ["hook:1", "hook:2"],
    );
    for (const hook of hooks) {
      assert.equal(hook.build, "generation");
      assert.deepEqual(hook.work, { produceShotIds: [HOOK_SHOT], voiceBeatIds: ["b1"], writerBeatIds: ["b1"] });
      assert.equal(hook.control.from, "Your kitchen counter is lying to you.", "the master's hook line is the control");
      assert.equal(hook.control.to, null, "the new line is written by the writer, so it is not known yet");
    }
    assert.equal(hooks[0]?.estimateUsd, 0.26);
  });

  it("a product variant re-runs produce_shot for the product shots only", () => {
    const expansion = expandVariants(input({ products: ["SKU-NEW-002"], maxVariants: 4, budgetUsd: 1 }));
    const [product] = expansion.planned;
    assert.equal(product?.key, "product:SKU-NEW-002");
    assert.deepEqual(product?.work, { produceShotIds: [PRODUCT_SHOT], voiceBeatIds: [], writerBeatIds: [] });
    assert.equal(product?.control.from, "SKU-FIX-001");
    assert.equal(product?.estimateUsd, 0.4);
  });

  it("a persona variant regenerates the presenter shots and speaks every beat again, with no new lines written", () => {
    const expansion = expandVariants(input({ personas: ["persona_b"], maxVariants: 4, budgetUsd: 2 }));
    const [persona] = expansion.planned;
    assert.deepEqual(persona?.work, { produceShotIds: [HOOK_SHOT], voiceBeatIds: ALL_BEATS, writerBeatIds: [] });
    assert.equal(persona?.estimateUsd, 1.4);
    assert.equal(persona?.control.from, "persona_fixture");
  });

  it("a language variant regenerates the presenter shots, speaks every beat and has the writer write every beat", () => {
    const expansion = expandVariants(input({ languages: ["de"], maxVariants: 4, budgetUsd: 2 }));
    const [language] = expansion.planned;
    assert.deepEqual(language?.work, { produceShotIds: [HOOK_SHOT], voiceBeatIds: ALL_BEATS, writerBeatIds: ALL_BEATS });
    assert.equal(language?.control.from, "en");
    assert.equal(language?.control.to, "de");
  });

  it("fits the budget cheapest first, and names the limit that stops a variant", () => {
    const expansion = expandVariants(input({ captionStyles: ["upper"], music: ["trk_1", "trk_2"], maxVariants: 4, budgetUsd: 0.1 }));
    assert.deepEqual(
      expansion.planned.map((variant) => variant.key),
      ["music:trk_1"],
      "music at $0.06 is cheaper than caption at $0.07, so it goes first and then nothing else fits $0.10",
    );
    assert.deepEqual(
      expansion.skipped.map((skip) => [skip.key, skip.reason]),
      [
        ["music:trk_2", "over_budget"],
        ["caption:upper", "over_budget"],
      ],
    );
    assert.equal(expansion.estimateUsd, 0.06);
    assert.equal(expansion.budgetUsd, 0.1);
  });

  it("the reservation's headroom caps the budget when it is lower than the matrix's, and says so", () => {
    const expansion = expandVariants(input({ music: ["trk_1"], maxVariants: 4, budgetUsd: 1 }, { headroomUsd: 0.05 }));
    assert.equal(expansion.planned.length, 0);
    assert.deepEqual(expansion.skipped.map((skip) => skip.reason), ["over_reservation"]);
    assert.equal(expansion.budgetUsd, 0.05);
  });

  it("the matrix's maxVariants caps the count, and the rest are skipped with that reason", () => {
    const expansion = expandVariants(input({ captionStyles: ["upper", "middle", "lower"], maxVariants: 1, budgetUsd: 5 }));
    assert.equal(expansion.planned.length, 1);
    assert.deepEqual(expansion.skipped.map((skip) => skip.reason), ["over_max_variants", "over_max_variants"]);
  });

  it("skips a caption style the compositor does not draw, a music track that is unknown or too short, and a duplicate", () => {
    const expansion = expandVariants(
      input(
        { captionStyles: ["captions.boxed", "upper", "upper"], music: ["trk_missing", "trk_short"], maxVariants: 9, budgetUsd: 5 },
        { tracks: new Map([["trk_short", track(9, 1000)]]) },
      ),
    );
    assert.deepEqual(
      expansion.planned.map((variant) => variant.key),
      ["caption:upper"],
    );
    const reasons = expansion.skipped.map((skip) => [skip.key, skip.reason]);
    assert.deepEqual(reasons, [
      ["caption:captions.boxed", "caption_not_drawable"],
      ["caption:upper", "duplicate_value"],
      ["music:trk_missing", "music_track_unknown"],
      ["music:trk_short", "music_too_short"],
    ]);
  });

  it("a hook variant needs a hook beat in the request", () => {
    const noHook: ProductionRequest = structuredClone(productionRequestFixture as ProductionRequest);
    noHook.script.beats = noHook.script.beats.map((beat) => ({ ...beat, role: beat.role === "hook" ? "setup" : beat.role }));
    const expansion = expandVariants(input({ hooks: 1, maxVariants: 4, budgetUsd: 1 }, { request: noHook }));
    assert.equal(expansion.planned.length, 0);
    assert.deepEqual(expansion.skipped.map((skip) => skip.reason), ["no_hook_beat"]);
    assert.equal(workFor("hook", noHook, scenePlanFixture), null);
  });

  it("is pure: the same input gives the same plan", () => {
    const first = expandVariants(input({ captionStyles: ["upper"], music: ["trk_1"], hooks: 1, maxVariants: 4, budgetUsd: 1 }));
    const second = expandVariants(input({ captionStyles: ["upper"], music: ["trk_1"], hooks: 1, maxVariants: 4, budgetUsd: 1 }));
    assert.deepEqual(first, second);
  });

  it("refuses a headroom that is not an amount", () => {
    assert.throws(() => expandVariants(input({ captionStyles: ["upper"] }, { headroomUsd: -1 })), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
    assert.throws(() => expandVariants(input({ captionStyles: ["upper"] }, { headroomUsd: Number.NaN })), (error: unknown) => error instanceof EngineError);
  });
});

describe("variant expansion: the request budget's room for the reservation (Bible 14.1, 14.4)", () => {
  it("a variant the headroom does not cover fits the room the request budget leaves for the reservation", () => {
    const expansion = expandVariants(input({ captionStyles: ["upper", "middle"], maxVariants: 4, budgetUsd: 5 }, { headroomUsd: 0, extendableUsd: 0.1 }));
    assert.deepEqual(expansion.planned.map((variant) => variant.key), ["caption:upper"]);
    assert.deepEqual(expansion.skipped.map((skip) => [skip.key, skip.reason]), [["caption:middle", "over_request_budget"]]);
    assert.equal(expansion.budgetUsd, 0.1);
  });

  it("with no room under the request budget, the same variant is refused as over the reservation", () => {
    const expansion = expandVariants(input({ captionStyles: ["upper", "middle"], maxVariants: 4, budgetUsd: 5 }, { headroomUsd: 0.1, extendableUsd: 0 }));
    assert.deepEqual(expansion.planned.map((variant) => variant.key), ["caption:upper"]);
    assert.deepEqual(expansion.skipped.map((skip) => [skip.key, skip.reason]), [["caption:middle", "over_reservation"]]);
  });

  it("the matrix's own budget binds before the reservation, and says so", () => {
    const expansion = expandVariants(input({ captionStyles: ["upper", "middle"], maxVariants: 4, budgetUsd: 0.1 }, { headroomUsd: 5, extendableUsd: 5 }));
    assert.deepEqual(expansion.planned.map((variant) => variant.key), ["caption:upper"]);
    assert.deepEqual(expansion.skipped.map((skip) => [skip.key, skip.reason]), [["caption:middle", "over_budget"]]);
  });

  it("refuses a room under the request budget that is not an amount", () => {
    assert.throws(() => expandVariants(input({ captionStyles: ["upper"] }, { extendableUsd: -1 })), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });
});

describe("variant control values and the music mix", () => {
  it("reads the master's caption band from its first captions clip that names one, and null when none does", () => {
    assert.equal(masterBand(masterWithCaptions()), "lower");
    assert.equal(masterBand(edlFixture), null, "the fixture's captions clip names no band, so the master's band is unknown");
  });

  it("uses the editor's music mix, so a variant's music sits at the level the editor sets (thresholds.editor.music)", () => {
    assert.equal(variantMusicMix.gainDb, thresholds.editor.music.baseGainDb.value);
    assert.equal(variantMusicMix.duckDb, thresholds.editor.music.duckDb);
  });
});
