import assert from "node:assert/strict";
import test from "node:test";
import { assertRole, hasRole, nextOwnerCount } from "./access.ts";

test("viewers can read but not write", () => {
  assert.equal(hasRole("viewer", "viewer"), true);
  assert.equal(hasRole("viewer", "member"), false);
  assert.throws(() => assertRole("viewer", "member"), /permission/);
});

test("owners outrank every other role", () => {
  assert.equal(hasRole("owner", "admin"), true);
  assert.equal(hasRole("admin", "owner"), false);
  assert.equal(hasRole("member", "viewer"), true);
});

test("the last owner cannot be removed", () => {
  assert.equal(nextOwnerCount(1, "owner", null), 0);
  assert.equal(nextOwnerCount(1, "owner", "admin"), 0);
  assert.equal(nextOwnerCount(2, "owner", "admin"), 1);
  assert.equal(nextOwnerCount(1, "member", "owner"), 2);
});
