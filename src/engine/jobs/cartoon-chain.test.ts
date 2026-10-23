// The cartoon_generated chain end to end on recorded fixtures (Video Engine Bible 6.4, 6.6, 6.7, 6.8, 7.1; contract v5).
//
// The shot goes through the real stages: the plan's summary (shotSummaryOf), the orchestrator's advance over each result, the produce
// stage with the real asset router and the real OpenRouter image and video adapters over a recorded transport (the keyframe, then the
// clip from it), the poller's settle (the provider is polled until it finishes, then finish runs), the take check, and the edit.
//
// Stand-ins, and only these: the plan is the contract fixture's plan with the cartoon shot in the form the plan builder writes it (the
// clip sends no references: see plan/sources.ts), because the planner's own choice of a cartoon shot is not recorded. The other shots'
// takes are the contract fixtures. The links for the provider's inputs are a fake signer's (the production link is Meridian's signed
// engine-media route). The media detectors are clean recorded answers, and the palette similarity is a recorded score (the embedding
// vendor is an open owner decision, Bible 20.2). The video listing is a stand-in written in the test (see profilesOf). Nothing calls a
// live API: the transport answers from the recorded replies, and an unexpected request throws. The keyframe answer is the recorded image
// answer of assets/test/fixtures.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { budgetReservationSchema, EngineError, type ShotSpec, type StyleKit } from "../contracts/index.ts";
import {
  cartoonChainShotFixture,
  CHARACTER_SHEET_URI,
  FIXTURE_IDS,
  fixtureId,
  scenePlanChainFixture,
  styleKitFixture,
  take2Fixture,
  take3bFixture,
  validatedRequestFixture,
  videoDnaFixture,
  voiceTrackFixture,
} from "../contracts/fixtures/index.ts";
import type { ProviderAdapter, ProviderPoll } from "../contracts/assets.ts";
import { createAssetRouter, type AsyncAssetRouter } from "../assets/router.ts";
import { memoryMediaStore, type MediaStore } from "../assets/adapter.ts";
import { openRouterImageAdapter } from "../assets/providers/openrouterImage.ts";
import { openRouterVideoAdapter, videoProfilesFromListing, type VideoProfile } from "../assets/providers/openrouterVideo.ts";
import { gatewayDownloader } from "../gateway/download.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { check, gateResult } from "../review/gates/common.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { readArtifact, writeArtifact } from "./artifact-store.ts";
import { scopedLedgerStore, sqlAssetCache, sqlBreakerStore, sqlBucketStore, sqlProviderStats } from "./asset-stores-sql.ts";
import { startEngineRequest } from "./orchestrator-sql.ts";
import { sqlLedgerStore } from "./sql-ledger-store.ts";
import { createCheckTakeHandler } from "./handlers/check-take.ts";
import { createEditHandler } from "./handlers/edit.ts";
import { shotSummaryOf } from "./handlers/plan.ts";
import { createProduceShotHandler, routerGenerator } from "./handlers/produce-shot.ts";
import { advance, type OrchestratorState } from "./orchestrator.ts";
import { fakeMedia, fakeObjects, fixture, gatewayWith, json, MP4_BYTES, probeOf, raw, recordedTransport, scorerFrom, type Reply } from "./test/harness.ts";
import { routes } from "../config/routes.ts";
import { routesWith } from "../assets/test/recorded.ts";
import type { EngineEvent, EnginePayload, QueuedJob, StageContext, StageRunResult } from "./types.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";

const ORG = "org_cartoon_chain";
const BRAND = "brand_cartoon_chain";
const REQUEST_ID = FIXTURE_IDS.request;
const RESERVATION = fixtureId("res_", 960);
const NOW = "2026-10-14T10:00:00.000Z";
const CHAIN_SHOT = cartoonChainShotFixture.shotId;
/**
 * The chain's models. The route table names none (the live catalog chooses, Bible 10.5), so this test's table names the keyframe and
 * the clip the way the fallback path reads them. The ids are the recorded listing's.
 */
