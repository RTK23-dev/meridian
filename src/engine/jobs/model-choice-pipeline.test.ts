// End to end on fixtures with the orchestrator's model choice (Bible 10.5, contracts v7 and v8). One request is carried from its plan
// through the model choice, estimate_reserve, produce_shot, the poll and check_take, with one generated shot and one stock shot. The
// model choice is the plan stage's own step (plan/model-choices.ts chooseModels, which the plan handler runs after a passing plan), on
// the recorded catalog listings and a recorded model_chooser answer; the plan's artifacts are written as the plan handler writes them.
// Every other stage is the real handler on the real dispatcher, orchestrator and Postgres (PGlite). No test here calls a live API.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { budgetReservationSchema, type GateResult, type ProviderAdapter, type ScenePlan, type ShotSpec } from "../contracts/index.ts";
import type { ModelChoices } from "../contracts/model-choices.ts";
import { FIXTURE_IDS, fixtureId, productionRequestFixture } from "../contracts/fixtures/index.ts";
import { createAssetRouter, type AsyncAssetRouter } from "../assets/router.ts";
import { memoryMediaStore } from "../assets/adapter.ts";
import { searchStock } from "../assets/stock.ts";
import { stockProviderFor } from "../assets/providers/index.ts";
import { videoProfilesFromListing } from "../assets/providers/openrouterVideo.ts";
import { parseModelsCatalog, parseVideoCatalog, type CatalogRead, type ModelCatalogSource } from "../gateway/catalog.ts";
import type { HttpRequest } from "../gateway/types.ts";
import { chooseModels } from "../plan/model-choices.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { applyEngineEvent, readEngineRequest, startEngineRequest } from "./orchestrator-sql.ts";
import { readArtifact, writeArtifact } from "./artifact-store.ts";
import { scopedLedgerStore, sqlAssetCache, sqlBreakerStore, sqlBucketStore, sqlProviderStats } from "./asset-stores-sql.ts";
import { sqlLedgerStore } from "./sql-ledger-store.ts";
import { sqlRoleCallJournal } from "./role-call-store.ts";
import { createEstimateReserveHandler } from "./handlers/estimate-reserve.ts";
import { createProduceShotHandler, routerGenerator } from "./handlers/produce-shot.ts";
import { createCheckTakeHandler } from "./handlers/check-take.ts";
import { registerEngineHandlers } from "./handlers/register.ts";
import { gatewayDownloader } from "../gateway/download.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import type { EngineRuntime, ShotSummary, StageOutput } from "./types.ts";
import { fakeMedia, fakeObjects, fixture, gatewayWith, json, MP4_BYTES, MP4_STOCK_BYTES, probeOf, raw, recordedTransport, runQueued, scorerFrom } from "./test/harness.ts";

const ORG = "org_model_choice_pipeline";
const BRAND = "brand_model_choice_pipeline";
const REQUEST_ID = FIXTURE_IDS.request;
const HOLD_ID = fixtureId("res_", 78);
const NOW = "2026-10-16T10:00:00.000Z";
const READ_AT = "2026-10-16T09:59:00.000Z";
const PALETTE = ["#1a2b3c", "#ffffff", "#f5a623"];
/** The orchestrator's pick: not in the route table (which routes Kling first), listed in the recorded catalog with 6 s at 1080p. */
const CHOSEN = "google/veo-3.1-lite";

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
      endMs: 6000,
      visualType: "cinematic",
      layer: "base",
      source: { kind: "generate", modelClass: "video.cinematic", prompt: "Slow push-in on a clean kitchen counter, soft window light, no text in frame.", refs: [], takes: 1 },
    },
    {
      shotId: STOCK_SHOT,
      beatId: "b4",
      startMs: 6000,
      endMs: 14000,
      visualType: "stock_footage",
      layer: "cutaway",
      source: { kind: "stock", query: "kitchen counter blender", minMs: 4000 },
    },
  ];
  return { schema: "meridian.scene_plan/v1", planId: "plan_choice_fixture", requestId: REQUEST_ID, videoDnaId: FIXTURE_IDS.dna, voiceTrackId: "vt_choice_fixture", shots, estimatedUsd: 0.3, decisions: [] };
}

