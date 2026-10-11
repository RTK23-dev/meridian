import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { BudgetLedgerService } from "../security/budget-ledger.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { openTestBackends } from "../credentials/test-databases.ts";
import { pollProductionJobs } from "./poller.ts";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

/** What the scripted provider answers for one stored provider job id: a status, or a thrown status-check error. */
type ScriptedAnswer = { status: string; errorCode?: string; error?: string } | { throws: unknown };

for (const { name, sql } of backends) {
  test(`[${name}] the submission pass resolves each unknown submission by its evidence, and never moves its reservation`, async () => {
    const tenant = await studioTenant(sql, `submission-pass-${name}`);

    /** A job whose submission outcome is unknown, with its held reservation. A null provider id means no evidence can be gathered. */
    async function unknownJob(label: string, options: { providerJobId: string | null; hoursOld: number }) {
      const jobId = `prod-submission-${label}-${randomUUID().slice(0, 8)}`;
      await sql`
        insert into production_jobs (
          id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
          status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id,
          attempt_count, modality, error_code, error_message
        ) values (
          ${jobId}, ${tenant.organizationId}, ${tenant.brandId}, 'higgsfield', ${options.providerJobId}, ${options.providerJobId},
          ${options.providerJobId ? `https://api.higgsfield.ai/v1/requests/${options.providerJobId}/status` : null}, null,
          'SUBMISSION_UNKNOWN', 'BALANCED', 250, '{}', now() - (${options.hoursOld} * interval '1 hour'), now(), now(), null,
          0, 'video', 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN', 'Provider submission outcome is unknown.'
        )
      `;
      const reservation = await BudgetLedgerService.reserve(sql, {
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        amountMicros: 2_500_000n,
        productionJobId: jobId,
      });
      return { jobId, providerJobId: options.providerJobId, reservationId: reservation.id };
    }

    const confirmed = await unknownJob("confirmed", { providerJobId: `req-confirmed-${randomUUID().slice(0, 8)}`, hoursOld: 0 });
    const failed = await unknownJob("failed", { providerJobId: `req-failed-${randomUUID().slice(0, 8)}`, hoursOld: 0 });
    const review = await unknownJob("review", { providerJobId: `req-review-${randomUUID().slice(0, 8)}`, hoursOld: 0 });
    const expired = await unknownJob("expired", { providerJobId: null, hoursOld: 25 });
    const waiting = await unknownJob("waiting", { providerJobId: null, hoursOld: 1 });

    const answers = new Map<string, ScriptedAnswer>([
      [confirmed.providerJobId!, { status: "RUNNING" }],
      [failed.providerJobId!, { status: "FAILED", errorCode: "RENDER_REJECTED", error: "Prompt rejected by the provider." }],
      [
        review.providerJobId!,
        { throws: Object.assign(new Error("Higgsfield status check failed (401)."), { status: 401 }) },
      ],
    ]);
    const checked: string[] = [];
    const provider = {
      checkJobStatus: async (jobId: string) => {
        checked.push(jobId);
        const answer = answers.get(jobId);
        if (!answer) throw new Error(`No answer scripted for ${jobId}.`);
        if ("throws" in answer) throw answer.throws;
        return { status: answer.status, errorCode: answer.errorCode, error: answer.error };
      },
    };
    const router = { get: (id: string) => (id === "higgsfield" ? provider : undefined) };
    const pollOnce = () =>
      pollProductionJobs(sql, { organizationId: tenant.organizationId, router: router as never, driveClient: {} as never, limit: 50 });

    async function jobRow(jobId: string) {
      const [row] = await sql<{ status: string; error_code: string | null; error_message: string | null; provider_job_id: string | null; next_poll_at: unknown }>`
        select status, error_code, error_message, provider_job_id, next_poll_at from production_jobs where id = ${jobId}
      `;
      return row!;
    }
    async function reservationStatus(reservationId: string) {
      const [row] = await sql<{ status: string }>`select status from budget_reservations where id = ${reservationId}`;
      return row!.status;
    }
    async function ledgerEntries(reservationId: string) {
      const [row] = await sql<{ count: number | string }>`select count(*) as count from budget_ledger_entries where reservation_id = ${reservationId}`;
      return Number(row!.count);
    }

    const before = {
      failed: { status: await reservationStatus(failed.reservationId), entries: await ledgerEntries(failed.reservationId) },
      review: { status: await reservationStatus(review.reservationId), entries: await ledgerEntries(review.reservationId) },
      expired: { status: await reservationStatus(expired.reservationId), entries: await ledgerEntries(expired.reservationId) },
    };

    const first = await pollOnce();
    assert.deepEqual(
      [...checked].sort(),
      [confirmed.providerJobId!, failed.providerJobId!, review.providerJobId!].sort(),
      "the provider is asked only about jobs that have a stored provider id",
    );
    assert.equal(first.claimed, 5, "the pass claims every unknown submission it is due to look at");

    // CONFIRMED: accepted under its stored id, so it returns to the queue with that id, and it is not polled again in this pass.
    const confirmedRow = await jobRow(confirmed.jobId);
    assert.equal(confirmedRow.status, "QUEUED");
    assert.equal(confirmedRow.provider_job_id, confirmed.providerJobId);
    assert.equal(confirmedRow.error_code, null);
    assert.ok(confirmedRow.next_poll_at, "the job is scheduled for its next turn");
    assert.equal(await reservationStatus(confirmed.reservationId), "RESERVED", "confirming a job does not settle its spend");

    // FAILED: the provider's error is recorded, and the reservation is still held.
    const failedRow = await jobRow(failed.jobId);
    assert.equal(failedRow.status, "FAILED");
    assert.equal(failedRow.error_code, "RENDER_REJECTED");
    assert.match(failedRow.error_message ?? "", /Prompt rejected by the provider\./);
    assert.match(failedRow.error_message ?? "", /reservation is held/);
    assert.equal(await reservationStatus(failed.reservationId), "RESERVED");

    // REVIEW: a refused status check cannot show whether the job was accepted. It is marked for a person, and the spend is untouched.
    const reviewRow = await jobRow(review.jobId);
    assert.equal(reviewRow.status, "SUBMISSION_UNKNOWN", "the job stays in the operator's queue");
    assert.equal(reviewRow.error_code, "SUBMISSION_REVIEW_REQUIRED");
    assert.match(reviewRow.error_message ?? "", /HTTP 401/);
    assert.match(reviewRow.error_message ?? "", /reservation is held/);
    assert.equal(await reservationStatus(review.reservationId), before.review.status, "REVIEW leaves the reservation status untouched");
    assert.equal(await ledgerEntries(review.reservationId), before.review.entries, "REVIEW writes no ledger entry");

    // EXPIRED: no evidence in twenty-four hours. It is marked for a person, and the spend is untouched.
    const expiredRow = await jobRow(expired.jobId);
    assert.equal(expiredRow.status, "SUBMISSION_UNKNOWN");
    assert.equal(expiredRow.error_code, "SUBMISSION_EVIDENCE_EXPIRED");
    assert.match(expiredRow.error_message ?? "", /within 24 hours/);
    assert.equal(await reservationStatus(expired.reservationId), before.expired.status, "EXPIRED leaves the reservation status untouched");
    assert.equal(await ledgerEntries(expired.reservationId), before.expired.entries, "EXPIRED writes no ledger entry");

    // WAITING: no evidence yet and inside the bound, so the job keeps its status and is checked again later.
    const waitingRow = await jobRow(waiting.jobId);
    assert.equal(waitingRow.status, "SUBMISSION_UNKNOWN");
    assert.equal(waitingRow.error_code, "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN", "the original reason is kept");
    assert.ok(waitingRow.next_poll_at, "the job is scheduled for a later check");
    assert.equal(await reservationStatus(waiting.reservationId), "RESERVED");

    // A later pass claims none of them: REVIEW and EXPIRED are marked, FAILED is terminal, CONFIRMED and WAITING are not due yet.
    const callsBefore = checked.length;
    const second = await pollOnce();
    assert.equal(second.claimed, 0, "no job is claimed again");
    assert.equal(checked.length, callsBefore, "the provider is not asked again");
  });
}
