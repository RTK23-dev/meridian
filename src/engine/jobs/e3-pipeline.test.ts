// End to end on fixtures (Video Engine Bible 19, E3): one request is carried from its plan through estimate_reserve, produce_shot
// and check_take for two shots, one stock and one generated. The stages are the real handlers, the dispatcher is the real
// dispatcher, the orchestrator and its SQL are the real ones, and the stores are Postgres (PGlite here). The provider answers
// are the recorded responses of the asset and review fixtures (fixtures/). The voice and intake outputs are fixed: the flow starts
// at the plan, as the lead asked. No test here calls a live API.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { budgetReservationSchema, type GateResult, type ScenePlan, type ShotSpec } from "../contracts/index.ts";
import type { ShotSummary } from "./types.ts";
import { FIXTURE_IDS, fixtureId, productionRequestFixture } from "../contracts/fixtures/index.ts";
import { createAssetRouter, type AssetRouter } from "../assets/router.ts";
import { memoryMediaStore } from "../assets/adapter.ts";
import { searchStock } from "../assets/stock.ts";
import { stockProviderFor } from "../assets/providers/index.ts";
import { videoProfilesFromListing, type VideoProfile } from "../assets/providers/openrouterVideo.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { applyEngineEvent, readEngineRequest, startEngineRequest } from "./orchestrator-sql.ts";
import { writeArtifact, mediaKey } from "./artifact-store.ts";
import { scopedLedgerStore, sqlAssetCache, sqlBreakerStore, sqlBucketStore, sqlProviderStats } from "./asset-stores-sql.ts";
import { sqlLedgerStore } from "./sql-ledger-store.ts";
import { createEstimateReserveHandler } from "./handlers/estimate-reserve.ts";
import { createProduceShotHandler, routerGenerator } from "./handlers/produce-shot.ts";
import { createCheckTakeHandler } from "./handlers/check-take.ts";
import { registerEngineHandlers } from "./handlers/register.ts";
import { gatewayDownloader } from "../gateway/download.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { EngineRuntime } from "./types.ts";
import { fakeMedia, fakeObjects, fixture, gatewayWith, json, MP4_BYTES, MP4_STOCK_BYTES, probeOf, raw, recordedTransport, runQueued, scorerFrom } from "./test/harness.ts";
import type { StageOutput } from "./types.ts";

const ORG = "org_e3_pipeline";
const BRAND = "brand_e3_pipeline";
const REQUEST_ID = FIXTURE_IDS.request;
const HOLD_ID = fixtureId("res_", 77);
const NOW = "2026-10-14T10:00:00.000Z";
const KLING = "kwaivgi/kling-v3.0-std";
const PALETTE = ["#1a2b3c", "#ffffff", "#f5a623"];

const GENERATED_SHOT = fixtureId("shot_", 1);
const STOCK_SHOT = fixtureId("shot_", 2);

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db.close();
});

function gate(name: GateResult["gate"], subjectId: string): GateResult {
  return { gate: name, subjectId, pass: true, checks: [{ rule: `${name}.ok`, pass: true, value: 1 }] };
}

function plan(): ScenePlan {
  const shots: ShotSpec[] = [
    {
      shotId: GENERATED_SHOT,
      beatId: "b3",
      startMs: 0,
      endMs: 5000,
      visualType: "cinematic",
      layer: "base",
      source: {
        kind: "generate",
        modelClass: "video.cinematic",
        prompt: "Slow push-in on a clean kitchen counter, soft window light, no text in frame.",
        refs: [],
        takes: 1,
      },
    },
    {
      shotId: STOCK_SHOT,
      beatId: "b4",
      startMs: 5000,
      endMs: 13000,
      visualType: "stock_footage",
      layer: "cutaway",
      source: { kind: "stock", query: "kitchen counter blender", minMs: 4000 },
    },
  ];
  return {
    schema: "meridian.scene_plan/v1",
    planId: "plan_e3_fixture",
    requestId: REQUEST_ID,
    videoDnaId: FIXTURE_IDS.dna,
    voiceTrackId: "vt_e3_fixture",
    shots,
    estimatedUsd: 0.7875,
    decisions: [],
  };
}

