/**
 * The Drive file id reserved for one small-file write, recorded in Postgres BEFORE the create call.
 *
 * Drive rejects a create whose `id` is already taken (HTTP 409). So every writer of the same file (same workspace, scope, storage key and
 * bytes) creates under the one id reserved here: two concurrent writers converge on the first reservation, and a retry after a lost
 * response reuses it. Drive then holds at most one file for it, and a 409 is confirmed by reading that file back (drive.ts).
 */
import type { Sql } from "../learning/store.ts";

export type DriveReservationKey = {
  organizationId: string;
  /** driveScopeOf(brandId): the brand id, or the workspace's own space. */
  scope: string;
  storageKeyHash: string;
  sha256: string;
};

export type DriveReservationStore = {
  /** The id already reserved for this file, or null. */
  find(key: DriveReservationKey): Promise<string | null>;
  /** Reserves `fileId` unless another writer reserved first, and returns the id that holds: the first one. */
  reserve(key: DriveReservationKey, fileId: string): Promise<string>;
};

export function createSqlDriveReservationStore(sql: Sql): DriveReservationStore {
  const find = async (key: DriveReservationKey): Promise<string | null> => {
    const rows = await sql<{ file_id: string }>`
      select file_id from drive_reserved_ids
      where organization_id = ${key.organizationId} and scope = ${key.scope}
        and storage_key_hash = ${key.storageKeyHash} and sha256 = ${key.sha256}
      limit 1
    `;
    return rows[0]?.file_id ?? null;
  };
  return {
    find,
    async reserve(key, fileId) {
      await sql`
        insert into drive_reserved_ids (organization_id, scope, storage_key_hash, sha256, file_id)
        values (${key.organizationId}, ${key.scope}, ${key.storageKeyHash}, ${key.sha256}, ${fileId})
        on conflict (organization_id, scope, storage_key_hash, sha256) do nothing
      `;
      const held = await find(key);
      if (!held) throw new Error("The Drive file id reservation is missing after its insert. Nothing was written to Drive.");
      return held;
    },
  };
}

/** The same rules in memory, for tests. */
export function createMemoryDriveReservationStore(): DriveReservationStore & { size(): number } {
  const rows = new Map<string, string>();
  const keyOf = (key: DriveReservationKey) => JSON.stringify([key.organizationId, key.scope, key.storageKeyHash, key.sha256]);
  return {
    async find(key) {
      return rows.get(keyOf(key)) ?? null;
    },
    async reserve(key, fileId) {
      const k = keyOf(key);
      if (!rows.has(k)) rows.set(k, fileId);
      return rows.get(k)!;
    },
    size: () => rows.size,
  };
}
