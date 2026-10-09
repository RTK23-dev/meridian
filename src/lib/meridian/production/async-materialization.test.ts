import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock, test } from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { googleDriveClient } from "../storage/drive.ts";
import {
  accountReservedMicros,
  accountSpentMicros,
  createTenantFixture,
  execute,
  fakeMp4,
  injectProvider,
  job,
  planStatus,
  productionJobs,
  reservationsFor,
  type Tenant,
} from "../testing/production-fixtures.ts";
import type { ProductionJob } from "./types.ts";
import { finalizeProductionArtifact } from "./artifact-finalizer.ts";
import { pollProductionJobs } from "./poller.ts";

const MP4_BASE64 = Buffer.from(fakeMp4()).toString("base64");
const MODEL = "gemini-omni-1.1-flash";

/** Deterministic in-memory Drive, installed on the production singleton for the duration of one test. */
function installDrive() {
  const files = new Map<string, Uint8Array>();
  const put = mock.method(googleDriveClient, "put", (async (input: { bytes: Uint8Array }) => {
    const fileId = `drive-file-${randomUUID()}`;
    files.set(fileId, input.bytes);
    return { fileId, id: fileId, webViewLink: "" };
  }) as unknown as typeof googleDriveClient.put);
  const get = mock.method(googleDriveClient, "get", (async (fileId: string) => ({
    bytes: files.get(fileId) ?? new Uint8Array(),
    mimeType: "video/mp4",
    name: fileId,
  })) as unknown as typeof googleDriveClient.get);
  return {
    restore() {
      put.mock.restore();
      get.mock.restore();
    },
  };
}

function completedWithBytes(providerJobId: string): ProductionJob {
  return {
    jobId: providerJobId,
    providerJobId,
    status: "COMPLETED",
    metadata: { videoBytesBase64: MP4_BASE64, mimeType: "video/mp4" },
  } as unknown as ProductionJob;
}

function queued(index: number): ProductionJob {
  return { jobId: `pj-${index}`, providerJobId: `pj-${index}`, status: "QUEUED" } as unknown as ProductionJob;
}

async function artifactCounts(sql: Sql, tenant: Tenant) {
  const creatives = await sql<{ n: number }>`
    select count(*)::int as n from creative_records
    where organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId} and origin = 'generated' and (workflow::jsonb)->>'kind' = 'video'
  `;
  const assets = await sql<{ n: number }>`
    select count(*)::int as n from assets where organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId} and kind = 'video'
  `;
  const reviews = await sql<{ n: number; status: string }>`
    select count(*)::int as n, min(status) as status from reviews where organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId}
  `;
  return {
    creatives: Number(creatives[0]!.n),
    assets: Number(assets[0]!.n),
    reviews: Number(reviews[0]!.n),
  };
}

async function creativeStatuses(sql: Sql, tenant: Tenant) {
  return sql<{ status: string; qa: string | null }>`
    select c.status, a.qa_decision as qa from creative_records c
    left join assets a on a.creative_id = c.id
    where c.organization_id = ${tenant.organizationId} and c.brand_id = ${tenant.brandId} and c.origin = 'generated' and (c.workflow::jsonb)->>'kind' = 'video'
  `;
}

async function resetPollSchedule(sql: Sql, tenant: Tenant) {
  await sql`update production_jobs set next_poll_at = null where organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId}`;
}

test("synchronous completion materializes through the shared service: one creative in review, one review, settled reservation", async () => {
  const sql = await getSql();
  const drive = installDrive();
  const tenant = await createTenantFixture(sql, "sync", 50, "google_omni", MODEL);
  const injected = injectProvider("google_omni", async (spec) => job(spec, "COMPLETED", { metadata: { videoBytesBase64: MP4_BASE64, mimeType: "video/mp4" } } as Partial<ProductionJob>));
  try {
    await execute(sql, tenant, tenant.plan, tenant.brief);

    assert.equal(injected.submitted.length, 1);
    const [row] = await productionJobs(sql, tenant);
    assert.equal(row!.status, "COMPLETED");
    assert.ok(row!.materialized_at, "job is materialized");
    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 1, assets: 1, reviews: 1 });
    const statuses = await creativeStatuses(sql, tenant);
    assert.equal(statuses[0]!.status, "in_review", "creative enters review, not approved");
    assert.notEqual(statuses[0]!.qa, "auto_approved");
    const [reservation] = await reservationsFor(sql, tenant.plan.id);
    assert.equal(reservation!.status, "RECONCILED");
    assert.equal(reservation!.production_job_id, row!.id, "reservation is linked to the job");
    assert.equal(await planStatus(sql, tenant.plan.id), "completed");
    assert.equal(await accountReservedMicros(sql, tenant), 0n);
  } finally {
    injected.restore();
    drive.restore();
  }
});

