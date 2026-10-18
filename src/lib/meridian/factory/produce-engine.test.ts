import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { factoryRunFor, planRowsFor, runRow, stageJob, studioTenant, type FactoryTenant } from "../testing/produce-fixtures.ts";
import { engineRequestStatus, reservationState, type EngineReadinessPorts } from "../../../engine/api/index.ts";
import type { CredentialLookup } from "../../../engine/gateway/types.ts";
import { manifestFixture, renderedVideoFixture } from "../../../engine/contracts/fixtures/index.ts";
import { newId } from "../../../engine/contracts/index.ts";
import { writeArtifact } from "../../../engine/jobs/artifact-store.ts";
import { readEngineRequest } from "../../../engine/jobs/orchestrator-sql.ts";
import type { OrchestratorState } from "../../../engine/jobs/orchestrator.ts";
import { ENGINE_STAGES } from "../../../engine/jobs/registry.ts";
import type { EngineRuntime, StageHandler } from "../../../engine/jobs/types.ts";
import { creativeIdsOfVariant } from "./rights.ts";
import type { EngineOnlyFields } from "./engine-request.ts";
import type { FactoryEngineSeams } from "./produce-shared.ts";
import { meteredSpendOf, engineHeldOf } from "./spend.ts";

// The testing runtime enables the image double and the testing artifact store. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

// The stage uses the "@/" alias through its server modules, so the alias hook is registered before they load.
enableAppAliases();
const { executeFactoryJob } = await import("./worker.ts");

const NOW = "2026-10-15T10:00:00.000Z";

/**
 * The engine fields a Factory request is given in these tests. They are fixture values, the fields a caller who knows them would set:
 * the plan does not carry them, so production sends none (see the last test).
 */
const ENGINE_FIELDS: EngineOnlyFields = {
  formatId: "ugc-demo-hook",
  referenceVideo: "reference-video-factory-fixture",
  keep: ["hook_mechanism"],
  change: ["product"],
  language: "en",
  beats: [{ beatId: "beat-1", role: "hook", text: "One swipe, and the mess is gone." }],
  visualRequests: [{ beatId: "beat-1", want: "product close-up", strength: "must" }],
  pageId: "page-factory-fixture",
  styleKitId: "style-factory-fixture",
  voiceId: "voice-factory-fixture",
  priority: "normal",
};

/** A stage that is not run by these tests. It is registered so the readiness check sees a handler for every stage. */
function unrunStage(stage: string): StageHandler {
  return {
    async run() {
      throw new Error(`${stage} is not run by this fixture`);
    },
  };
}

/** The readiness ports of a connected workspace, with a handler for every stage and a fixture key. No key is read: the lookup is scripted. */
function readinessPorts(options: { openrouterConnected?: boolean } = {}): EngineReadinessPorts {
  const handlers = Object.fromEntries(ENGINE_STAGES.map((stage) => [stage, unrunStage(stage)] as const)) as EngineRuntime["handlers"];
  const ready: CredentialLookup = { status: "ready", credential: { kind: "api_key", secret: "fixture-not-a-key" } };
  return {
    monthBudget: { monthBudget: async () => ({ status: "known" as const, usd: 100 }) },
    credentials: {
      get: async (credentialId: string): Promise<CredentialLookup> => {
        if (credentialId === "openrouter" && options.openrouterConnected === false) {
          return { status: "not_connected", reason: "no OpenRouter key is saved for this workspace (fixture)" };
        }
        if (credentialId === "openrouter" || credentialId === "heygen") return ready;
        return { status: "not_connected", reason: "not used by this fixture" };
      },
    },
    runtime: { handlers },
  };
}

function engineSeams(options: { openrouterConnected?: boolean; withFields?: boolean } = {}): FactoryEngineSeams {
  const withFields = options.withFields !== false;
  return { readiness: readinessPorts(options), ...(withFields ? { fields: () => ENGINE_FIELDS } : {}) };
}

async function produce(sql: Sql, tenant: FactoryTenant, runId: string, seams: FactoryEngineSeams = engineSeams()): Promise<string> {
  return executeFactoryJob(sql, stageJob(tenant, runId, "factory.produce"), { runId }, undefined, { engine: seams });
}

