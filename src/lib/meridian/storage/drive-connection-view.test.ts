import assert from "node:assert/strict";
import test from "node:test";
import { getGoogleDriveAuthStatus } from "./google-auth.ts";
import { OAUTH_SIGN_IN_NOTE, driveConnectionView } from "./drive-connection-view.ts";

const SECRET = "client-secret-VALUE-9f3a";
const REFRESH = "refresh-token-VALUE-7c1d";
const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----MIIE-VALUE-2b8e";
const KEY_JSON = JSON.stringify({ type: "service_account", client_email: "svc@example.test", private_key: PRIVATE_KEY });
const CLIENT = { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: SECRET };
const NOT_CONNECTED = { connected: false, connectedAt: null };

test("with no Drive credentials the panel is not connected, names what is missing, and offers the connect and setup steps", () => {
  const view = driveConnectionView({});
  assert.equal(view.state, "not_connected");
  assert.equal(view.method, "none");
  assert.match(view.detail, /not connected/i);
  assert.ok(view.missing.some((item) => item.includes("GOOGLE_SERVICE_ACCOUNT_KEY")));
  assert.ok(view.missing.includes("MERIDIAN_DRIVE_FOLDER_ID"));
  assert.ok(view.steps.some((step) => step.includes("GOOGLE_SERVICE_ACCOUNT_KEY")));
  assert.ok(view.steps.some((step) => step.includes("/api/drive/callback")), "the redirect address is named");
  assert.ok(view.steps.some((step) => step.includes("drive.file")), "the scope is named");
  assert.equal(view.oauthSignInNote, OAUTH_SIGN_IN_NOTE);
  assert.match(view.oauthSignInNote, /Google Ads/);
  assert.equal(view.connect.available, false);
  assert.match(view.connect.reason, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
});

test("a service account key marks the credentials as set, with no setup steps left", () => {
  const view = driveConnectionView({ GOOGLE_SERVICE_ACCOUNT_KEY: KEY_JSON, MERIDIAN_DRIVE_FOLDER_ID: "folder-123" });
  assert.equal(view.state, "credentials_set");
  assert.equal(view.method, "service_account");
  assert.deepEqual(view.missing, []);
  assert.deepEqual(view.steps, []);
  assert.equal(view.folderConfigured, true);
});

test("OAuth refresh credentials mark the credentials as set, and a missing folder is named", () => {
  const view = driveConnectionView({ GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: SECRET, GOOGLE_REFRESH_TOKEN: REFRESH });
  assert.equal(view.state, "credentials_set");
  assert.equal(view.method, "oauth_refresh");
  assert.deepEqual(view.missing, ["MERIDIAN_DRIVE_FOLDER_ID"]);
});

test("a partial OAuth configuration is not connected, and Connect names the client setting it lacks", () => {
  const view = driveConnectionView({ GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: SECRET });
  assert.equal(view.state, "not_connected");
  assert.equal(view.connect.available, true, "the OAuth client is complete, so the workspace can connect");
});

test("Connect is available once the OAuth client is set, and its reason names exactly what is missing", () => {
  const withBoth = driveConnectionView(CLIENT);
  assert.equal(withBoth.connect.available, true);
  assert.equal(withBoth.connect.reason, "");
  const onlyId = driveConnectionView({ GOOGLE_CLIENT_ID: "client-id" });
  assert.equal(onlyId.connect.available, false);
  assert.match(onlyId.connect.reason, /GOOGLE_CLIENT_SECRET/);
  assert.equal(onlyId.connect.reason.includes("client-id"), false, "the reason names the setting, not its value");
  const onlySecret = driveConnectionView({ GOOGLE_CLIENT_SECRET: SECRET });
  assert.match(onlySecret.connect.reason, /GOOGLE_CLIENT_ID/);
});

test("a workspace connection is shown as connected, with when it was made and no token", () => {
  const view = driveConnectionView({ ...CLIENT, GOOGLE_REFRESH_TOKEN: REFRESH }, { connected: true, connectedAt: "2026-10-10T09:00:00.000Z" });
  assert.equal(view.state, "connected");
  assert.equal(view.method, "workspace");
  assert.equal(view.connectedAt, "2026-10-10T09:00:00.000Z");
  assert.deepEqual(view.missing, []);
  assert.match(view.detail, /Meridian can see only the files it creates/);
});

test("a workspace connection that cannot be used without the OAuth client says so, and does not report it working", () => {
  const view = driveConnectionView({ GOOGLE_SERVICE_ACCOUNT_KEY: KEY_JSON }, { connected: true, connectedAt: "2026-10-10T09:00:00.000Z" });
  assert.equal(view.state, "connected");
  assert.match(view.detail, /cannot be used/);
  assert.match(view.detail, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set/);
  assert.deepEqual(view.missing, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
});

test("the panel never contains a secret, a refresh token, or a private key", () => {
  const views = [
    driveConnectionView({ GOOGLE_SERVICE_ACCOUNT_KEY: KEY_JSON }),
    driveConnectionView({ GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: SECRET, GOOGLE_REFRESH_TOKEN: REFRESH }),
    driveConnectionView({}),
    driveConnectionView({ ...CLIENT, GOOGLE_REFRESH_TOKEN: REFRESH }, { connected: true, connectedAt: "2026-10-10T09:00:00.000Z" }),
  ];
  for (const view of views) {
    const text = JSON.stringify(view);
    for (const secret of [SECRET, REFRESH, PRIVATE_KEY, "svc@example.test"]) {
      assert.equal(text.includes(secret), false, "the view must not carry a secret value");
    }
  }
});

test("the auth status reads an explicit environment, so it can be checked without touching the process environment", () => {
  assert.equal(getGoogleDriveAuthStatus({}).configured, false);
  assert.equal(getGoogleDriveAuthStatus({ GOOGLE_SERVICE_ACCOUNT_KEY: KEY_JSON }).type, "service_account");
  assert.equal(getGoogleDriveAuthStatus({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", GOOGLE_REFRESH_TOKEN: "c" }).type, "oauth_refresh");
  assert.equal(driveConnectionView({}, NOT_CONNECTED).state, "not_connected");
});
