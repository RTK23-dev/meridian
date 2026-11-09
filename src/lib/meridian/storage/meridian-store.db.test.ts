// Files without a brand, and files without Drive (owner direction 2026-11-09), on a real Postgres (PGlite, or MERIDIAN_PG_TEST_URL).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { Sql } from "../learning/store.ts";
import { createDatabaseObjectStore, DATABASE_OBJECT_MAX_BYTES } from "./database-store.ts";
import { createMeridianObjectStore, type ScopedObjectStore, type StorageHome } from "./meridian-store.ts";
import { createMemoryStorageMetadataRepository, createSqlStorageMetadataRepository, type StoredObject } from "./object-store.ts";

const ORG = "org_store";
const OTHER = "org_other";
const BRAND = "brand_store";
const bytes = (...values: number[]) => new Uint8Array(values);

let db: TestDatabase;
let sql: Sql;

before(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await seedWorkspace(sql, ORG, BRAND);
  await seedWorkspace(sql, OTHER);
});

after(async () => {
  await db.close();
});

describe("the database store", () => {
  it("keeps a workspace file (no brand) and reads back the same bytes", async () => {
    const store = createDatabaseObjectStore(sql);
    const put = await store.put({ organizationId: ORG, brandId: null, key: "mcp/c1/a.mp3", mimeType: "audio/mpeg", bytes: bytes(1, 2, 3) });
    assert.equal(put.brandId, null);
    assert.equal(put.size, 3);
    const got = await store.get(ORG, null, "mcp/c1/a.mp3");
    assert.deepEqual(got?.bytes, bytes(1, 2, 3));
    assert.equal(got?.mimeType, "audio/mpeg");
    const row = await sql<{ provider: string; brand_id: string | null }>`select provider, brand_id from storage_objects where name = 'mcp/c1/a.mp3'`;
    assert.deepEqual(row[0], { provider: "database", brand_id: null });
  });

  it("keeps the workspace's space apart from a brand's and from another workspace", async () => {
    const store = createDatabaseObjectStore(sql);
    await store.put({ organizationId: ORG, brandId: BRAND, key: "same/key.png", mimeType: "image/png", bytes: bytes(9) });
    await store.put({ organizationId: ORG, brandId: null, key: "same/key.png", mimeType: "image/png", bytes: bytes(8) });
    assert.deepEqual((await store.get(ORG, BRAND, "same/key.png"))?.bytes, bytes(9));
    assert.deepEqual((await store.get(ORG, null, "same/key.png"))?.bytes, bytes(8));
    assert.equal(await store.get(OTHER, null, "same/key.png"), null, "another workspace reads nothing");
  });

  it("treats the same bytes again as a retry and refuses different bytes under a taken name", async () => {
    const store = createDatabaseObjectStore(sql);
    await store.put({ organizationId: ORG, brandId: null, key: "once.png", mimeType: "image/png", bytes: bytes(4, 5) });
    await store.put({ organizationId: ORG, brandId: null, key: "once.png", mimeType: "image/png", bytes: bytes(4, 5) });
    await assert.rejects(store.put({ organizationId: ORG, brandId: null, key: "once.png", mimeType: "image/png", bytes: bytes(6) }), /different file/);
    const rows = await sql<{ n: number }>`select count(*)::int as n from storage_objects where organization_id = ${ORG} and brand_id is null and name = 'once.png'`;
    assert.equal(rows[0]?.n, 1);
    assert.deepEqual((await store.get(ORG, null, "once.png"))?.bytes, bytes(4, 5));
  });

  it("refuses an empty file, an unsafe key and a file over the limit before writing", async () => {
    const store = createDatabaseObjectStore(sql);
    await assert.rejects(store.put({ organizationId: ORG, brandId: null, key: "empty.png", mimeType: "image/png", bytes: bytes() }), /empty/);
    await assert.rejects(store.put({ organizationId: ORG, brandId: null, key: "../up.png", mimeType: "image/png", bytes: bytes(1) }), /not allowed/);
    const big = new Uint8Array(DATABASE_OBJECT_MAX_BYTES + 1);
    await assert.rejects(store.put({ organizationId: ORG, brandId: null, key: "big.mp4", mimeType: "video/mp4", bytes: big }), /Connect Google Drive/);
    const rows = await sql<{ n: number }>`select count(*)::int as n from storage_objects where name in ('empty.png', 'big.mp4')`;
    assert.equal(rows[0]?.n, 0);
  });

  it("removes an object with its bytes", async () => {
    const store = createDatabaseObjectStore(sql);
    await store.put({ organizationId: ORG, brandId: null, key: "gone.png", mimeType: "image/png", bytes: bytes(7) });
    assert.equal(await store.remove(ORG, null, "gone.png"), true);
    assert.equal(await store.get(ORG, null, "gone.png"), null);
    const blobs = await sql<{ n: number }>`select count(*)::int as n from storage_blobs b join storage_objects o on o.id = b.storage_object_id where o.name = 'gone.png'`;
    assert.equal(blobs[0]?.n, 0);
  });
});