function summaryOf(shot: ShotSpec): ShotSummary {
  return {
    shotId: shot.shotId,
    visualType: shot.visualType,
    downgradeTo: null,
    sourceKind: shot.source.kind,
    modelClass: shot.source.kind === "generate" ? shot.source.modelClass : null,
    takesWanted: 1,
  };
}

/** The recorded provider answers. Everything the flow calls is listed; anything else fails the test. */
function providers() {
  const profiles: ReadonlyMap<string, VideoProfile> = videoProfilesFromListing(fixture("video-models.json")).profiles;
  const script = recordedTransport({
    "POST /api/v1/videos": json(200, fixture("video-submit-pending.json")),
    "GET /api/v1/videos/job-abc123": json(200, fixture("video-poll-completed.json")),
    "GET /api/v1/videos/job-abc123/content": raw(200, MP4_BYTES),
    "GET /videos/search": json(200, fixture("pexels-search.json")),
    "GET /video-files/4433001/4433001-hd_1080_1920_30fps.mp4": raw(200, MP4_STOCK_BYTES),
    "POST /api/v1/chat/completions": json(200, fixture("openrouter-critic-take-ok.json")),
  });
  return { profiles, ...script };
}

function runtimeFor(options: { gateway: ReturnType<typeof gatewayWith>; profiles: ReadonlyMap<string, VideoProfile>; objects: ReturnType<typeof fakeObjects>; media: ReturnType<typeof fakeMedia> }): EngineRuntime {
  const { gateway, profiles, objects, media } = options;
  const runtime: EngineRuntime = { handlers: {}, providers: { resolve: () => null }, now: () => Date.parse(NOW) };
  const routerFor = (scope: { sql: Sql; organizationId: string; requestId: string; reservationId: string }): AssetRouter =>
    createAssetRouter({
      gateway,
      ledger: scopedLedgerStore(scope.sql, scope.organizationId, scope.reservationId),
      cache: sqlAssetCache(scope.sql, scope.organizationId),
      stats: sqlProviderStats(scope.sql, scope.organizationId),
      breakers: sqlBreakerStore(scope.sql, scope.organizationId),
      buckets: sqlBucketStore(scope.sql, scope.organizationId),
      media: memoryMediaStore(),
      videoProfiles: profiles,
      settings: { pollIntervalMs: 0, backoffBaseMs: 0, backoffCapMs: 0 },
      sleep: async () => {},
      now: () => Date.parse(NOW),
    });
  registerEngineHandlers(runtime, {
    estimate_reserve: createEstimateReserveHandler({
      workspaceBudget: { async monthBudget() { return { status: "known", usd: 100 }; } },
    }),
    produce_shot: createProduceShotHandler({
      generator: routerGenerator(routerFor),
      stock: (input) =>
        searchStock({ gateway, organizationId: input.organizationId, query: input.query, minDurationMs: input.minDurationMs, providerFor: (route) => stockProviderFor(route, gateway) }),
      downloader: gatewayDownloader(gateway),
      media,
      objects,
      now: () => Date.parse(NOW),
    }),
    check_take: createCheckTakeHandler({
      gateway,
      media,
      objects,
      scorer: scorerFrom({ palette_vs_style_kit: 0.82 }),
      measure: async ({ take }) => ({ durationMs: take.durationMs, blackOrFrozenRunFrames: 0, flickerScore: 0.1, meanMotion: 0.22 }),
      paletteHex: async () => PALETTE,
      now: () => NOW,
    }),
  });
  return runtime;
}

