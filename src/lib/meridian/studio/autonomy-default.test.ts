import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { automationFromStudioAutonomy, brandAutomationDefault, mergeRunSettings, studioAutonomyOfAutomation } from "../factory/run-settings.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { studioAutonomyDefault } from "./session.server.ts";

const WS = "ws_autonomy";
const BRAND = "brand_autonomy";

describe("the Studio word for an automation mode", () => {
  test("each mode maps to its Studio word, and back again", () => {
    for (const mode of ["manual", "semi", "full"] as const) {
      assert.equal(automationFromStudioAutonomy(studioAutonomyOfAutomation(mode)), mode);
    }
  });

  test("a brand with no saved defaults starts from its brain's level", () => {
    assert.equal(brandAutomationDefault({ runDefaults: "{}", brainLevel: "automated" }), "semi");
    assert.equal(brandAutomationDefault({ runDefaults: null, brainLevel: "autonomous" }), "full");
    assert.equal(brandAutomationDefault({ runDefaults: undefined, brainLevel: "assisted" }), "manual");
  });

  test("saved run defaults win over the brain's level", () => {
    const saved = JSON.stringify(mergeRunSettings(null, { automation: "full" }));
    assert.equal(brandAutomationDefault({ runDefaults: saved, brainLevel: "manual" }), "full");
  });
});

describe("the autonomy a Studio plan starts from", () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase();
    await seedWorkspace(db.sql, WS, BRAND);
  });

  after(async () => {
    await db.close();
  });

  test("a brand with no saved defaults and no brain level starts manual", async () => {
    assert.equal(await studioAutonomyDefault(db.sql, WS, BRAND), "manual");
  });

  test("a brand with no saved defaults takes its brain's automation level", async () => {
    await db.sql`insert into brand_brains (brand_id, automation_level, updated_by) values (${BRAND}, 'automated', 'test')`;
    assert.equal(await studioAutonomyDefault(db.sql, WS, BRAND), "semi_automatic");
  });

  test("saved run defaults set the Studio default, whatever the brain says", async () => {
    const saved = JSON.stringify(mergeRunSettings(null, { automation: "full" }));
    await db.sql`update brands set run_defaults = ${saved} where id = ${BRAND}`;
    assert.equal(await studioAutonomyDefault(db.sql, WS, BRAND), "fully_automatic");
  });

  test("another workspace does not read this brand's defaults", async () => {
    assert.equal(await studioAutonomyDefault(db.sql, "ws_other", BRAND), "manual");
  });
});