const KEYFRAME_MODEL = "bytedance-seed/seedream-4.5";
const CLIP_MODEL = "bytedance/seedance-2.0-mini";
const CHAIN_ROUTES = routesWith(
  "video.budget",
  [{ provider: "openrouter", model: CLIP_MODEL, priceKey: "seedance_2_0_mini", verified: false }],
  routesWith("image.keyframe", [{ provider: "openrouter", model: KEYFRAME_MODEL, priceKey: "seedream_4_5", verified: false }], routes.table),
);
const CLIP_JOB = "job-cartoon-clip-1";
const LINK_HOST = "https://media.example.test/engine/link";
/** The recorded keyframe answer (the image adapter's own fixture, a valid PNG above its size floor). */
const KEYFRAME_ANSWER = JSON.parse(readFileSync(new URL("../assets/test/fixtures/openrouter-image-references.json", import.meta.url), "utf8")).answer;
const CLIP_POLICY_FAILED = { id: CLIP_JOB, generation_id: "gen-cartoon-clip-1", polling_url: `/api/v1/videos/${CLIP_JOB}`, status: "failed", error: "Generation refused by content moderation policy", usage: { cost: 0, is_byok: false } };
const CRITIC_ANSWER = fixture("openrouter-critic-take-ok.json");
/**
 * The cartoon shot as the plan builder writes it (plan/sources.ts): the keyframe carries the references, and the clip sends none. The
 * contract fixture still lists the references on the clip, which the video adapter refuses (it has no reference field), so the test
 * plans the builder's form. The other shots of the fixture plan are kept.
 */
const FIXTURE_CALLS = cartoonChainShotFixture.source.kind === "chain" ? cartoonChainShotFixture.source.calls : [];
const [KEYFRAME_CALL, CLIP_CALL] = FIXTURE_CALLS;
if (KEYFRAME_CALL === undefined || CLIP_CALL === undefined) throw new Error("the cartoon fixture is not a two-call chain");
const CARTOON_SHOT: ShotSpec = { ...cartoonChainShotFixture, source: { kind: "chain", calls: [KEYFRAME_CALL, { ...CLIP_CALL, refs: [] }] } };
const PLANNED_SHOTS: ShotSpec[] = [CARTOON_SHOT, ...scenePlanChainFixture.shots.slice(1)];

/** The link port's stand-in for Meridian's signed engine-media route: a fetchable https URL for any store uri. */
function linker(linked: string[]) {
  return async (input: { organizationId: string; uri: string }): Promise<string> => {
    linked.push(input.uri);
    return `${LINK_HOST}/${linked.length}.png?sig=recorded`;
  };
}

/** The recorded transport for one run. The clip's poll answers in progress, then completed (or failed, for the refusal). */
function transportFor(options: { clipPoll?: Reply[]; clipSubmit?: Reply } = {}) {
  return recordedTransport({
    "POST /api/v1/images": json(200, KEYFRAME_ANSWER),
    "POST /api/v1/videos": options.clipSubmit ?? json(200, fixture("cartoon-clip-submit.json")),
    [`GET /api/v1/videos/${CLIP_JOB}`]: options.clipPoll ?? [json(200, fixture("cartoon-clip-in-progress.json")), json(200, fixture("cartoon-clip-completed.json"))],
    [`GET /api/v1/videos/${CLIP_JOB}/content`]: raw(200, MP4_BYTES),
    "POST /api/v1/chat/completions": json(200, CRITIC_ANSWER),
  });
}

/**
 * The routed video profiles. STAND-IN: the recorded GET /videos/models answers do not list the routed model, so its entry is written
 * here in the documented listing shape, with the 3-second length the cartoon shot needs. The owner's live run reads the real listing;
 * the router refuses a model whose durations do not include the shot's length.
 */
function profilesOf(): ReadonlyMap<string, VideoProfile> {
  return videoProfilesFromListing({
    data: [
      {
        id: CLIP_MODEL,
        canonical_slug: CLIP_MODEL,
        generate_audio: false,
        supported_durations: [3, 5, 8],
        supported_resolutions: ["720p", "1080p"],
        supported_aspect_ratios: ["9:16", "16:9"],
        supported_frame_images: ["first_frame"],
      },
    ],
  }).profiles;
}

let db: TestDatabase;

/** Each test has its own database: the request and its reservation are stored once per database. */
async function openDb(): Promise<void> {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
}

/** One test body, in its own database, closed when the body ends. */
function inDb(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    await openDb();
    try {
      await body();
    } finally {
      await db.close();
    }
  };
}