async function gate(sql: Sql, tenant: FactoryTenant, runId: string): Promise<string> {
  return executeFactoryJob(sql, stageJob(tenant, runId, "factory.gate"), { runId }, undefined, {});
}

/** The engine request a variant was linked to. The test fails when the variant has none. */
async function requestOf(sql: Sql, tenant: FactoryTenant, variantId: string): Promise<string> {
  const rows = await sql<{ request_id: string }>`
    select request_id from factory_engine_requests where variant_id = ${variantId} and organization_id = ${tenant.organizationId}
  `;
  const [row] = rows;
  assert.ok(row, "the variant's engine request is linked to it");
  return row.request_id;
}

/** How many engine requests and Factory links exist in the workspace. A refused start writes neither. */
async function engineCounts(sql: Sql, organizationId: string): Promise<{ requests: number; links: number }> {
  const [requests] = await sql<{ n: number }>`select count(*)::int as n from engine_requests where organization_id = ${organizationId}`;
  const [links] = await sql<{ n: number }>`select count(*)::int as n from factory_engine_requests where organization_id = ${organizationId}`;
  return { requests: requests?.n ?? 0, links: links?.n ?? 0 };
}

/**
 * The engine's delivered master, from its recorded fixtures: a rendered video and a manifest stored under the request, and the request marked
 * delivered with them. The engine's own run is tested in src/engine; here its finished state is written so the Factory reads a delivery.
 */
async function deliverRecordedRequest(sql: Sql, organizationId: string, requestId: string): Promise<void> {
  const read = await readEngineRequest(sql, organizationId, requestId);
  assert.ok(read, "the engine request exists");
  const renderId = newId("art_");
  const manifestId = newId("art_");
  const edlId = renderedVideoFixture.edlId;
  await writeArtifact(sql, {
    organizationId,
    requestId,
    stage: "render",
    type: "rendered_video",
    body: renderedVideoFixture,
    createdAt: NOW,
    artifactId: renderId,
  });
  await writeArtifact(sql, {
    organizationId,
    requestId,
    stage: "deliver",
    type: "manifest",
    body: { ...manifestFixture, requestId },
    createdAt: NOW,
    artifactId: manifestId,
  });
  // As deliver leaves it: the state names the master's video id, and the manifest artifact is under its manifest:<videoId> slot.
  const videoId = renderedVideoFixture.videoId;
  const state: OrchestratorState = {
    ...read.state,
    status: "delivered",
    pause: null,
    masterEdlId: edlId,
    manifestId: videoId,
    artifacts: { ...read.state.artifacts, [`render:${edlId}`]: renderId, [`manifest:${videoId}`]: manifestId },
  };
  await sql`
    update engine_requests set status = 'delivered', state = ${JSON.stringify(state)}, updated_at = now()
    where id = ${requestId} and organization_id = ${organizationId}
  `;
}

/** The engine's recorded stop for a request: a pause with the engine's reason, or an escalation to review. */
async function stopRecordedRequest(sql: Sql, organizationId: string, requestId: string, pause: NonNullable<OrchestratorState["pause"]>): Promise<void> {
  const read = await readEngineRequest(sql, organizationId, requestId);
  assert.ok(read, "the engine request exists");
  const state: OrchestratorState = { ...read.state, status: "paused", pause };
  await sql`
    update engine_requests set status = 'paused', pause_reason = ${pause.reason}, state = ${JSON.stringify(state)}, updated_at = now()
    where id = ${requestId} and organization_id = ${organizationId}
  `;
}

/** A live budget reservation of a request, as the engine's budget writes it (reserved, nothing paused). */
async function reserveRecorded(sql: Sql, organizationId: string, requestId: string, usd: number): Promise<string> {
  const reservationId = `res-${randomUUID()}`;
  await sql`
    insert into engine_reservations (id, organization_id, request_id, mode, state, lines, estimate_usd, redo_allowance_usd, reserved_usd, paused_reason, created_at)
    values (${reservationId}, ${organizationId}, ${requestId}, 'cap', 'reserved', '[]', ${usd}, 0, ${usd}, null, now())
  `;
  return reservationId;
}

