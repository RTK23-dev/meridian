import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EngineError,
  manifestSchema,
  type Decision,
  type EditDecisionList,
  type GateResult,
  type ManifestRoleCall,
  type ProductionRequest,
  type ScenePlan,
  type Take,
  type VideoDNA,
} from "../contracts/index.ts";
import {
  edlFixture,
  FIXTURE_IDS,
  manifestFixture,
  manifestRoleCallsFixture,
  productionRequestFixture,
  scenePlanFixture,
  takesFixture,
  videoDnaFixture,
} from "../contracts/fixtures/index.ts";
import { withCaptionBand } from "../variants/diff.ts";
import { buildManifest, disclosuresFor, gatesFor, shotsFor, timingsFor, uniqueDecisions, type ManifestInput } from "./manifest.ts";

const COST = manifestFixture.cost;
const MASTER_VIDEO = FIXTURE_IDS.video;
const VARIANT_VIDEO = FIXTURE_IDS.video.replace(/.$/, "Z");

function input(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    video: { videoId: MASTER_VIDEO, edl: edlFixture, variantOfVideoId: null },
    request: productionRequestFixture as ProductionRequest,
    dna: videoDnaFixture as VideoDNA,
    plan: scenePlanFixture as ScenePlan,
    takes: takesFixture as Take[],
    gates: manifestFixture.gates as GateResult[],
    decisions: scenePlanFixture.decisions as Decision[],
    roleCalls: manifestRoleCallsFixture as ManifestRoleCall[],
    promptVersions: manifestFixture.promptVersions,
    cost: COST,
    disclosures: { aiGeneratedPeople: true, paidPartnership: false },
    timings: manifestFixture.timings,
    ...overrides,
  };
}

describe("the shots of a video, from the takes its EDL plays", () => {
  it("names each shot the EDL plays with its take, provider, model and attempts, in plan order", () => {
    const shots = shotsFor(edlFixture, scenePlanFixture, takesFixture);
    assert.deepEqual(shots, manifestFixture.shots);
  });

  it("does not list a component shot, which has no take and no provider", () => {
    const shots = shotsFor(edlFixture, scenePlanFixture, takesFixture);
    assert.equal(shots.some((shot) => shot.shotId === FIXTURE_IDS.shot4), false);
    assert.equal(shots.some((shot) => shot.shotId === FIXTURE_IDS.shot5), false);
  });

  it("refuses a clip that plays media no take of the request made, because the manifest could not name its provider", () => {
    const edl = structuredClone(edlFixture);
    const base = edl.tracks.find((track) => track.layer === "base");
    if (base?.clips[0]) base.clips[0].srcUri = "store://takes/unknown.mp4";
    assert.throws(() => shotsFor(edl, scenePlanFixture, takesFixture), (error: unknown) => error instanceof EngineError && error.kind === "invalid_input");
  });

  it("refuses a take whose shot the plan does not have", () => {
    const orphan: Take = { ...takesFixture[0]!, shotId: FIXTURE_IDS.shot1.replace(/.$/, "Q") as Take["shotId"] };
    assert.throws(
      () => shotsFor(edlFixture, scenePlanFixture, [orphan, ...takesFixture.slice(1)]),
      (error: unknown) => error instanceof EngineError,
    );
  });
});

