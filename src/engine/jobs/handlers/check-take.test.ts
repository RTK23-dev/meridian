import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { budgetReservationSchema, EngineError, scenePlanSchema, takeSchema, type ScenePlan, type ShotSpec, type Take } from "../../contracts/index.ts";
import { FIXTURE_IDS, fixtureId } from "../../contracts/fixtures/index.ts";
import { gatewayWith, fixture, json, probeOf, recordedTransport, fakeMedia, fakeObjects, MP4_BYTES } from "../test/harness.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../test/pg-test-db.ts";
import { startEngineRequest } from "../orchestrator-sql.ts";
import { writeArtifact } from "../artifact-store.ts";
import { sqlLedgerStore } from "../sql-ledger-store.ts";
import type { StageContext } from "../types.ts";
import { checkOneTake, createCheckTakeHandler, frameTimesFor, probedMeasurements, takeShotOf } from "./check-take.ts";
import { notConnectedScorer } from "../../review/take/similarity.ts";
import type { BlackFramesResult } from "../../media/interface.ts";

const ORG = "org_check_test";
const BRAND = "brand_check_test";
const NOW = "2026-10-14T10:00:00.000Z";

let db: TestDatabase;
let counter = 0;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
});

after(async () => {
  await db.close();
});

function shotOf(visualType: ShotSpec["visualType"], source: ShotSpec["source"]): ShotSpec {
  return { shotId: fixtureId("shot_", 61), beatId: "b1", startMs: 1000, endMs: 6000, visualType, layer: "base", source };
}

describe("check_take helpers", () => {
  test("six frames are spread evenly through the take, strictly ascending and inside it", () => {
    const times = frameTimesFor(5000);
    assert.equal(times.length, 6);
    assert.ok(times.every((time) => time >= 0 && time < 5000));
    assert.ok(times.every((time, index) => index === 0 || time > (times[index - 1] ?? -1)));
    assert.deepEqual(frameTimesFor(3), [], "a take too short for six distinct frames gives no frames, so the Critic has no evidence");
  });

  test("the shot facts come from the plan: a product shot names its hero, a presenter shot its portrait, and a generated or stock shot must move", () => {
    const product = takeShotOf(shotOf("product_hero", { kind: "generate", modelClass: "image.keyframe", prompt: "a product", refs: [], takes: 1 }));
    assert.deepEqual(product.product, { heroUris: [] }, "the hero list is empty until a kit is loaded, so the check is not evaluated");
    assert.equal(product.persona, null);
    assert.equal(product.plannedDurationMs, 5000);
    assert.equal(product.motionRequired, true);

    const presenter = takeShotOf(shotOf("ugc_presenter", { kind: "generate", modelClass: "avatar", prompt: "a presenter", refs: [], takes: 1 }));
    assert.deepEqual(presenter.persona, { portraitUris: [] });
    assert.equal(presenter.product, null);

    assert.equal(takeShotOf(shotOf("stock_footage", { kind: "stock", query: "kitchen", minMs: 4000 })).motionRequired, true);
  });

  test("the probed duration is the only measurement the default gives; every other one is unknown", () => {
    const take = takeSchema.parse({
      schema: "meridian.take/v1",
      takeId: FIXTURE_IDS.take1,
      shotId: FIXTURE_IDS.shot3,
      attempt: 1,
      provider: "openrouter",
      model: "kwaivgi/kling-v3.0-std",
      uri: "engine/x.mp4",
      durationMs: 5000,
      width: 1080,
      height: 1920,
      promptHash: `sha256:${"c".repeat(64)}`,
      costUsd: 0.6125,
      latencyMs: 1200,
    }) as Take;
    assert.deepEqual(probedMeasurements(take), { durationMs: 5000, blackOrFrozenRunFrames: null, flickerScore: null, meanMotion: null });
  });
});

