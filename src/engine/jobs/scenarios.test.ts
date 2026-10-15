// End-to-end scenarios for the E4 and E5 acceptance tests (Video Engine Bible 19), on PGlite with recorded responses.
//
// Each scenario runs one request through the orchestrator's event log (engine_requests, engine_events, jobs, engine_gate_results,
// engine_decisions, engine_manifests). The real stage handlers run where they need no paid call: compose, pre_render_gate, render
// (HyperFrames and Shotstack deps are scripted), post_render_review (the final Critic answers from a recorded response), variants
// and deliver. The stages that spend money or call a model before them (intake, voice, plan, estimate_reserve, produce_shot,
// check_take, edit) are answered by the test with the stage's output, built from the chain fixtures. Two scenarios answer
// pre_render_gate with its gate result instead of running the handler: the redo and the coded-shot block, whose failing checks
// the chain's clean inputs cannot produce, and the downgrade, whose rebuilt EDL the chain fixtures do not contain. The orchestrator
// routing on those gates is the thing under test there, and each test says so.
//
// Nothing here calls a provider: the gateway is a scripted transport and no key is read.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import {
  budgetReservationSchema,
  EngineError,
  type EditDecisionList,
  type GateResult,
  type ProductionRequest,
  type StyleKit,
  type TakeVerdict,
} from "../contracts/index.ts";
import * as fx from "../contracts/fixtures/index.ts";
import { fixtureId } from "../contracts/fixtures/index.ts";
import { compile } from "../compose/compiler.ts";
import { cleanRender, drawnOverlays, integrityPassed, VIDEO_ID } from "../review/test/render.ts";
import type { GoldMetrics } from "../review/gold.ts";
import type { TimelineResult } from "../media/interface.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { writeArtifact } from "./artifact-store.ts";
import { scopedLedgerStore } from "./asset-stores-sql.ts";
import { sqlLedgerStore } from "./sql-ledger-store.ts";
import { executeEngineJob } from "./dispatch.ts";
import { applyEngineEvent, readEngineRequest, startEngineRequest } from "./orchestrator-sql.ts";
import { createEngineRuntime } from "./runtime.ts";
import { sqlEventStore } from "./event-store-sql.ts";
import { withReservationLedger } from "./sql-ledger-store.ts";
import { createRenderHandler, type RenderPorts, type RenderScope } from "./handlers/render.ts";
import type { PostRenderPorts } from "./handlers/post-render-review.ts";
import { notConnectedWorkspaceBudget } from "./handlers/estimate-reserve.ts";
import { fakeObjects, gatewayWith, json, PNG_1X1, recordedTransport, type Reply } from "./test/harness.ts";
import type { EnginePayload, EngineRuntime, StageContext, StageOutput } from "./types.ts";
import { DOWNLOAD_URL, scriptedGateway, submitExchange, pollExchange, downloadExchange, shotstackDepsFor } from "../render/test/shotstackHarness.ts";
import type { RenderAdapter, RenderSubmitInput } from "../render/hyperframesCloud.ts";
import { shotstackRenderKey } from "../render/shotstack.ts";

const WS = "ws_scenarios";
const BRAND = "brand_scenarios";
const REQ = fx.FIXTURE_IDS.request;
const RES = fx.FIXTURE_IDS.reservation;
const CREATED = "2026-10-15T10:00:00.000Z";
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
const here = dirname(fileURLToPath(import.meta.url));
const SHOT_1 = fx.FIXTURE_IDS.shot1;
const SHOT_2 = fx.FIXTURE_IDS.shot2;
const SHOT_3 = fx.FIXTURE_IDS.shot3;
const TAKE_1 = fx.FIXTURE_IDS.take1;
const TAKE_2 = fx.FIXTURE_IDS.take2;
const TAKE_3A = fx.FIXTURE_IDS.take3a;
const TAKE_3B = fx.FIXTURE_IDS.take3b;
const EDL = cleanRender().edl.edlId;
const MUSIC = { trackId: "track_fixture_music", uri: "store://music/fixture-bed.mp3", durationMs: 60_000 };

const databases: TestDatabase[] = [];
after(async () => {
  for (const db of databases) await db.close();
});

