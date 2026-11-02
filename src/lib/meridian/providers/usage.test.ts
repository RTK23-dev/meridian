import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { openTestBackends } from "../../../test-support/lib/meridian/credentials/test-databases.ts";
import type { Sql } from "../learning/store.ts";
import type { Transport, TransportResponse } from "./http.ts";
import { phaseForStoredConnection } from "./live.ts";
import { anyStageConfirmed, isRefusal, isRefusalStatus, observeProviderUse, recordProviderUse } from "./usage.ts";

// No test here calls a provider: every response is a stub from a fake transport, and the database is the embedded or the test database.
const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

const OK: TransportResponse = { status: 200, body: "{}", headers: {} };

function responseWith(status: number): Transport {
  return async () => ({ status, body: "{}", headers: {} });
}

type Row = { status: string; last_error: string; last_success_at: unknown };

type SeedRow = { status: string; lastError?: string; lastSuccessAt?: string | null; disconnectedAt?: string | null };

async function addConnection(sql: Sql, organizationId: string, provider: string, row: SeedRow): Promise<void> {
  await sql`
    insert into provider_connections (id, organization_id, provider, status, last_error, last_success_at, disconnected_at)
    values (${randomUUID()}, ${organizationId}, ${provider}, ${row.status}, ${row.lastError ?? ""},
      ${row.lastSuccessAt ?? null}, ${row.disconnectedAt ?? null})
  `;
}

async function seedConnection(sql: Sql, provider: string, row: SeedRow): Promise<string> {
  const organizationId = `org-usage-${randomUUID()}`;
  await sql`
    insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test')
    on conflict (id) do nothing
  `;
  await addConnection(sql, organizationId, provider, row);
  return organizationId;
}

/** One performance schedule for a provider, as the performance screen creates it: id perf:<org>:<brand>:<provider>. */
async function seedSchedule(sql: Sql, organizationId: string, provider: string, enabled: boolean): Promise<void> {
  await sql`
    insert into job_schedules (id, organization_id, brand_id, job_type, every_seconds, next_run, enabled)
    values (${`perf:${organizationId}:brand-a:${provider}`}, ${organizationId}, null, 'performance.sync', 3600, now(), ${enabled})
  `;
}

async function scheduleEnabled(sql: Sql, organizationId: string, provider: string): Promise<boolean | null> {
  const rows = await sql<{ enabled: boolean }>`
    select enabled from job_schedules where id = ${`perf:${organizationId}:brand-a:${provider}`}
  `;
  return rows[0]?.enabled ?? null;
}

async function readRow(sql: Sql, organizationId: string, provider: string): Promise<Row | null> {
  const rows = await sql<Row>`
    select status, last_error, last_success_at from provider_connections
    where organization_id = ${organizationId} and provider = ${provider}
  `;
  return rows[0] ?? null;
}

test("a publish counts as accepted only when a stage was stored with the id the provider returned", () => {
  assert.equal(anyStageConfirmed([]), false);
  assert.equal(anyStageConfirmed([{ status: "failed", externalId: null }]), false);
  assert.equal(anyStageConfirmed([{ status: "stored", externalId: null }]), false, "a stored status without an id is not confirmed");
  assert.equal(anyStageConfirmed([{ status: "stored", externalId: "" }]), false, "an empty id is not confirmed");
  assert.equal(anyStageConfirmed([{ status: "failed", externalId: "x" }]), false, "an id on a failed stage is not confirmed");
  assert.equal(anyStageConfirmed([{ status: "failed", externalId: null }, { status: "stored", externalId: "123" }]), true);
});

test("the refusal statuses are exactly 401 and 403", () => {
  for (const status of [401, 403]) assert.equal(isRefusalStatus(status), true);
  for (const status of [200, 201, 400, 404, 429, 500, 503]) assert.equal(isRefusalStatus(status), false);
});

test("the observer passes every response through unchanged and keeps the first refusal", async () => {
  const seen: number[] = [];
  const inner: Transport = async () => {
    const next = seen.length === 0 ? 200 : seen.length === 1 ? 403 : 401;
    seen.push(next);
    return { status: next, body: `body-${next}`, headers: { h: "1" } };
  };
  const observed = observeProviderUse(inner, "meta");
  assert.equal(observed.refusedStatus(), null);
  const first = await observed.transport({ method: "GET", url: "https://example.test/a", headers: {} });
  assert.deepEqual(first, { status: 200, body: "body-200", headers: { h: "1" } });
  assert.equal(observed.refusedStatus(), null, "a 200 is not a refusal");
  const second = await observed.transport({ method: "GET", url: "https://example.test/b", headers: {} });
  assert.equal(second.status, 403);
  assert.equal(observed.refusedStatus(), 403);
  await observed.transport({ method: "GET", url: "https://example.test/c", headers: {} });
  assert.equal(observed.refusedStatus(), 403, "the first refusal is kept, not replaced by a later one");
});