/** An actual cost on the engine's ledger for a request, as the engine records a call that returned its bill. */
async function recordActual(sql: Sql, organizationId: string, requestId: string, reservationId: string, usd: number): Promise<void> {
  await sql`
    insert into engine_ledger (id, organization_id, request_id, reservation_id, stage, provider, model, estimate_usd, reserved_usd,
      actual_usd, settlement, idempotency_key, at)
    values (${randomUUID()}, ${organizationId}, ${requestId}, ${reservationId}, 'produce_shot', 'fixture', 'fixture', ${usd}, ${usd},
      ${usd}, 'billed', ${`ledger-${randomUUID()}`}, now())
  `;
}

test("a Factory video made by the engine goes from plan to request to a delivered creative, and the gates judge the master", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-engine-delivered");
  const runId = await factoryRunFor(sql, tenant, {
    automation: "full",
    formats: ["video"],
    providers: { video: "engine" },
    costPerMasterUsd: 1.25,
    caps: { totalCents: 500 },
  });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["video"]);
  assert.ok(variantId);

  assert.match(await produce(sql, tenant, runId), /^waiting:factory\.produce/, "the engine accepts the request, and the run waits for it");
  const requestId = await requestOf(sql, tenant, variantId);
  assert.match(requestId, /^req_/, "the request id is the engine's request id");
  assert.equal((await engineRequestStatus(sql, tenant.organizationId, requestId))?.status, "queued", "the engine has the request, queued");
  const waiting = await runRow(sql, tenant, runId);
  assert.equal(waiting.status, "running", "a run waiting for the engine stays running");
  assert.match(waiting.error, /has not started it yet/, "the wait says why the run is waiting");

  await deliverRecordedRequest(sql, tenant.organizationId, requestId);
  await produce(sql, tenant, runId);

  const creativeId = `engine-creative-${requestId}`;
  const [link] = await sql<{ creative_id: string; provider: string; production_job_id: string }>`
    select creative_id, provider, production_job_id from factory_creatives
    where variant_id = ${variantId} and format = 'video' and slide_index = -1
  `;
  assert.equal(link?.creative_id, creativeId, "the master is the variant's video creative");
  assert.equal(link?.provider, "engine");
  assert.equal(link?.production_job_id, requestId, "the link names the engine request");

  const [record] = await sql<{ status: string; origin: string; workflow: string }>`
    select status, origin, workflow from creative_records where id = ${creativeId}
  `;
  assert.equal(record?.origin, "generated");
  assert.equal(record?.status, "in_review", "the master waits for a person: nothing approves it here");
  const engineState = await readEngineRequest(sql, tenant.organizationId, requestId);
  assert.equal(JSON.parse(record?.workflow ?? "{}").engineManifestId, engineState?.state.manifestId, "the creative records the manifest");

  const [asset] = await sql<{ storage_key: string; mime_type: string; byte_size: number; duration_ms: number; provider: string; kind: string }>`
    select storage_key, mime_type, byte_size, duration_ms, provider, kind from assets where creative_id = ${creativeId}
  `;
  assert.equal(asset?.storage_key, renderedVideoFixture.uri, "the MP4 is the engine's rendered master");
  assert.equal(asset?.mime_type, "video/mp4");
  assert.equal(Number(asset?.byte_size), renderedVideoFixture.bytes);
  assert.equal(Number(asset?.duration_ms), renderedVideoFixture.durationMs);
  assert.equal(asset?.provider, "engine");
  assert.equal(asset?.kind, "video");

  const done = await runRow(sql, tenant, runId);
  assert.equal(done.error, "", "once the master is linked the wait is over");

  // The gates run on the master. The variant reads as pass until the gate stage runs, and then the master's evidence decides. No licence
  // is attested for the master, so the rights gate blocks it (the rule for every Factory creative), and nothing here passes it.
  await sql`update factory_variants set gate_result = 'pass' where id = ${variantId}`;
  assert.equal(await gate(sql, tenant, runId), "gated:1");
  const [variant] = await sql<{ gate_result: string }>`select gate_result from factory_variants where id = ${variantId}`;
  assert.equal(variant?.gate_result, "block", "the gate recomputed the variant from the master: no licence is attested, so it is blocked");
  assert.deepEqual(
    await creativeIdsOfVariant(sql, tenant.organizationId, tenant.brandId, variantId),
    [creativeId],
    "the rights and claims gates read the master's creative",
  );
});

