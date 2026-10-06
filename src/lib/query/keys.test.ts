import assert from "node:assert/strict";
import test from "node:test";
import { qk, userScopedQueryKey } from "./keys.ts";

test("query keys scope workspace data by user and brand data by brand", () => {
  assert.notDeepEqual(qk.workspace("user-a"), qk.workspace("user-b"));
  assert.notDeepEqual(qk.brand("brand-a"), qk.brand("brand-b"));
  assert.notDeepEqual(userScopedQueryKey("user-a", qk.brand("brand-a")), userScopedQueryKey("user-b", qk.brand("brand-a")));
  assert.deepEqual(qk.trace("brand-a", "creative-1"), ["trace", "brand-a", "creative-1"]);
});