function criticReply(name: string): Reply {
  return json(200, JSON.parse(readFileSync(join(here, "../review/test/fixtures", `${name}.json`), "utf8")));
}

/** A timeline of one audible minute at clean loudness, as the media functions report it. */
function cleanTimeline(): TimelineResult {
  const loudness = Array.from({ length: 600 }, (_, index) => ({ atMs: index * 100, lufs: -18 as number | null }));
  return { videoPresent: true, audioPresent: true, brightness: [], motion: [], loudness, envelope: { stepMs: 10, rms: [] } };
}

/** Every media URI of an EDL: the clip sources and the audio. The licence check reads this set. */
function mediaUrisOf(edl: EditDecisionList): Set<string> {
  const uris = new Set<string>();
  for (const track of edl.tracks) for (const clip of track.clips) if (clip.srcUri) uris.add(clip.srcUri);
  for (const clip of [edl.audio.voice, ...edl.audio.sfx, ...(edl.audio.music ? [edl.audio.music] : [])]) uris.add(clip.uri);
  return uris;
}

function gate(name: GateResult["gate"], pass: boolean, failing: { rule?: string; shotIds?: string[] } = {}): GateResult {
  return {
    gate: name,
    subjectId: REQ,
    pass,
    checks: pass ? [{ rule: `${name}.ok`, pass: true }] : [{ rule: failing.rule ?? `${name}.broken`, pass: false, detail: "check detail" }],
    ...(failing.shotIds ? { failingShotIds: failing.shotIds } : {}),
  };
}

/** Gold metrics that meet the target (Bible 12.4), by check key "gate:rule". */
function proven(keys: string[]): Record<string, GoldMetrics> {
  const metrics: GoldMetrics = {
    total: 200,
    failLabels: 100,
    passLabels: 100,
    caughtFailures: 95,
    falseFails: 5,
    recall: 0.95,
    falseFailRate: 0.05,
    enoughLabels: true,
    meetsTarget: true,
  };
  return Object.fromEntries(keys.map((key) => [key, metrics]));
}

type ShotSummaryLike = {
  shotId: string;
  visualType: string;
  downgradeTo: string | null;
  sourceKind: "generate" | "stock" | "component" | "asset";
  modelClass: string | null;
  takesWanted: 1 | 2;
};

/** The chain plan's shots as the plan stage reports them (ShotSummary). */
function planShots(): ShotSummaryLike[] {
  return fx.scenePlanFixture.shots.map((shot) => ({
    shotId: shot.shotId,
    visualType: shot.visualType,
    downgradeTo: shot.downgradeTo ?? null,
    sourceKind: shot.source.kind === "generate" ? "generate" : shot.source.kind === "stock" ? "stock" : shot.source.kind === "component" ? "component" : "asset",
    modelClass: shot.source.kind === "generate" ? shot.source.modelClass : null,
    takesWanted: shot.source.kind === "generate" ? (shot.source.takes as 1 | 2) : 1,
  }));
}

type World = {
  db: TestDatabase;
  runtime: EngineRuntime;
  objects: ReturnType<typeof fakeObjects>;
  kit: StyleKit;
  dedupe: number;
  renderMode: "ok" | "fail";
  overlayDrop: boolean;
  critic: ReturnType<typeof recordedTransport>;
  edlArtifactId: string;
};

function hyperframesAdapter(mode: "ok" | "fail"): RenderAdapter<RenderSubmitInput> {
  return {
    renderer: "hyperframes-cloud",
    async ready() {
      return undefined;
    },
    async submit() {
      if (mode === "fail") throw new EngineError("provider", "HyperFrames refused the render", { retryable: true, stage: "render" });
      return { renderId: "hfr_scenario_0001", status: "queued" };
    },
    async poll(renderId) {
      return { renderId, status: "completed", videoUrl: "https://video.example.test/hfr_scenario_0001.mp4" };
    },
    async fetchResult() {
      return { bytes: MP4 };
    },
  };
}