test("a paused engine request stops the run with the engine's reason, and no creative is made", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-engine-paused");
  const runId = await factoryRunFor(sql, tenant, {
    automation: "full",
    formats: ["video"],
    providers: { video: "engine" },
    costPerMasterUsd: 1.25,
    caps: { totalCents: 500 },
  });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["video"]);
  assert.ok(variantId);
  await produce(sql, tenant, runId);
  const requestId = await requestOf(sql, tenant, variantId);

  const reason = "produce_shot failed for good after 3 attempts (fixture)";
  await stopRecordedRequest(sql, tenant.organizationId, requestId, { kind: "dead_letter", stage: "produce_shot", subjectId: "shot_fixture", reason });
  assert.equal(await produce(sql, tenant, runId), "stopped:factory.produce", "a paused request stops the run");

  const row = await runRow(sql, tenant, runId);
  assert.equal(row.status, "paused");
  assert.match(row.error, /paused the video/, "the run says the engine paused the video");
  assert.ok(row.error.includes(reason), "the run shows the engine's reason, as the engine wrote it");
  const [count] = await sql<{ n: number }>`
    select count(*)::int as n from creative_records where id = ${`engine-creative-${requestId}`}
  `;
  assert.equal(count?.n, 0, "no creative was made for a request that did not deliver");
});

test("a request the engine sent to review keeps the run waiting, and says a person must decide", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-engine-review");
  const runId = await factoryRunFor(sql, tenant, {
    automation: "full",
    formats: ["video"],
    providers: { video: "engine" },
    costPerMasterUsd: 1.25,
    caps: { totalCents: 500 },
  });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["video"]);
  assert.ok(variantId);
  await produce(sql, tenant, runId);
  const requestId = await requestOf(sql, tenant, variantId);

  await stopRecordedRequest(sql, tenant.organizationId, requestId, {
    kind: "escalation",
    stage: "check_take",
    subjectId: "shot_fixture",
    reason: "check_take failed its take gate after 2 redos (fixture)",
  });
  assert.match(await produce(sql, tenant, runId), /^waiting:factory\.produce/, "a request in review is waiting, not stopped");
  const row = await runRow(sql, tenant, runId);
  assert.equal(row.status, "running");
  assert.match(row.error, /sent the video .* to review at check_take/, "the run names the stage that sent it to review");
  assert.match(row.error, /The run waits for a person\./);
});

test("a run that names the engine stops with the engine's own reason when it is not connected, and sends nothing", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-engine-not-connected");
  const runId = await factoryRunFor(sql, tenant, {
    automation: "full",
    formats: ["video"],
    providers: { video: "engine" },
    costPerMasterUsd: 1.25,
    caps: { totalCents: 500 },
  });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["video"]);
  assert.ok(variantId);

  const before = await engineCounts(sql, tenant.organizationId);
  assert.equal(await produce(sql, tenant, runId, engineSeams({ openrouterConnected: false })), "stopped:factory.produce");
  assert.deepEqual(await engineCounts(sql, tenant.organizationId), before, "no engine request and no link was written");

  const row = await runRow(sql, tenant, runId);
  assert.equal(row.status, "paused");
  assert.match(row.error, /not connected, so no request was sent/);
  assert.match(row.error, /OpenRouter: no OpenRouter key is saved for this workspace \(fixture\)/, "the reason is the engine's, and names the key");
});

