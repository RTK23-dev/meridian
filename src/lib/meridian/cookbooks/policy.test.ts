// The cookbook policy (K7): each role and each relationship between person and cookbook, checked as a table.

import assert from "node:assert/strict";
import { test } from "node:test";
import { canCreate, canEdit, canShareWithWorkspace, canView } from "./policy.ts";
import type { StoredCookbook } from "./store.ts";
import { threeDDataExplainerCookbook } from "./builtin/three-d-data-explainer.ts";

function stored(createdBy: string, parent: StoredCookbook["parent"] = null): StoredCookbook {
  return {
    rowId: "row",
    organizationId: "org",
    brandId: "brand",
    cookbookId: "ck_mine",
    version: 1,
    parent,
    cookbook: threeDDataExplainerCookbook,
    contentHash: "sha256:x",
    createdBy,
    createdAt: "2026-10-31T00:00:00.000Z",
    archivedAt: null,
  };
}

test("every role can view; viewers cannot create, and members and above can", () => {
  assert.equal(canView("viewer"), true);
  assert.equal(canCreate("viewer"), false);
  assert.equal(canCreate("member"), true);
  assert.equal(canCreate("admin"), true);
  assert.equal(canCreate("owner"), true);
});

test("a member edits the cookbook they made, and not someone else's", () => {
  assert.equal(canEdit("member", "u1", stored("u1")), true);
  assert.equal(canEdit("member", "u2", stored("u1")), false);
});

test("a copy of a built-in is maintained by an admin, not by a member who did not make it", () => {
  const copy = stored("u1", { cookbookId: "ck_3d_data_explainer", version: 2 });
  assert.equal(canEdit("member", "u1", copy), false, "even the member who forked it");
  assert.equal(canEdit("admin", "u2", copy), true);
});

test("an admin or owner edits any cookbook of the workspace; a viewer edits none", () => {
  assert.equal(canEdit("admin", "u2", stored("u1")), true);
  assert.equal(canEdit("owner", "u2", stored("u1")), true);
  assert.equal(canEdit("viewer", "u1", stored("u1")), false);
});

test("members may share a fork with the workspace, and viewers may not", () => {
  assert.equal(canShareWithWorkspace("member"), true);
  assert.equal(canShareWithWorkspace("viewer"), false);
});
