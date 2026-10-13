import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { factoryRunFor, planRowsFor, stageJob, stubImageProvider, studioTenant, type FactoryTenant } from "../testing/produce-fixtures.ts";
import type { Sql } from "../learning/store.ts";
import type { SubmissionLookup } from "./held-reservations.ts";

// The testing runtime enables the image double. Production never selects it.
process.env.MERIDIAN_TESTING_RUNTIME = "true";
enableAppAliases();
const { executeFactoryJob } = await import("../factory/worker.ts");
const {
  HOLD_CHECK_ACTION,
  SUBMISSION_WINDOW_EXPIRED_CODE,
  listHeldReservations,
  listWindowReleases,
  releaseExpiredHolds,
  submissionHasNoOutcome,
} = await import("./held-reservations.ts");

/** A provider lookup that answers the same way for every submission, and records which production jobs it was asked about. */
function lookupAnswering(answer: () => unknown) {
  const asked: string[] = [];
  const lookup: SubmissionLookup = async (input) => {
    asked.push(input.productionJobId);
    return answer() as Awaited<ReturnType<SubmissionLookup>>;
  };
  return { asked, lookupFor: () => lookup };
}

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

async function checksOf(sql: Sql, reservationId: string): Promise<Array<{ result: string }>> {
  const rows = await sql<{ metadata: string }>`
    select metadata from audit_log where object_id = ${reservationId} and action = ${HOLD_CHECK_ACTION} order by created_at asc
  `;
  return rows.map((row) => JSON.parse(row.metadata) as { result: string });
}

test("before its window expires a hold is not checked and not released", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "held-window-before");
  const { reservationId, jobId } = await heldSubmission(sql, tenant);
  const lookup = lookupAnswering(() => ({ kind: "absent" }));
  await releaseExpiredHolds(sql, { lookupFor: lookup.lookupFor, checkIntervalMinutes: 0 });
  assert.equal(await statusOf(sql, reservationId), "RESERVED", "the window has not expired, so the hold stands");
  assert.equal(lookup.asked.includes(jobId), false, "the provider is not asked before the window expires");
  assert.equal((await checksOf(sql, reservationId)).length, 0);
});

test("with no provider lookup, an expired hold stays, and the check says so", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "held-window-no-lookup");
  const { reservationId } = await heldSubmission(sql, tenant);
  await expire(sql, reservationId);
  // No lookup is registered for any provider, so the default registry gives none.
  await releaseExpiredHolds(sql, { checkIntervalMinutes: 0 });
  assert.equal(await statusOf(sql, reservationId), "RESERVED", "without a lookup that confirms absence, the hold stays");
  assert.deepEqual((await checksOf(sql, reservationId)).map((item) => item.result), ["no_lookup"]);

  await sql`update memberships set role = 'admin' where user_id = ${tenant.userId} and organization_id = ${tenant.organizationId}`;
  const listed = await listHeldReservations(sql, tenant.userId, tenant.brandId);
  const row = listed.find((item) => item.reservationId === reservationId);
  assert.ok(row, "the hold is shown to an admin");
  assert.equal(row?.lastCheck?.result, "no_lookup", "the panel can say why the hold stays");
});

test("when the provider confirms it holds no job, the hold is released once, with its reason and actor, and a second sweep releases nothing more", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "held-window-absent");
  const { reservationId, jobId } = await heldSubmission(sql, tenant);
  await expire(sql, reservationId);
  const lookup = lookupAnswering(() => ({ kind: "absent" }));

  const first = await releaseExpiredHolds(sql, { lookupFor: lookup.lookupFor, checkIntervalMinutes: 0 });
  assert.equal(await statusOf(sql, reservationId), "RELEASED");
  assert.equal(first.released >= 1, true);
  assert.deepEqual(lookup.asked.filter((id) => id === jobId), [jobId], "the provider was asked once");

  const [job] = await sql<{ status: string; error_code: string }>`select status, error_code from production_jobs where id = ${jobId}`;
  assert.equal(job?.status, "FAILED", "the job no longer reads as an unknown submission");
  assert.equal(job?.error_code, SUBMISSION_WINDOW_EXPIRED_CODE);

  const entries = await sql<{ reason: string; actor: string }>`
    select metadata->>'reason' as reason, metadata->>'actor' as actor from budget_ledger_entries
    where reservation_id = ${reservationId} and entry_type = 'RESERVATION_RELEASED'
  `;
  assert.deepEqual(entries.map((item) => ({ reason: item.reason, actor: item.actor })), [{ reason: "window_expired", actor: "system" }]);
  const audited = await sql<{ n: number }>`
    select count(*)::int as n from audit_log
    where object_id = ${reservationId} and action = 'budget.held_reservation_window_expired' and actor_id = 'system'
  `;
  assert.equal(audited[0]?.n, 1, "the release is in the audit log, by the system");

  await releaseExpiredHolds(sql, { lookupFor: lookup.lookupFor, checkIntervalMinutes: 0 });
  const after = await sql<{ n: number }>`
    select count(*)::int as n from budget_ledger_entries where reservation_id = ${reservationId} and entry_type = 'RESERVATION_RELEASED'
  `;
  assert.equal(after[0]?.n, 1, "a second sweep releases nothing more");
  assert.equal(lookup.asked.filter((id) => id === jobId).length, 1, "a released hold is not asked about again");
});

