import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { BudgetLedgerService } from "../security/budget-ledger.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { openTestBackends } from "../credentials/test-databases.ts";
import { HiggsfieldProvider } from "./providers/higgsfield.ts";
import {
  MAX_PROVIDER_POLL_ATTEMPTS,
  MAX_PROVIDER_POLL_AGE_MS,
  classifyProviderPollError,
  pollProductionJobs,
  providerPollDecision,
} from "./poller.ts";

const KEY = "workspace-higgsfield-reconcile-key";
const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

// The classification and the decision are pure, so they are checked on their own, with the numbers passed in.

test("classifyProviderPollError: the status decides permanent or transient, and a missing status is transient", () => {
  const permanent = [401, 403, 404, 400, 422, 301];
  for (const status of permanent) {
    assert.equal(classifyProviderPollError({ status }).permanent, true, `HTTP ${status} is permanent`);
  }
  const transient = [408, 429, 500, 502, 503, 504];
  for (const status of transient) {
    assert.equal(classifyProviderPollError({ status }).permanent, false, `HTTP ${status} is transient`);
  }
  assert.equal(classifyProviderPollError({ status: 401 }).errorCode, "PROVIDER_AUTH_REJECTED");
  assert.equal(classifyProviderPollError({ status: 404 }).errorCode, "PROVIDER_JOB_NOT_FOUND");
  assert.equal(classifyProviderPollError({ status: 429 }).errorCode, "PROVIDER_RATE_LIMITED");
  // No status, a Node error code that is not a contract code, a thrown string, and a status that is not an HTTP status.
  for (const error of [new Error("socket hang up"), Object.assign(new Error("reset"), { code: "ECONNRESET" }), "boom", { status: 0 }]) {
    const failure = classifyProviderPollError(error);
    assert.equal(failure.permanent, false, `${String(error)} is transient`);
    assert.equal(failure.errorCode, "PROVIDER_POLL_FAILED");
  }
  assert.equal(classifyProviderPollError({ code: "MALFORMED_RESPONSE" }).permanent, true);
  assert.equal(classifyProviderPollError({ code: "INVALID_JOB_ID" }).permanent, true);
  assert.equal(classifyProviderPollError({ code: "REDIRECT_REFUSED" }).permanent, true);
});

test("classifyProviderPollError: a Higgsfield error's own status is what the poller sees", async () => {
  const fetchImpl = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
  const provider = new HiggsfieldProvider({
    fetchImpl,
    lookup: async () => ({ status: "ready", source: "workspace", secret: KEY, fingerprint: "fp" }),
  });
  const error = await provider.checkJobStatus("req-classify-1", { organizationId: "org-x" }).then(
    () => assert.fail("expected a 403 to throw"),
    (err: unknown) => err,
  );
  assert.equal(classifyProviderPollError(error).errorCode, "PROVIDER_AUTH_REJECTED");
});

test("providerPollDecision: a transient failure retries with backoff up to the attempt bound, then reconciles", () => {
  const transient = { permanent: false, errorCode: "PROVIDER_UNAVAILABLE", reason: "down." };
  assert.deepEqual(providerPollDecision({ failure: transient, attempts: 1, ageMs: 0 }), { action: "retry", delaySeconds: 30 });
  assert.deepEqual(providerPollDecision({ failure: transient, attempts: 6, ageMs: 0 }), { action: "retry", delaySeconds: 180 });
  assert.deepEqual(providerPollDecision({ failure: transient, attempts: 100, ageMs: 0 }), { action: "retry", delaySeconds: 180 });
  const last = providerPollDecision({ failure: transient, attempts: MAX_PROVIDER_POLL_ATTEMPTS, ageMs: 0 });
  assert.equal(last.action, "reconcile");
  assert.equal(last.action === "reconcile" && last.errorCode, "POLL_RETRY_EXHAUSTED");
  assert.match(last.action === "reconcile" ? last.reason : "", /reservation is held/);
});

