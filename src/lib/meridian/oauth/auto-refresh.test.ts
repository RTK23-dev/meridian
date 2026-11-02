import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { openTestBackends } from "../../../test-support/lib/meridian/credentials/test-databases.ts";
import type { Sql } from "../learning/store.ts";
import type { Transport, TransportRequest, TransportResponse } from "../providers/http.ts";
import { renewalDue, renewStoredToken, RENEW_AHEAD_MS } from "./auto-refresh.ts";
import { openSecret, sealSecret } from "./flow.server.ts";

// No test here calls a provider: the token endpoint is a fake transport, and the database is the embedded or the test database.
const KEY = "auto-refresh-test-key";
const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

function sealed(plain: string): string {
  const value = sealSecret(plain, KEY);
  if (typeof value !== "string") throw new Error("test key did not seal");
  return value;
}

/** A transport that answers the token endpoint with one response, and records each request. */
function tokenEndpoint(response: TransportResponse) {
  const requests: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    return response;
  };
  return { transport, requests };
}

const GOOGLE_RENEWED: TransportResponse = { status: 200, body: JSON.stringify({ access_token: "renewed-google-access", expires_in: 3600 }), headers: {} };

type Row = { sealed_token: string; sealed_refresh: string; expires_at: unknown };

async function seedWorkspace(sql: Sql, provider: string, row: { expiresAt: string | null; hasRefresh: boolean }): Promise<string> {
  const organizationId = `org-renew-${randomUUID()}`;
  await sql`
    insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test')
    on conflict (id) do nothing
  `;
  await sql`
    insert into provider_secrets (id, organization_id, provider, sealed_token, sealed_refresh, expires_at)
    values (${randomUUID()}, ${organizationId}, ${provider}, ${sealed("original-access")}, ${row.hasRefresh ? sealed("stored-refresh") : ""}, ${row.expiresAt})
  `;
  await sql`
    insert into provider_connections (id, organization_id, provider, status) values (${randomUUID()}, ${organizationId}, ${provider}, 'HEALTHY')
  `;
  return organizationId;
}

async function readSecrets(sql: Sql, organizationId: string, provider: string): Promise<Row | null> {
  const rows = await sql<Row>`
    select sealed_token, sealed_refresh, expires_at from provider_secrets where organization_id = ${organizationId} and provider = ${provider}
  `;
  return rows[0] ?? null;
}

async function readStatus(sql: Sql, organizationId: string, provider: string): Promise<string | null> {
  const rows = await sql<{ status: string }>`
    select status from provider_connections where organization_id = ${organizationId} and provider = ${provider}
  `;
  return rows[0]?.status ?? null;
}

test("a token is due only within the renew-ahead window of its stated expiry", () => {
  assert.equal(renewalDue(null, NOW), false, "no stated expiry: nothing to renew");
  assert.equal(renewalDue(undefined, NOW), false);
  assert.equal(renewalDue(new Date(NOW + 60 * 60 * 1000).toISOString(), NOW), false, "an hour left is not due");
  assert.equal(renewalDue(new Date(NOW + RENEW_AHEAD_MS).toISOString(), NOW), true, "exactly the window is due");
  assert.equal(renewalDue(new Date(NOW - 1000).toISOString(), NOW), true, "a passed expiry is due");
  assert.equal(renewalDue("not a time", NOW), true, "an unreadable expiry is due, so renewal reports what happened");
  assert.equal(renewalDue(new Date(NOW + 60 * 60 * 1000), NOW), false, "a Date value is read as a time");
});