test("when the provider reports a job for the submission, the hold stays and the job keeps its state", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "held-window-present");
  const { reservationId, jobId } = await heldSubmission(sql, tenant);
  await expire(sql, reservationId);
  const lookup = lookupAnswering(() => ({ kind: "present", providerJobId: "provider-job-7" }));
  await releaseExpiredHolds(sql, { lookupFor: lookup.lookupFor, checkIntervalMinutes: 0 });

  assert.equal(await statusOf(sql, reservationId), "RESERVED", "a job the provider holds keeps its budget reserved");
  const [job] = await sql<{ status: string; provider_job_id: string | null }>`select status, provider_job_id from production_jobs where id = ${jobId}`;
  assert.equal(job?.status, "SUBMISSION_UNKNOWN", "the job is left in its existing state");
  assert.equal(job?.provider_job_id, null, "the sweep does not write a provider id onto the job");
  const checks = await checksOf(sql, reservationId);
  assert.deepEqual(checks.map((item) => item.result), ["present"]);
});

test("a lookup that fails keeps the hold, and records that it failed without the message", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "held-window-failed");
  const thrown = await heldSubmission(sql, tenant);
  await expire(sql, thrown.reservationId);
  const throwing = lookupAnswering(() => {
    throw new TypeError("network reset with token abc");
  });
  await releaseExpiredHolds(sql, { lookupFor: throwing.lookupFor, checkIntervalMinutes: 0 });
  assert.equal(await statusOf(sql, thrown.reservationId), "RESERVED");
  const [check] = await sql<{ metadata: string }>`
    select metadata from audit_log where object_id = ${thrown.reservationId} and action = ${HOLD_CHECK_ACTION}
  `;
  assert.equal(JSON.parse(check!.metadata).result, "failed");
  assert.equal(check!.metadata.includes("token abc"), false, "the error message is never stored");

  const answered = await heldSubmission(sql, tenant);
  await expire(sql, answered.reservationId);
  const unclear = lookupAnswering(() => ({ kind: "failed" }));
  await releaseExpiredHolds(sql, { lookupFor: unclear.lookupFor, checkIntervalMinutes: 0 });
  assert.equal(await statusOf(sql, answered.reservationId), "RESERVED", "a lookup that cannot say keeps the hold");
});

test("a submission with an outcome is never asked about and never released, even past its window", async () => {
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

  const lookup = lookupAnswering(() => ({ kind: "absent" }));
  await releaseExpiredHolds(sql, { lookupFor: lookup.lookupFor, checkIntervalMinutes: 0 });
  assert.equal(await statusOf(sql, failed.reservationId), "RESERVED", "a failure the provider reported keeps its hold");
  assert.equal(await statusOf(sql, accepted.reservationId), "RESERVED", "an accepted job keeps its hold");
  assert.equal(lookup.asked.includes(failed.jobId), false, "a failed job is not asked about");
  assert.equal(lookup.asked.includes(accepted.jobId), false, "an accepted job is not asked about");
});

test("a check is not repeated for the same hold inside its interval", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "held-window-interval");
  const { reservationId, jobId } = await heldSubmission(sql, tenant);
  await expire(sql, reservationId);
  const lookup = lookupAnswering(() => ({ kind: "present", providerJobId: "job-9" }));
  await releaseExpiredHolds(sql, { lookupFor: lookup.lookupFor });
  await releaseExpiredHolds(sql, { lookupFor: lookup.lookupFor });
  assert.equal(lookup.asked.filter((id) => id === jobId).length, 1, "the second sweep, inside the interval, does not ask again");
});

test("the released list shows each automatic release with its reason to an admin only", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "held-window-list");
  const { reservationId } = await heldSubmission(sql, tenant);
  await expire(sql, reservationId);
  await releaseExpiredHolds(sql, { lookupFor: lookupAnswering(() => ({ kind: "absent" })).lookupFor, checkIntervalMinutes: 0 });

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
