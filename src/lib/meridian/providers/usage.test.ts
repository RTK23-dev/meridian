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

async function seedConnection(
  sql: Sql,
  provider: string,
  row: { status: string; lastError?: string; lastSuccessAt?: string | null; disconnectedAt?: string | null },
): Promise<string> {
  const organizationId = `org-usage-${randomUUID()}`;
  await sql`
    insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test')
    on conflict (id) do nothing
  `;
  await sql`
    insert into provider_connections (id, organization_id, provider, status, last_error, last_success_at, disconnected_at)
    values (${randomUUID()}, ${organizationId}, ${provider}, ${row.status}, ${row.lastError ?? ""},
      ${row.lastSuccessAt ?? null}, ${row.disconnectedAt ?? null})
  `;
  return organizationId;
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
}
