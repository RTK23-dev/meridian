import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql, type Sql } from "../../db.ts";
import { DRIVE_FILE_SCOPE, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL } from "./drive-oauth-config.ts";
import { lookupWorkspaceRefreshToken, readDriveConnectionMeta } from "./drive-connection-store.ts";
import {
  buildDriveAuthorizationUrl,
  disconnectDriveWorkspace,
  driveCallbackUrl,
  finishDriveConnect,
  hashDriveOauthState,
  startDriveConnect,
} from "./drive-oauth.ts";

// The Drive connection flow, against the real database. Google is a stub: the token endpoint and the revocation endpoint.

const MASTER_KEY = "drive-oauth-test-master-key-with-sufficient-length";
const ORIGIN = "https://meridian.example.test";
const CLIENT_ENV = { GOOGLE_CLIENT_ID: "client-id-test.apps.example", GOOGLE_CLIENT_SECRET: "client-secret-VALUE-oauth-test" };

type Workspace = { orgId: string; adminId: string; memberId: string; outsiderId: string };

async function seedWorkspace(sql: Sql): Promise<Workspace> {
  const run = randomUUID();
  const t: Workspace = { orgId: `org-${run}`, adminId: `admin-${run}`, memberId: `member-${run}`, outsiderId: `outsider-${run}` };
  for (const id of [t.adminId, t.memberId, t.outsiderId]) {
    await sql`insert into "user" (id, name, email, "emailVerified") values (${id}, 'Person', ${`${id}@example.test`}, true)`;
  }
  await sql`insert into organizations (id, name, slug, created_by) values (${t.orgId}, 'Org', ${`s-${run}`}, ${t.adminId})`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`m-${randomUUID()}`}, ${t.orgId}, ${t.adminId}, 'admin')`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`m-${randomUUID()}`}, ${t.orgId}, ${t.memberId}, 'member')`;
  return t;
}

type Sent = { url: string; body: URLSearchParams };

/** Google's token and revocation endpoints. The handlers decide each answer. */
function googleStub(handlers: { token?: (body: URLSearchParams) => Response; revoke?: (body: URLSearchParams) => Response }) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ""));
    sent.push({ url, body });
    if (url === GOOGLE_TOKEN_URL) return (handlers.token ?? (() => new Response("{}", { status: 500 })))(body);
    if (url === GOOGLE_REVOKE_URL) return (handlers.revoke ?? (() => new Response("", { status: 200 })))(body);
    return new Response("unexpected", { status: 599 });
  }) as typeof fetch;
  return { sent, fetch: fetchImpl };
}

const grant = (refreshToken: string | null) => (): Response =>
  new Response(JSON.stringify({ access_token: "access-VALUE-not-stored", expires_in: 3600, ...(refreshToken ? { refresh_token: refreshToken } : {}) }), { status: 200 });

/** Starts a connection as the admin and returns the state Google would send back. */
async function startAs(sql: Sql, workspace: Workspace, userId: string, now = Date.now(), newState?: string) {
  const started = await startDriveConnect(sql, {
    organizationId: workspace.orgId,
    userId,
    origin: ORIGIN,
    env: CLIENT_ENV,
    now,
    newState: newState ? () => newState : undefined,
  });
  if (!started.ok) return { started, state: "" };
  const state = new URL(started.url).searchParams.get("state") ?? "";
  return { started, state };
}

test("the consent URL asks for drive.file only, with offline access and consent, and carries the state", () => {
  const url = new URL(buildDriveAuthorizationUrl({ clientId: "client-x", redirectUri: `${ORIGIN}/api/drive/callback`, state: "state-VALUE" }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("scope"), DRIVE_FILE_SCOPE);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-VALUE");
  assert.equal(url.searchParams.get("redirect_uri"), `${ORIGIN}/api/drive/callback`);
  assert.equal(url.searchParams.get("client_id"), "client-x");
  assert.equal(url.searchParams.get("scope")?.includes("auth/drive "), false, "not the full Drive scope");
  assert.equal(driveCallbackUrl(`${ORIGIN}/`), `${ORIGIN}/api/drive/callback`);
});

test("starting a connection is refused to a member, and records nothing", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const result = await startDriveConnect(sql, { organizationId: workspace.orgId, userId: workspace.memberId, origin: ORIGIN, env: CLIENT_ENV, now: Date.now() });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 403);
  assert.match(result.message, /Only an admin/);
  const rows = await sql<{ n: number }>`select count(*)::int as n from drive_oauth_states where organization_id = ${workspace.orgId}`;
  assert.equal(Number(rows[0]!.n), 0);
});