/** Stores the request, its reservation, and the artifacts the stages read (the plan, the VideoDNA, the voice, the validated request). */
async function startCartoonRequest(): Promise<{ requestArtifactId: string; validatedId: string; voiceId: string; dnaId: string; planId: string }> {
  const requestArtifactId = fixtureId("art_", 961);
  await startEngineRequest(db.sql, {
    organizationId: ORG,
    brandId: BRAND,
    requestId: REQUEST_ID,
    formatId: "fmt_cartoon_chain",
    priority: "normal",
    cachedDna: true,
    variantCount: 0,
    requestArtifactId,
  });
  const reservation = budgetReservationSchema.parse({
    schema: "meridian.budget_reservation/v1",
    reservationId: RESERVATION,
    requestId: REQUEST_ID,
    workspaceId: ORG,
    mode: "cap",
    lines: [{ stage: "produce_shot", estimateUsd: 1 }],
    estimateUsd: 1,
    redoAllowanceUsd: 0,
    reservedUsd: 1,
    state: "reserved",
    createdAt: NOW,
  });
  await sqlLedgerStore(db.sql as Sql, ORG).createReservation(reservation);
  const put = (stage: string, type: "scene_plan" | "video_dna" | "voice_track" | "validated_request", body: unknown) =>
    writeArtifact(db.sql, { organizationId: ORG, requestId: REQUEST_ID, stage, type, body, createdAt: NOW });
  const plan = await put("plan", "scene_plan", { ...scenePlanChainFixture, shots: PLANNED_SHOTS });
  const dna = await put("analyze_reference", "video_dna", videoDnaFixture);
  const voice = await put("voice", "voice_track", voiceTrackFixture);
  const validated = await put("intake", "validated_request", validatedRequestFixture);
  return { requestArtifactId, validatedId: validated.artifactId, voiceId: voice.artifactId, dnaId: dna.artifactId, planId: plan.artifactId };
}

/** The asset router of one run, on the request's reservation, with the real stores and the given gateway (runtime.ts's wiring). */
function routerFor(gateway: Gateway, media: MediaStore): AsyncAssetRouter {
  return createAssetRouter({
    gateway,
    ledger: scopedLedgerStore(db.sql as Sql, ORG, RESERVATION),
    cache: sqlAssetCache(db.sql as Sql, ORG),
    stats: sqlProviderStats(db.sql as Sql, ORG),
    breakers: sqlBreakerStore(db.sql as Sql, ORG),
    buckets: sqlBucketStore(db.sql as Sql, ORG),
    media,
    videoProfiles: profilesOf(),
    sleep: async () => {},
    now: () => Date.parse(NOW),
  });
}

/** The adapter a provider id names, for the poller's polls (the same adapters the router submits to). */
function adapterFor(gateway: Gateway, media: MediaStore, id: string): ProviderAdapter {
  for (const route of gateway.routes("image.keyframe")) {
    if (`${route.provider.id}:${route.model}` === id) return openRouterImageAdapter({ gateway, organizationId: ORG, workspaceId: ORG, route, media });
  }
  for (const route of gateway.routes("video.budget")) {
    if (`${route.provider.id}:${route.model}` === id) {
      return openRouterVideoAdapter({ gateway, organizationId: ORG, route, profile: profilesOf().get(route.model) ?? null });
    }
  }
  throw new Error(`no adapter for ${id} in this test`);
}

/** The produce_shot handler of one run: the real router, the real downloader and the fakes the media functions need (recorded shapes). */
function produceHandler(gateway: Gateway, media: MediaStore, objects: ReturnType<typeof fakeObjects>, linked: string[]) {
  return createProduceShotHandler({
    generator: routerGenerator(() => routerFor(gateway, media)),
    stock: async () => {
      throw new EngineError("internal", "the cartoon chain test makes no stock search");
    },
    downloader: gatewayDownloader(gateway),
    media: fakeMedia({ probe: () => probeOf({ durationMs: 3000, bytes: MP4_BYTES.byteLength }) }),
    objects,
    now: () => Date.parse(NOW),
    providerUrl: linker(linked),
  });
}

/** A stage context for a queued job, as the dispatcher builds it from the job row (the payload is the orchestrator's). */
function contextOf(job: QueuedJob, payload: EnginePayload = job.payload): StageContext {
  return {
    sql: db.sql as Sql,
    jobId: `job_${job.subjectId}_${job.attempt}`,
    organizationId: ORG,
    requestId: REQUEST_ID,
    stage: job.stage,
    subjectId: job.subjectId,
    attempt: job.attempt,
    payload,
    signal: new AbortController().signal,
  };
}

