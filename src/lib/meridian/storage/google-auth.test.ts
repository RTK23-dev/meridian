import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { getGoogleDriveAuthStatus, createGoogleDriveAuth, type GoogleDriveAuthDeps } from "./google-auth.ts";
import type { WorkspaceRefreshTokenLookup } from "./drive-connection-store.ts";

// The precedence of Drive credentials: a workspace's own connection, then the service account, then the environment's OAuth
// refresh token, then none. Google is a stub. Nothing here touches the network or the database.

const CLIENT_ID = "client-id-test.apps.example";
const CLIENT_SECRET = "client-secret-VALUE-test";
const ENV_REFRESH = "env-refresh-VALUE-test";
const WORKSPACE_REFRESH = "workspace-refresh-VALUE-test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const SA_EMAIL = "meridian-drive@example.test";
const SA_KEY = JSON.stringify({ type: "service_account", client_email: SA_EMAIL, private_key: privateKey });

type Call = { url: string; body: URLSearchParams };

/** A stub for Google's token endpoint. Each refresh token or assertion maps to a token, or to a refusal. */
function googleStub(answer: (body: URLSearchParams) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
    return answer(new URLSearchParams(String(init?.body ?? "")));
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function okToken(token: string): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
}

function build(options: {
  env?: Record<string, string>;
  lookup?: WorkspaceRefreshTokenLookup | ((orgId: string) => WorkspaceRefreshTokenLookup);
  answer?: (body: URLSearchParams) => Response;
  now?: () => number;
}) {
  const google = googleStub(options.answer ?? ((body) => okToken(body.get("refresh_token") ? `token-for-${body.get("refresh_token")}` : "token-for-assertion")));
  const lookups: string[] = [];
  const logs: string[] = [];
  const deps: GoogleDriveAuthDeps = {
    env: () => options.env ?? {},
    fetch: google.fetch,
    now: options.now ?? (() => Date.parse("2026-10-11T12:00:00Z")),
    lookupWorkspaceRefreshToken: async (orgId) => {
      lookups.push(orgId);
      const lookup = options.lookup;
      if (typeof lookup === "function") return lookup(orgId);
      return lookup ?? { status: "none" };
    },
    log: (message) => logs.push(message),
  };
  return { auth: createGoogleDriveAuth(deps), google, lookups, logs };
}

const DEPLOYMENT = { GOOGLE_SERVICE_ACCOUNT_KEY: SA_KEY, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_REFRESH_TOKEN: ENV_REFRESH };

test("precedence 1: a workspace's own Drive connection is used first, ahead of the service account and the environment token", async () => {
  const { auth, google, lookups } = build({
    env: DEPLOYMENT,
    lookup: { status: "found", refreshToken: WORKSPACE_REFRESH },
  });
  const access = await auth.access("org-a");
  assert.equal(access.ok, true);
  if (!access.ok) return;
  assert.equal(access.source, "workspace");
  assert.equal(access.token, `token-for-${WORKSPACE_REFRESH}`);
  assert.deepEqual(lookups, ["org-a"]);
  assert.equal(google.calls.length, 1, "only the workspace's refresh is sent");
  assert.equal(google.calls[0]!.body.get("refresh_token"), WORKSPACE_REFRESH);
  assert.equal(google.calls[0]!.body.get("client_id"), CLIENT_ID);
  assert.equal(google.calls[0]!.body.get("grant_type"), "refresh_token");
});

test("precedence 2: with no workspace connection, the service account is used ahead of the environment token", async () => {
  const { auth, google } = build({ env: DEPLOYMENT, lookup: { status: "none" } });
  const access = await auth.access("org-a");
  assert.equal(access.ok, true);
  if (!access.ok) return;
  assert.equal(access.source, "service_account");
  assert.equal(google.calls.length, 1);
  assert.equal(google.calls[0]!.body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  // The assertion is a JWT signed by the service account key. Its issuer is the service account, and the key verifies it.
  const [header, claims, signature] = google.calls[0]!.body.get("assertion")!.split(".");
  assert.equal((JSON.parse(Buffer.from(claims!, "base64url").toString()) as { iss: string }).iss, SA_EMAIL);
  assert.equal((JSON.parse(Buffer.from(header!, "base64url").toString()) as { alg: string }).alg, "RS256");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${claims}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature!, "base64url")), true, "the assertion is signed by the service account key");
});

test("precedence 3: with no workspace connection and no service account, the environment OAuth refresh token is used", async () => {
  const { auth, google } = build({
    env: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_REFRESH_TOKEN: ENV_REFRESH },
    lookup: { status: "none" },
  });
  const access = await auth.access("org-a");
  assert.equal(access.ok, true);
  if (!access.ok) return;
  assert.equal(access.source, "oauth_refresh");
  assert.equal(google.calls[0]!.body.get("refresh_token"), ENV_REFRESH);
});

test("a workspace whose connection cannot be opened fails closed: no other credential is used, and nothing is sent to Google", async () => {
  const { auth, google } = build({
    env: DEPLOYMENT,
    lookup: { status: "unreadable", reason: "The stored Drive connection could not be opened." },
  });
  const access = await auth.access("org-a");
  assert.equal(access.ok, false);
  if (access.ok) return;
  assert.equal(access.source, "failed");
  assert.match(access.reason, /could not be opened/);
  assert.match(access.reason, /Nothing was written to another account/);
  assert.equal(google.calls.length, 0, "the service account and the environment token are not tried");
});

