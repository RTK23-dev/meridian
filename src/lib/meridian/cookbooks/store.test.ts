// The cookbook store (K6), on PGlite with every migration applied: versions are immutable and numbered; a fork keeps its parent; a brand's
// cookbook is invisible to another brand and visible across the workspace when shared; an archived cookbook leaves the library but still
// resolves; built-in ids are reserved; a stored body that no longer matches its contract is an error, never used.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { threeDDataExplainerCookbook } from "./builtin/three-d-data-explainer.ts";
import { archiveCookbook, forkCookbook, getCookbookVersion, listCookbooks, saveCookbookVersion } from "./store.ts";

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

test("a cookbook keeps its brand: saving a new version under another brand is refused", async () => {
  const result = await saveCookbookVersion(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbook: custom("ck_store_only_a"), createdBy: USER });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "brand_mismatch");
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
  const result = await archiveCookbook(db.sql, { organizationId: ORG, brandId: BRAND_B, cookbookId: "ck_store_only_a" });
  assert.equal(result.ok, false);
});