test("providerPollDecision: a job unreadable for twenty-four hours reconciles, whatever its attempt count", () => {
  const transient = { permanent: false, errorCode: "PROVIDER_UNAVAILABLE", reason: "down." };
  assert.equal(providerPollDecision({ failure: transient, attempts: 1, ageMs: MAX_PROVIDER_POLL_AGE_MS - 1 }).action, "retry");
  const aged = providerPollDecision({ failure: transient, attempts: 1, ageMs: MAX_PROVIDER_POLL_AGE_MS });
  assert.equal(aged.action, "reconcile");
  assert.match(aged.action === "reconcile" ? aged.reason : "", /24 hours/);
});

test("providerPollDecision: a permanent failure reconciles on its first attempt", () => {
  const permanent = { permanent: true, errorCode: "PROVIDER_AUTH_REJECTED", reason: "Key rejected." };
  const decision = providerPollDecision({ failure: permanent, attempts: 1, ageMs: 0 });
  assert.equal(decision.action, "reconcile");
  assert.equal(decision.action === "reconcile" && decision.errorCode, "PROVIDER_AUTH_REJECTED");
});

// Durable behaviour: the job row and its budget reservation, on each backend.

for (const { name, sql } of backends) {
  type Fixture = { tenant: Awaited<ReturnType<typeof studioTenant>>; jobId: string; reservationId: string };

  async function fixtureJob(label: string, options: { attemptCount?: number; hoursOld?: number } = {}): Promise<Fixture> {
    const tenant = await studioTenant(sql, label);
    const jobId = `prod-reconcile-${label}-${randomUUID().slice(0, 8)}`;
    const requestId = `req-${randomUUID().slice(0, 12)}`;
    await sql`
      insert into production_jobs (
        id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
        status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id, attempt_count
      ) values (
        ${jobId}, ${tenant.organizationId}, ${tenant.brandId}, 'higgsfield', ${requestId}, ${requestId},
        ${`https://api.higgsfield.ai/v1/requests/${requestId}/status`}, ${`https://api.higgsfield.ai/v1/requests/${requestId}/cancel`},
        'RUNNING', 'BALANCED', 250, '{}', now() - (${options.hoursOld ?? 0} * interval '1 hour'), now(), now(), null, ${options.attemptCount ?? 0}
      )
    `;
    const reservation = await BudgetLedgerService.reserve(sql, {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      amountMicros: 2_500_000n,
      productionJobId: jobId,
    });
    return { tenant, jobId, reservationId: reservation.id };
  }

  /** A provider whose status checks answer `status`, and a log of each request made. */
  function providerAnswering(statusCode: number, body: unknown = "") {
    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return typeof body === "string" ? new Response(body, { status: statusCode }) : new Response(JSON.stringify(body), { status: statusCode });
    }) as unknown as typeof fetch;
    const provider = new HiggsfieldProvider({
      fetchImpl,
      lookup: async () => ({ status: "ready", source: "workspace", secret: KEY, fingerprint: "fp" }),
    });
    return { provider, requests, router: { get: (id: string) => (id === "higgsfield" ? provider : undefined) } };
  }

  async function jobRow(jobId: string) {
    const [row] = await sql<{ status: string; error_code: string | null; error_message: string | null; attempt_count: number; next_poll_at: unknown }>`
      select status, error_code, error_message, attempt_count, next_poll_at from production_jobs where id = ${jobId}
    `;
    return row!;
  }

  async function reservationStatus(reservationId: string) {
    const [row] = await sql<{ status: string }>`select status from budget_reservations where id = ${reservationId}`;
    return row!.status;
  }

  async function pollOnce(fixture: Fixture, router: unknown) {
    return pollProductionJobs(sql, {
      organizationId: fixture.tenant.organizationId,
      router: router as never,
      driveClient: {} as never,
      limit: 50,
    });
  }

  test(`[${name}] a 401 on the status check stops polling: the job is terminal with a reason, and its reservation stays held`, async () => {
    const fixture = await fixtureJob("auth-401");
    const { requests, router } = providerAnswering(401, "unauthorized");

    const first = await pollOnce(fixture, router);
    assert.equal(first.failed, 1);
    assert.equal(requests.length, 1);

    const row = await jobRow(fixture.jobId);
    assert.equal(row.status, "SUBMISSION_UNKNOWN", "the job is in the reconciliation state, not RUNNING");
    assert.equal(row.error_code, "PROVIDER_AUTH_REJECTED");
    assert.match(row.error_message ?? "", /HTTP 401/);
    assert.match(row.error_message ?? "", /reservation is held/);
    assert.equal(await reservationStatus(fixture.reservationId), "RESERVED", "the spend stays held");

    const second = await pollOnce(fixture, router);
    assert.equal(second.claimed, 0, "the job is not claimed again");
    assert.equal(requests.length, 1, "the provider is not contacted again");
  });

  test(`[${name}] a transient failure below the bound is retried with a delay, and records why`, async () => {
    const fixture = await fixtureJob("transient-once");
    const { requests, router } = providerAnswering(503, "busy");

    const result = await pollOnce(fixture, router);
    assert.equal(result.polled, 1);
    assert.equal(requests.length, 1);

    const row = await jobRow(fixture.jobId);
    assert.equal(row.status, "RUNNING", "a transient failure does not end the job");
    assert.equal(row.attempt_count, 1);
    assert.equal(row.error_code, "PROVIDER_UNAVAILABLE");
    assert.ok(row.next_poll_at, "the next poll is scheduled");
    assert.equal(await reservationStatus(fixture.reservationId), "RESERVED");
  });

  test(`[${name}] repeated transient failures stop at the attempt bound, and the reservation stays held`, async () => {
    const fixture = await fixtureJob("transient-bound");
    const { requests, router } = providerAnswering(503, "busy");

    // Each pass is made due again, so the test is not waiting on the retry delay. The bound must end the loop by itself.
    let passes = 0;
    while (passes < MAX_PROVIDER_POLL_ATTEMPTS + 10) {
      await sql`update production_jobs set next_poll_at = null where id = ${fixture.jobId}`;
      const claimed = await pollOnce(fixture, router);
      passes += 1;
      if (claimed.claimed === 0) break;
    }

    assert.equal(requests.length, MAX_PROVIDER_POLL_ATTEMPTS, "exactly the bound's worth of status checks were made");
    const row = await jobRow(fixture.jobId);
    assert.equal(row.status, "SUBMISSION_UNKNOWN");
    assert.equal(row.error_code, "POLL_RETRY_EXHAUSTED");
    assert.equal(row.attempt_count, MAX_PROVIDER_POLL_ATTEMPTS);
    assert.match(row.error_message ?? "", /reservation is held/);
    assert.equal(await reservationStatus(fixture.reservationId), "RESERVED");
  });

  test(`[${name}] a transient failure on a job older than twenty-four hours is terminal at once`, async () => {
    const fixture = await fixtureJob("transient-old", { hoursOld: 25 });
    const { requests, router } = providerAnswering(502, "bad gateway");

    await pollOnce(fixture, router);
    assert.equal(requests.length, 1);
    const row = await jobRow(fixture.jobId);
    assert.equal(row.status, "SUBMISSION_UNKNOWN");
    assert.equal(row.error_code, "POLL_RETRY_EXHAUSTED");
    assert.match(row.error_message ?? "", /24 hours/);
    assert.equal(await reservationStatus(fixture.reservationId), "RESERVED");
  });

  test(`[${name}] a refused artifact URL fails the job with the reason, and the reservation stays held`, async () => {
    const fixture = await fixtureJob("refused-artifact");
    const { requests, router } = providerAnswering(200, {
      status: "completed",
      video: { url: "https://10.0.0.5/output.mp4" },
    });

    const result = await pollOnce(fixture, router);
    assert.equal(result.failed, 1);
    assert.equal(requests.length, 1, "the artifact URL was refused before any request");

    const row = await jobRow(fixture.jobId);
    assert.equal(row.status, "FAILED");
    assert.equal(row.error_code, "ARTIFACT_URL_REFUSED");
    assert.equal(await reservationStatus(fixture.reservationId), "RESERVED", "a render that may be billed keeps its spend held");
  });
}