/** The render ports for one scenario: HyperFrames with the given behaviour, and Shotstack only when a test gives it. */
function renderPortsFor(state: World, shotstack?: (scope: RenderScope) => ReturnType<typeof shotstackDepsFor>): RenderPorts {
  return {
    loadStyleKit: async () => state.kit,
    renderEstimateUsd: async () => 0.05,
    hyperframes: () => ({
      adapter: hyperframesAdapter(state.renderMode),
      ledger: scopedLedgerStore(state.db.sql, WS, RES),
      verifyIntegrity: async (input) => integrityPassed(input.videoId) as GateResult,
      storeVideo: async ({ videoId, bytes }) => {
        const key = `renders/${videoId}.mp4`;
        await state.objects.put({ organizationId: WS, brandId: BRAND, key, mimeType: "video/mp4", bytes });
        return key;
      },
      resolveAsset: async () => MP4,
      pollIntervalMs: 0,
      sleep: async () => undefined,
      newVideoId: () => VIDEO_ID,
    }),
    ...(shotstack ? { shotstack } : {}),
    now: () => CREATED,
  };
}

function postRenderPorts(state: World): PostRenderPorts {
  return {
    gateway: gatewayWith(state.critic.transport),
    media: {
      async frames(request) {
        return { frames: request.atMs.map((atMs) => ({ atMs, width: 1080, height: 1920, png: PNG_1X1 })) };
      },
      async loudness() {
        return { integratedLufs: -14, truePeakDbtp: -2, loudnessRangeLu: 6 };
      },
      async timeline() {
        return cleanTimeline();
      },
    },
    objects: state.objects,
    measureBlackFrames: async (input) => input.times.map((atMs) => ({ atMs, black: false })),
    measureOverlays: async ({ edl }) => drawnOverlays(edl).map((item, index) => ({ clipId: item.clipId, present: !(state.overlayDrop && index === 0) })),
    measureOcr: async () => ({ captionWordsChecked: 24, captionWordsMismatched: 0, onScreenText: ["Send BLEND to get the link"] }),
    forbiddenTerms: async () => ["miracle cure"],
    now: () => CREATED,
  };
}

/** A fresh database with a workspace, a request row started at intake's cached-DNA point, its reservation and its composition root. */
async function world(options: { variantCount?: number; request?: ProductionRequest; gateMetrics?: Record<string, GoldMetrics>; renderMode?: "ok" | "fail"; overlayDrop?: boolean } = {}): Promise<World> {
  const db = await createTestDatabase();
  databases.push(db);
  await seedWorkspace(db.sql, WS, BRAND);
  const render = cleanRender();
  // The request row comes first (artifacts reference it), and the two artifacts the start names are written under their ids.
  const requestArtifactId = fixtureId("art_", 40);
  const dnaArtifactId = fixtureId("art_", 42);
  await startEngineRequest(db.sql, {
    organizationId: WS,
    brandId: BRAND,
    requestId: REQ,
    formatId: fx.productionRequestFixture.format.formatId,
    priority: "normal",
    cachedDna: true,
    cachedDnaArtifactId: dnaArtifactId,
    variantCount: options.variantCount ?? 0,
    requestArtifactId,
    ...(options.gateMetrics ? { gateMetrics: options.gateMetrics } : {}),
  });
  await writeArtifact(db.sql, {
    organizationId: WS,
    requestId: REQ,
    stage: "intake",
    type: "production_request",
    body: options.request ?? fx.productionRequestFixture,
    createdAt: CREATED,
    artifactId: requestArtifactId,
  });
  await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "analyze_reference", type: "video_dna", body: fx.videoDnaFixture, createdAt: CREATED, artifactId: dnaArtifactId });
  await sqlLedgerStore(db.sql, WS).createReservation(
    budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId: RES,
      requestId: REQ,
      workspaceId: WS,
      mode: "cap",
      lines: [{ stage: "claude_roles", estimateUsd: 2 }],
      estimateUsd: 2,
      redoAllowanceUsd: 0,
      reservedUsd: 2,
      state: "reserved",
      createdAt: CREATED,
    }),
  );
  const edl = await writeArtifact(db.sql, { organizationId: WS, requestId: REQ, stage: "edit", type: "edl", body: render.edl, createdAt: CREATED });
  const state: World = {
    db,
    runtime: undefined as unknown as EngineRuntime,
    objects: fakeObjects(),
    kit: fx.styleKitFixture,
    dedupe: 0,
    renderMode: options.renderMode ?? "ok",
    overlayDrop: options.overlayDrop === true,
    critic: recordedTransport({ "POST /api/v1/chat/completions": criticReply("openrouter-critic-final-ok") }),
    edlArtifactId: edl.artifactId,
  };
  state.runtime = createEngineRuntime({
    sql: db.sql,
    gateway: gatewayWith(recordedTransport({}).transport),
    workspaceBudget: notConnectedWorkspaceBudget,
    now: () => CREATED,
    styleKit: async () => state.kit,
    preRender: {
      renderBudget: async () => ({ remainingUsd: 10, renderEstimateUsd: 0.05 }),
      licensedUris: async () => mediaUrisOf(render.edl),
      productImageUris: async () => [fx.BLENDER_FRONT_URI],
      disclosures: async () => ({ aiGeneratedPeople: true }),
    },
    render: renderPortsFor(state),
    variants: {
      loadMusicTrack: async ({ trackId }) => (trackId === MUSIC.trackId ? MUSIC : undefined),
      withLedger: (scope, fn) => withReservationLedger(db.sql, scope.organizationId, scope.reservationId, fn),
      events: sqlEventStore(db.sql),
      now: () => CREATED,
    },
    postRender: postRenderPorts(state),
  });
  return state;
}