/**
 * Runs a produce job to its take the way the worker does: a submitted call is polled until the provider finishes, and then finish
 * settles it. The loop ends when the stage is done (a take, or a hold).
 */
async function driveProduce(handler: ReturnType<typeof produceHandler>, ctx: StageContext, gateway: Gateway, media: MediaStore): Promise<StageRunResult> {
  let result = await handler.run(ctx);
  while (result.kind === "submitted") {
    const adapter = adapterFor(gateway, media, result.provider);
    let polled: ProviderPoll = await adapter.poll(result.jobRef);
    for (let polls = 0; polled.state === "pending" && polls < 5; polls += 1) polled = await adapter.poll(result.jobRef);
    if (handler.finish === undefined) throw new Error("the produce handler has no finish");
    result = await handler.finish(
      {
        ...ctx,
        poll: { provider: result.provider, jobRef: result.jobRef, submittedAt: result.submittedAt, ...(result.carry === undefined ? {} : { carry: result.carry }) },
      },
      polled,
    );
  }
  return result;
}

function gateFor(name: "request" | "voice" | "plan" | "budget" | "take" | "edit", pass = true) {
  return gateResult(name, name === "take" ? "take_fixture" : REQUEST_ID, [check(`${name}_fixture`, pass)]);
}

/** The orchestrator's state, advanced one event at a time. */
function driver() {
  let state: OrchestratorState | null = null;
  let jobs: QueuedJob[] = [];
  return {
    apply(event: EngineEvent) {
      const result = advance(state, event);
      state = result.state;
      jobs = result.jobs;
      return result;
    },
    get state(): OrchestratorState {
      if (state === null) throw new Error("no orchestrator state");
      return state;
    },
    jobsFor(stage: string, subject?: string): QueuedJob[] {
      return jobs.filter((job) => job.stage === stage && (subject === undefined || job.subjectId === subject));
    },
  };
}

/** The ledger rows of the request's reservation, in the order the calls were made. */
async function ledgerRows(): Promise<Array<{ stage: string; provider: string; model: string; idempotencyKey: string; actualUsd: string | null }>> {
  return db.sql<{ stage: string; provider: string; model: string; idempotencyKey: string; actualUsd: string | null }>`
    select stage, provider, model, idempotency_key as "idempotencyKey", actual_usd::text as "actualUsd" from engine_ledger
    where organization_id = ${ORG} and reservation_id = ${RESERVATION} order by at asc, id asc
  `;
}