test("a workspace connection with no OAuth client configured fails closed, and names the missing setting", async () => {
  const { auth, google } = build({
    env: { GOOGLE_SERVICE_ACCOUNT_KEY: SA_KEY, GOOGLE_REFRESH_TOKEN: ENV_REFRESH },
    lookup: { status: "found", refreshToken: WORKSPACE_REFRESH },
  });
  const access = await auth.access("org-a");
  assert.equal(access.ok, false);
  if (access.ok) return;
  assert.equal(access.source, "failed");
  assert.match(access.reason, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
  assert.equal(google.calls.length, 0);
});

test("a refused workspace refresh fails closed, and its failure never carries the token", async () => {
  const { auth, logs } = build({
    env: DEPLOYMENT,
    lookup: { status: "found", refreshToken: WORKSPACE_REFRESH },
    answer: () => new Response(`{"error":"invalid_grant","error_description":"Token has been expired or revoked ${WORKSPACE_REFRESH}"}`, { status: 400 }),
  });
  const access = await auth.access("org-a");
  assert.equal(access.ok, false);
  if (access.ok) return;
  assert.equal(access.source, "failed");
  assert.match(access.reason, /HTTP 400 \(invalid_grant\)/);
  assert.equal(JSON.stringify(access).includes(WORKSPACE_REFRESH), false, "the failure does not echo the refresh token");
  assert.equal(logs.join("\n").includes(WORKSPACE_REFRESH), false, "the log does not either");
});

test("none: not connected, with the names of what is missing", async () => {
  const { auth, google } = build({ env: {}, lookup: { status: "none" } });
  const access = await auth.access("org-a");
  assert.equal(access.ok, false);
  if (access.ok) return;
  assert.equal(access.source, "none");
  assert.deepEqual(access.missing, ["GOOGLE_SERVICE_ACCOUNT_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]);
  assert.match(access.reason, /not connected/);
  for (const name of access.missing) assert.ok(access.reason.includes(name), `the reason names ${name}`);
  assert.equal(google.calls.length, 0);
});

test("none with a partial OAuth setup names only the settings still missing", async () => {
  const { auth } = build({ env: { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET }, lookup: { status: "none" } });
  const access = await auth.access();
  assert.equal(access.ok, false);
  if (access.ok) return;
  assert.deepEqual(access.missing, ["GOOGLE_SERVICE_ACCOUNT_KEY", "GOOGLE_REFRESH_TOKEN"]);
});

test("a call that names no workspace never looks up a workspace connection", async () => {
  const { auth, lookups } = build({ env: DEPLOYMENT, lookup: { status: "found", refreshToken: WORKSPACE_REFRESH } });
  const access = await auth.access();
  assert.equal(access.ok && access.source, "service_account");
  assert.deepEqual(lookups, []);
});

test("workspace tokens are kept per workspace, and an invalidated workspace token is minted again", async () => {
  const connections: Record<string, string> = { "org-a": "refresh-A", "org-b": "refresh-B" };
  const { auth, google } = build({
    env: DEPLOYMENT,
    lookup: (orgId) => (connections[orgId] ? { status: "found", refreshToken: connections[orgId]! } : { status: "none" }),
  });
  const a = await auth.access("org-a");
  const b = await auth.access("org-b");
  assert.equal(a.ok && a.token, "token-for-refresh-A");
  assert.equal(b.ok && b.token, "token-for-refresh-B");
  await auth.access("org-a");
  assert.equal(google.calls.length, 2, "a cached workspace token is reused");
  auth.invalidate("org-a");
  connections["org-a"] = "refresh-A2";
  const again = await auth.access("org-a");
  assert.equal(again.ok && again.token, "token-for-refresh-A2");
  assert.equal(google.calls.length, 3);
});

test("a service account key that cannot be read fails without echoing the key", async () => {
  const brokenKey = '{"client_email": "x@example.test", "private_key": "KEY-VALUE-SHOULD-NOT-LEAK"';
  const { auth, google, logs } = build({ env: { GOOGLE_SERVICE_ACCOUNT_KEY: brokenKey }, lookup: { status: "none" } });
  const access = await auth.access();
  assert.equal(access.ok, false);
  if (access.ok) return;
  assert.equal(access.source, "failed");
  assert.equal(JSON.stringify(access).includes("KEY-VALUE-SHOULD-NOT-LEAK"), false);
  assert.equal(logs.join("\n").includes("KEY-VALUE-SHOULD-NOT-LEAK"), false);
  assert.equal(google.calls.length, 0);
});

test("the deployment status names what is missing, and never a value", () => {
  assert.deepEqual(getGoogleDriveAuthStatus({}).missing, ["GOOGLE_SERVICE_ACCOUNT_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]);
  assert.deepEqual(getGoogleDriveAuthStatus({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_REFRESH_TOKEN: ENV_REFRESH }).missing, []);
  const status = getGoogleDriveAuthStatus({ GOOGLE_CLIENT_ID: CLIENT_ID });
  assert.equal(status.configured, false);
  assert.equal(JSON.stringify(status).includes(CLIENT_ID), false);
});