/** Applies one stage output the test answers (the upstream stages). */
async function answer(state: World, output: StageOutput): Promise<void> {
  state.dedupe += 1;
  await applyEngineEvent(state.db.sql, {
    organizationId: WS,
    requestId: REQ,
    event: { type: "succeeded", output },
    dedupeKey: `test:${state.dedupe}:${output.stage}:${output.subjectId}`,
  });
}

type QueuedRow = { id: string; organization_id: string; brand_id: string | null; job_type: string; payload: string; max_attempts: number };

/** The oldest queued job of a stage, optionally for one subject. Null when none is queued. */
async function queuedJob(state: World, stage: string, subjectId?: string): Promise<QueuedRow | null> {
  const rows = await state.db.sql<QueuedRow>`
    select id, organization_id, brand_id, job_type, payload, max_attempts from jobs
    where job_type = ${`engine.${stage}`} and status = 'queued' order by idempotency_key
  `;
  // The newest attempt wins: the test answers some jobs without running them, so an older one may still be queued.
  let newest: { row: QueuedRow; attempt: number } | null = null;
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as EnginePayload;
    if (subjectId !== undefined && payload.subjectId !== subjectId) continue;
    const attempt = Number(payload.attempt);
    if (newest === null || attempt > newest.attempt) newest = { row, attempt };
  }
  return newest?.row ?? null;
}

/** Runs the queued job of a stage through the dispatcher, as Meridian's worker does, and marks it succeeded. */
async function runReal(state: World, stage: string, subjectId?: string): Promise<void> {
  const row = await queuedJob(state, stage, subjectId);
  if (row === null) throw new Error(`no queued ${stage} job${subjectId ? ` for ${subjectId}` : ""}`);
  await executeEngineJob(
    state.db.sql,
    { id: row.id, organization_id: row.organization_id, brand_id: row.brand_id, job_type: row.job_type, payload: row.payload, attempts: 0, max_attempts: row.max_attempts },
    state.runtime,
  );
  await state.db.sql`update jobs set status = 'succeeded' where id = ${row.id}`;
}

async function queuedStages(state: World): Promise<string[]> {
  const rows = await state.db.sql<{ job_type: string }>`select job_type from jobs where status = 'queued' and organization_id = ${WS}`;
  return rows.map((row) => row.job_type.replace("engine.", ""));
}

async function store(state: World, type: "take" | "take_verdict" | "scene_plan" | "voice_track" | "validated_request", body: unknown): Promise<string> {
  const written = await writeArtifact(state.db.sql, { organizationId: WS, requestId: REQ, stage: "test", type, body: body as never, createdAt: CREATED });
  return written.artifactId;
}

