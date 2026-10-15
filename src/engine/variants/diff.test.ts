import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { edlSchema, EngineError, idSchema, type EditDecisionList } from "../contracts/index.ts";
import { edlFixture, FIXTURE_IDS, scenePlanFixture, take1Fixture, take3bFixture } from "../contracts/fixtures/index.ts";
import { variantMusicMix } from "./config.ts";
import type { PlannedVariant } from "./expand.ts";
import {
  asVariant,
  buildRerenderVariant,
  checkControl,
  clipIdsForUris,
  diffEdl,
  variantEdlId,
  withCaptionBand,
  withMusic,
  withVisualSources,
} from "./diff.ts";

/** The chain fixture's master, with its captions split: one clip over the presenter (keeps its band), one after it. */
function master(): EditDecisionList {
  const base = structuredClone(edlFixture);
  base.tracks = base.tracks.map((layer) =>
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
  return base;
}

const NEW_TRACK = { trackId: "trk_alt", uri: "store://music/alt.wav", durationMs: 30_000 };

function plannedCaption(band: "upper" | "middle" | "lower"): PlannedVariant {
  return {
    key: `caption:${band}`,
    attribute: "caption",
    value: band,
    change: { kind: "caption", band },
    control: { edlId: FIXTURE_IDS.edl, from: "lower", to: band },
    estimateUsd: 0.07,
    build: "rerender",
    work: { produceShotIds: [], voiceBeatIds: [], writerBeatIds: [] },
  };
}

describe("diffEdl: the changed parts of a variant against its master", () => {
  it("an identical EDL has no changes", () => {
    assert.deepEqual(diffEdl(master(), master()), []);
  });

  it("a caption band change is one surface: the captions", () => {
    const { edl, changedClips } = withCaptionBand(master(), "upper");
    assert.equal(changedClips, 1, "only the caption after the presenter changes; the one over the face keeps its band");
    assert.deepEqual(
      diffEdl(master(), edl).map((change) => change.surface),
      ["captions"],
    );
  });

  it("a music change is one surface: the music", () => {
    const edl = withMusic(master(), NEW_TRACK);
    assert.deepEqual(
      diffEdl(master(), edl).map((change) => change.surface),
      ["music"],
    );
  });

  it("names a changed visual clip by its id, and a moved clip by its timing", () => {
    const changed = structuredClone(master());
    const graphics = changed.tracks.find((track) => track.layer === "graphics");
    const card = graphics?.clips.find((clip) => clip.clipId === "c_gfx_4");
    if (card) card.props = { name: "Other blender" };
    const moved = changed.tracks.find((track) => track.layer === "base");
    const clip = moved?.clips.find((item) => item.clipId === "c_base_2");
    if (clip) clip.endMs = 9500;
    const surfaces = diffEdl(master(), changed).map((change) => change.surface);
    assert.ok(surfaces.includes("visual:c_gfx_4"));
    assert.ok(surfaces.includes("timing:c_base_2"));
  });

  it("names a change to the voice, the effects and a top-level field", () => {
    const changed = structuredClone(master());
    changed.audio.voice = { ...changed.audio.voice, gainDb: -1 };
    changed.effects = [];
    changed.seed = 7;
    const surfaces = diffEdl(master(), changed).map((change) => change.surface).sort();
    assert.deepEqual(surfaces, ["effects", "other:seed", "voice"]);
  });

  it("names a clip that was added or removed as a structure change", () => {
    const changed = structuredClone(master());
    const base = changed.tracks.find((track) => track.layer === "base");
    base?.clips.pop();
    assert.deepEqual(
      diffEdl(master(), changed).map((change) => change.surface),
      ["structure:base"],
    );
  });
});

describe("checkControl: a variant changes only what its attribute allows", () => {
  it("a caption variant may change the captions and nothing else", () => {
    const edl = withCaptionBand(master(), "upper").edl;
    assert.equal(checkControl("caption", diffEdl(master(), edl), new Set()).pass, true);

    const alsoMoved = structuredClone(edl);
    const base = alsoMoved.tracks.find((track) => track.layer === "base");
    const clip = base?.clips[0];
    if (clip) clip.srcUri = "store://takes/other.mp4";
    const check = checkControl("caption", diffEdl(master(), alsoMoved), new Set());
    assert.equal(check.pass, false);
    assert.deepEqual(check.violations, ["visual:c_base_2 (tracks.base.c_base_2)"]);
  });

  it("a music variant may change the music and nothing else", () => {
    const edl = withMusic(master(), NEW_TRACK);
    assert.equal(checkControl("music", diffEdl(master(), edl), new Set()).pass, true);
    assert.equal(checkControl("caption", diffEdl(master(), edl), new Set()).pass, false);
  });

  it("a product variant may change the visual clips of the product shots only", () => {
    const retaken = withVisualSources(master(), [{ fromUri: take3bFixture.uri, toUri: "store://takes/new-blender.mp4", toDurationMs: 9000 }]).edl;
    const productClips = clipIdsForUris(master(), new Set([take3bFixture.uri]));
    assert.deepEqual([...productClips], ["c_base_3"]);
    assert.equal(checkControl("product", diffEdl(master(), retaken), productClips).pass, true);
    assert.equal(checkControl("product", diffEdl(master(), retaken), new Set(["c_base_2"])).pass, false, "a clip that is not a product shot may not change");
  });

  it("a hook variant may change the voice, the captions and the regenerated shots, and the timing only with a voice change", () => {
    const changed = structuredClone(master());
    changed.audio.voice = { ...changed.audio.voice, endMs: 2000 };
    const base = changed.tracks.find((track) => track.layer === "presenter");
    const face = base?.clips[0];
    if (face) face.endMs = 2000;
    const workClips = new Set(["c_presenter_1"]);
    assert.equal(checkControl("hook", diffEdl(master(), changed), workClips).pass, true);

    const timingOnly = structuredClone(master());
    const stretched = timingOnly.tracks.find((track) => track.layer === "base")?.clips[0];
    if (stretched) stretched.endMs = 3500;
    const check = checkControl("hook", diffEdl(master(), timingOnly), workClips);
    assert.equal(check.pass, false);
    assert.ok(check.violations.includes("timing changed without a voice change"));
  });

  it("a hook variant may not change the music", () => {
    const edl = withMusic(master(), NEW_TRACK);
    assert.equal(checkControl("hook", diffEdl(master(), edl), new Set()).pass, false);
  });
});

describe("the transforms that build a variant", () => {
  it("withCaptionBand keeps the band of a caption over the presenter, as the editor does", () => {
    const { edl, changedClips, keptClips } = withCaptionBand(master(), "upper");
    assert.equal(keptClips, 1);
    assert.equal(changedClips, 1);
    const captions = edl.tracks.find((track) => track.layer === "captions")?.clips ?? [];
    assert.equal(captions.find((clip) => clip.clipId === "c_cap_1")?.props?.band, "lower");
    assert.equal(captions.find((clip) => clip.clipId === "c_cap_2")?.props?.band, "upper");
  });

  it("withMusic keeps the master's mix when the master has music, and uses the editor's mix when it has none", () => {
    const withBed = withMusic(master(), NEW_TRACK);
    assert.equal(withBed.audio.music?.gainDb, -12);
    assert.equal(withBed.audio.music?.duckDb, -18);
    assert.equal(withBed.audio.music?.endMs, master().durationMs);

    const noMusic = structuredClone(master());
    delete noMusic.audio.music;
    const added = withMusic(noMusic, NEW_TRACK);
    assert.equal(added.audio.music?.gainDb, variantMusicMix.gainDb);
    assert.equal(added.audio.music?.duckDb, variantMusicMix.duckDb);
  });

  it("withMusic refuses a track shorter than the timeline", () => {
    assert.throws(() => withMusic(master(), { ...NEW_TRACK, durationMs: 1000 }), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("withVisualSources swaps the media of the clips that play a take, and reports a take no clip plays", () => {
    const { edl, unmatched } = withVisualSources(master(), [
      { fromUri: take3bFixture.uri, toUri: "store://takes/new.mp4", toDurationMs: 6000 },
      { fromUri: "store://takes/absent.mp4", toUri: "store://takes/x.mp4", toDurationMs: 6000 },
    ]);
    assert.deepEqual(unmatched, ["store://takes/absent.mp4"]);
    const base = edl.tracks.find((track) => track.layer === "base");
    assert.equal(base?.clips.find((clip) => clip.clipId === "c_base_3")?.srcUri, "store://takes/new.mp4");
  });

  it("withVisualSources refuses a take that is too short for the clip it replaces", () => {
    assert.throws(
      () => withVisualSources(master(), [{ fromUri: take3bFixture.uri, toUri: "store://takes/short.mp4", toDurationMs: 5000 }]),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });

  it("a variant EDL id is stable for a master and a key, and differs between keys", () => {
    const first = variantEdlId(FIXTURE_IDS.edl, "caption:upper");
    assert.equal(variantEdlId(FIXTURE_IDS.edl, "caption:upper"), first);
    assert.notEqual(variantEdlId(FIXTURE_IDS.edl, "caption:middle"), first);
    assert.equal(idSchema("edl_").safeParse(first).success, true);
  });

  it("asVariant names the master as variantOf and gives the variant its own id, checked against the EDL contract", () => {
    const result = asVariant(master(), withCaptionBand(master(), "upper").edl, "caption:upper");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.edl.variantOf, FIXTURE_IDS.edl);
    assert.notEqual(result.edl.edlId, FIXTURE_IDS.edl);
    assert.equal(edlSchema.safeParse(result.edl).success, true);
    assert.equal(result.edl.seed, master().seed, "the variant keeps the master's seed");
  });

  it("asVariant refuses an EDL that does not parse", () => {
    const broken = { ...master(), durationMs: -5 } as unknown as EditDecisionList;
    const result = asVariant(master(), broken, "caption:upper");
    assert.equal(result.ok, false);
  });
});

describe("buildRerenderVariant: caption and music variants are built from the master and checked", () => {
  it("builds a caption variant whose only change is the captions", () => {
    const built = buildRerenderVariant(master(), plannedCaption("upper"));
    assert.equal(built.status, "built");
    if (built.status !== "built") return;
    assert.deepEqual(
      built.changes.map((change) => change.surface),
      ["captions"],
    );
    assert.equal(built.edl.variantOf, FIXTURE_IDS.edl);
    assert.equal(edlSchema.safeParse(built.edl).success, true);
  });

  it("builds a music variant from a track that covers the timeline", () => {
    const planned: PlannedVariant = {
      key: "music:trk_alt",
      attribute: "music",
      value: "trk_alt",
      change: { kind: "music", track: { ...NEW_TRACK, durationMs: 60_000 } },
      control: { edlId: FIXTURE_IDS.edl, from: edlFixture.audio.music?.uri ?? null, to: "trk_alt" },
      estimateUsd: 0.06,
      build: "rerender",
      work: { produceShotIds: [], voiceBeatIds: [], writerBeatIds: [] },
    };
    const built = buildRerenderVariant(master(), planned);
    assert.equal(built.status, "built");
    if (built.status === "built") assert.deepEqual(built.changes.map((change) => change.surface), ["music"]);
  });

  it("does not build a caption variant that changes nothing, and says why", () => {
    const built = buildRerenderVariant(master(), plannedCaption("lower"));
    assert.deepEqual(built, { status: "not_built", reason: "no_change" });
  });

  it("does not build a music track too short for the timeline, and names the reason", () => {
    const planned: PlannedVariant = {
      key: "music:short",
      attribute: "music",
      value: "short",
      change: { kind: "music", track: { trackId: "short", uri: "store://music/short.wav", durationMs: 1000 } },
      control: { edlId: FIXTURE_IDS.edl, from: null, to: "short" },
      estimateUsd: 0.06,
      build: "rerender",
      work: { produceShotIds: [], voiceBeatIds: [], writerBeatIds: [] },
    };
    const built = buildRerenderVariant(master(), planned);
    assert.equal(built.status, "not_built");
  });

  it("does not build a generation variant in this stage", () => {
    const planned: PlannedVariant = {
      key: "product:SKU",
      attribute: "product",
      value: "SKU",
      change: { kind: "product", sku: "SKU" },
      control: { edlId: FIXTURE_IDS.edl, from: null, to: "SKU" },
      estimateUsd: 0.4,
      build: "generation",
      work: { produceShotIds: [FIXTURE_IDS.shot3], voiceBeatIds: [], writerBeatIds: [] },
    };
    assert.deepEqual(buildRerenderVariant(master(), planned), { status: "not_built", reason: "needs_generation" });
  });
});

describe("the fixture's plan and takes line up with the EDL the variants change", () => {
  it("the product shot's take plays in the master EDL, so a product variant can find its clip", () => {
    const shot = scenePlanFixture.shots.find((item) => item.shotId === FIXTURE_IDS.shot3);
    assert.equal(shot?.visualType, "product_hero");
    assert.deepEqual([...clipIdsForUris(master(), new Set([take1Fixture.uri]))], ["c_presenter_1"]);
  });
});
