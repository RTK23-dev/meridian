import assert from "node:assert/strict";
import test from "node:test";
import { oauthClientReadiness } from "./client-readiness.ts";

test("account sign-in is not ready when the client id and secret are missing, and it names them", () => {
  const readiness = oauthClientReadiness({});
  assert.equal(readiness.meta.ready, false);
  assert.deepEqual(readiness.meta.missing, ["META_APP_ID", "META_APP_SECRET"]);
  assert.equal(readiness.google.ready, false);
  assert.deepEqual(readiness.google.missing, ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET"]);
  assert.equal(readiness.tiktok.ready, false);
  assert.deepEqual(readiness.tiktok.missing, ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"]);
});

test("a client id without its secret is still not ready, and only the secret is named", () => {
  const readiness = oauthClientReadiness({ META_APP_ID: "app-1", GOOGLE_ADS_CLIENT_ID: "g-1", GOOGLE_ADS_CLIENT_SECRET: "g-secret" });
  assert.equal(readiness.meta.ready, false);
  assert.deepEqual(readiness.meta.missing, ["META_APP_SECRET"]);
  assert.equal(readiness.google.ready, true);
  assert.deepEqual(readiness.google.missing, []);
});

test("a blank value counts as missing, and the result never carries a value", () => {
  const readiness = oauthClientReadiness({ META_APP_ID: "   ", META_APP_SECRET: "meta-secret-value", GOOGLE_ADS_CLIENT_ID: "", GOOGLE_ADS_CLIENT_SECRET: "g-secret-value" });
  assert.deepEqual(readiness.meta.missing, ["META_APP_ID"]);
  assert.equal(readiness.google.ready, false);
  const serialized = JSON.stringify(readiness);
  assert.equal(serialized.includes("meta-secret-value"), false);
  assert.equal(serialized.includes("g-secret-value"), false);
});
