// The install of the 3D data explainer's style kit (B16, Q30 D) on PGlite: one kit row, the same id each time, and the id a page names.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WORKSPACE_ID } from "../../../engine/contracts/fixtures/index.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { installThreeDStyleKit } from "./style-preset.ts";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WORKSPACE_ID, "brand_style_preset");
});

after(async () => {
  await db.close();
});

test("installing the preset's style kit gives the kit id a page can name, and a second install finds the same row", async () => {
  const first = await installThreeDStyleKit(db.sql, { organizationId: WORKSPACE_ID });
  const second = await installThreeDStyleKit(db.sql, { organizationId: WORKSPACE_ID });
  assert.equal(first.kitId, "sk_3d_data_explainer");
  assert.equal(second.kitId, first.kitId);
  const rows = await db.sql<{ n: number }>`select count(*)::int as n from engine_kits where organization_id = ${WORKSPACE_ID} and kind = 'style' and kit_id = ${first.kitId}`;
  assert.equal(rows[0]?.n, 1, "one row, however many times it is installed");
});