for (const backend of backends) {
  const sql = backend.sql;

  test(`[${backend.name}] a token with time left is not renewed, and no request is sent`, async () => {
    const organizationId = await seedWorkspace(sql, "google", { expiresAt: new Date(NOW + 60 * 60 * 1000).toISOString(), hasRefresh: true });
    const endpoint = tokenEndpoint(GOOGLE_RENEWED);
    const outcome = await renewStoredToken(sql, { organizationId, provider: "google", encryptionKey: KEY, env: {}, transport: endpoint.transport, now: NOW });
    assert.equal(outcome, "not_due");
    assert.equal(endpoint.requests.length, 0);
  });

  test(`[${backend.name}] a due token is renewed with its stored refresh token, and the new token is stored sealed`, async () => {
    const organizationId = await seedWorkspace(sql, "google", { expiresAt: new Date(NOW - 1000).toISOString(), hasRefresh: true });
    const endpoint = tokenEndpoint(GOOGLE_RENEWED);
    const outcome = await renewStoredToken(sql, { organizationId, provider: "google", encryptionKey: KEY, env: {}, transport: endpoint.transport, now: NOW });
    assert.equal(outcome, "renewed");
    assert.equal(endpoint.requests.length, 1);
    const body = String(endpoint.requests[0]?.body ?? "");
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /refresh_token=stored-refresh/, "the stored refresh token is what is sent");
    const row = await readSecrets(sql, organizationId, "google");
    assert.equal(openSecret(row?.sealed_token ?? "", KEY), "renewed-google-access");
    assert.equal(openSecret(row?.sealed_refresh ?? "", KEY), "stored-refresh", "Google sent no new refresh token, so the stored one is kept");
    const expiresAt = row?.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(String(row?.expires_at));
    assert.equal(expiresAt, NOW + 3600 * 1000, "the new expiry is the provider's stated lifetime from now");
    assert.equal(await readStatus(sql, organizationId, "google"), "HEALTHY", "a renewal does not change the connection status by itself");
  });

  test(`[${backend.name}] a renewal the provider refuses marks the connection FAILED and stores nothing`, async () => {
    const organizationId = await seedWorkspace(sql, "google", { expiresAt: new Date(NOW - 1000).toISOString(), hasRefresh: true });
    const before = await readSecrets(sql, organizationId, "google");
    const refused: TransportResponse = { status: 400, body: JSON.stringify({ error: "invalid_grant" }), headers: {} };
    const outcome = await renewStoredToken(sql, { organizationId, provider: "google", encryptionKey: KEY, env: {}, transport: tokenEndpoint(refused).transport, now: NOW });
    assert.equal(outcome, "refused");
    assert.deepEqual(await readSecrets(sql, organizationId, "google"), before, "the stored token is not replaced");
    assert.equal(await readStatus(sql, organizationId, "google"), "FAILED");
  });

  test(`[${backend.name}] a failure that is not a refusal changes nothing`, async () => {
    const organizationId = await seedWorkspace(sql, "google", { expiresAt: new Date(NOW - 1000).toISOString(), hasRefresh: true });
    const before = await readSecrets(sql, organizationId, "google");
    const unavailable: TransportResponse = { status: 503, body: "{}", headers: {} };
    const outcome = await renewStoredToken(sql, { organizationId, provider: "google", encryptionKey: KEY, env: {}, transport: tokenEndpoint(unavailable).transport, now: NOW });
    assert.equal(outcome, "failed");
    assert.deepEqual(await readSecrets(sql, organizationId, "google"), before);
    assert.equal(await readStatus(sql, organizationId, "google"), "HEALTHY");
  });

  test(`[${backend.name}] a disconnected connection is never renewed, and no request is sent`, async () => {
    const organizationId = await seedWorkspace(sql, "google", { expiresAt: new Date(NOW - 1000).toISOString(), hasRefresh: true });
    await sql`update provider_connections set disconnected_at = now() where organization_id = ${organizationId} and provider = 'google'`;
    const before = await readSecrets(sql, organizationId, "google");
    const endpoint = tokenEndpoint(GOOGLE_RENEWED);
    const outcome = await renewStoredToken(sql, { organizationId, provider: "google", encryptionKey: KEY, env: {}, transport: endpoint.transport, now: NOW });
    assert.equal(outcome, "not_due");
    assert.equal(endpoint.requests.length, 0);
    assert.deepEqual(await readSecrets(sql, organizationId, "google"), before);
  });

  test(`[${backend.name}] a due token with no stored refresh token is reported, not requested`, async () => {
    const organizationId = await seedWorkspace(sql, "google", { expiresAt: new Date(NOW - 1000).toISOString(), hasRefresh: false });
    const endpoint = tokenEndpoint(GOOGLE_RENEWED);
    const outcome = await renewStoredToken(sql, { organizationId, provider: "google", encryptionKey: KEY, env: {}, transport: endpoint.transport, now: NOW });
    assert.equal(outcome, "no_refresh_token");
    assert.equal(endpoint.requests.length, 0);
  });

  test(`[${backend.name}] a renewal that another request completed first is not written over`, async () => {
    const organizationId = await seedWorkspace(sql, "google", { expiresAt: new Date(NOW - 1000).toISOString(), hasRefresh: true });
    // The read of the token sees the original; before this request's write, another request stores its own renewed token.
    const racing = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(" ").toLowerCase();
      const run = (sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(strings, ...values);
      if (!text.includes("from provider_secrets")) return run;
      return run.then(async (rows) => {
        await sql`update provider_secrets set sealed_token = ${sealed("other-request-access")} where organization_id = ${organizationId} and provider = 'google'`;
        return rows;
      });
    }) as unknown as Sql;
    const outcome = await renewStoredToken(racing, {
      organizationId,
      provider: "google",
      encryptionKey: KEY,
      env: {},
      transport: tokenEndpoint(GOOGLE_RENEWED).transport,
      now: NOW,
    });
    assert.equal(outcome, "superseded");
    const row = await readSecrets(sql, organizationId, "google");
    assert.equal(openSecret(row?.sealed_token ?? "", KEY), "other-request-access", "the token another request stored is kept");
  });
}