test("starting a connection needs the OAuth client, and names what is missing", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const result = await startDriveConnect(sql, { organizationId: workspace.orgId, userId: workspace.adminId, origin: ORIGIN, env: { GOOGLE_CLIENT_ID: "only-id" }, now: Date.now() });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.match(result.message, /GOOGLE_CLIENT_SECRET/);
  assert.equal(result.message.includes("only-id"), false, "the message names the setting, not its value");
});

test("an admin's connection records a hashed, expiring state bound to that admin and workspace", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const now = Date.now();
  const { started, state } = await startAs(sql, workspace, workspace.adminId, now, "state-plain-VALUE-admin-1");
  assert.equal(started.ok, true);
  assert.equal(state, "state-plain-VALUE-admin-1");
  const rows = await sql<{ state_hash: string; user_id: string; organization_id: string; expires_at: unknown }>`
    select state_hash, user_id, organization_id, expires_at from drive_oauth_states where state_hash = ${hashDriveOauthState(state)}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.user_id, workspace.adminId);
  assert.equal(rows[0]!.organization_id, workspace.orgId);
  assert.equal(JSON.stringify(rows[0]).includes("state-plain-VALUE-admin-1"), false, "the database holds the hash, not the state");
  const expiresIn = Date.parse(String(rows[0]!.expires_at)) - now;
  assert.ok(expiresIn > 9 * 60 * 1000 && expiresIn <= 10 * 60 * 1000 + 5000, "the state expires in about ten minutes");
});

test("a completed connection stores the refresh token encrypted for that workspace, and the token is never shown", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const { state } = await startAs(sql, workspace, workspace.adminId);
  const google = googleStub({ token: grant("refresh-VALUE-connected-1") });
  const finished = await finishDriveConnect(sql, {
    state,
    code: "auth-code-VALUE-1",
    userId: workspace.adminId,
    origin: ORIGIN,
    env: CLIENT_ENV,
    masterKey: MASTER_KEY,
    fetch: google.fetch,
  });
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  assert.equal(finished.organizationId, workspace.orgId);

  // The exchange was made with the code, this client, and the callback address the consent request named.
  assert.equal(google.sent.length, 1);
  assert.equal(google.sent[0]!.body.get("grant_type"), "authorization_code");
  assert.equal(google.sent[0]!.body.get("code"), "auth-code-VALUE-1");
  assert.equal(google.sent[0]!.body.get("redirect_uri"), `${ORIGIN}/api/drive/callback`);

  const vault = await sql<{ ciphertext: string; credential_type: string }>`
    select ciphertext, credential_type from credential_vault where organization_id = ${workspace.orgId} and credential_type = 'storage:google_drive'`;
  assert.equal(vault.length, 1);
  assert.equal(vault[0]!.ciphertext.includes("refresh-VALUE"), false, "the stored value is encrypted");
  const looked = await lookupWorkspaceRefreshToken(sql, workspace.orgId, MASTER_KEY);
  assert.deepEqual(looked, { status: "found", refreshToken: "refresh-VALUE-connected-1" });
  const meta = await readDriveConnectionMeta(sql, workspace.orgId);
  assert.equal(meta.connected, true);
  assert.equal(JSON.stringify(meta).includes("refresh-VALUE"), false, "the status a page reads holds no token");

  const used = await sql<{ used_at: unknown }>`select used_at from drive_oauth_states where state_hash = ${hashDriveOauthState(state)}`;
  assert.ok(used[0]?.used_at, "the state is marked used");
});

test("a state finishes once: a repeated callback is refused without a second exchange", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const { state } = await startAs(sql, workspace, workspace.adminId);
  const google = googleStub({ token: grant("refresh-VALUE-once") });
  const input = { state, code: "code-once", userId: workspace.adminId, origin: ORIGIN, env: CLIENT_ENV, masterKey: MASTER_KEY, fetch: google.fetch };
  assert.equal((await finishDriveConnect(sql, input)).ok, true);
  const again = await finishDriveConnect(sql, input);
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.status, 400);
  assert.equal(google.sent.length, 1, "Google was asked once");
});

test("a state finishes only for the person who started it, and a refused attempt does not use the state up", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const { state } = await startAs(sql, workspace, workspace.adminId);
  const google = googleStub({ token: grant("refresh-VALUE-owner") });
  const base = { state, code: "code-owner", origin: ORIGIN, env: CLIENT_ENV, masterKey: MASTER_KEY, fetch: google.fetch };
  const other = await finishDriveConnect(sql, { ...base, userId: workspace.outsiderId });
  assert.equal(other.ok, false);
  if (other.ok) return;
  assert.equal(other.status, 403);
  assert.equal(google.sent.length, 0);
  assert.equal((await finishDriveConnect(sql, { ...base, userId: workspace.adminId })).ok, true, "the person who started it can still finish");
});

test("an expired state is refused", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const { state } = await startAs(sql, workspace, workspace.adminId);
  await sql`update drive_oauth_states set expires_at = now() - interval '1 minute' where state_hash = ${hashDriveOauthState(state)}`;
  const google = googleStub({ token: grant("refresh-VALUE-late") });
  const result = await finishDriveConnect(sql, { state, code: "code-late", userId: workspace.adminId, origin: ORIGIN, env: CLIENT_ENV, masterKey: MASTER_KEY, fetch: google.fetch });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
  assert.equal(google.sent.length, 0);
});

test("a person who was demoted before the callback cannot finish the connection", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const { state } = await startAs(sql, workspace, workspace.adminId);
  await sql`update memberships set role = 'member' where organization_id = ${workspace.orgId} and user_id = ${workspace.adminId}`;
  const google = googleStub({ token: grant("refresh-VALUE-demoted") });
  const result = await finishDriveConnect(sql, { state, code: "code-demoted", userId: workspace.adminId, origin: ORIGIN, env: CLIENT_ENV, masterKey: MASTER_KEY, fetch: google.fetch });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 403);
  assert.equal(google.sent.length, 0);
});

test("when Google returns no refresh token, nothing is connected, and the message holds no code or secret", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const { state } = await startAs(sql, workspace, workspace.adminId);
  const google = googleStub({ token: grant(null) });
  const result = await finishDriveConnect(sql, { state, code: "code-no-refresh", userId: workspace.adminId, origin: ORIGIN, env: CLIENT_ENV, masterKey: MASTER_KEY, fetch: google.fetch });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 502);
  assert.equal(result.message.includes("code-no-refresh") || result.message.includes(CLIENT_ENV.GOOGLE_CLIENT_SECRET), false);
  assert.equal((await readDriveConnectionMeta(sql, workspace.orgId)).connected, false);
});

test("a refused exchange reports Google's short error code, never the code, the secret, or the body", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const { state } = await startAs(sql, workspace, workspace.adminId);
  const google = googleStub({
    token: () => new Response('{"error":"invalid_grant","error_description":"auth-code-VALUE-refused client-secret-VALUE-oauth-test"}', { status: 400 }),
  });
  const result = await finishDriveConnect(sql, { state, code: "auth-code-VALUE-refused", userId: workspace.adminId, origin: ORIGIN, env: CLIENT_ENV, masterKey: MASTER_KEY, fetch: google.fetch });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 502);
  assert.match(result.message, /HTTP 400 \(invalid_grant\)/);
  assert.equal(result.message.includes("auth-code-VALUE"), false);
  assert.equal(result.message.includes("client-secret-VALUE"), false);
});

test("without TOKEN_ENCRYPTION_KEY the callback stops before it uses the state, so the state still works once the key is set", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const { state } = await startAs(sql, workspace, workspace.adminId);
  const google = googleStub({ token: grant("refresh-VALUE-keyed") });
  const noKey = await finishDriveConnect(sql, { state, code: "code-keyless", userId: workspace.adminId, origin: ORIGIN, env: CLIENT_ENV, masterKey: "", fetch: google.fetch });
  assert.equal(noKey.ok, false);
  if (noKey.ok) return;
  assert.equal(noKey.status, 500);
  assert.equal(google.sent.length, 0);
  assert.equal((await finishDriveConnect(sql, { state, code: "code-keyed", userId: workspace.adminId, origin: ORIGIN, env: CLIENT_ENV, masterKey: MASTER_KEY, fetch: google.fetch })).ok, true);
});

test("reconnecting replaces the stored token: one row per workspace, holding the new token", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  for (const token of ["refresh-VALUE-first", "refresh-VALUE-second"]) {
    const { state } = await startAs(sql, workspace, workspace.adminId);
    const google = googleStub({ token: grant(token) });
    assert.equal((await finishDriveConnect(sql, { state, code: `code-${token}`, userId: workspace.adminId, origin: ORIGIN, env: CLIENT_ENV, masterKey: MASTER_KEY, fetch: google.fetch })).ok, true);
  }
  const rows = await sql<{ n: number }>`select count(*)::int as n from credential_vault where organization_id = ${workspace.orgId} and credential_type = 'storage:google_drive'`;
  assert.equal(Number(rows[0]!.n), 1);
  assert.deepEqual(await lookupWorkspaceRefreshToken(sql, workspace.orgId, MASTER_KEY), { status: "found", refreshToken: "refresh-VALUE-second" });
});

test("disconnecting removes the stored token, asks Google to revoke it, and reports the revocation", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const { state } = await startAs(sql, workspace, workspace.adminId);
  await finishDriveConnect(sql, { state, code: "code-disc", userId: workspace.adminId, origin: ORIGIN, env: CLIENT_ENV, masterKey: MASTER_KEY, fetch: googleStub({ token: grant("refresh-VALUE-disc") }).fetch });

  let invalidated = 0;
  const google = googleStub({ revoke: () => new Response("", { status: 200 }) });
  const result = await disconnectDriveWorkspace(sql, { organizationId: workspace.orgId, userId: workspace.adminId, masterKey: MASTER_KEY, fetch: google.fetch, invalidate: () => invalidated++ });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "disconnected");
  assert.equal(result.revocation, "revoked");
  assert.equal(invalidated, 1);
  assert.equal(google.sent.length, 1);
  assert.equal(google.sent[0]!.url, GOOGLE_REVOKE_URL);
  assert.equal(google.sent[0]!.body.get("token"), "refresh-VALUE-disc");
  assert.equal(JSON.stringify(result).includes("refresh-VALUE-disc"), false, "the result holds no token");
  assert.equal((await readDriveConnectionMeta(sql, workspace.orgId)).connected, false);
  assert.deepEqual(await lookupWorkspaceRefreshToken(sql, workspace.orgId, MASTER_KEY), { status: "none" });
});

test("when Google does not confirm the revocation, the local token is still removed, and the result says so", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const { state } = await startAs(sql, workspace, workspace.adminId);
  await finishDriveConnect(sql, { state, code: "code-fail", userId: workspace.adminId, origin: ORIGIN, env: CLIENT_ENV, masterKey: MASTER_KEY, fetch: googleStub({ token: grant("refresh-VALUE-fail") }).fetch });

  const google = googleStub({ revoke: () => new Response('{"error":"invalid_token"}', { status: 400 }) });
  const result = await disconnectDriveWorkspace(sql, { organizationId: workspace.orgId, userId: workspace.adminId, masterKey: MASTER_KEY, fetch: google.fetch, invalidate: () => {} });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "disconnected");
  assert.equal(result.revocation, "revocation_failed");
  assert.match(result.detail, /did not confirm the revocation \(HTTP 400\)/);
  assert.match(result.detail, /connected apps/);
  assert.equal(JSON.stringify(result).includes("refresh-VALUE-fail"), false);
  assert.equal((await readDriveConnectionMeta(sql, workspace.orgId)).connected, false, "the token is not kept");
});

test("disconnecting with no connection says so, and asks Google for nothing", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const google = googleStub({});
  const result = await disconnectDriveWorkspace(sql, { organizationId: workspace.orgId, userId: workspace.adminId, masterKey: MASTER_KEY, fetch: google.fetch, invalidate: () => {} });
  assert.equal(result.ok && result.status, "not_connected");
  assert.equal(google.sent.length, 0);
});

test("a member cannot disconnect, and the connection stays", async () => {
  const sql = await getSql();
  const workspace = await seedWorkspace(sql);
  const { state } = await startAs(sql, workspace, workspace.adminId);
  await finishDriveConnect(sql, { state, code: "code-keep", userId: workspace.adminId, origin: ORIGIN, env: CLIENT_ENV, masterKey: MASTER_KEY, fetch: googleStub({ token: grant("refresh-VALUE-keep") }).fetch });
  const google = googleStub({});
  const result = await disconnectDriveWorkspace(sql, { organizationId: workspace.orgId, userId: workspace.memberId, masterKey: MASTER_KEY, fetch: google.fetch, invalidate: () => {} });
  assert.equal(result.ok, false);
  assert.equal(google.sent.length, 0);
  assert.equal((await readDriveConnectionMeta(sql, workspace.orgId)).connected, true);
});