test("queued to completed: the poller materializes the artifact and completes the plan", async () => {
  const sql = await getSql();
  const drive = installDrive();
  const tenant = await createTenantFixture(sql, "queued", 50, "google_omni", MODEL);
  const injected = injectProvider("google_omni", async (_spec, index) => queued(index), async (id) => completedWithBytes(id));
  try {
    await execute(sql, tenant, tenant.plan, tenant.brief);

    // Accepted but not finished: nothing is materialized and the plan is still executing.
    assert.equal(await planStatus(sql, tenant.plan.id), "executing");
    const [reservation] = await reservationsFor(sql, tenant.plan.id);
    assert.equal(reservation!.status, "RESERVED", "reservation is held while the render is in flight");
    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 0, assets: 0, reviews: 0 });

    const poll = await pollProductionJobs(sql, { driveClient: googleDriveClient });
    assert.equal(poll.rendered, 1);

    const [row] = await productionJobs(sql, tenant);
    assert.equal(row!.status, "COMPLETED");
    assert.ok(row!.artifact_id, "artifact is registered");
    assert.ok(row!.materialized_at, "job is materialized");
    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 1, assets: 1, reviews: 1 });
    const statuses = await creativeStatuses(sql, tenant);
    assert.equal(statuses[0]!.status, "in_review");
    assert.notEqual(statuses[0]!.qa, "auto_approved", "asynchronous artifacts are never auto-approved");
    const [settled] = await reservationsFor(sql, tenant.plan.id);
    assert.equal(settled!.status, "RECONCILED");
    assert.equal(await planStatus(sql, tenant.plan.id), "completed");
    assert.equal(await accountSpentMicros(sql, tenant), BigInt(settled!.amount_micros));
    assert.equal(await accountReservedMicros(sql, tenant), 0n);
  } finally {
    injected.restore();
    drive.restore();
  }
});

test("poller materializes a job finalized before a crash, without contacting the provider", async () => {
  const sql = await getSql();
  const drive = installDrive();
  const tenant = await createTenantFixture(sql, "finalized", 50, "google_omni", MODEL);
  const injected = injectProvider("google_omni", async (_spec, index) => queued(index), async (id) => {
    throw new Error(`provider must not be polled for ${id}`);
  });
  try {
    await execute(sql, tenant, tenant.plan, tenant.brief);
    const [row] = await productionJobs(sql, tenant);
    // Simulate a crash after artifact finalization but before materialization.
    const finalized = await finalizeProductionArtifact(sql, {
      jobId: row!.id,
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      provider: "google_omni",
      rawArtifact: { base64: MP4_BASE64 },
      options: { durationMs: 8000 },
    });
    assert.equal(finalized.success, true);
    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 0, assets: 0, reviews: 0 }, "nothing materialized yet");

    const pollsBefore = injected.polled.length;
    const poll = await pollProductionJobs(sql, { driveClient: googleDriveClient });
    assert.equal(poll.rendered, 1);
    assert.equal(injected.polled.length, pollsBefore, "no provider call for an already-finalized artifact");
    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 1, assets: 1, reviews: 1 });
    assert.equal(await planStatus(sql, tenant.plan.id), "completed");
  } finally {
    injected.restore();
    drive.restore();
  }
});