test("the observer ignores non-refusal failures and records nothing for them", async () => {
  for (const status of [400, 404, 429, 500]) {
    const observed = observeProviderUse(responseWith(status), "meta");
    await observed.transport({ method: "GET", url: "https://example.test", headers: {} });
    assert.equal(observed.refusedStatus(), null, `${status} is not a refusal`);
  }
  assert.deepEqual(await observeProviderUse(responseWith(200), "meta").transport({ method: "GET", url: "x", headers: {} }), OK);
});

test("Meta sends an invalid or expired token as HTTP 400 with code 190, and that is a refusal", async () => {
  const invalidToken = JSON.stringify({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } });
  const response: TransportResponse = { status: 400, body: invalidToken, headers: {} };
  assert.equal(isRefusal("meta", response), true);
  const observed = observeProviderUse(async () => response, "meta");
  await observed.transport({ method: "GET", url: "https://example.test", headers: {} });
  assert.equal(observed.refusedStatus(), 400, "the recorded status is the one Meta sent");
});

test("a Meta error that is not a token problem is not a refusal, even when its type is OAuthException", () => {
  const notAToken = JSON.stringify({ error: { message: "trial_params is not allowed for this account", type: "OAuthException", code: 100 } });
  assert.equal(isRefusal("meta", { status: 400, body: notAToken, headers: {} }), false);
  assert.equal(isRefusal("meta", { status: 400, body: "not json", headers: {} }), false);
  assert.equal(isRefusal("meta", { status: 200, body: "{}", headers: {} }), false);
});

test("TikTok's token codes in a 200 body are refusals; its success code and the codes the SDK does not name as credential refusals are not", () => {
  const tiktok = (code: number) => ({ status: 200, body: JSON.stringify({ code, message: "stub" }), headers: {} });
  for (const code of [40102, 40103, 40105, 40107]) assert.equal(isRefusal("tiktok", tiktok(code)), true, `TikTok ${code}`);
  assert.equal(isRefusal("tiktok", tiktok(0)), false, "code 0 is success");
  assert.equal(isRefusal("tiktok", tiktok(40104)), false, "an empty token is not a refused credential");
  assert.equal(isRefusal("tiktok", tiktok(40114)), false, "logout is not named by the SDK");
  assert.equal(isRefusal("meta", tiktok(40105)), false, "TikTok's codes mean nothing to Meta");
});

test("an OAuth invalid_grant is a refusal from any provider, because the refresh token itself was revoked or expired", () => {
  const revoked = JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." });
  assert.equal(isRefusal("google", { status: 400, body: revoked, headers: {} }), true);
  assert.equal(isRefusal("tiktok", { status: 400, body: revoked, headers: {} }), true);
  assert.equal(isRefusal("google", { status: 400, body: JSON.stringify({ error: "invalid_request" }), headers: {} }), false);
});

test("the code 190 rule applies to Meta only, and a body code from another provider is not read as a refusal", () => {
  const body = JSON.stringify({ error: { code: 190 } });
  assert.equal(isRefusal("tiktok", { status: 400, body, headers: {} }), false);
  assert.equal(isRefusal("google", { status: 400, body, headers: {} }), false);
  assert.equal(isRefusal("tiktok", { status: 401, body, headers: {} }), true, "HTTP 401 is a refusal from any provider");
});

