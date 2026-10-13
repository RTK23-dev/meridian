import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { factoryRunFor, planRowsFor, runRow, stageJob, stubImageProvider, studioTenant, type FactoryTenant } from "../testing/produce-fixtures.ts";
import type { CreativeSpec, ProductionJob } from "../production/types.ts";

// The testing runtime enables the image double and the testing artifact store. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

// The stage and the poller use the "@/" alias through their server modules, so the alias hook is registered before they load.
enableAppAliases();
const { executeFactoryJob } = await import("./worker.ts");
const fixtures = await import("../testing/production-fixtures.ts");
const { productionRouter } = await import("../production/router.ts");
const { pollProductionJobs } = await import("../production/poller.ts");

/** A video that has finished, with the bytes the provider returns on a completed job. */
function completedVideo(spec: CreativeSpec, providerJobId: string): ProductionJob {
  const bytes = Buffer.from(fixtures.fakeMp4()).toString("base64");
  return fixtures.job(spec, "COMPLETED", { providerJobId, metadata: { videoBytesBase64: bytes, mimeType: "video/mp4" } });
}

async function produce(sql: Sql, tenant: FactoryTenant, runId: string, resumeWait = false): Promise<string> {
  return executeFactoryJob(sql, stageJob(tenant, runId, "factory.produce"), resumeWait ? { runId, resumeWait: true } : { runId });
}

function videoVariantJob(variantId: string): string {
  return `factory-${variantId}-video`.slice(0, 180);
}

test("a carousel variant is produced as its slides and one carousel creative, every slide linked to the run and the variant", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-carousel");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["carousel"], providers: { carousel: "google_nano_banana" }, caps: { totalCents: 500 } });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["carousel"]);
  const stub = stubImageProvider();
  try {
    const result = await produce(sql, tenant, runId);
    assert.ok(result.startsWith("variants:1;creatives:5"), `four slides and the carousel: ${result}`);
  } finally {
    stub.restore();
  }
  // The creative engine's carousel scope plans four slides, and each is one image provider call.
  assert.equal(stub.state.calls, 4, "one provider call for each slide");

  const slides = await sql<{ slide_index: number; creative_id: string; variant_id: string }>`
    select slide_index, creative_id, variant_id from factory_creatives
    where run_id = ${runId} and format = 'carousel' and slide_index >= 0 order by slide_index
  `;
  assert.deepEqual(slides.map((row) => row.slide_index), [0, 1, 2, 3], "each slide has its position in the carousel");
  assert.ok(slides.every((row) => row.variant_id === variantId), "every slide belongs to the variant");

  const slideCreatives = await sql<{ origin: string; workflow: string }>`
    select origin, workflow from creative_records where id = any(${slides.map((row) => row.creative_id)})
  `;
  assert.equal(slideCreatives.length, 4, "each slide is a creative record, as an image is");
  for (const creative of slideCreatives) {
    assert.equal(creative.origin, "generated");
    assert.equal(JSON.parse(creative.workflow).kind, "carousel_slide", "each slide records that it belongs to a carousel");
  }

  const [carousel] = await sql<{ creative_id: string }>`
    select creative_id from factory_creatives where run_id = ${runId} and format = 'carousel' and slide_index = -1
  `;
  assert.ok(carousel, "the carousel itself is linked to the variant");
  const [carouselRecord] = await sql<{ format: string; workflow: string; raw_text: string }>`
    select format, workflow, raw_text from creative_records where id = ${carousel.creative_id}
  `;
  assert.equal(carouselRecord?.format, "carousel");
  assert.equal(JSON.parse(carouselRecord?.workflow ?? "{}").kind, "carousel", "the carousel record names its slides");
  assert.equal(JSON.parse(carouselRecord?.workflow ?? "{}").slides?.length, 4, "the carousel lists its four slides in order");

  const [parent] = await sql<{ status: string; modality: string }>`
    select status, modality from production_jobs where id = ${`factory-${variantId}-carousel`.slice(0, 180)}
  `;
  assert.equal(parent?.modality, "carousel");
  assert.equal(parent?.status, "COMPLETED", "the carousel job completes once its last slide is stored");
});