test("a cartoon_generated shot goes plan, produce (keyframe, then the clip from it), check and edit, on recorded fixtures", inDb(async () => {
  const stored = await startCartoonRequest();
  const media = memoryMediaStore();
  const transport = transportFor();
  const gateway = gatewayWith(transport.transport, CHAIN_ROUTES);
  const objects = fakeObjects();
  const linked: string[] = [];
  const orchestrator = driver();

  // Plan: the stage's summary accepts the chain (it is refused only for a chain the orchestrator cannot run).
  const summaries = PLANNED_SHOTS.map(shotSummaryOf);
  assert.equal(summaries.find((summary) => summary.shotId === CHAIN_SHOT)?.sourceKind, "chain");

  orchestrator.apply({ type: "start", organizationId: ORG, requestId: REQUEST_ID, priority: "normal", cachedDna: true, variantCount: 0, requestArtifactId: stored.requestArtifactId });
  orchestrator.apply({ type: "succeeded", output: { stage: "intake", subjectId: REQUEST_ID, gate: gateFor("request"), budgetReservationId: RESERVATION, budgetPause: null, artifacts: { validated: stored.validatedId } } });
  orchestrator.apply({ type: "succeeded", output: { stage: "voice", subjectId: REQUEST_ID, gate: gateFor("voice"), artifacts: { voice: stored.voiceId } } });
  orchestrator.apply({ type: "succeeded", output: { stage: "plan", subjectId: REQUEST_ID, gate: gateFor("plan"), shots: summaries, artifacts: { plan: stored.planId } } });
  orchestrator.apply({ type: "succeeded", output: { stage: "estimate_reserve", subjectId: REQUEST_ID, gate: gateFor("budget"), budgetReservationId: RESERVATION, artifacts: {} } });

  // Produce: the chain is one produce job, on the image bucket, paid, on the request's reservation.
  const [produceJob] = orchestrator.jobsFor("produce_shot", CHAIN_SHOT);
  assert.ok(produceJob, "the chain shot has its produce job");
  assert.equal(produceJob.paid, true);
  assert.equal(produceJob.payload.budgetReservationId, RESERVATION);
  assert.equal(produceJob.payload.details.providerKey, "image", "the chain's bucket is its first call's");
  assert.equal(produceJob.payload.details.sourceKind, "chain");
  const handler = produceHandler(gateway, media, objects, linked);
  const made = await driveProduce(handler, contextOf(produceJob), gateway, media);
  assert.equal(made.kind, "done");
  if (made.kind !== "done" || made.output.stage !== "produce_shot") throw new Error("expected the chain to finish as a produce output");
  assert.equal(made.output.hold, undefined, "no hold: both calls were made");
  const takeId = made.output.takeId;
  assert.ok(takeId, "the chain made its take");

  // The calls: the keyframe (an image, with the sheet as its reference) then the clip (a video, first frame the keyframe), in order.
  const imagePosts = transport.requests.filter((request) => request.method === "POST" && request.url.endsWith("/api/v1/images"));
  const videoPosts = transport.requests.filter((request) => request.method === "POST" && request.url.endsWith("/api/v1/videos"));
  assert.equal(imagePosts.length, 1, "one keyframe call");
  assert.equal(videoPosts.length, 1, "one clip call");
  assert.ok((transport.requests.indexOf(imagePosts[0] as never)) < transport.requests.indexOf(videoPosts[0] as never), "the keyframe is called before the clip");
  const keyframeBody = JSON.parse(String(imagePosts[0]?.body));
  assert.deepEqual(keyframeBody.input_references, [{ type: "image_url", image_url: { url: `${LINK_HOST}/1.png?sig=recorded` } }], "the sheet is sent as a fetchable link");
  assert.deepEqual(linked.slice(0, 1), [CHARACTER_SHEET_URI], "the keyframe's reference is linked once");
  const clipBody = JSON.parse(String(videoPosts[0]?.body));
  assert.equal(clipBody.model, CLIP_MODEL);
  assert.equal(clipBody.frame_images?.[0]?.frame_type, "first_frame");
  assert.match(clipBody.frame_images?.[0]?.image_url?.url ?? "", /^https:\/\/media\.example\.test\/engine\/link\//, "the clip starts from the keyframe as a fetchable link");

  // Each call has its own ledger entry and its own idempotency key, on the request's reservation.
  const rows = await ledgerRows();
  assert.deepEqual(rows.map((row) => `${row.provider}:${row.model}`), [`openrouter:${KEYFRAME_MODEL}`, `openrouter:${CLIP_MODEL}`], "one row per call, in call order");
  assert.notEqual(rows[0]?.idempotencyKey, rows[1]?.idempotencyKey, "each call has its own idempotency key");
  assert.ok(rows.every((row) => row.stage === "produce_shot"));

  // The take is the clip's, and costs both calls (read from the chain records, the same as the ledger's two rows).
  const takeStored = await readArtifact(db.sql, { organizationId: ORG, artifactId: made.output.artifacts[`take:${takeId}`] ?? "" });
  const take = takeStored.envelope.body as { shotId: string; model: string; costUsd: number; uri: string };
  assert.equal(take.shotId, CHAIN_SHOT);
  assert.equal(take.model, CLIP_MODEL, "the take is the clip's model");
  assert.equal(take.costUsd, 0.19, "the take costs the keyframe (0.04) plus the clip (0.15)");

  // The orchestrator takes the take, and queues its check.
  orchestrator.apply({ type: "succeeded", output: made.output });
  const [checkJob] = orchestrator.jobsFor("check_take", takeId);
  assert.ok(checkJob, "the take is checked");

  // Check: the take check runs on the stored take, with the clean detector answers (recorded stand-ins) and the Critic's recorded answer.
  const checkHandler = createCheckTakeHandler({
    gateway,
    media: fakeMedia({ probe: () => probeOf({ durationMs: 3000 }) }),
    objects,
    detectors: {
      blackFrames: async () => ({ videoPresent: true, durationMs: 3000, fps: 30, blackRuns: [], frozenRuns: [] }),
      flicker: async () => ({ videoPresent: true, frames: 90, flickerScore: 0.1 }),
      motion: async () => ({ videoPresent: true, frames: 90, meanMotion: 0.22 }),
    },
    paletteHex: async () => ["#1a2b3c"],
    scorer: scorerFrom({ palette_vs_style_kit: 0.9 }),
    metrics: async () => ({}),
    now: () => NOW,
  });
  const checked = await checkHandler.run(contextOf(checkJob));
  assert.equal(checked.kind, "done");
  if (checked.kind !== "done" || checked.output.stage !== "check_take") throw new Error("expected a check output");
  assert.ok(checked.output.verdict.checks.some((verdict) => verdict.rule === "motion_present"), "the motion check applies to the chain's take");
  orchestrator.apply({ type: "succeeded", output: checked.output });
  const failing = checked.output.verdict.checks.filter((line) => !line.pass).map((line) => `${line.rule}${line.detail ? ` (${line.detail})` : ""}`);
  assert.equal(checked.output.verdict.pass, true, `the take passes its checks; failing: ${failing.join("; ")}`);
  assert.equal(orchestrator.state.shots[CHAIN_SHOT]?.acceptedTakeId, takeId, "the passing take is the shot's take");

  // Edit: the chain's take is media. The other shots' takes are the contract fixtures (stand-ins for their own runs).
  const chainTake = made.output.artifacts[`take:${takeId}`] ?? "";
  const other = await Promise.all([take2Fixture, take3bFixture].map((body) => writeArtifact(db.sql, { organizationId: ORG, requestId: REQUEST_ID, stage: "produce_shot", type: "take", body, createdAt: NOW })));
  const editHandler = createEditHandler({ loadStyleKit: async () => styleKitFixture as StyleKit });
  const edit = await editHandler.run(
    contextOf({
      ...checkJob,
      stage: "edit",
      subjectId: REQUEST_ID,
      attempt: "1",
      payload: {
        organizationId: ORG,
        requestId: REQUEST_ID,
        stage: "edit",
        subjectId: REQUEST_ID,
        attempt: "1",
        priority: "normal",
        budgetReservationId: RESERVATION,
        inputArtifactIds: [stored.planId, stored.dnaId, stored.voiceId, stored.validatedId, chainTake, ...other.map((artifact) => artifact.artifactId)],
        hints: [],
        details: {},
      },
    }),
  );
  assert.equal(edit.kind, "done");
  if (edit.kind !== "done" || edit.output.stage !== "edit") throw new Error("expected an edit output");
  assert.equal(edit.output.gate.pass, true, `the edit passes with the chain's take: ${edit.output.gate.checks.filter((line) => !line.pass).map((line) => line.rule).join(", ")}`);
  const edl = await readArtifact(db.sql, { organizationId: ORG, artifactId: edit.output.artifacts[`edl:${edit.output.edlId}`] ?? edit.output.artifacts.edl ?? "" });
  const clips = (edl.envelope.body as { tracks: Array<{ layer: string; clips: Array<{ srcUri?: string; clipId: string }> }> }).tracks.flatMap((track) => track.clips);
  assert.ok(clips.some((clip) => clip.srcUri === take.uri), "the EDL plays the chain's take");
}));

test("a refused clip stops the chain at the clip: the hold names it, the keyframe stays made, and no further call is made", inDb(async () => {
  const stored = await startCartoonRequest();
  const media = memoryMediaStore();
  const transport = transportFor({ clipPoll: [json(200, CLIP_POLICY_FAILED)] });
  const gateway = gatewayWith(transport.transport, CHAIN_ROUTES);
  const objects = fakeObjects();
  const orchestrator = driver();
  orchestrator.apply({ type: "start", organizationId: ORG, requestId: REQUEST_ID, priority: "normal", cachedDna: true, variantCount: 0, requestArtifactId: stored.requestArtifactId });
  orchestrator.apply({ type: "succeeded", output: { stage: "intake", subjectId: REQUEST_ID, gate: gateFor("request"), budgetReservationId: RESERVATION, budgetPause: null, artifacts: { validated: stored.validatedId } } });
  orchestrator.apply({ type: "succeeded", output: { stage: "voice", subjectId: REQUEST_ID, gate: gateFor("voice"), artifacts: { voice: stored.voiceId } } });
  orchestrator.apply({ type: "succeeded", output: { stage: "plan", subjectId: REQUEST_ID, gate: gateFor("plan"), shots: PLANNED_SHOTS.map(shotSummaryOf), artifacts: { plan: stored.planId } } });
  orchestrator.apply({ type: "succeeded", output: { stage: "estimate_reserve", subjectId: REQUEST_ID, gate: gateFor("budget"), budgetReservationId: RESERVATION, artifacts: {} } });
  const [produceJob] = orchestrator.jobsFor("produce_shot", CHAIN_SHOT);
  assert.ok(produceJob);

  const result = await driveProduce(produceHandler(gateway, media, objects, []), contextOf(produceJob), gateway, media);
  if (result.kind !== "done" || result.output.stage !== "produce_shot") throw new Error("expected a produce output");
  assert.equal(result.output.takeId, null, "no take: the clip was refused");
  assert.deepEqual(result.output.hold, { kind: "refused", errorKind: "content_policy", hint: "content_policy" }, "the hold is the provider's refusal, as a rule name");
  assert.ok(result.output.decisions?.some((decision) => decision.chose === "stopped at clip"), "the stop is recorded at the clip");

  const images = transport.requests.filter((request) => request.method === "POST" && request.url.endsWith("/api/v1/images"));
  const videos = transport.requests.filter((request) => request.method === "POST" && request.url.endsWith("/api/v1/videos"));
  assert.equal(images.length, 1, "the keyframe was made once");
  assert.equal(videos.length, 1, "the clip was submitted once, and was not resubmitted after the refusal");
  assert.equal(transport.requests.some((request) => request.url.includes("/content")), false, "a refused clip is never downloaded");
  const rows = await ledgerRows();
  assert.equal(rows.length, 2, "the two paid calls are on the ledger, and no third");
  orchestrator.apply({ type: "succeeded", output: result.output });
  assert.equal(orchestrator.jobsFor("check_take").length, 0, "no take, so no check");
  assert.equal(orchestrator.state.shots[CHAIN_SHOT]?.acceptedTakeId, null);
}));

test("a stop-motion chain whose frame model is not routed makes no call, and the stage stops with a configuration error", inDb(async () => {
  await startCartoonRequest();
  const media = memoryMediaStore();
  const transport = transportFor();
  const gateway = gatewayWith(transport.transport, CHAIN_ROUTES);
  const stopMotion: ShotSpec = {
    shotId: fixtureId("shot_", 962),
    beatId: "b1",
    startMs: 0,
    endMs: 2500,
    visualType: "stop_motion",
    layer: "base",
    source: {
      kind: "chain",
      calls: [
        { output: "frame_01", modelClass: "image.edit", prompt: "frame one of the product", refs: [{ kind: "asset", uri: "https://media.example.test/hero.png" }], takes: 1 },
        { output: "frame_02", modelClass: "image.edit", prompt: "frame two of the product", refs: [{ kind: "output", output: "frame_01" }], takes: 1 },
      ],
    },
  };
  // The stage reads the stop-motion shot from the scene plan it is given (its own plan, written for this test).
  const plan = await writeArtifact(db.sql, {
    organizationId: ORG,
    requestId: REQUEST_ID,
    stage: "plan",
    type: "scene_plan",
    body: { ...scenePlanChainFixture, planId: "plan_stop_motion_refused", shots: [stopMotion] },
    createdAt: NOW,
  });
  const payload: EnginePayload = {
    organizationId: ORG,
    requestId: REQUEST_ID,
    stage: "produce_shot",
    subjectId: stopMotion.shotId,
    attempt: "1",
    priority: "normal",
    budgetReservationId: RESERVATION,
    inputArtifactIds: [plan.artifactId],
    hints: [],
    details: { shotId: stopMotion.shotId, epoch: 0 },
  };
  const handler = produceHandler(gateway, media, fakeObjects(), []);
  const ctx: StageContext = {
    sql: db.sql as Sql,
    jobId: "job_stop_motion_refused",
    organizationId: ORG,
    requestId: REQUEST_ID,
    stage: "produce_shot",
    subjectId: stopMotion.shotId,
    attempt: "1",
    payload,
    signal: new AbortController().signal,
  };
  await assert.rejects(handler.run(ctx), (error: unknown) => error instanceof EngineError && error.kind === "config");
  assert.equal(transport.requests.length, 0, "no call is made: the frame model is not routed, so nothing is spent");
}));