for (const backend of backends) {
  const sql = backend.sql;

  test(`[${backend.name}] an accepted request refreshes the success and clears the earlier error`, async () => {
    const organizationId = await seedConnection(sql, "meta", { status: "FAILED", lastError: "old refusal" });
    const outcome = await recordProviderUse(sql, { organizationId, provider: "meta", refusedStatus: null, succeeded: true });
    assert.equal(outcome, "succeeded");
    const row = await readRow(sql, organizationId, "meta");
    assert.equal(row?.status, "HEALTHY");
    assert.equal(row?.last_error, "");
    assert.notEqual(row?.last_success_at, null);
  });

  test(`[${backend.name}] a refused request marks the connection FAILED with its status, and keeps the earlier success on record`, async () => {
    const earlier = "2026-10-30T10:00:00.000Z";
    const organizationId = await seedConnection(sql, "meta", { status: "HEALTHY", lastSuccessAt: earlier });
    const outcome = await recordProviderUse(sql, { organizationId, provider: "meta", refusedStatus: 403, succeeded: false });
    assert.equal(outcome, "refused");
    const row = await readRow(sql, organizationId, "meta");
    assert.equal(row?.status, "FAILED");
    assert.match(row?.last_error ?? "", /Meta refused the request \(HTTP 403\)/);
    assert.notEqual(row?.last_success_at, null, "the earlier success stays on record");
  });

  test(`[${backend.name}] a refusal wins over a success in the same operation`, async () => {
    const organizationId = await seedConnection(sql, "tiktok", { status: "HEALTHY" });
    const outcome = await recordProviderUse(sql, { organizationId, provider: "tiktok", refusedStatus: 401, succeeded: true });
    assert.equal(outcome, "refused");
    assert.equal((await readRow(sql, organizationId, "tiktok"))?.status, "FAILED");
  });

  test(`[${backend.name}] a failure that is not a refusal changes nothing`, async () => {
    const organizationId = await seedConnection(sql, "google", { status: "HEALTHY", lastSuccessAt: "2026-11-01T00:00:00.000Z" });
    const before = await readRow(sql, organizationId, "google");
    const outcome = await recordProviderUse(sql, { organizationId, provider: "google", refusedStatus: null, succeeded: false });
    assert.equal(outcome, "unchanged");
    assert.deepEqual(await readRow(sql, organizationId, "google"), before);
  });

  test(`[${backend.name}] a disconnected connection is never written`, async () => {
    const organizationId = await seedConnection(sql, "meta", { status: "DISCONNECTED", disconnectedAt: "2026-11-01T00:00:00.000Z" });
    const before = await readRow(sql, organizationId, "meta");
    await recordProviderUse(sql, { organizationId, provider: "meta", refusedStatus: 403, succeeded: false });
    assert.deepEqual(await readRow(sql, organizationId, "meta"), before);
    await recordProviderUse(sql, { organizationId, provider: "meta", refusedStatus: null, succeeded: true });
    assert.deepEqual(await readRow(sql, organizationId, "meta"), before);
  });

  test(`[${backend.name}] a workspace with no connection row gets no row created`, async () => {
    const organizationId = await seedConnection(sql, "meta", { status: "HEALTHY" });
    await recordProviderUse(sql, { organizationId, provider: "tiktok", refusedStatus: null, succeeded: true });
    assert.equal(await readRow(sql, organizationId, "tiktok"), null);
  });

  test(`[${backend.name}] the status a later read shows follows the recorded use: HEALTHY after a success, FAILED after a refusal`, async () => {
    const organizationId = await seedConnection(sql, "meta", { status: "FAILED", lastError: "earlier refusal" });
    const usable = { state: "usable" as const, reason: "The stored access token can be opened." };
    const phaseOf = async () => {
      const row = await readRow(sql, organizationId, "meta");
      return phaseForStoredConnection({
        provider: "meta",
        credential: usable,
        lastSuccessAt: row?.last_success_at,
        lastError: row?.last_error ?? "",
        disconnected: false,
      }).phase;
    };
    await recordProviderUse(sql, { organizationId, provider: "meta", refusedStatus: null, succeeded: true });
    assert.equal(await phaseOf(), "HEALTHY");
    await recordProviderUse(sql, { organizationId, provider: "meta", refusedStatus: 401, succeeded: false });
    assert.equal(await phaseOf(), "FAILED");
  });

  test(`[${backend.name}] a refusal stops only that provider's performance schedule, and an accepted request starts it again`, async () => {
    const organizationId = await seedConnection(sql, "meta", { status: "HEALTHY" });
    await addConnection(sql, organizationId, "tiktok", { status: "HEALTHY" });
    await seedSchedule(sql, organizationId, "meta", true);
    await seedSchedule(sql, organizationId, "tiktok", true);
    await recordProviderUse(sql, { organizationId, provider: "meta", refusedStatus: 403, succeeded: false });
    assert.equal(await scheduleEnabled(sql, organizationId, "meta"), false);
    assert.equal(await scheduleEnabled(sql, organizationId, "tiktok"), true, "another provider's schedule is not touched");
    await recordProviderUse(sql, { organizationId, provider: "meta", refusedStatus: null, succeeded: true });
    assert.equal(await scheduleEnabled(sql, organizationId, "meta"), true);
  });

  test(`[${backend.name}] a disconnected provider's schedules are not changed by a later use`, async () => {
    const organizationId = await seedConnection(sql, "meta", { status: "DISCONNECTED", disconnectedAt: "2026-11-01T00:00:00.000Z" });
    await seedSchedule(sql, organizationId, "meta", false);
    await recordProviderUse(sql, { organizationId, provider: "meta", refusedStatus: null, succeeded: true });
    assert.equal(await scheduleEnabled(sql, organizationId, "meta"), false);
  });
}