test("a video variant is produced as a video creative after its fixture job completes, linked to the run, and judged once", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-video-done");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["video"], providers: { video: "hypit" }, caps: { totalCents: 500 } });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["video"]);
  const provider = fixtures.injectProvider("hypit", async (spec) => completedVideo(spec, `fx-${spec.idempotencyKey}`));
  try {
    assert.equal(await produce(sql, tenant, runId), "variants:1;creatives:1");
  } finally {
    provider.restore();
  }
  assert.equal(provider.submitted.length, 1, "the video was submitted once");

  const [link] = await sql<{ creative_id: string; variant_id: string }>`
    select creative_id, variant_id from factory_creatives where run_id = ${runId} and format = 'video' and slide_index = -1
  `;
  assert.ok(link, "the video is linked to its run and variant");
  assert.equal(link?.variant_id, variantId);
  const [creative] = await sql<{ origin: string; status: string; workflow: string }>`
    select origin, status, workflow from creative_records where id = ${link?.creative_id ?? ""}
  `;
  assert.equal(creative?.origin, "generated");
  assert.equal(JSON.parse(creative?.workflow ?? "{}").kind, "video");
  assert.ok(["in_review", "rejected"].includes(creative?.status ?? ""), "a video is never approved by the judgment alone");

  const [videoJob] = await sql<{ status: string }>`select status from production_jobs where id = ${videoVariantJob(variantId)}`;
  assert.equal(videoJob?.status, "COMPLETED");

  const judged = await sql<{ n: number }>`
    select count(*)::int as n from decision_gate_records
    where subject_type = 'creative' and subject_id = ${link?.creative_id ?? ""} and gate = 'creative_qa'
  `;
  assert.equal(judged[0]?.n, 1, "the video is judged by the creative check, once");
});

test("a video that never completes leaves the run waiting with its reason: nothing is produced, and the stages after produce hold", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-video-waits");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["video"], providers: { video: "hypit" }, caps: { totalCents: 500 } });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["video"]);
  const provider = fixtures.injectProvider("hypit", async (spec) => fixtures.job(spec, "QUEUED", { providerJobId: `fx-queued-${spec.idempotencyKey}` }));
  try {
    assert.equal(await produce(sql, tenant, runId), "waiting:factory.produce;creatives:0");
  } finally {
    provider.restore();
  }

  const row = await runRow(sql, tenant, runId);
  assert.equal(row.status, "running", "a run waiting on a provider is still running, not failed or paused");
  assert.equal(row.current_stage, "factory.produce");
  assert.match(row.error, /still queued at the provider/, "the run says why it waits");
  const [waiting] = await sql<{ waiting_on: string }>`select waiting_on from factory_runs where id = ${runId}`;
  assert.equal(waiting?.waiting_on, "factory.produce");

  const [videoJob] = await sql<{ status: string }>`select status from production_jobs where id = ${videoVariantJob(variantId)}`;
  assert.equal(videoJob?.status, "QUEUED", "the job is still at the provider");
  const created = await sql<{ n: number }>`select count(*)::int as n from factory_creatives where run_id = ${runId}`;
  assert.equal(created[0]?.n, 0, "nothing is marked produced while the job is still running");

  const recheck = await sql<{ n: number }>`
    select count(*)::int as n from jobs
    where organization_id = ${tenant.organizationId} and job_type = 'factory.produce' and status = 'queued'
      and idempotency_key like ${`factory:${tenant.brandId}:${runId}:factory.produce:recheck:%`} and run_after > now()
  `;
  assert.equal(recheck[0]?.n, 1, "the stage checks again later, not now");

  const gate = await executeFactoryJob(sql, stageJob(tenant, runId, "factory.gate"), { runId });
  assert.equal(gate, "held:factory.gate", "the gate does not run while the video is still at the provider");
  assert.equal((await runRow(sql, tenant, runId)).status, "running");
});

