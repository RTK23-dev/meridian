import assert from "node:assert/strict";
import test from "node:test";
import { isOAuthProvider } from "./oauth-providers.ts";

test("meta, tiktok and google connect through OAuth", () => {
  for (const provider of ["meta", "tiktok", "google"]) assert.equal(isOAuthProvider(provider), true, provider);
});

test("the ad library and anything else do not get OAuth actions", () => {
  for (const provider of ["ad_library", "Meta", "", "__proto__", "constructor", "openrouter"]) assert.equal(isOAuthProvider(provider), false, provider);
});