/** Runs the upstream stages as the test answers them: intake, voice, plan and the estimate on the request's reservation. */
async function toProduction(state: World, shots: ShotSummaryLike[] = planShots()): Promise<void> {
  const validatedId = await store(state, "validated_request", fx.validatedRequestFixture);
  await answer(state, { stage: "intake", subjectId: REQ, gate: gate("request", true), budgetReservationId: RES, budgetPause: null, artifacts: { validated: validatedId } });
  const voiceId = await store(state, "voice_track", fx.voiceTrackFixture);
  await answer(state, { stage: "voice", subjectId: REQ, gate: gate("voice", true), artifacts: { voice: voiceId } });
  const planId = await store(state, "scene_plan", fx.scenePlanFixture);
  await answer(state, { stage: "plan", subjectId: REQ, gate: gate("plan", true), shots: shots as never, artifacts: { plan: planId } });
  await answer(state, { stage: "estimate_reserve", subjectId: REQ, gate: gate("budget", true), budgetReservationId: RES, artifacts: {} });
}

/** One produce job answered with a take, and its check answered with a verdict (what check_take writes). */
async function produceAndCheck(state: World, shotId: string, takeId: string, take: unknown, pass: boolean): Promise<void> {
  const takeArtifact = await store(state, "take", take);
  await answer(state, { stage: "produce_shot", subjectId: shotId, shotId, epoch: 0, takeId, artifacts: { [`take:${takeId}`]: takeArtifact } });
  const verdict: TakeVerdict = { takeId, pass, confidence: 0.9, checks: [{ rule: pass ? "slop.clean" : "slop.hands", pass }], action: pass ? "accept" : "redo" };
  const verdictArtifact = await store(state, "take_verdict", verdict);
  await answer(state, {
    stage: "check_take",
    subjectId: takeId,
    shotId,
    takeId,
    gate: gate("take", pass, { rule: "slop.hands" }),
    verdict,
    artifacts: { [`verdict:${takeId}`]: verdictArtifact },
  });
}

/** Shot 3: take 3a fails its check in the round and take 3b passes it, so the round accepts take 3b. */
async function produceShot3(state: World): Promise<void> {
  const take3a = await store(state, "take", fx.take3aFixture);
  await answer(state, { stage: "produce_shot", subjectId: SHOT_3, shotId: SHOT_3, epoch: 0, takeId: TAKE_3A, artifacts: { [`take:${TAKE_3A}`]: take3a } });
  await produceAndCheck(state, SHOT_3, TAKE_3B, fx.take3bFixture, true);
  const verdict: TakeVerdict = { takeId: TAKE_3A, pass: false, confidence: 0.9, checks: [{ rule: "slop.hands", pass: false }], action: "redo" };
  const verdictArtifact = await store(state, "take_verdict", verdict);
  await answer(state, {
    stage: "check_take",
    subjectId: TAKE_3A,
    shotId: SHOT_3,
    takeId: TAKE_3A,
    gate: gate("take", false, { rule: "slop.hands" }),
    verdict,
    artifacts: { [`verdict:${TAKE_3A}`]: verdictArtifact },
  });
}

/** Shots 1 and 3: take 1 passes, and shot 3 is produced by produceShot3. */
async function produceShots1And3(state: World): Promise<void> {
  await produceAndCheck(state, SHOT_1, TAKE_1, fx.take1Fixture, true);
  await produceShot3(state);
}

/** The whole clean chain: shots 1, 2 and 3 pass, the edit is answered. */
async function produceClean(state: World): Promise<void> {
  await produceShots1And3(state);
  await produceAndCheck(state, SHOT_2, TAKE_2, fx.take2Fixture, true);
}

async function answerEdit(state: World): Promise<void> {
  await answer(state, { stage: "edit", subjectId: REQ, gate: gate("edit", true), edlId: EDL, artifacts: { [`edl:${EDL}`]: state.edlArtifactId } });
}

/** The real chain after the edit: compose, pre-render, render, post-render. */
async function realChain(state: World): Promise<void> {
  await runReal(state, "compose");
  await runReal(state, "pre_render_gate");
  await runReal(state, "render");
  await runReal(state, "post_render_review");
}

async function manifestRows(state: World): Promise<Array<{ id: string; body: string }>> {
  return state.db.sql<{ id: string; body: string }>`select id, body from engine_manifests where organization_id = ${WS} and request_id = ${REQ}`;
}

