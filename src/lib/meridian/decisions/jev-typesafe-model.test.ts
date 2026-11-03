// The workspace's TypeSafe model, stored beside its JEV backend (migration 0152), on PGlite with every migration applied.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { isJevTypesafeModel, readJevBackend, readJevTypesafeModel, writeJevTypesafeModel } from "./jev-backend.ts";

const ORG = "org_jev_model";
let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, "brand_jev_model");
});
after(async () => { await db.close(); });

test("a workspace with nothing saved has no model, so the deployment's applies", async () => {
  assert.equal(await readJevTypesafeModel(db.sql, ORG), null);
});

test("saving a model keeps the default backend and is audited, and clearing returns to the deployment's model", async () => {
  await writeJevTypesafeModel(db.sql, { organizationId: ORG, actorId: "u1", model: "typesafe/jev-1.14" });
  assert.equal(await readJevTypesafeModel(db.sql, ORG), "typesafe/jev-1.14");
  const backend = await readJevBackend(db.sql, ORG);
  assert.deepEqual(backend, { ok: true, backend: "typesafe_direct" });
  const audit = await db.sql<{ n: number }>`select count(*)::int as n from audit_log where organization_id = ${ORG} and action = 'decision_engine.jev_typesafe_model.update'`;
  assert.equal(audit[0]?.n, 1);
  await writeJevTypesafeModel(db.sql, { organizationId: ORG, actorId: "u1", model: null });
  assert.equal(await readJevTypesafeModel(db.sql, ORG), null);
});

test("a stored value that is not a verified model is ignored, never sent", async () => {
  await db.sql`update decision_engine_jev_config set typesafe_model = 'typesafe/not-a-model' where organization_id = ${ORG}`;
  assert.equal(await readJevTypesafeModel(db.sql, ORG), null);
  assert.equal(isJevTypesafeModel("~typesafe/jev-latest"), false);
  assert.equal(isJevTypesafeModel("typesafe/jev-1.13"), true);
});
