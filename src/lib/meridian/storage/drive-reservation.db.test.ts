// The Drive id reservation table on a real Postgres (PGlite, or MERIDIAN_PG_TEST_URL). No Drive call is made.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { createSqlDriveReservationStore } from "./drive-reservation.ts";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, "org_reserve");
  await seedWorkspace(db.sql, "org_reserve_other");
});

after(async () => {
  await db.close();
});

const key = { organizationId: "org_reserve", scope: "brand_a", storageKeyHash: "k1", sha256: "s1" };

test("two writers that reserve the same file both get the first id", async () => {
  const store = createSqlDriveReservationStore(db.sql);
  const [first, second] = await Promise.all([store.reserve(key, "idFirstWriter01"), store.reserve(key, "idSecondWriter1")]);
  assert.equal(first, second);
  assert.equal(await store.find(key), first);
});

test("other bytes, another scope or another workspace get their own reservation", async () => {
  const store = createSqlDriveReservationStore(db.sql);
  assert.equal(await store.reserve({ ...key, sha256: "s2" }, "idOtherBytes001"), "idOtherBytes001");
  assert.equal(await store.reserve({ ...key, scope: "workspace" }, "idOtherScope001"), "idOtherScope001");
  assert.equal(await store.reserve({ ...key, organizationId: "org_reserve_other" }, "idOtherOrg00001"), "idOtherOrg00001");
  assert.equal(await store.find({ ...key, storageKeyHash: "missing" }), null);
});
