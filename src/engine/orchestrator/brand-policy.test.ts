import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../test/pg-test-db.ts";
import { effectiveDisabledFamilies, readBrandPolicy, writeBrandPolicy } from "./brand-policy.ts";
import { createPlanDraft, getPlan, listPlans } from "./store.ts";

const ORG = "org_brand_policy_a";
const OTHER = "org_brand_policy_b";
const BRAND = "brand_policy_one";

describe("the effective set of a plan (owner direction 2026-10-23, D16)", () => {
  test("the effective set is the union of the workspace's and the brand's families, unique and sorted", () => {
    assert.deepEqual(effectiveDisabledFamilies(["vendor-b", "vendor-a/clip"], ["vendor-c", "vendor-a/clip"]), ["vendor-a/clip", "vendor-b", "vendor-c"]);
    assert.deepEqual(effectiveDisabledFamilies(["vendor-a"], []), ["vendor-a"]);
    assert.deepEqual(effectiveDisabledFamilies([], ["vendor-c"]), ["vendor-c"]);
    assert.deepEqual(effectiveDisabledFamilies([], []), []);
  });

  test("a brand cannot switch on a family the workspace has switched off", () => {
    const effective = effectiveDisabledFamilies(["vendor-a/clip"], ["vendor-b"]);
    assert.ok(effective.includes("vendor-a/clip"), "the workspace's family stays off whatever the brand lists");
    assert.deepEqual(effectiveDisabledFamilies(["vendor-a/clip"], []), ["vendor-a/clip"], "an empty brand list keeps the workspace's set");
  });

  test("a family is compared in one form, so a brand's spelling does not make a second entry", () => {
    assert.deepEqual(effectiveDisabledFamilies(["Vendor-A/Clip"], ["~vendor-a/clip"]), ["vendor-a/clip"]);
  });

  test("an invalid family is refused rather than dropped, because a dropped family would be switched on", () => {
    assert.throws(() => effectiveDisabledFamilies(["vendor-a"], ["not a family!"]), /is not a model family/);
    assert.throws(() => effectiveDisabledFamilies([""], []), /is not a model family/);
    assert.throws(() => effectiveDisabledFamilies(["a/b/c"], []), /is not a model family/);
  });

  test("a list of more than 20 families is refused, and 20 are accepted", () => {
    const twentyOne = Array.from({ length: 21 }, (_, index) => `vendor-${index}`);
    assert.throws(() => effectiveDisabledFamilies([], twentyOne), /at most 20/);
    assert.equal(effectiveDisabledFamilies([], twentyOne.slice(0, 20)).length, 20);
  });
});

describe("a brand's stored policy and a plan's brand (migration 0119)", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG, BRAND);
    await seedWorkspace(db.sql, OTHER);
  });

  after(async () => {
    await db.close();
  });

  test("a brand with no stored policy has no families, and a saved list is read back normalized and sorted", async () => {
    assert.deepEqual(await readBrandPolicy(db.sql, ORG, BRAND), []);
    const saved = await writeBrandPolicy(db.sql, {
      organizationId: ORG,
      brandId: BRAND,
      actorId: "user_admin_a",
      disabledModelFamilies: ["Vendor-B", "vendor-a/clip", "vendor-b"],
    });
    assert.deepEqual(saved, ["vendor-a/clip", "vendor-b"]);
    assert.deepEqual(await readBrandPolicy(db.sql, ORG, BRAND), ["vendor-a/clip", "vendor-b"]);
  });

  test("a save replaces the list, and records who saved it", async () => {
    await writeBrandPolicy(db.sql, { organizationId: ORG, brandId: BRAND, actorId: "user_admin_b", disabledModelFamilies: ["vendor-c"] });
    assert.deepEqual(await readBrandPolicy(db.sql, ORG, BRAND), ["vendor-c"]);
    const rows = await db.sql<{ updated_by: string }>`
      select updated_by from orchestrator_brand_policies where organization_id = ${ORG} and brand_id = ${BRAND}
    `;
    assert.equal(rows[0]?.updated_by, "user_admin_b");
  });

  test("an invalid list is refused, and the stored list is left as it was", async () => {
    await assert.rejects(
      writeBrandPolicy(db.sql, {
        organizationId: ORG,
        brandId: BRAND,
        actorId: "user_admin_a",
        disabledModelFamilies: ["vendor-d", "not a family!"],
      }),
      /is not a model family/,
    );
    const twentyOne = Array.from({ length: 21 }, (_, index) => `vendor-${index}`);
    await assert.rejects(
      writeBrandPolicy(db.sql, { organizationId: ORG, brandId: BRAND, actorId: "user_admin_a", disabledModelFamilies: twentyOne }),
      /at most 20/,
    );
    assert.deepEqual(await readBrandPolicy(db.sql, ORG, BRAND), ["vendor-c"]);
  });

  test("a brand's row is not visible from another organization", async () => {
    await writeBrandPolicy(db.sql, { organizationId: OTHER, brandId: BRAND, actorId: "user_other", disabledModelFamilies: ["vendor-z"] });
    assert.deepEqual(await readBrandPolicy(db.sql, ORG, BRAND), ["vendor-c"], "the first organization's list is unchanged");
    assert.deepEqual(await readBrandPolicy(db.sql, OTHER, BRAND), ["vendor-z"]);
    assert.deepEqual(await readBrandPolicy(db.sql, "org_brand_policy_none", BRAND), [], "an organization with no row reads none");
  });

  test("a plan made for a brand records it, and a plan made without one has no brand", async () => {
    const brief = { goal: "A short video", format: "a hook", userInputs: "", brand: { name: "Example", summary: "plain" }, budgetUsd: 1 };
    await createPlanDraft(db.sql, {
      id: "plan_brand_recorded",
      organizationId: ORG,
      title: "Branded",
      brief,
      orchestratorModel: "vendor-a/model-x",
      budgetUsd: 1,
      brandId: BRAND,
    });
    await createPlanDraft(db.sql, { id: "plan_brand_none", organizationId: ORG, title: "Plain", brief, orchestratorModel: "vendor-a/model-x", budgetUsd: 1 });
    assert.equal((await getPlan(db.sql, ORG, "plan_brand_recorded"))?.brandId, BRAND);
    assert.equal((await getPlan(db.sql, ORG, "plan_brand_none"))?.brandId, null);
    const listed = await listPlans(db.sql, ORG, 10);
    assert.equal(listed.find((plan) => plan.id === "plan_brand_recorded")?.brandId, BRAND);
    assert.equal(listed.find((plan) => plan.id === "plan_brand_none")?.brandId, null);
  });

  test("a stored list that does not check is refused on read, never read as empty", async () => {
    await db.sql`
      update orchestrator_brand_policies set disabled_model_families = ${JSON.stringify(["not a family!"])}::jsonb
      where organization_id = ${ORG} and brand_id = ${BRAND}
    `;
    await assert.rejects(readBrandPolicy(db.sql, ORG, BRAND), /is not a model family/);
  });
});
