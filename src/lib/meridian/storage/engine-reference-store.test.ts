// The engine's reference store (engine-reference-store.ts): the read of a reference, and its release once the analysis ends (Bible 6.2
// step 7). The objects are a fake, so no Drive call is made; the index (storage_objects) is PGlite with every migration applied.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { engineReferenceStore, type ReferenceObjects } from "./engine-reference-store.ts";
import { createSqlStorageMetadataRepository } from "./object-store.ts";

const ORG = "ws_reference_store";
const BRAND = "brand_reference_store";
const KEY = "uploads/reel-1.mp4";
const FILE_ID = "drive_file_reference_1";

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG, BRAND);
  await createSqlStorageMetadataRepository(db.sql).upsert({
    organizationId: ORG,
    brandId: BRAND,
    key: KEY,
    providerFileId: FILE_ID,
    mimeType: "video/mp4",
    sizeBytes: 3,
    sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    lifecycle: "stored",
  });
});

after(async () => {
  await db.close();
});

/** A fake object store: it holds the reference under its key, and records each delete by Drive file id. */
function fakeObjects(): ReferenceObjects & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async get(organizationId, brandId, key) {
      return organizationId === ORG && brandId === BRAND && key === KEY ? { bytes: new Uint8Array([1, 2, 3]), mimeType: "video/mp4" } : null;
    },
    async delete(_organizationId, fileId) {
      deleted.push(fileId);
    },
  };
}

test("the reference is read under its brand, as bytes and its mime type", async () => {
  const store = engineReferenceStore(db.sql, fakeObjects());
  const object = await store.get(ORG, BRAND, KEY);
  assert.deepEqual(Array.from(object?.bytes ?? []), [1, 2, 3]);
  assert.equal(object?.mimeType, "video/mp4");
  assert.equal(await store.get(ORG, "brand_other", KEY), null, "another brand does not read it");
});

test("release deletes the stored file and its index row, so the reference is no longer found", async () => {
  const objects = fakeObjects();
  const store = engineReferenceStore(db.sql, objects);
  await store.release(ORG, BRAND, KEY);
  assert.deepEqual(objects.deleted, [FILE_ID], "the Drive file the index names is deleted");
  assert.equal(await createSqlStorageMetadataRepository(db.sql).getByKey(ORG, BRAND, KEY), null, "the index row is gone");
});

test("a release of a reference that is already gone does nothing: no delete is sent", async () => {
  const objects = fakeObjects();
  await engineReferenceStore(db.sql, objects).release(ORG, BRAND, KEY);
  assert.deepEqual(objects.deleted, []);
});
