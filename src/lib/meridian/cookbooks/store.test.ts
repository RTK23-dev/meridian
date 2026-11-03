// The cookbook store (K6), on PGlite with every migration applied: versions are immutable and numbered; a fork keeps its parent; a brand's
// cookbook is invisible to another brand and visible across the workspace when shared; an archived cookbook leaves the library but still
// resolves; built-in ids are reserved; a stored body that no longer matches its contract is an error, never used.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { threeDDataExplainerCookbook } from "./builtin/three-d-data-explainer.ts";
import { archiveCookbook, forkCookbook, getCookbookVersion, listCookbookVersions, listCookbooks, saveCookbookVersion } from "./store.ts";

const ORG = "org_cookbook_store";
const BRAND_A = "brand_cookbook_a";
const BRAND_B = "brand_cookbook_b";
const USER = "user_cookbook_store";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND_A);
  await seedWorkspace(db.sql, ORG, BRAND_B);
});

after(async () => {
  await db.close();
});

function custom(cookbookId: string, label = "My explainer") {
  return { ...threeDDataExplainerCookbook, cookbookId, label, scope: "workspace" as const, version: 1 };
}

test("a new cookbook is version 1, and each edit writes the next version without changing the last one", async () => {
  const first = await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbook: custom("ck_store_one"), createdBy: USER });
  assert.equal(first.ok, true);
  const second = await saveCookbookVersion(db.sql, {
    organizationId: ORG,
    brandId: BRAND_A,
    cookbook: custom("ck_store_one", "Renamed"),
    createdBy: USER,
  });
  assert.equal(second.ok, true);
  if (!second.ok || !first.ok) return;
  assert.equal(second.value.version, 2);
  const v1 = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbookId: "ck_store_one", version: 1 });
  assert.equal(v1.ok && v1.value.cookbook.label, "My explainer", "version 1 is unchanged");
  assert.equal(first.value.contentHash === second.value.contentHash, false);
});

test("a stored body that fails validation is refused on the way in", async () => {
  const broken = { ...custom("ck_store_bad"), steps: [] };
  const result = await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbook: broken, createdBy: USER });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid");
});

test("a brand's cookbook is invisible to another brand, and a workspace cookbook is visible to every brand", async () => {
  await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbook: custom("ck_store_only_a"), createdBy: USER });
  const fromB = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbookId: "ck_store_only_a" });
  assert.equal(fromB.ok, false, "another brand cannot read it");
  const shared = await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: null, cookbook: custom("ck_store_shared"), createdBy: USER });
  assert.equal(shared.ok, true);
  const inB = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbookId: "ck_store_shared" });
  assert.equal(inB.ok, true, "every brand reads a workspace cookbook");
});

test("a cookbook id is per brand: another brand can use the same id and is never told the first one exists", async () => {
  const fromB = await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbook: custom("ck_store_only_a", "Brand B's own"), createdBy: USER });
  assert.equal(fromB.ok, true, "the id is free for brand B");
  if (fromB.ok) assert.equal(fromB.value.version, 1, "brand B's copy starts at version 1");
  const readA = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbookId: "ck_store_only_a" });
  assert.equal(readA.ok && readA.value.cookbook.label, "My explainer", "brand A still reads its own");
  const readB = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbookId: "ck_store_only_a" });
  assert.equal(readB.ok && readB.value.cookbook.label, "Brand B's own", "brand B reads its own");
});

test("a brand cannot save over a workspace-shared cookbook's id: it keeps its scope, fork it", async () => {
  await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: null, cookbook: custom("ck_store_shared_id"), createdBy: USER });
  const result = await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbook: custom("ck_store_shared_id"), createdBy: USER });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "brand_mismatch");
});

test("a workspace-shared cookbook and a brand's own can use one id: each is read, listed and archived on its own", async () => {
  await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbook: custom("ck_store_twin", "A only"), createdBy: USER });
  const shared = await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: null, cookbook: custom("ck_store_twin", "Shared"), createdBy: USER });
  assert.equal(shared.ok, true, "sharing an id a brand uses privately is allowed");
  const a = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbookId: "ck_store_twin" });
  assert.equal(a.ok && a.value.cookbook.label, "A only", "brand A reads its own over the shared one");
  const b = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbookId: "ck_store_twin" });
  assert.equal(b.ok && b.value.cookbook.label, "Shared", "brand B reads the shared one");
  const listA = (await listCookbooks(db.sql, { organizationId: ORG, brandId: BRAND_A })).filter((item) => item.cookbookId === "ck_store_twin");
  assert.equal(listA.length, 1, "one entry per id");
  assert.equal(listA[0]?.cookbook.label, "A only");
  await archiveCookbook(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbookId: "ck_store_twin" });
  const bAfter = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbookId: "ck_store_twin" });
  assert.equal(bAfter.ok && bAfter.value.archivedAt, null, "archiving brand A's copy leaves the shared one alone");
});