describe("the manifest of a video (Bible 4.4, Manifest v2)", () => {
  it("builds a manifest that matches the contract, with the role calls and the prompt versions of its request", () => {
    const manifest = buildManifest(input());
    assert.equal(manifestSchema.safeParse(manifest).success, true);
    assert.equal(manifest.schema, "meridian.manifest/v2");
    assert.equal(manifest.videoId, MASTER_VIDEO);
    assert.equal(manifest.requestId, FIXTURE_IDS.request);
    assert.equal(manifest.formatId, "fmt_fixture_rank");
    assert.equal(manifest.videoDnaId, FIXTURE_IDS.dna);
    assert.deepEqual(manifest.genome, videoDnaFixture.genome);
    assert.deepEqual(manifest.promptVersions, manifestFixture.promptVersions);
    assert.deepEqual(manifest.roleCalls, manifestRoleCallsFixture);
    assert.equal("variantOf" in manifest, false, "the master names no master");
  });

  it("holds every role call of the request, each with its prompt version, its model and its verified cost (contract v6: no estimate, no null cost)", () => {
    const manifest = buildManifest(input());
    for (const call of manifest.roleCalls ?? []) {
      assert.equal(manifest.promptVersions[call.role], call.promptVersion);
      assert.ok(call.costUsd !== null, "an unknown cost is not written into a manifest");
    }
  });

  it("refuses a role call whose prompt version is not the one recorded for its role", () => {
    const mismatched = manifestRoleCallsFixture.map((call) => (call.role === "planner" ? { ...call, promptVersion: "planner@2" as const } : call));
    assert.throws(() => buildManifest(input({ roleCalls: mismatched as ManifestRoleCall[] })), (error: unknown) => error instanceof EngineError && error.kind === "internal");
  });

  it("refuses a cost whose total is not the sum of its parts", () => {
    assert.throws(() => buildManifest(input({ cost: { ...COST, total: COST.total + 0.01 } })), (error: unknown) => error instanceof EngineError);
  });

  it("refuses a timing that is negative (the manifest holds milliseconds from zero)", () => {
    assert.throws(() => buildManifest(input({ timings: { total: -5 } })), (error: unknown) => error instanceof EngineError);
  });

  it("writes a variant's manifest with its master named as variantOf, and its own shots", () => {
    const variantEdl: EditDecisionList = { ...withCaptionBand(edlFixture, "upper").edl, edlId: FIXTURE_IDS.edl.replace(/.$/, "V"), variantOf: FIXTURE_IDS.edl };
    const manifest = buildManifest(input({ video: { videoId: VARIANT_VIDEO, edl: variantEdl, variantOfVideoId: MASTER_VIDEO } }));
    assert.equal(manifest.variantOf, MASTER_VIDEO);
    assert.equal(manifest.videoId, VARIANT_VIDEO);
    assert.deepEqual(manifest.shots, manifestFixture.shots);
  });
});

describe("disclosure flags, carried from the plan (Bible 12.3)", () => {
  it("sets aiGeneratedPeople when a generated presenter or cinematic shot is in the video", () => {
    const shots = shotsFor(edlFixture, scenePlanFixture, takesFixture);
    assert.equal(disclosuresFor(shots, scenePlanFixture, false).aiGeneratedPeople, true);
  });

  it("does not set aiGeneratedPeople for a video of stock footage and components only", () => {
    const stockOnly = shotsFor(edlFixture, scenePlanFixture, takesFixture).filter((shot) => shot.shotId === FIXTURE_IDS.shot2);
    assert.equal(disclosuresFor(stockOnly, scenePlanFixture, false).aiGeneratedPeople, false);
  });

  it("holds paidPartnership at the answer it is given, and at true when no answer is given (unknown is disclosed)", () => {
    const shots = shotsFor(edlFixture, scenePlanFixture, takesFixture);
    assert.equal(disclosuresFor(shots, scenePlanFixture, false).paidPartnership, false);
    assert.equal(disclosuresFor(shots, scenePlanFixture, undefined).paidPartnership, true);
  });
});

describe("timings and gates of a video", () => {
  it("gives each artifact type the milliseconds from the request to its first artifact, and the total to the video's review", () => {
    const timings = timingsFor(
      [
        { type: "production_request", createdAt: "2026-10-13T09:00:00.000Z" },
        { type: "video_dna", createdAt: "2026-10-13T09:00:05.000Z" },
        { type: "video_dna", createdAt: "2026-10-13T09:00:09.000Z" },
        { type: "scene_plan", createdAt: "2026-10-13T09:00:41.000Z" },
      ],
      "2026-10-13T09:00:00.000Z",
      "2026-10-13T09:10:00.000Z",
    );
    assert.deepEqual(timings, { production_request: 0, video_dna: 5000, scene_plan: 41000, total: 600000 });
  });

  it("leaves out a gate that belongs to another video, and keeps the request's own gates", () => {
    const gates = manifestFixture.gates as GateResult[];
    const otherVideo = new Set([FIXTURE_IDS.edl, FIXTURE_IDS.composition, MASTER_VIDEO]);
    const mine = new Set([VARIANT_VIDEO]);
    const kept = gatesFor(gates, mine, otherVideo).map((gate) => gate.gate);
    assert.equal(kept.includes("edit"), false, "the master's edit gate is another video's");
    assert.equal(kept.includes("request"), true, "the request's own gates apply to every video");
    assert.equal(kept.includes("take"), true);
  });

  it("removes a duplicate decision, and keeps two decisions that differ in one alternative", () => {
    const one: Decision = { at: "b1", chose: "a", alternatives: [{ option: "x", score: 0.1 }], reason: "r", by: "scorer" };
    const other: Decision = { ...one, alternatives: [{ option: "y", score: 0.1 }] };
    assert.deepEqual(uniqueDecisions([one, { ...one }, other]), [one, other]);
  });
});