test("duplicate polls never duplicate creative, asset, review, or ledger rows", async () => {
  const sql = await getSql();
  const drive = installDrive();
  const tenant = await createTenantFixture(sql, "dupe", 50, "google_omni", MODEL);
  const injected = injectProvider("google_omni", async (_spec, index) => queued(index), async (id) => completedWithBytes(id));
  try {
    await execute(sql, tenant, tenant.plan, tenant.brief);
    await pollProductionJobs(sql, { driveClient: googleDriveClient });
    const [reservation] = await reservationsFor(sql, tenant.plan.id);

    for (let i = 0; i < 3; i += 1) {
      await resetPollSchedule(sql, tenant);
      const again = await pollProductionJobs(sql, { driveClient: googleDriveClient });
      assert.equal(again.rendered, 0, "a materialized job is not claimed again");
    }

    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 1, assets: 1, reviews: 1 });
    const ledger = await sql<{ n: number }>`
      select count(*)::int as n from budget_ledger_entries where reservation_id = ${reservation!.id} and entry_type = 'RESERVATION_RECONCILED'
    `;
    assert.equal(Number(ledger[0]!.n), 1, "the reservation is settled exactly once");
    assert.equal(await planStatus(sql, tenant.plan.id), "completed");
  } finally {
    injected.restore();
    drive.restore();
  }
});

test("crash mid-materialization: a partial write is completed exactly once on retry", async () => {
  const sql = await getSql();
  const drive = installDrive();
  const tenant = await createTenantFixture(sql, "crash", 50, "google_omni", MODEL);
  const injected = injectProvider("google_omni", async (_spec, index) => queued(index), async (id) => completedWithBytes(id));
  try {
    await execute(sql, tenant, tenant.plan, tenant.brief);
    const [row] = await productionJobs(sql, tenant);
    await finalizeProductionArtifact(sql, {
      jobId: row!.id,
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      provider: "google_omni",
      rawArtifact: { base64: MP4_BASE64 },
      options: { durationMs: 8000 },
    });
    // Residue of a crash after the creative row was written but before the asset, review and marker.
    await sql`
      insert into creative_records (id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle, message, cta, format, proof_type, brief_id, status, created_by, workflow)
      values (${`video-creative-${row!.id}`}, ${tenant.organizationId}, ${tenant.brandId}, 'generated', 'partial', '', '', '', '', '', '', '', '', '', ${tenant.briefId}, 'in_review', 'test-user', ${JSON.stringify({ kind: "video" })})
    `;

    await pollProductionJobs(sql, { driveClient: googleDriveClient });

    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 1, assets: 1, reviews: 1 }, "the partial creative is completed, not duplicated");
    const [after] = await productionJobs(sql, tenant);
    assert.ok(after!.materialized_at, "materialization marker is set after the retry");
    assert.equal(await planStatus(sql, tenant.plan.id), "completed");
  } finally {
    injected.restore();
    drive.restore();
  }
});

test("multiple jobs in one plan: the plan completes only after every job is materialized", async () => {
  const sql = await getSql();
  const drive = installDrive();
  const tenant = await createTenantFixture(sql, "multi", 50, "google_omni", MODEL, 2);
  const injected = injectProvider("google_omni", async (_spec, index) => queued(index), async (id) =>
    id === "pj-1" ? completedWithBytes(id) : ({ jobId: id, providerJobId: id, status: "RUNNING" } as unknown as ProductionJob),
  );
  try {
    await execute(sql, tenant, tenant.plan, tenant.brief);
    assert.equal(injected.submitted.length, 2);
    const reservations = await reservationsFor(sql, tenant.plan.id);
    assert.equal(reservations.length, 2, "one reservation per video job");
    assert.ok(reservations.every((r) => r.production_job_id), "each reservation is linked to its job");

    await pollProductionJobs(sql, { driveClient: googleDriveClient });
    assert.equal(await planStatus(sql, tenant.plan.id), "executing", "one job still in flight keeps the plan open");
    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 1, assets: 1, reviews: 1 });

    injected.setPoll(async (id) => completedWithBytes(id));
    await resetPollSchedule(sql, tenant);
    await pollProductionJobs(sql, { driveClient: googleDriveClient });

    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 2, assets: 2, reviews: 2 });
    assert.equal(await planStatus(sql, tenant.plan.id), "completed");
    const settled = await reservationsFor(sql, tenant.plan.id);
    assert.ok(settled.every((r) => r.status === "RECONCILED"));
    assert.equal(await accountReservedMicros(sql, tenant), 0n);
  } finally {
    injected.restore();
    drive.restore();
  }
});