describe("E4: the four scenarios end to end, each with a manifest", () => {
  test("clean pass: every stage answers, the video is delivered and its manifest is written", async () => {
    const state = await world();
    await toProduction(state);
    await produceClean(state);
    await answerEdit(state);
    await realChain(state);
    await runReal(state, "deliver");

    assert.equal((await readEngineRequest(state.db.sql, WS, REQ))?.status, "delivered");
    const manifests = await manifestRows(state);
    assert.equal(manifests.length, 1, "one manifest row per delivered video");
    const body = JSON.parse(manifests[0]?.body ?? "{}") as { schema: string; shots: Array<{ shotId: string; takeId: string }>; gates: Array<{ gate: string }> };
    assert.equal(body.schema, "meridian.manifest/v2");
    assert.ok(body.shots.some((shot) => shot.shotId === SHOT_1 && shot.takeId === TAKE_1), "the manifest names the take of shot 1");
    assert.ok(body.gates.some((item) => item.gate === "pre_render"), "the manifest carries the pre-render gate");
    assert.ok(body.gates.some((item) => item.gate === "post_render"), "the manifest carries the post-render gate");
    const reservation = await state.db.sql<{ state: string }>`select state from engine_reservations where id = ${RES}`;
    assert.equal(reservation[0]?.state, "released", "the reservation is released at deliver");
  });

  test("one redo: a proven pre-render failure on one shot sends only that shot back to produce, then the request delivers", async () => {
    const state = await world({ gateMetrics: proven(["pre_render:shot_intent"]) });
    await toProduction(state);
    await produceClean(state);
    await answerEdit(state);
    await runReal(state, "compose");
    await answer(state, { stage: "pre_render_gate", subjectId: EDL, edlId: EDL, gate: gate("pre_render", false, { rule: "shot_intent", shotIds: [SHOT_1] }), artifacts: {} });
    const redo = await queuedJob(state, "produce_shot", SHOT_1);
    assert.ok(redo, "shot 1 is produced again");
    assert.equal((JSON.parse(redo.payload) as EnginePayload).attempt, "2");
    const other = await queuedJob(state, "produce_shot", SHOT_2);
    assert.ok(other === null || (JSON.parse(other.payload) as EnginePayload).attempt === "1", "shot 2 is not produced again (its only job is the first attempt)");

    const redoTake = fixtureId("take_", 91);
    await produceAndCheck(state, SHOT_1, redoTake, { ...fx.take1Fixture, takeId: redoTake }, true);
    await answerEdit(state);
    await realChain(state);
    await runReal(state, "deliver");
    assert.equal((await readEngineRequest(state.db.sql, WS, REQ))?.status, "delivered");
    assert.equal((await manifestRows(state)).length, 1);
  });

  test("downgrade: a shot that fails its redos is downgraded, the planner swaps its type, and the manifest records the decision", async () => {
    const state = await world();
    await toProduction(state);
    // Shot 1 fails its first round and its two redos (Bible 5.3): the third failing round downgrades it to kinetic_type.
    const takes = [TAKE_1, fixtureId("take_", 92), fixtureId("take_", 93)];
    for (const takeId of takes) await produceAndCheck(state, SHOT_1, takeId, { ...fx.take1Fixture, takeId }, false);
    assert.ok(await queuedJob(state, "plan", SHOT_1), "a downgrade replan is queued for shot 1");
    const downgraded = planShots().map((shot) =>
      shot.shotId === SHOT_1 ? { ...shot, visualType: "kinetic_type", downgradeTo: null, sourceKind: "component" as const, modelClass: null, takesWanted: 1 as const } : shot,
    );
    const planId = await store(state, "scene_plan", fx.scenePlanFixture);
    await answer(state, { stage: "plan", subjectId: SHOT_1, gate: gate("plan", true), shots: downgraded as never, artifacts: { plan: planId } });
    await produceShot3(state);
    await produceAndCheck(state, SHOT_2, TAKE_2, fx.take2Fixture, true);
    await answerEdit(state);
    await runReal(state, "compose");
    // The edit above is the test's answer, built from the original plan. The pre-render gate is answered too (the planner's rebuilt
    // EDL is not in the chain fixtures), so the render and review that follow are the real stages.
    await answer(state, { stage: "pre_render_gate", subjectId: EDL, edlId: EDL, gate: gate("pre_render", true), artifacts: {} });
    await runReal(state, "render");
    await runReal(state, "post_render_review");
    await runReal(state, "deliver");
    assert.equal((await readEngineRequest(state.db.sql, WS, REQ))?.status, "delivered");
    const manifest = JSON.parse((await manifestRows(state))[0]?.body ?? "{}") as { decisions: Array<{ chose: string }> };
    assert.ok(manifest.decisions.some((decision) => decision.chose === "kinetic_type"), "the manifest records the downgrade");
  });

  test("human escalation: a shot with no downgrade pauses for review; a human picks a take; the request resumes and delivers", async () => {
    const state = await world();
    await toProduction(state);
    const takes = [TAKE_2, fixtureId("take_", 94), fixtureId("take_", 95)];
    for (const takeId of takes) await produceAndCheck(state, SHOT_2, takeId, { ...fx.take2Fixture, takeId }, false);
    const paused = await readEngineRequest(state.db.sql, WS, REQ);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.state.pause?.kind, "escalation");
    const review = await state.db.sql<{ kind: string; subject_id: string }>`select kind, subject_id from engine_review_items where request_id = ${REQ}`;
    assert.ok(review.some((item) => item.kind === "escalation" && item.subject_id === SHOT_2), "a review item names the shot");

    await produceShots1And3(state);
    await applyEngineEvent(state.db.sql, { organizationId: WS, requestId: REQ, event: { type: "human_choice", shotId: SHOT_2, takeId: TAKE_2 }, dedupeKey: "test:human:1" });
    assert.equal((await readEngineRequest(state.db.sql, WS, REQ))?.status, "running", "the human choice resumes the request");
    await answerEdit(state);
    await realChain(state);
    await runReal(state, "deliver");
    assert.equal((await readEngineRequest(state.db.sql, WS, REQ))?.status, "delivered");
    const gold = await state.db.sql<{ n: number }>`select count(*)::int as n from engine_events where request_id = ${REQ} and kind = 'gold_label'`;
    assert.equal(gold[0]?.n, 1, "the human choice is stored as a gold label");
  });

  test("a broken overlay never reaches deliver: an unproven post-render failure escalates and nothing is delivered", async () => {
    const state = await world({ overlayDrop: true });
    await toProduction(state);
    await produceClean(state);
    await answerEdit(state);
    await realChain(state);
    const read = await readEngineRequest(state.db.sql, WS, REQ);
    assert.equal(read?.status, "paused");
    assert.equal(read?.state.pause?.stage, "post_render_review");
    assert.ok(!(await queuedStages(state)).includes("deliver"), "deliver is not queued for a video with a failed overlay");
    const gates = await state.db.sql<{ gate: string; passed: boolean }>`select gate, passed from engine_gate_results where request_id = ${REQ} and gate = 'post_render'`;
    assert.deepEqual(gates.map((item) => item.passed), [false], "the failed post-render result is stored");
  });
});