/** A request, a stored take with its plan, and a reservation the Critic is authorized against. */
async function takeWithPlan(shot: ShotSpec, bytes: Uint8Array | null): Promise<{ requestId: string; reservationId: string; takeId: string; takeArtifactId: string; planArtifactId: string; uri: string }> {
  counter += 1;
  const requestId = fixtureId("req_", 960 + counter);
  const reservationId = fixtureId("res_", 960 + counter);
  await startEngineRequest(db.sql, {
    organizationId: ORG,
    brandId: BRAND,
    requestId,
    formatId: "fmt_check_test",
    priority: "normal",
    cachedDna: true,
    variantCount: 0,
    requestArtifactId: fixtureId("art_", 960 + counter),
  });
  await sqlLedgerStore(db.sql, ORG).createReservation(
    budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId,
      requestId,
      workspaceId: ORG,
      mode: "cap",
      lines: [{ stage: "check_take", estimateUsd: 0.1 }],
      estimateUsd: 0.1,
      redoAllowanceUsd: 0,
      reservedUsd: 0.1,
      state: "reserved",
      createdAt: NOW,
    }),
  );
  const plan: ScenePlan = scenePlanSchema.parse({
    schema: "meridian.scene_plan/v1",
    planId: `plan_check_${counter}`,
    requestId,
    videoDnaId: FIXTURE_IDS.dna,
    voiceTrackId: "vt_check",
    shots: [shot],
    estimatedUsd: 0.1,
    decisions: [],
  });
  const planArtifact = await writeArtifact(db.sql, { organizationId: ORG, requestId, stage: "plan", type: "scene_plan", body: plan, createdAt: NOW });
  const takeId = fixtureId("take_", 960 + counter);
  const uri = `engine/${ORG}/${requestId}/produce_shot/${takeId}.mp4`;
  const take = takeSchema.parse({
    schema: "meridian.take/v1",
    takeId,
    shotId: shot.shotId,
    attempt: 1,
    provider: "openrouter",
    model: "kwaivgi/kling-v3.0-std",
    uri,
    durationMs: 5000,
    width: 1080,
    height: 1920,
    promptHash: `sha256:${"d".repeat(64)}`,
    costUsd: 0.6125,
    latencyMs: 1200,
  });
  const takeArtifact = await writeArtifact(db.sql, { organizationId: ORG, requestId, stage: "produce_shot", type: "take", body: take, parentIds: [planArtifact.artifactId], createdAt: NOW });
  if (bytes) objects.objects.set(`${ORG}|${BRAND}|${uri}`, { mimeType: "video/mp4", bytes });
  return { requestId, reservationId, takeId, takeArtifactId: takeArtifact.artifactId, planArtifactId: planArtifact.artifactId, uri };
}

const objects = fakeObjects();

function contextFor(input: { requestId: string; reservationId: string; takeId: string; takeArtifactId: string; planArtifactId: string }): StageContext {
  return {
    sql: db.sql,
    jobId: `job_${input.takeId}`,
    organizationId: ORG,
    requestId: input.requestId,
    stage: "check_take",
    subjectId: input.takeId,
    attempt: "1",
    payload: {
      organizationId: ORG,
      requestId: input.requestId,
      stage: "check_take",
      subjectId: input.takeId,
      attempt: "1",
      priority: "normal",
      budgetReservationId: input.reservationId,
      inputArtifactIds: [input.takeArtifactId, input.planArtifactId],
      hints: [],
      details: { shotId: FIXTURE_IDS.shot3, takeId: input.takeId, epoch: 0 },
    },
    signal: new AbortController().signal,
  };
}