/** A Drive stand-in that records what was sent to it and keeps a storage_objects row as the real one does. */
function fakeDrive(): ScopedObjectStore & { puts: string[] } {
  const kept = new Map<string, StoredObject>();
  const repo = createSqlStorageMetadataRepository(sql);
  const puts: string[] = [];
  return {
    puts,
    async put(input) {
      puts.push(input.key);
      const object: StoredObject = { ...input, checksum: "c", size: input.bytes.byteLength, version: 1, lifecycle: input.lifecycle ?? "stored" };
      kept.set(`${input.organizationId}:${input.brandId ?? ""}:${input.key}`, object);
      await repo.upsert({ organizationId: input.organizationId, brandId: input.brandId, key: input.key, providerFileId: `drive_${input.key}`, mimeType: input.mimeType, sizeBytes: input.bytes.byteLength, sha256: "c" });
      return object;
    },
    async get(organizationId, brandId, key) {
      return kept.get(`${organizationId}:${brandId ?? ""}:${key}`) ?? null;
    },
  };
}

describe("Meridian's store: Drive when it is set up, the database when it is not", () => {
  const database: () => Promise<StorageHome> = async () => ({ kind: "database", detail: "no drive" });
  const driveHome: () => Promise<StorageHome> = async () => ({ kind: "drive", detail: "drive" });

  it("keeps a new file in the database when Drive is not set up, and sends nothing to Drive", async () => {
    const drive = fakeDrive();
    const store = createMeridianObjectStore(sql, { drive, home: database });
    await store.put({ organizationId: ORG, brandId: null, key: "route/db.png", mimeType: "image/png", bytes: bytes(1) });
    assert.deepEqual(drive.puts, []);
    assert.deepEqual((await store.get(ORG, null, "route/db.png"))?.bytes, bytes(1));
  });

  it("keeps a new file in Drive when Drive is set up", async () => {
    const drive = fakeDrive();
    const store = createMeridianObjectStore(sql, { drive, home: driveHome });
    await store.put({ organizationId: ORG, brandId: null, key: "route/drive.png", mimeType: "image/png", bytes: bytes(2) });
    assert.deepEqual(drive.puts, ["route/drive.png"]);
    assert.deepEqual((await store.get(ORG, null, "route/drive.png"))?.bytes, bytes(2));
  });

  it("reads a database file after Drive is connected, from the database", async () => {
    await createMeridianObjectStore(sql, { drive: fakeDrive(), home: database }).put({ organizationId: ORG, brandId: null, key: "route/before.png", mimeType: "image/png", bytes: bytes(3) });
    const drive = fakeDrive();
    const later = createMeridianObjectStore(sql, { drive, home: driveHome });
    assert.deepEqual((await later.get(ORG, null, "route/before.png"))?.bytes, bytes(3));
    // Storing the same file again stays in the database, where its record is.
    await later.put({ organizationId: ORG, brandId: null, key: "route/before.png", mimeType: "image/png", bytes: bytes(3) });
    assert.deepEqual(drive.puts, []);
  });

  it("reads nothing for a file with no record when Drive is not set up", async () => {
    const store = createMeridianObjectStore(sql, { drive: fakeDrive(), home: database });
    assert.equal(await store.get(ORG, null, "route/never.png"), null);
  });
});

describe("the storage record of a workspace file", () => {
  it("the Drive record path keeps one row per workspace name", async () => {
    const repo = createSqlStorageMetadataRepository(sql);
    const record = { organizationId: ORG, brandId: null, key: "drive/one.png", providerFileId: "f1", mimeType: "image/png", sizeBytes: 1, sha256: "s" };
    await repo.upsert(record);
    await repo.upsert({ ...record, providerFileId: "f2" });
    const rows = await sql<{ provider_file_id: string }>`select provider_file_id from storage_objects where organization_id = ${ORG} and brand_id is null and name = 'drive/one.png'`;
    assert.deepEqual(rows.map((row) => row.provider_file_id), ["f2"]);
    assert.equal((await repo.getByKey(ORG, null, "drive/one.png"))?.providerFileId, "f2");
    assert.equal(await repo.getByKey(ORG, BRAND, "drive/one.png"), null, "a brand's space does not see the workspace's");
  });

  it("the memory repository keeps the two spaces apart", async () => {
    const repo = createMemoryStorageMetadataRepository();
    await repo.upsert({ organizationId: ORG, brandId: null, key: "k", providerFileId: "w", mimeType: "m", sizeBytes: 1, sha256: "s" });
    assert.equal((await repo.getByKey(ORG, null, "k"))?.providerFileId, "w");
    assert.equal(await repo.getByKey(ORG, BRAND, "k"), null);
  });
});