describe("E4: a plan with five coded shots in a row is blocked before render", () => {
  test("the slideshow failure of the pre-render gate, when unproven, goes to review and render is never queued", async () => {
    const state = await world();
    await toProduction(state);
    await produceClean(state);
    await answerEdit(state);
    await runReal(state, "compose");
    await answer(state, { stage: "pre_render_gate", subjectId: EDL, edlId: EDL, gate: gate("pre_render", false, { rule: "slideshow_coded_run" }), artifacts: {} });
    assert.equal(await queuedJob(state, "render"), null, "render is never queued");
    assert.equal((await readEngineRequest(state.db.sql, WS, REQ))?.state.pause?.kind, "escalation");
  });
});

describe("E5: variants and the render fallback", () => {
  test("a music re-render variant triggers no generation: no voice or produce job is queued, and the variant is composed only", async () => {
    const request: ProductionRequest = { ...fx.productionRequestFixture, output: { master: true, variants: { music: [MUSIC.trackId], maxVariants: 2, budgetUsd: 1 } } };
    const state = await world({ variantCount: 1, request });
    await toProduction(state);
    await produceClean(state);
    await answerEdit(state);
    await realChain(state);
    const generation = async () =>
      (await state.db.sql<{ n: number }>`select count(*)::int as n from jobs where organization_id = ${WS} and job_type in ('engine.voice', 'engine.produce_shot')`)[0]?.n ?? -1;
    const before = await generation();
    await runReal(state, "variants");
    assert.equal(await generation(), before, "the variants stage adds no voice or produce job");
    assert.ok((await queuedStages(state)).includes("compose"), "the music variant is composed");
    assert.ok(!(await queuedStages(state)).includes("deliver"), "deliver waits for the variant");
    const planned = await state.db.sql<{ n: number }>`select count(*)::int as n from engine_events where request_id = ${REQ} and kind = 'variant.planned'`;
    assert.ok((planned[0]?.n ?? 0) >= 1, "the variant plan is on record");
  });

  test("a forced HyperFrames failure on a component-free EDL falls back to Shotstack and renders the video", async () => {
    const state = await world({ renderMode: "fail" });
    const render = cleanRender();
    const edl: EditDecisionList = { ...render.edl, tracks: render.edl.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.component === undefined) })) };
    const compiled = compile(edl, state.kit);
    const shotstack = scriptedGateway([submitExchange({ key: shotstackRenderKey(edl) }), pollExchange("done", { url: DOWNLOAD_URL }), downloadExchange()]);
    const handler = createRenderHandler(renderPortsFor(state, () => shotstackDepsFor(shotstack.gateway, sqlLedgerStore(state.db.sql, WS))));
    const inputs = [
      (await writeArtifact(state.db.sql, { organizationId: WS, requestId: REQ, stage: "compose", type: "composition", body: compiled.composition, createdAt: CREATED })).artifactId,
      (await writeArtifact(state.db.sql, { organizationId: WS, requestId: REQ, stage: "edit", type: "edl", body: edl, createdAt: CREATED })).artifactId,
      await store(state, "validated_request", fx.validatedRequestFixture),
    ];
    const result = await handler.run(renderContext(state, inputs, edl.edlId));
    if (result.kind !== "done" || result.output.stage !== "render") assert.fail("render did not finish");
    assert.equal(result.output.gate.pass, true, "the Shotstack video passes the integrity check");
    assert.ok(result.output.decisions?.some((decision) => decision.chose === "shotstack"), "the fallback is a decision");
    assert.ok(result.output.artifacts[`render:${edl.edlId}`], "a rendered video is stored");
    assert.deepEqual(shotstack.problems, [], "the Shotstack requests match the script");
  });

  test("a forced HyperFrames failure on an EDL with a custom component goes to review, with no Shotstack request", async () => {
    const state = await world({ renderMode: "fail" });
    const render = cleanRender();
    const compiled = compile(render.edl, state.kit);
    const shotstack = scriptedGateway([]);
    const handler = createRenderHandler(renderPortsFor(state, () => shotstackDepsFor(shotstack.gateway, sqlLedgerStore(state.db.sql, WS))));
    const inputs = [
      (await writeArtifact(state.db.sql, { organizationId: WS, requestId: REQ, stage: "compose", type: "composition", body: compiled.composition, createdAt: CREATED })).artifactId,
      state.edlArtifactId,
      await store(state, "validated_request", fx.validatedRequestFixture),
    ];
    const result = await handler.run(renderContext(state, inputs, render.edl.edlId));
    if (result.kind !== "done" || result.output.stage !== "render") assert.fail("render did not finish");
    assert.equal(result.output.gate.pass, false);
    assert.equal(result.output.gate.checks[0]?.rule, "render_completed");
    assert.equal(shotstack.seen.length, 0, "no Shotstack request is made for a custom component");
    assert.equal(result.output.artifacts[`render:${render.edl.edlId}`], undefined, "no video is stored");
  });
});

/** The stage context of one render job, with the artifacts the job reads. */
function renderContext(state: World, inputArtifactIds: string[], edlId: string): StageContext {
  const payload: EnginePayload = {
    organizationId: WS,
    requestId: REQ,
    stage: "render",
    subjectId: edlId,
    attempt: "1",
    priority: "normal",
    budgetReservationId: RES,
    inputArtifactIds,
    hints: [],
    details: {},
  };
  return {
    sql: state.db.sql,
    jobId: "job_scenario_render",
    organizationId: WS,
    requestId: REQ,
    stage: "render",
    subjectId: edlId,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
}