describe("check_take on PostgreSQL", () => {
  test("with no connected evidence, the take escalates and every check that could not be run is named as missing", async () => {
    const shot = shotOf("cinematic", { kind: "generate", modelClass: "video.cinematic", prompt: "a counter", refs: [], takes: 1 });
    const taken = await takeWithPlan(shot, MP4_BYTES);
    const critic = recordedTransport({ "POST /api/v1/chat/completions": json(200, fixture("openrouter-critic-take-ok.json")) });
    const handler = createCheckTakeHandler({
      gateway: gatewayWith(critic.transport),
      media: fakeMedia({ probe: () => probeOf() }),
      objects: objects,
      now: () => NOW,
    });

    const result = await handler.run(contextFor(taken));
    assert.equal(result.kind, "done");
    if (result.kind !== "done" || result.output.stage !== "check_take") throw new Error("expected a check output");
    const { verdict, gate } = result.output;
    assert.equal(verdict.action, "escalate", "missing evidence routes to review, never to a pass");
    assert.equal(verdict.pass, false);
    assert.equal(gate.pass, false);
    const missing = verdict.checks.filter((check) => !check.pass).map((check) => check.rule);
    for (const rule of ["flicker_below_max", "no_black_or_frozen_frames", "motion_present", "palette_match"]) {
      assert.ok(missing.includes(rule), `${rule} is named as not evaluated`);
    }
    assert.equal(verdict.checks.find((check) => check.rule === "palette_match")?.detail?.includes("not"), true);
    assert.equal(result.output.artifacts[`verdict:${taken.takeId}`] !== undefined, true, "the verdict is stored as its artifact");
    const stored = await db.sql<{ type: string; stage: string }>`
      select type, stage from engine_artifacts where organization_id = ${ORG} and request_id = ${taken.requestId} and type = 'take_verdict'
    `;
    assert.deepEqual(stored, [{ type: "take_verdict", stage: "check_take" }]);
  });

  test("a stored take whose media is missing from the object store fails the stage: nothing is judged and no verdict is written", async () => {
    const shot = shotOf("cinematic", { kind: "generate", modelClass: "video.cinematic", prompt: "a counter", refs: [], takes: 1 });
    const taken = await takeWithPlan(shot, null);
    const handler = createCheckTakeHandler({
      gateway: gatewayWith(recordedTransport({}).transport),
      media: fakeMedia(),
      objects,
      scorer: notConnectedScorer(),
      now: () => NOW,
    });
    await assert.rejects(handler.run(contextFor(taken)), (error: unknown) => error instanceof EngineError && error.kind === "not_found");
    const verdicts = await db.sql<{ n: unknown }>`select count(*) as n from engine_artifacts where organization_id = ${ORG} and request_id = ${taken.requestId} and type = 'take_verdict'`;
    assert.equal(Number(verdicts[0]?.n), 0);
  });

  test("the measurements, palette and gold metrics are the ports' answers when they are connected, and the frames are the media's", async () => {
    const shot = shotOf("cinematic", { kind: "generate", modelClass: "video.cinematic", prompt: "a counter", refs: [], takes: 1 });
    const taken = await takeWithPlan(shot, MP4_BYTES);
    const media = fakeMedia({ probe: () => probeOf() });
    const critic = recordedTransport({ "POST /api/v1/chat/completions": json(200, fixture("openrouter-critic-take-ok.json")) });
    const measured: string[] = [];
    const { run } = await checkOneTake(contextFor(taken), {
      gateway: gatewayWith(critic.transport),
      media,
      objects,
      scorer: { id: "similarity:fixture", async score() { return { status: "scored", score: 0.82, scorer: "similarity:fixture" }; } },
      measure: async ({ take }) => {
        measured.push(take.takeId);
        return { durationMs: take.durationMs, blackOrFrozenRunFrames: 0, flickerScore: 0.1, meanMotion: 0.22 };
      },
      paletteHex: async () => ["#1a2b3c"],
      metrics: async () => ({}),
      now: () => NOW,
    });
    assert.deepEqual(measured, [taken.takeId]);
    assert.deepEqual(media.frameCalls.at(-1), frameTimesFor(5000), "the rubric frames are taken at the even times");
    assert.equal(run.verdict.takeId, taken.takeId);
    assert.equal(run.calls.length, 1, "one Critic call for the take, on the request's reservation");
    assert.equal(run.verdict.action, "accept", "a take that every connected check passes is accepted");
  });

  test("the media detectors are the take's measurements when no measure port is given: their clean answers pass the code checks", async () => {
    const shot = shotOf("cinematic", { kind: "generate", modelClass: "video.cinematic", prompt: "a counter", refs: [], takes: 1 });
    const taken = await takeWithPlan(shot, MP4_BYTES);
    const media = fakeMedia({ probe: () => probeOf() });
    const critic = recordedTransport({ "POST /api/v1/chat/completions": json(200, fixture("openrouter-critic-take-ok.json")) });
    const clean: BlackFramesResult = { videoPresent: true, durationMs: 5000, fps: 30, blackRuns: [], frozenRuns: [] };
    const seenBytes: number[] = [];
    const { run } = await checkOneTake(contextFor(taken), {
      gateway: gatewayWith(critic.transport),
      media,
      objects,
      scorer: { id: "similarity:fixture", async score() { return { status: "scored", score: 0.82, scorer: "similarity:fixture" }; } },
      detectors: {
        blackFrames: async ({ source }) => {
          if (source.kind === "bytes") seenBytes.push(source.bytes.byteLength);
          return clean;
        },
        flicker: async () => ({ videoPresent: true, frames: 150, flickerScore: 0.1 }),
        motion: async () => ({ videoPresent: true, frames: 150, meanMotion: 0.22 }),
      },
      paletteHex: async () => ["#1a2b3c"],
      metrics: async () => ({}),
      now: () => NOW,
    });
    const rule = (name: string) => run.verdict.checks.find((check) => check.rule === name);
    assert.deepEqual(seenBytes, [MP4_BYTES.byteLength], "the detector reads the take's own bytes");
    assert.equal(rule("no_black_or_frozen_frames")?.pass, true, "a clean detector answer is a pass, not missing evidence");
    assert.equal(rule("flicker_below_max")?.pass, true);
    assert.equal(rule("motion_present")?.pass, true);
  });

  test("a detector that refuses the take's file leaves its measure missing, so the take is not accepted", async () => {
    const shot = shotOf("cinematic", { kind: "generate", modelClass: "video.cinematic", prompt: "a counter", refs: [], takes: 1 });
    const taken = await takeWithPlan(shot, MP4_BYTES);
    const media = fakeMedia({ probe: () => probeOf() });
    const critic = recordedTransport({ "POST /api/v1/chat/completions": json(200, fixture("openrouter-critic-take-ok.json")) });
    const { run } = await checkOneTake(contextFor(taken), {
      gateway: gatewayWith(critic.transport),
      media,
      objects,
      scorer: { id: "similarity:fixture", async score() { return { status: "scored", score: 0.82, scorer: "similarity:fixture" }; } },
      detectors: {
        blackFrames: async () => {
          throw new EngineError("invalid_input", "the take cannot be decoded", { stage: "media.detectors" });
        },
        flicker: async () => ({ videoPresent: true, frames: 150, flickerScore: 0.1 }),
        motion: async () => ({ videoPresent: true, frames: 150, meanMotion: 0.22 }),
      },
      paletteHex: async () => ["#1a2b3c"],
      metrics: async () => ({}),
      now: () => NOW,
    });
    const black = run.verdict.checks.find((check) => check.rule === "no_black_or_frozen_frames");
    assert.equal(black?.pass, false, "a refused detector is missing evidence for its check");
    assert.notEqual(run.verdict.action, "accept", "the take goes to review, never to a pass");
  });
});