function summaryOf(shot: ShotSpec): ShotSummary {
  if (shot.source.kind === "chain") throw new Error("this fixture has no chain shot");
  return {
    shotId: shot.shotId,
    visualType: shot.visualType,
    downgradeTo: null,
    sourceKind: shot.source.kind,
    modelClass: shot.source.kind === "generate" ? shot.source.modelClass : null,
    takesWanted: 1,
  };
}

/** The recorded catalog: the gateway's recorded listings (unverified live), read once at READ_AT. */
const gatewayFixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../gateway/test/fixtures/${name}.json`, import.meta.url), "utf8"));
function recordedCatalog(): ModelCatalogSource & { reads: number } {
  const videoListing = gatewayFixture("openrouter-catalog-videos");
  const read: CatalogRead = {
    status: "read",
    catalog: {
      readAt: READ_AT,
      entries: [...parseVideoCatalog(videoListing, READ_AT).entries, ...parseModelsCatalog("image", gatewayFixture("openrouter-catalog-image"), READ_AT).entries],
      dropped: [],
      failed: [],
      videoListing,
    },
  };
  const source = { reads: 0, async read() { source.reads += 1; return read; } };
  return source;
}

/** The chat answers: the model_chooser call picks the chosen model for c1; every other chat call is a take Critic. */
function chatReply(request: HttpRequest) {
  const body = String(request.body);
  if (body.includes("model_chooser_answer")) {
    return json(200, {
      id: "gen-choice-pipeline",
      model: "anthropic/claude-haiku-5.5",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify({ picks: [{ callId: "c1", modelId: CHOSEN, reason: "A 6 s cinematic push-in: the cheapest candidate that lists 6 s at 1080p." }] }) },
        },
      ],
      usage: { prompt_tokens: 1800, completion_tokens: 60, cost: 0.0021 },
    });
  }
  return json(200, fixture("openrouter-critic-take-ok.json"));
}

function providers() {
  return recordedTransport({
    "POST /api/v1/videos": json(200, fixture("video-submit-pending.json")),
    "GET /api/v1/videos/job-abc123/content": raw(200, MP4_BYTES),
    "GET /videos/search": json(200, fixture("pexels-search.json")),
    "GET /video-files/4433001/4433001-hd_1080_1920_30fps.mp4": raw(200, MP4_STOCK_BYTES),
    "POST /api/v1/chat/completions": chatReply,
  });
}

function runtimeFor(options: { gateway: ReturnType<typeof gatewayWith>; catalog: ModelCatalogSource; objects: ReturnType<typeof fakeObjects>; media: ReturnType<typeof fakeMedia> }): EngineRuntime {
  const { gateway, catalog, objects, media } = options;
  // The poll's adapter for the chosen model: the recorded job, finished, with its content URL and OpenRouter's bill.
  const chosen = {
    id: `openrouter:${CHOSEN}`,
    poll: async () => ({ state: "done" as const, uri: "https://openrouter.ai/api/v1/videos/job-abc123/content?index=0", actualUsd: 0.29 }),
  } as unknown as ProviderAdapter;
  const runtime: EngineRuntime = {
    handlers: {},
    providers: { resolve: (providerId) => (providerId === `openrouter:${CHOSEN}` ? chosen : null) },
    now: () => Date.parse(NOW),
  };
  // The route table's own profiles: Kling only, from the asset fixture. The chosen model's profile comes from the catalog read.
  const routedProfiles = new Map([...videoProfilesFromListing(fixture("video-models.json")).profiles].filter(([model]) => model === "kwaivgi/kling-v3.0-std"));
  const routerFor = (scope: { sql: Sql; organizationId: string; requestId: string; reservationId: string }): AsyncAssetRouter =>
    createAssetRouter({
      gateway,
      ledger: scopedLedgerStore(scope.sql, scope.organizationId, scope.reservationId),
      cache: sqlAssetCache(scope.sql, scope.organizationId),
      stats: sqlProviderStats(scope.sql, scope.organizationId),
      breakers: sqlBreakerStore(scope.sql, scope.organizationId),
      buckets: sqlBucketStore(scope.sql, scope.organizationId),
      media: memoryMediaStore(),
      videoProfiles: routedProfiles,
      catalog,
      settings: { pollIntervalMs: 0, backoffBaseMs: 0, backoffCapMs: 0 },
      sleep: async () => {},
      now: () => Date.parse(NOW),
    });
  registerEngineHandlers(runtime, {
    estimate_reserve: createEstimateReserveHandler({ workspaceBudget: { async monthBudget() { return { status: "known", usd: 100 }; } } }),
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

test("a request's calls carry the orchestrator's model choice from the plan to the take, the ledger and the decisions", async () => {
  await seedWorkspace(db.sql, ORG, BRAND);
  const requestArtifactId = fixtureId("art_", 601);
  await startEngineRequest(db.sql, {
    organizationId: ORG,
    brandId: BRAND,
    requestId: REQUEST_ID,
    formatId: "fmt_choice_fixture",
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
  // Intake's pre-flight hold covers the voice and the plan's Claude calls (the model_chooser call among them).
  await sqlLedgerStore(db.sql, ORG).createReservation(
    budgetReservationSchema.parse({
      schema: "meridian.budget_reservation/v1",
      reservationId: HOLD_ID,
      requestId: REQUEST_ID,
      workspaceId: ORG,
      mode: "cap",
      lines: [
        { stage: "voice", estimateUsd: 0.5 },
        { stage: "claude_roles", estimateUsd: 0.4 },
      ],
      estimateUsd: 0.9,
      redoAllowanceUsd: 0,
      reservedUsd: 0.9,
      state: "reserved",
      createdAt: NOW,
    }),
  );
  const apply = (output: StageOutput) => applyEngineEvent(db.sql, { organizationId: ORG, requestId: REQUEST_ID, event: { type: "succeeded", output } });
  await apply({ stage: "intake", subjectId: REQUEST_ID, gate: gate("request", REQUEST_ID), budgetReservationId: HOLD_ID, budgetPause: null, artifacts: { validated: fixtureId("art_", 602) } });
  await apply({ stage: "voice", subjectId: REQUEST_ID, gate: gate("voice", REQUEST_ID), artifacts: { voice: fixtureId("art_", 603) } });

  const { transport, requests } = providers();
  const gateway = gatewayWith(transport);
  const catalog = recordedCatalog();

  // The plan stage's model choice: one model_chooser call for the request, on the hold, journaled; then the plan (with the choice's
  // decisions) and the request's model_choices artifact, as the plan handler writes them.
  const scenePlan = plan();
  const chosen = await chooseModels({
    deps: { gateway, ledger: scopedLedgerStore(db.sql, ORG, HOLD_ID), now: () => NOW, journal: sqlRoleCallJournal(db.sql, { organizationId: ORG, requestId: REQUEST_ID }) },
    catalog,
    requestId: REQUEST_ID,
    workspaceId: ORG,
    reservationId: HOLD_ID,
    attempt: 1,
    plan: scenePlan,
  });
  assert.ok(chosen.choices !== null);
  const planArtifact = await writeArtifact(db.sql, {
    organizationId: ORG,
    requestId: REQUEST_ID,
    stage: "plan",
    type: "scene_plan",
    body: { ...scenePlan, decisions: [...scenePlan.decisions, ...chosen.decisions] },
    parentIds: [requestArtifactId],
    createdAt: NOW,
  });
  const choicesArtifact = await writeArtifact(db.sql, {
    organizationId: ORG,
    requestId: REQUEST_ID,
    stage: "plan",
    type: "model_choices",
    body: chosen.choices,
    parentIds: [planArtifact.artifactId],
    createdAt: NOW,
  });
  await apply({
    stage: "plan",
    subjectId: REQUEST_ID,
    gate: gate("plan", REQUEST_ID),
    shots: scenePlan.shots.map(summaryOf),
    artifacts: { plan: planArtifact.artifactId, model_choices: choicesArtifact.artifactId },
  });

  const objects = fakeObjects();
  const media = fakeMedia({ probe: (bytes) => probeOf({ durationMs: bytes.byteLength === MP4_STOCK_BYTES.byteLength ? 8000 : 6000 }) });
  const runtime = runtimeFor({ gateway, catalog, objects, media });

  assert.equal(await runQueued(db.sql, runtime, "engine.estimate_reserve"), 1);
  assert.equal(await runQueued(db.sql, runtime, "engine.produce_shot"), 2);
  assert.equal(await runQueued(db.sql, runtime, "engine.poll"), 1);
  assert.equal(await runQueued(db.sql, runtime, "engine.check_take"), 2);

  const request = await readEngineRequest(db.sql, ORG, REQUEST_ID);
  assert.ok(request);
  assert.equal(request.state.shots[GENERATED_SHOT]?.status, "accepted");
  assert.equal(request.state.shots[STOCK_SHOT]?.status, "accepted");
  assert.equal(request.state.pause, null);

  // The model_choices artifact: the generated shot's one call ("shot"), the orchestrator's pick, with its catalog read time.
  const stored = (await readArtifact(db.sql, { organizationId: ORG, artifactId: choicesArtifact.artifactId })).envelope.body as ModelChoices;
  assert.deepEqual(stored.choices.map((entry) => [entry.shotId, entry.output, entry.modelChoice.modelId, entry.modelChoice.source, entry.modelChoice.catalogReadAt]), [
    [GENERATED_SHOT, "shot", CHOSEN, "orchestrator", READ_AT],
  ]);

  // The produce job read the model choices: they are among its input artifacts.
  const produceJobs = await db.sql<{ payload: unknown }>`
    select payload from jobs where organization_id = ${ORG} and job_type = 'engine.produce_shot'
  `;
  const inputs = produceJobs.map((row) => (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as { inputArtifactIds: string[] });
  assert.ok(inputs.every((payload) => payload.inputArtifactIds.includes(choicesArtifact.artifactId)), "each produce job names the model_choices artifact");

  // The call went to the chosen model, not to the route table's Kling.
  const submits = requests.filter((sent) => sent.method === "POST" && sent.url.endsWith("/api/v1/videos"));
  assert.equal(submits.length, 1);
  assert.equal((JSON.parse(String(submits[0]?.body)) as { model: string; duration: number }).model, CHOSEN);

  // The take names the chosen model.
  const takes = await db.sql<{ body: string }>`select body from engine_artifacts where organization_id = ${ORG} and type = 'take'`;
  const generatedTake = takes.map((row) => JSON.parse(row.body) as { shotId: string; provider: string; model: string; costUsd: number }).find((take) => take.shotId === GENERATED_SHOT);
  assert.equal(generatedTake?.provider, "openrouter");
  assert.equal(generatedTake?.model, CHOSEN);
  assert.equal(generatedTake?.costUsd, 0.29, "the take costs OpenRouter's bill");

  // The ledger: the model_chooser call on the hold, and the generated call estimated from the catalog price and billed by OpenRouter.
  const ledger = await db.sql<{ stage: string; model: string; role: string | null; estimate_usd: unknown; actual_usd: unknown; settlement: string | null }>`
    select l.stage, l.model, c.role, l.estimate_usd, l.actual_usd, l.settlement from engine_ledger l
    left join engine_role_calls c on c.organization_id = l.organization_id and c.idempotency_key = l.idempotency_key
    where l.organization_id = ${ORG}
  `;
  const chooserRows = ledger.filter((row) => row.role === "model_chooser");
  assert.equal(chooserRows.length, 1, "one model_chooser call for the request");
  assert.equal(Number(chooserRows[0]?.actual_usd), 0.0021);
  const produced = ledger.filter((row) => row.stage === "produce_shot");
  assert.equal(produced.length, 1);
  assert.equal(produced[0]?.model, CHOSEN);
  assert.equal(Number(produced[0]?.estimate_usd), 0.3, "6 s at the catalog's $0.05 per second");
  assert.equal(Number(produced[0]?.actual_usd), 0.29);
  assert.equal(produced[0]?.settlement, "billed");

  // The choice is journaled and recorded as decisions: in the plan (by shot and call) and on the shot's produce output.
  const roleCalls = await db.sql<{ role: string; status: string }>`select role, status from engine_role_calls where organization_id = ${ORG}`;
  assert.ok(roleCalls.some((call) => call.role === "model_chooser" && call.status === "answered"));
  const planBody = (await readArtifact(db.sql, { organizationId: ORG, artifactId: planArtifact.artifactId })).envelope.body as ScenePlan;
  assert.ok(planBody.decisions.some((decision) => decision.chose === `openrouter:${CHOSEN}` && decision.by === "director" && decision.reason.startsWith(`${GENERATED_SHOT} shot: `)));
  const decisions = await db.sql<{ chose: string; reason: string }>`select chose, reason from engine_decisions where organization_id = ${ORG}`;
  assert.ok(
    decisions.some((row) => row.chose === `openrouter:${CHOSEN}` && /orchestrator choice/.test(row.reason) && /catalog price \$0\.05 per_second/.test(row.reason)),
    "the produced shot's decisions name the choice and its catalog price",
  );
  assert.equal(catalog.reads >= 2, true, "the catalog is read for the choice and checked again by the router");
});
