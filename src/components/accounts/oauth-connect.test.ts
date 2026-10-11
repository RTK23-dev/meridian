import assert from "node:assert/strict";
import test from "node:test";
import { signInProviderForPlatform, signInState } from "./oauth-connect.ts";

test("only Meta and Google ad accounts start a sign-in", () => {
  assert.equal(signInProviderForPlatform("meta_ads"), "meta");
  assert.equal(signInProviderForPlatform("google_ads"), "google");
  assert.equal(signInProviderForPlatform("instagram"), null);
  assert.equal(signInProviderForPlatform("facebook"), null);
  assert.equal(signInProviderForPlatform("youtube"), null);
});

test("sign-in is enabled for an admin when the deployment has the client id and secret", () => {
  const state = signInState({ provider: "meta", canAdmin: true, readiness: { ready: true, missing: [] } });
  assert.deepEqual(state, { enabled: true, reason: null });
});

test("sign-in is disabled with the reason for a member who is not an admin", () => {
  const state = signInState({ provider: "google", canAdmin: false, readiness: { ready: true, missing: [] } });
  assert.equal(state.enabled, false);
  assert.match(state.reason ?? "", /admin/);
});

test("sign-in is disabled with the missing settings named when the client id or secret is not set", () => {
  const state = signInState({ provider: "meta", canAdmin: true, readiness: { ready: false, missing: ["META_APP_SECRET"] } });
  assert.equal(state.enabled, false);
  assert.match(state.reason ?? "", /Meta sign-in is off/);
  assert.match(state.reason ?? "", /META_APP_SECRET/);
});

test("sign-in is disabled while the readiness check is still loading", () => {
  const state = signInState({ provider: "google", canAdmin: true, readiness: undefined });
  assert.equal(state.enabled, false);
  assert.match(state.reason ?? "", /Checking/);
});
