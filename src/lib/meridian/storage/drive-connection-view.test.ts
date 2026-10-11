import assert from "node:assert/strict";
import test from "node:test";
import { getGoogleDriveAuthStatus } from "./google-auth.ts";
import { OAUTH_SIGN_IN_NOTE, driveConnectionView } from "./drive-connection-view.ts";

const SECRET = "client-secret-VALUE-9f3a";
const REFRESH = "refresh-token-VALUE-7c1d";
const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----MIIE-VALUE-2b8e";
const KEY_JSON = JSON.stringify({ type: "service_account", client_email: "svc@example.test", private_key: PRIVATE_KEY });

test("with no Drive credentials the panel is not connected, names what is missing, and lists the steps", () => {
  const view = driveConnectionView({});
  assert.equal(view.state, "not_connected");
  assert.equal(view.method, "none");
  assert.match(view.detail, /not connected/i);
  assert.ok(view.missing.some((item) => item.includes("GOOGLE_SERVICE_ACCOUNT_KEY")));
  assert.ok(view.missing.includes("MERIDIAN_DRIVE_FOLDER_ID"));
  assert.ok(view.steps.some((step) => step.includes("GOOGLE_SERVICE_ACCOUNT_KEY")));
  assert.ok(view.steps.some((step) => step.includes("https://www.googleapis.com/auth/drive")));
  assert.ok(view.steps.some((step) => step.includes("https://developers.google.com/oauthplayground")));
  assert.equal(view.oauthSignInNote, OAUTH_SIGN_IN_NOTE);
  assert.match(view.oauthSignInNote, /Google Ads/);
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

test("a partial OAuth configuration is not connected", () => {
  const view = driveConnectionView({ GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: SECRET });
  assert.equal(view.state, "not_connected");
});

test("the panel never contains a secret, a refresh token, or a private key", () => {
  const views = [
    driveConnectionView({ GOOGLE_SERVICE_ACCOUNT_KEY: KEY_JSON }),
    driveConnectionView({ GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: SECRET, GOOGLE_REFRESH_TOKEN: REFRESH }),
    driveConnectionView({}),
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
});
