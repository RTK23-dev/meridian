import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { factoryRunFor, planRowsFor, stageJob, stubImageProvider, studioTenant, type FactoryTenant } from "../testing/produce-fixtures.ts";
import type { Sql } from "../learning/store.ts";

// The testing runtime enables the image double. Production never selects it.
process.env.MERIDIAN_TESTING_RUNTIME = "true";
enableAppAliases();
const { executeFactoryJob } = await import("../factory/worker.ts");
const { listWindowReleases, releaseExpiredHolds, submissionHasNoOutcome, SUBMISSION_WINDOW_EXPIRED_CODE } = await import("./held-reservations.ts");

/** A reservation whose provider call did not return, so its submission is held with no outcome. */
async function heldSubmission(sql: Sql, tenant: FactoryTenant): Promise<{ reservationId: string; jobId: string }> {
  const runId = await factoryRunFor(sql, tenant, { automation: "full", formats: ["image"], providers: { image: "google_nano_banana" }, caps: { totalCents: 500 } });
  await planRowsFor(sql, tenant, runId, ["image"]);
  const stub = stubImageProvider({ throws: true });
  try {
    await executeFactoryJob(sql, stageJob(tenant, runId, "factory.produce"), { runId });
  } finally {
    stub.restore();
  }
  const [row] = await sql<{ id: string; production_job_id: string }>`
    select id, production_job_id from budget_reservations
    where organization_id = ${tenant.organizationId} and status = 'RESERVED' order by created_at desc limit 1
  `;
  assert.ok(row, "a reservation is held");
  return { reservationId: row.id, jobId: row.production_job_id };
}

async function statusOf(sql: Sql, reservationId: string): Promise<string> {
  const [row] = await sql<{ status: string }>`select status from budget_reservations where id = ${reservationId}`;
  return row!.status;
}

async function expire(sql: Sql, reservationId: string): Promise<void> {
  await sql`update budget_reservations set expires_at = now() - interval '1 hour' where id = ${reservationId}`;
}

test("before its window expires nothing is released", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "held-window-before");
  const { reservationId } = await heldSubmission(sql, tenant);
  await releaseExpiredHolds(sql);
  assert.equal(await statusOf(sql, reservationId), "RESERVED", "the window has not expired, so the hold stands");
});

test("after its window expires with no outcome it is released once, and a second sweep releases nothing more", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "held-window-release");
  const { reservationId, jobId } = await heldSubmission(sql, tenant);
  await expire(sql, reservationId);

  await releaseExpiredHolds(sql);
  assert.equal(await statusOf(sql, reservationId), "RELEASED");
  const [job] = await sql<{ status: string; error_code: string }>`select status, error_code from production_jobs where id = ${jobId}`;
  assert.equal(job?.status, "FAILED", "the job no longer reads as an unknown submission");
  assert.equal(job?.error_code, SUBMISSION_WINDOW_EXPIRED_CODE);

  const entries = await sql<{ reason: string; actor: string }>`
    select metadata->>'reason' as reason, metadata->>'actor' as actor from budget_ledger_entries
    where reservation_id = ${reservationId} and entry_type = 'RESERVATION_RELEASED'
  `;
  assert.deepEqual(entries.map((item) => ({ reason: item.reason, actor: item.actor })), [{ reason: "window_expired", actor: "system" }]);
  const audited = await sql<{ n: number }>`
    select count(*)::int as n from audit_log where object_id = ${reservationId} and action = 'budget.held_reservation_window_expired' and actor_id = 'system'
  `;
  assert.equal(audited[0]?.n, 1, "the release is in the audit log, by the system");

  await releaseExpiredHolds(sql);
  const after = await sql<{ n: number }>`
    select count(*)::int as n from budget_ledger_entries where reservation_id = ${reservationId} and entry_type = 'RESERVATION_RELEASED'
  `;
  assert.equal(after[0]?.n, 1, "the second sweep finds nothing to release");
});

test("a submission with an outcome is never released, even past its window", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "held-window-outcome");

  // The provider reported the job failed. That is an outcome, so the hold stays for an operator.
  const failed = await heldSubmission(sql, tenant);
  await sql`update production_jobs set status = 'FAILED', error_code = 'PROVIDER_FAILED' where id = ${failed.jobId}`;
  await expire(sql, failed.reservationId);

  // The provider accepted the job and gave it a provider job id, so its outcome is pending.
  const accepted = await heldSubmission(sql, tenant);
  await sql`update production_jobs set status = 'SUBMISSION_UNKNOWN', provider_job_id = 'job-accepted-1' where id = ${accepted.jobId}`;
  await expire(sql, accepted.reservationId);

  await releaseExpiredHolds(sql);
  assert.equal(await statusOf(sql, failed.reservationId), "RESERVED", "a failure the provider reported keeps its hold");
  assert.equal(await statusOf(sql, accepted.reservationId), "RESERVED", "an accepted job keeps its hold");
});

test("the released list shows each automatic release with its reason to an admin only", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "held-window-list");
  const { reservationId } = await heldSubmission(sql, tenant);
  await expire(sql, reservationId);
  await releaseExpiredHolds(sql);

  await sql`update memberships set role = 'admin' where user_id = ${tenant.userId} and organization_id = ${tenant.organizationId}`;
  const listed = await listWindowReleases(sql, tenant.userId, tenant.brandId);
  const row = listed.find((item) => item.reservationId === reservationId);
  assert.ok(row, "the automatic release is listed");
  assert.equal(row?.reason, "window_expired");
  assert.equal(row?.actor, "system");
  assert.equal(row?.amountUsd, 1);

  await sql`update memberships set role = 'member' where user_id = ${tenant.userId} and organization_id = ${tenant.organizationId}`;
  await assert.rejects(() => listWindowReleases(sql, tenant.userId, tenant.brandId), /do not have permission/);
});

test("a submission has no outcome only while it is unanswered: no provider id, no creative, not failed", () => {
  assert.equal(submissionHasNoOutcome({ status: "SUBMITTING", provider_job_id: null, materialized_creative_id: null }), true);
  assert.equal(submissionHasNoOutcome({ status: "SUBMISSION_UNKNOWN", provider_job_id: "", materialized_creative_id: null }), true);
  assert.equal(submissionHasNoOutcome({ status: "SUBMISSION_UNKNOWN", provider_job_id: "job-1", materialized_creative_id: null }), false);
  assert.equal(submissionHasNoOutcome({ status: "FAILED", provider_job_id: null, materialized_creative_id: null }), false);
  assert.equal(submissionHasNoOutcome({ status: "QUEUED", provider_job_id: null, materialized_creative_id: null }), false);
  assert.equal(submissionHasNoOutcome({ status: "COMPLETED", provider_job_id: null, materialized_creative_id: "cr-1" }), false);
  assert.equal(submissionHasNoOutcome({ status: "SUBMISSION_UNKNOWN", provider_job_id: null, materialized_creative_id: "cr-1" }), false);
});
