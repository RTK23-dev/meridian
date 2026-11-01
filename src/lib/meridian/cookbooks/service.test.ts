// The cookbook service (K7) on PGlite: who may save, edit, fork and archive; what the library shows; resolving a cookbook with values.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { threeDDataExplainerCookbook } from "./builtin/three-d-data-explainer.ts";
import { archiveCookbookFor, forkCookbookFor, libraryFor, proposeFor, readCookbookFor, resolveFor, saveCookbookFor } from "./service.ts";
import type { RunInputs } from "./eligibility.ts";

const ORG = "org_cookbook_service";
const BRAND = "brand_cookbook_service";
let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
});

after(async () => {
  await db.close();
});

const scope = { organizationId: ORG, brandId: BRAND };

function mine(cookbookId: string) {
  return { ...threeDDataExplainerCookbook, cookbookId, scope: "workspace" as const, version: 1, label: `Mine ${cookbookId}`, parent: undefined };
}

test("the library holds every built-in cookbook, and the workspace has none yet", async () => {
  const library = await libraryFor(db.sql, scope);
  assert.equal(library.builtins.length, 10, "the 3D explainer, the UGC product and voice-led list, four factory presets and three start modes");
  assert.deepEqual(library.workspace, []);
});

test("a viewer cannot create a cookbook, and a member can", async () => {
  const refused = await saveCookbookFor(db.sql, { ...scope, role: "viewer", userId: "u_a", cookbook: mine("ck_svc_one") });
  assert.equal(refused.ok, false);
  const saved = await saveCookbookFor(db.sql, { ...scope, role: "member", userId: "u_a", cookbook: mine("ck_svc_one") });
  assert.equal(saved.ok, true);
});

test("another member cannot edit someone else's cookbook; an admin can, and the version moves on", async () => {
  const other = await saveCookbookFor(db.sql, { ...scope, role: "member", userId: "u_b", cookbook: mine("ck_svc_one") });
  assert.equal(other.ok, false);
  const admin = await saveCookbookFor(db.sql, { ...scope, role: "admin", userId: "u_admin", cookbook: mine("ck_svc_one") });
  assert.equal(admin.ok, true);
  if (admin.ok) assert.equal(admin.value.version, 2);
});

test("a built-in id cannot be saved over", async () => {
  const result = await saveCookbookFor(db.sql, { ...scope, role: "owner", userId: "u_owner", cookbook: mine("ck_3d_data_explainer") });
  assert.equal(result.ok, false);
});

test("a member forks a built-in; the copy records the built-in as its parent; only an admin maintains the copy", async () => {
  const fork = await forkCookbookFor(db.sql, {
    ...scope,
    role: "member",
    userId: "u_a",
    from: { cookbookId: "ck_3d_data_explainer" },
    newCookbookId: "ck_svc_copy",
    shareWithWorkspace: false,
  });
  assert.equal(fork.ok, true, fork.ok ? "" : fork.reason);
  if (!fork.ok) return;
  assert.deepEqual(fork.value.parent, { cookbookId: "ck_3d_data_explainer", version: threeDDataExplainerCookbook.version });
  const memberEdit = await saveCookbookFor(db.sql, { ...scope, role: "member", userId: "u_a", cookbook: { ...mine("ck_svc_copy"), label: "Changed" } });
  assert.equal(memberEdit.ok, false, "the member who forked it cannot maintain the copy");
  const adminEdit = await saveCookbookFor(db.sql, { ...scope, role: "admin", userId: "u_admin", cookbook: { ...mine("ck_svc_copy"), label: "Changed" } });
  assert.equal(adminEdit.ok, true);
});

test("a viewer cannot fork a cookbook", async () => {
  const viewerFork = await forkCookbookFor(db.sql, {
    ...scope,
    role: "viewer",
    userId: "u_v",
    from: { cookbookId: "ck_3d_data_explainer" },
    newCookbookId: "ck_svc_viewer",
    shareWithWorkspace: false,
  });
  assert.equal(viewerFork.ok, false);
});

test("archiving: a built-in cannot be archived, a member archives their own, and not another's", async () => {
  const builtin = await archiveCookbookFor(db.sql, { ...scope, role: "owner", userId: "u_owner", cookbookId: "ck_3d_data_explainer" });
  assert.equal(builtin.ok, false);
  const notMine = await archiveCookbookFor(db.sql, { ...scope, role: "member", userId: "u_b", cookbookId: "ck_svc_one" });
  assert.equal(notMine.ok, false);
  const mineArchived = await archiveCookbookFor(db.sql, { ...scope, role: "member", userId: "u_a", cookbookId: "ck_svc_copy" });
  assert.equal(mineArchived.ok, false, "the copy is an admin's to archive, like its edits");
  const adminArchived = await archiveCookbookFor(db.sql, { ...scope, role: "admin", userId: "u_admin", cookbookId: "ck_svc_copy" });
  assert.equal(adminArchived.ok, true);
});

test("a built-in resolves with values, and an unknown cookbook is not found", async () => {
  const resolved = await resolveFor(db.sql, { ...scope, cookbookId: "ck_3d_data_explainer", values: { voice_way: "none" }, lengthMs: 60000 });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.deepEqual(resolved.value.modes, ["agent", "engine"]);
  const missing = await resolveFor(db.sql, { ...scope, cookbookId: "ck_nope", values: {}, lengthMs: 60000 });
  assert.equal(missing.ok, false);
});

test("reading a workspace cookbook returns its source and the stored row", async () => {
  const read = await readCookbookFor(db.sql, { ...scope, cookbookId: "ck_svc_one" });
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.value.source, "workspace");
});

const RUN: RunInputs = {
  briefChars: 100,
  reference: { attached: false, dnaCached: false },
  productKit: false,
  uploads: { voice: false, footage: false, music: false },
  budgetUsd: null,
  runKind: "normal",
};

test("a run with no selector connected gets the picker over the eligible cookbooks, never a guessed pick", async () => {
  const proposal = await proposeFor(db.sql, { ...scope, inputs: RUN, lengthMs: 60000 });
  assert.equal(proposal.status, "not_connected");
  if (proposal.status === "not_connected") assert.ok(proposal.eligible.some((ref) => ref.cookbookId === "ck_3d_data_explainer" && ref.version >= 1));
});

test("with a selector port, a pick names only a cookbook the library offers, and it is resolved", async () => {
  const port = async () => ({
    ok: true as const,
    text: JSON.stringify({ picks: [{ cookbookId: "ck_3d_data_explainer", version: 2, reason: "A data story.", values: {} }] }),
  });
  const proposal = await proposeFor(db.sql, { ...scope, inputs: RUN, lengthMs: 60000, port });
  assert.equal(proposal.status, "proposed");
  if (proposal.status === "proposed") assert.equal(proposal.picks[0]?.cookbookId, "ck_3d_data_explainer");
});