test("a fork keeps its parent, and a brand fork is not shared", async () => {
  const fork = await forkCookbook(db.sql, {
    organizationId: ORG,
    brandId: BRAND_A,
    from: { cookbookId: "ck_store_one", version: 1 },
    newCookbookId: "ck_store_fork",
    shareWithWorkspace: false,
    createdBy: USER,
  });
  assert.equal(fork.ok, true);
  if (!fork.ok) return;
  assert.deepEqual(fork.value.parent, { cookbookId: "ck_store_one", version: 1 });
  assert.equal(fork.value.brandId, BRAND_A);
  const fromB = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbookId: "ck_store_fork" });
  assert.equal(fromB.ok, false);
});

test("the library lists the latest visible version of each cookbook, and an archived one leaves it but still resolves", async () => {
  const listed = await listCookbooks(db.sql, { organizationId: ORG, brandId: BRAND_A });
  const one = listed.find((cookbook) => cookbook.cookbookId === "ck_store_one");
  assert.equal(one?.version, 2, "the library shows version 2");
  const archived = await archiveCookbook(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbookId: "ck_store_one" });
  assert.equal(archived.ok, true);
  const afterArchive = await listCookbooks(db.sql, { organizationId: ORG, brandId: BRAND_A });
  assert.equal(afterArchive.some((cookbook) => cookbook.cookbookId === "ck_store_one"), false);
  const stillThere = await getCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbookId: "ck_store_one", version: 1 });
  assert.equal(stillThere.ok, true, "old runs can still read an archived cookbook");
});

test("a built-in id cannot be saved over, and a cookbook in another workspace is not found", async () => {
  const reserved = await saveCookbookVersion(db.sql, {
    organizationId: ORG,
    brandId: BRAND_A,
    cookbook: custom("ck_3d_data_explainer"),
    createdBy: USER,
  });
  assert.equal(reserved.ok, false);
  if (!reserved.ok) assert.equal(reserved.reason, "reserved");
  const elsewhere = await getCookbookVersion(db.sql, { organizationId: "org_other", brandId: BRAND_A, cookbookId: "ck_store_one" });
  assert.equal(elsewhere.ok, false);
});

test("archiving a cookbook outside the brand's view finds nothing", async () => {
  const result = await archiveCookbook(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbookId: "ck_store_fork" });
  assert.equal(result.ok, false);
});

test("a brand lists the versions it can see, newest first, and another brand sees none of a brand-only cookbook (K19)", async () => {
  for (const label of ["First", "Second", "Third"]) {
    const saved = await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbook: custom("ck_store_versions", label), createdBy: USER });
    assert.equal(saved.ok, true);
  }
  const mine = await listCookbookVersions(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbookId: "ck_store_versions" });
  assert.deepEqual(mine.map((item) => item.version), [3, 2, 1]);
  assert.ok(mine.every((item) => item.archived === false));
  assert.ok(mine.every((item) => !Number.isNaN(Date.parse(item.createdAt))), "each version has a time");
  const theirs = await listCookbookVersions(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbookId: "ck_store_versions" });
  assert.deepEqual(theirs, [], "a brand-only cookbook is not listed for another brand");
  const none = await listCookbookVersions(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbookId: "ck_store_missing" });
  assert.deepEqual(none, []);
});

test("a later version of a copy keeps the parent its first version recorded (K20b3)", async () => {
  const first = await saveCookbookVersion(db.sql, {
    organizationId: ORG,
    brandId: BRAND_A,
    cookbook: custom("ck_store_parent"),
    createdBy: USER,
    parent: { cookbookId: "ck_3d_data_explainer", version: 2 },
  });
  assert.equal(first.ok, true);
  const second = await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_A, cookbook: custom("ck_store_parent", "Edited"), createdBy: USER });
  assert.equal(second.ok, true);
  const rows = await db.sql<{ version: number; parent_cookbook_id: string | null; parent_version: number | null }>`
    select version, parent_cookbook_id, parent_version from cookbooks
    where organization_id = ${ORG} and cookbook_id = 'ck_store_parent' order by version
  `;
  assert.deepEqual(rows.map((row) => [row.version, row.parent_cookbook_id, row.parent_version]), [
    [1, "ck_3d_data_explainer", 2],
    [2, "ck_3d_data_explainer", 2],
  ]);
});
