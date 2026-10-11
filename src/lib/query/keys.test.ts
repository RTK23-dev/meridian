import assert from "node:assert/strict";
import test from "node:test";
import { partialMatchKey } from "@tanstack/react-query";
import { qk, userScopedQueryKey } from "./keys.ts";

test("query keys scope workspace data by user and brand data by brand", () => {
  assert.notDeepEqual(qk.workspace("user-a"), qk.workspace("user-b"));
  assert.notDeepEqual(qk.brand("brand-a"), qk.brand("brand-b"));
  assert.notDeepEqual(userScopedQueryKey("user-a", qk.brand("brand-a")), userScopedQueryKey("user-b", qk.brand("brand-a")));
  assert.deepEqual(qk.trace("brand-a", "creative-1"), ["trace", "brand-a", "creative-1"]);
});

test("a signed-out or empty user id shares one sentinel scope, never a real user's scope", () => {
  const signedOut = ["user", "signed-out", "brand", "brand-a"];
  assert.deepEqual(userScopedQueryKey(null, qk.brand("brand-a")), signedOut);
  assert.deepEqual(userScopedQueryKey(undefined, qk.brand("brand-a")), signedOut);
  assert.deepEqual(userScopedQueryKey("", qk.brand("brand-a")), signedOut, "an empty id is signed out, not a key of its own");
  assert.notDeepEqual(userScopedQueryKey("user-a", qk.brand("brand-a")), signedOut);
});

test("a platform-scoped accounts key sits under the brand-level key, so one invalidation covers both", () => {
  const brandLevel = userScopedQueryKey("user-a", qk.accounts("brand-a"));
  const platform = userScopedQueryKey("user-a", qk.accounts("brand-a", "meta"));
  assert.deepEqual(platform, ["user", "user-a", "accounts", "brand-a", "meta"]);
  assert.notDeepEqual(platform, brandLevel);
  assert.equal(partialMatchKey(platform, brandLevel), true, "invalidating the brand-level key refreshes the platform key");
  assert.equal(partialMatchKey(userScopedQueryKey("user-a", qk.accounts("brand-a", "tiktok")), platform), false, "one platform does not refresh another");
  assert.equal(partialMatchKey(userScopedQueryKey("user-b", qk.accounts("brand-a")), brandLevel), false, "another user's key is not refreshed");
});