test("once the poller stores a waiting video, the check links it, judges it once, and queues the stages after produce", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-video-resume");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["video"], providers: { video: "hypit" }, caps: { totalCents: 500 } });
  await planRowsFor(sql, tenant, runId, ["video"]);
  const provider = fixtures.injectProvider(
    "hypit",
    async (spec) => fixtures.job(spec, "QUEUED", { providerJobId: `fx-resume-${spec.idempotencyKey}` }),
    async (providerJobId) => completedVideo({} as CreativeSpec, providerJobId),
  );
  try {
    assert.equal(await produce(sql, tenant, runId), "waiting:factory.produce;creatives:0");
    // The worker's poller reads the job row and finds the provider has finished it.
    await pollProductionJobs(sql, { organizationId: tenant.organizationId });
    const resumed = await produce(sql, tenant, runId, true);
    assert.match(resumed, /^variants:1;creatives:1;resumed:\d+$/, `the check links the video and resumes: ${resumed}`);
  } finally {
    provider.restore();
  }

  const link = await sql<{ creative_id: string }>`select creative_id from factory_creatives where run_id = ${runId} and format = 'video'`;
  assert.equal(link.length, 1, "the stored video is linked to the run");
  const judged = await sql<{ n: number }>`
    select count(*)::int as n from decision_gate_records
    where subject_type = 'creative' and subject_id = ${link[0]?.creative_id ?? ""} and gate = 'creative_qa'
  `;
  assert.equal(judged[0]?.n, 1);

  const row = await runRow(sql, tenant, runId);
  assert.equal(row.error, "", "the wait's reason is cleared");
  const [waiting] = await sql<{ waiting_on: string }>`select waiting_on from factory_runs where id = ${runId}`;
  assert.equal(waiting?.waiting_on, "", "the run is no longer waiting");
  const gate = await sql<{ n: number }>`
    select count(*)::int as n from jobs
    where organization_id = ${tenant.organizationId} and job_type = 'factory.gate' and idempotency_key like ${`%:factory.gate:resume:%`}
  `;
  assert.ok((gate[0]?.n ?? 0) >= 1, "the stages after produce are queued from gate");

  // A second check finds the video linked and judged, so it links nothing and judges nothing again.
  await produce(sql, tenant, runId, true);
  const again = await sql<{ n: number }>`
    select count(*)::int as n from decision_gate_records
    where subject_type = 'creative' and subject_id = ${link[0]?.creative_id ?? ""} and gate = 'creative_qa'
  `;
  assert.equal(again[0]?.n, 1, "the engine is asked once, however many checks run");
});

test("a named provider that is not ready stops the run before any reservation or call, with its reason", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "factory-video-not-ready");
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["video"], providers: { video: "hypit" }, caps: { totalCents: 500 } });
  const [variantId] = await planRowsFor(sql, tenant, runId, ["video"]);
  const original = productionRouter.get("hypit");
  assert.ok(original, "the Hypit provider is registered");
  const notReady = Object.create(original!, {
    health: { value: async () => ({ id: "hypit", state: "NOT_CONFIGURED", capabilities: [], detail: "No Hypit key is saved (fixture).", checkedAt: new Date().toISOString() }) },
    healthFor: { value: async () => ({ id: "hypit", state: "NOT_CONFIGURED", capabilities: [], detail: "No Hypit key is saved (fixture).", checkedAt: new Date().toISOString() }) },
  }) as typeof original;
  productionRouter.register(notReady!);
  try {
    assert.equal(await produce(sql, tenant, runId), "stopped:factory.produce");
  } finally {
    productionRouter.register(original!);
  }
  const row = await runRow(sql, tenant, runId);
  assert.equal(row.status, "paused");
  assert.match(row.error, /NOT_CONFIGURED/, "the run names the provider's state");
  const [videoJob] = await sql<{ n: number }>`select count(*)::int as n from production_jobs where id = ${videoVariantJob(variantId)}`;
  assert.equal(videoJob?.n, 0, "no job was created, so nothing was reserved or sent");
  const spend = await sql<{ n: number }>`select count(*)::int as n from factory_costs where run_id = ${runId}`;
  assert.equal(spend[0]?.n, 0, "nothing was spent");
});