test("failed async job: the reservation is held for reconciliation and the plan settles failed", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "failed", 50, "google_omni", MODEL);
  const injected = injectProvider("google_omni", async (_spec, index) => queued(index), async (id) =>
    ({ jobId: id, providerJobId: id, status: "FAILED", error: "render rejected after acceptance" } as unknown as ProductionJob),
  );
  try {
    await execute(sql, tenant, tenant.plan, tenant.brief);
    await pollProductionJobs(sql);

    const [row] = await productionJobs(sql, tenant);
    assert.equal(row!.status, "FAILED");
    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 0, assets: 0, reviews: 0 });
    const [reservation] = await reservationsFor(sql, tenant.plan.id);
    assert.equal(reservation!.status, "RESERVED", "billing is uncertain after acceptance, so the reservation is held");
    assert.equal(await planStatus(sql, tenant.plan.id), "failed");
    assert.ok(await accountReservedMicros(sql, tenant) > 0n);
  } finally {
    injected.restore();
  }
});

test("ambiguous financial outcome: a completed render whose artifact never arrives keeps its reservation held", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "ambiguous", 50, "google_omni", MODEL);
  const injected = injectProvider("google_omni", async (_spec, index) => queued(index), async (id) =>
    ({ jobId: id, providerJobId: id, status: "COMPLETED" } as unknown as ProductionJob),
  );
  try {
    await execute(sql, tenant, tenant.plan, tenant.brief);
    // The provider reported completion, but no bytes or URL are available. The final attempt gives up.
    await sql`update production_jobs set attempt_count = 4 where organization_id = ${tenant.organizationId}`;
    await pollProductionJobs(sql);

    const [row] = await productionJobs(sql, tenant);
    assert.equal(row!.status, "FAILED");
    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 0, assets: 0, reviews: 0 });
    const [reservation] = await reservationsFor(sql, tenant.plan.id);
    assert.equal(reservation!.status, "RESERVED", "a render that may have been billed is not released");
    assert.equal(await planStatus(sql, tenant.plan.id), "failed");
  } finally {
    injected.restore();
  }
});

test("artifact integrity: a corrupt stored record is never materialized, and a retry after repair completes once", async () => {
  const sql = await getSql();
  const drive = installDrive();
  const tenant = await createTenantFixture(sql, "integrity", 50, "google_omni", MODEL);
  const injected = injectProvider("google_omni", async (_spec, index) => queued(index), async (id) => completedWithBytes(id));
  try {
    await execute(sql, tenant, tenant.plan, tenant.brief);
    const [row] = await productionJobs(sql, tenant);
    await finalizeProductionArtifact(sql, {
      jobId: row!.id,
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      provider: "google_omni",
      rawArtifact: { base64: MP4_BASE64 },
      options: { durationMs: 8000 },
    });
    const [finalizedRow] = await productionJobs(sql, tenant);
    const [stored] = await sql<{ sha256: string }>`select sha256 from storage_objects where id = ${finalizedRow!.artifact_id}`;
    await sql`update storage_objects set sha256 = 'not-a-sha256' where id = ${finalizedRow!.artifact_id}`;

    await pollProductionJobs(sql, { driveClient: googleDriveClient });
    const [failed] = await productionJobs(sql, tenant);
    assert.equal(failed!.materialized_at, null, "a corrupt artifact is not materialized");
    assert.match(failed!.error_message ?? "", /SHA-256/, "the refusal is recorded durably");
    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 0, assets: 0, reviews: 0 });

    // Repair the record; the job is retried from the durable state and materialized exactly once.
    await sql`update storage_objects set sha256 = ${stored!.sha256} where id = ${finalizedRow!.artifact_id}`;
    await resetPollSchedule(sql, tenant);
    await pollProductionJobs(sql, { driveClient: googleDriveClient });
    assert.deepEqual(await artifactCounts(sql, tenant), { creatives: 1, assets: 1, reviews: 1 });
    assert.equal(await planStatus(sql, tenant.plan.id), "completed");
  } finally {
    injected.restore();
    drive.restore();
  }
});