test("one request from plan through estimate, produce and check: a stock shot and a generated shot are both accepted", async () => {
  await seedWorkspace(db.sql, ORG, BRAND);
  const requestArtifactId = fixtureId("art_", 501);
  await startEngineRequest(db.sql, {
    organizationId: ORG,
    brandId: BRAND,
    requestId: REQUEST_ID,
    formatId: "fmt_e3_fixture",
    priority: "normal",
    cachedDna: true,
    variantCount: 0,
    requestArtifactId,
  });
  await writeArtifact(db.sql, {
    organizationId: ORG,
    requestId: REQUEST_ID,
    stage: "intake",
    type: "production_request",
    body: { ...productionRequestFixture, requestId: REQUEST_ID, workspaceId: ORG },
    createdAt: NOW,
    artifactId: requestArtifactId,
  });

  // Intake, voice and the plan are given as their outputs. The intake output names a pre-flight hold, a real reservation, so the paid
  // voice stage can be queued; the estimate then makes the plan's own reservation. (Intake's hold is the open decision in STATUS.md.)
  await sqlLedgerStore(db.sql, ORG).createReservation(
    budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId: HOLD_ID,
      requestId: REQUEST_ID,
      workspaceId: ORG,
      mode: "cap",
      lines: [{ stage: "voice", estimateUsd: 0.5 }],
      estimateUsd: 0.5,
      redoAllowanceUsd: 0,
      reservedUsd: 0.5,
      state: "reserved",
      createdAt: NOW,
    }),
  );
  const apply = (output: StageOutput) => applyEngineEvent(db.sql, { organizationId: ORG, requestId: REQUEST_ID, event: { type: "succeeded", output } });
  await apply({ stage: "intake", subjectId: REQUEST_ID, gate: gate("request", REQUEST_ID), budgetReservationId: HOLD_ID, artifacts: { validated: fixtureId("art_", 502) } });
  await apply({ stage: "voice", subjectId: REQUEST_ID, gate: gate("voice", REQUEST_ID), artifacts: { voice: fixtureId("art_", 503) } });

  const scenePlan = plan();
  const planArtifact = await writeArtifact(db.sql, {
    organizationId: ORG,
    requestId: REQUEST_ID,
    stage: "plan",
    type: "scene_plan",
    body: scenePlan,
    parentIds: [requestArtifactId],
    createdAt: NOW,
  });
  await apply({
    stage: "plan",
    subjectId: REQUEST_ID,
    gate: gate("plan", REQUEST_ID),
    shots: scenePlan.shots.map(summaryOf),
    artifacts: { plan: planArtifact.artifactId },
  });

  const { profiles, transport, requests } = providers();
  const gateway = gatewayWith(transport);
  const objects = fakeObjects();
  const media = fakeMedia({ probe: (bytes) => probeOf({ durationMs: bytes.byteLength === MP4_STOCK_BYTES.byteLength ? 8000 : 5000 }) });
  const runtime = runtimeFor({ gateway, profiles, objects, media });

  // estimate_reserve prices the plan and makes the request's reservation.
  assert.equal(await runQueued(db.sql, runtime, "engine.estimate_reserve"), 1);
  // produce_shot: one job per generated or stock shot, each on the reservation.
  assert.equal(await runQueued(db.sql, runtime, "engine.produce_shot"), 2);
  // check_take: one job per take, reading the take and the plan.
  assert.equal(await runQueued(db.sql, runtime, "engine.check_take"), 2);

  const request = await readEngineRequest(db.sql, ORG, REQUEST_ID);
  assert.ok(request, "the request exists");
  assert.equal(request.state.shots[GENERATED_SHOT]?.status, "accepted");
  assert.equal(request.state.shots[STOCK_SHOT]?.status, "accepted");
  assert.equal(request.state.pause, null);
  assert.equal(request.status, "running", "the request runs on to edit, which is queued and not yet built");

  const jobs = await db.sql<{ job_type: string; status: string; n: unknown }>`
    select job_type, status, count(*) as n from jobs where organization_id = ${ORG} group by job_type, status order by job_type, status
  `;
  const count = (type: string, status: string) => Number(jobs.find((row) => row.job_type === type && row.status === status)?.n ?? 0);
  assert.equal(count("engine.edit", "queued"), 1, "edit is queued once both shots are accepted");
  assert.equal(count("engine.produce_shot", "dead"), 0);
  assert.equal(count("engine.check_take", "dead"), 0);
  assert.equal(count("engine.produce_shot", "succeeded"), 2);

  // Two takes, each stored as media under the Bible 5.2 key and named by its take artifact.
  const takes = await db.sql<{ id: string; storage_key: string | null; body: string }>`
    select id, storage_key, body from engine_artifacts where organization_id = ${ORG} and type = 'take' order by id
  `;
  assert.equal(takes.length, 2);
  for (const take of takes) {
    const body = JSON.parse(take.body) as { uri: string; takeId: string; shotId: string; durationMs: number; width: number; height: number };
    assert.equal(take.storage_key, body.uri, "the take's uri is its media's storage key");
    assert.equal(body.uri, mediaKey({ workspaceId: ORG, requestId: REQUEST_ID, stage: "produce_shot", artifactId: take.id, extension: "mp4" }));
    assert.ok(objects.objects.has(`${ORG}|${BRAND}|${body.uri}`), "the media bytes are in the object store");
    assert.equal(body.width, 1080);
    assert.equal(body.height, 1920);
    assert.ok([5000, 8000].includes(body.durationMs), "the duration is the probed duration of each take");
  }

  const verdicts = await db.sql<{ body: string }>`
    select body from engine_artifacts where organization_id = ${ORG} and type = 'take_verdict'
  `;
  assert.equal(verdicts.length, 2);
  for (const verdict of verdicts) {
    const body = JSON.parse(verdict.body) as { pass: boolean; action: string; confidence: number };
    assert.equal(body.pass, true);
    assert.equal(body.action, "accept");
    assert.equal(body.confidence, 0.91);
  }

  // The ledger: the generated call is billed at OpenRouter's reported cost, the stock search is free and has no row, and the two
  // Critic calls are billed and journaled.
  const ledger = await db.sql<{ provider: string; model: string; stage: string; actual_usd: unknown; actual_is_estimate: boolean | null; idempotency_key: string }>`
    select provider, model, stage, actual_usd, actual_is_estimate, idempotency_key from engine_ledger
    where organization_id = ${ORG} order by stage, provider
  `;
  const generated = ledger.find((row) => row.stage === "produce_shot");
  assert.ok(generated, "the generated call is on the ledger");
  assert.equal(generated.provider, "openrouter");
  assert.equal(generated.model, KLING);
  assert.equal(Number(generated.actual_usd), 0.6125, "the actual is the bill OpenRouter reported");
  assert.equal(generated.actual_is_estimate, false);
  assert.equal(ledger.filter((row) => row.stage === "produce_shot").length, 1, "stock is free and writes no ledger row");
  assert.equal(ledger.filter((row) => row.stage === "claude_roles").length, 2, "one Critic call for each take, on the Claude roles line");

  const roleCalls = await db.sql<{ status: string }>`select status from engine_role_calls where organization_id = ${ORG}`;
  assert.equal(roleCalls.length, 2, "one journaled Critic call per take");
  assert.ok(roleCalls.every((call) => call.status === "answered"), "each Critic answer is journaled");

  // Attempts, the cache and the decisions.
  const attempts = await db.sql<{ provider_id: string; outcome: string }>`
    select provider_id, outcome from engine_provider_attempts where organization_id = ${ORG}
  `;
  assert.deepEqual(attempts.map((row) => [row.provider_id, row.outcome]), [[`openrouter:${KLING}`, "success"]]);
  const cached = await db.sql<{ n: unknown }>`select count(*) as n from engine_asset_cache where organization_id = ${ORG}`;
  assert.equal(Number(cached[0]?.n), 1, "the generated asset is in the cache, keyed by its spec");
  const decisions = await db.sql<{ chose: string; reason: string }>`
    select chose, reason from engine_decisions where organization_id = ${ORG} order by chose
  `;
  assert.ok(decisions.some((row) => row.chose === `openrouter:${KLING}`), "the scorer's choice of model is a decision");
  assert.ok(decisions.some((row) => row.chose.startsWith("pexels:")), "the stock clip is a decision");

  // The stock and generated downloads went through the gateway, and nothing else went out.
  const urls = requests.map((request) => `${request.method} ${new URL(request.url).host}${new URL(request.url).pathname}`);
  assert.ok(urls.includes("GET api.pexels.com/videos/search"));
  assert.ok(urls.includes("GET videos.pexels.com/video-files/4433001/4433001-hd_1080_1920_30fps.mp4"));
  assert.ok(urls.includes("POST openrouter.ai/api/v1/videos"), "the generated shot was submitted through OpenRouter");
  assert.ok(requests.every((request) => request.url.startsWith("https://")), "every call is https");
  assert.equal(requests.filter((request) => request.url.includes("/api/v1/chat/completions")).length, 2, "two Critic calls");
});