test("a request the plan cannot fill names the fields it lacks, and sends nothing", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-engine-fields");
  const runId = await factoryRunFor(sql, tenant, {
    automation: "full",
    formats: ["video"],
    providers: { video: "engine" },
    costPerMasterUsd: 1.25,
    caps: { totalCents: 500 },
  });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["video"]);
  assert.ok(variantId);

  // Production passes no fields: the Factory plan does not carry a format, a reference, a script or a page.
  const before = await engineCounts(sql, tenant.organizationId);
  assert.equal(await produce(sql, tenant, runId, engineSeams({ withFields: false })), "stopped:factory.produce");
  assert.deepEqual(await engineCounts(sql, tenant.organizationId), before);
  const row = await runRow(sql, tenant, runId);
  assert.equal(row.status, "paused");
  assert.match(row.error, /needs .*format\.formatId.*script\.beats.*page\.styleKitId/, "the run names the fields the plan does not carry");
});

test("engine actuals count toward the run's cap, and a request the cap cannot cover is not started", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-engine-cap");
  const runId = await factoryRunFor(sql, tenant, {
    automation: "full",
    formats: ["video"],
    providers: { video: "engine" },
    costPerMasterUsd: 0.6,
    caps: { totalCents: 100 },
  });
  const [first, second] = await planRowsFor(sql, tenant, runId, ["video"], 2);
  assert.ok(first && second);

  // The first request is held at its budget (60 cents). The second would take the run to 120 cents against a cap of 100.
  assert.equal(await produce(sql, tenant, runId), "stopped:factory.produce");
  const firstRequest = await requestOf(sql, tenant, first);
  const [linked] = await sql<{ n: number }>`select count(*)::int as n from factory_engine_requests where run_id = ${runId}`;
  assert.equal(linked?.n, 1, "only the first request was started");
  assert.match((await runRow(sql, tenant, runId)).error, /would pass the total spend cap/);
  assert.equal((await engineHeldOf(sql, tenant.organizationId, tenant.brandId, runId)).totalCents, 60, "the first request holds its budget");

  // The engine records 30 cents spent. The run now counts 30 spent and 30 held: 30 + 30 + 60 is still over the cap, so nothing is started.
  const reservationId = await reserveRecorded(sql, tenant.organizationId, firstRequest, 0.6);
  await recordActual(sql, tenant.organizationId, firstRequest, reservationId, 0.3);
  assert.equal((await meteredSpendOf(sql, tenant.organizationId, tenant.brandId, runId)).totalCents, 30, "engine actuals are spend");
  assert.equal((await engineHeldOf(sql, tenant.organizationId, tenant.brandId, runId)).totalCents, 30, "the unspent part is held, not spent");
  assert.equal(await produce(sql, tenant, runId), "stopped:factory.produce");
  const [still] = await sql<{ n: number }>`select count(*)::int as n from factory_engine_requests where run_id = ${runId}`;
  assert.equal(still?.n, 1, "the second request is still not started");
});

test("a cap reached by engine actuals stops the run, and pauses the request's live reservations", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-engine-cap-hit");
  const runId = await factoryRunFor(sql, tenant, {
    automation: "full",
    formats: ["video"],
    providers: { video: "engine" },
    costPerMasterUsd: 1.25,
    caps: { totalCents: 125 },
  });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["video"]);
  assert.ok(variantId);
  assert.match(await produce(sql, tenant, runId), /^waiting:factory\.produce/, "the request is held at its budget, which the cap covers");
  const requestId = await requestOf(sql, tenant, variantId);

  const reservationId = await reserveRecorded(sql, tenant.organizationId, requestId, 1.25);
  await recordActual(sql, tenant.organizationId, requestId, reservationId, 1.25);
  assert.equal(await reservationState(sql, tenant.organizationId, reservationId), "reserved", "the reservation is live before the cap is reached");

  // The run's spend is now the cap. The next stage that could spend is refused, and the request's live reservation is paused with it.
  assert.equal(await produce(sql, tenant, runId), "stopped:factory.produce");
  assert.equal(await reservationState(sql, tenant.organizationId, reservationId), "paused", "the cap paused the engine's reservation");
  const row = await runRow(sql, tenant, runId);
  assert.equal(row.status, "paused");
  assert.match(row.error, /spend cap for this run is reached/);
});
