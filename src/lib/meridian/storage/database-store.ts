/**
 * Files kept in Meridian's own database, for a workspace that has not connected Google Drive (owner direction 2026-11-09: setting up
 * Drive is no longer needed to make a video). The record is the same storage_objects row Drive files have, with provider 'database';
 * the bytes are one storage_blobs row next to it (migration 0158). Drive stays the store when it is connected (meridian-store.ts).
 *
 * Objects are immutable, as Drive objects are: storing the same bytes again under a key is a no-op, and different bytes under a key that
 * is already taken are refused, never overwritten. A file over DATABASE_OBJECT_MAX_BYTES is refused before anything is written, with a
 * reason that says to connect Drive. The bytes travel as base64 text and are decoded in SQL, so every driver sends them the same way.
 */
import { createHash, randomUUID } from "node:crypto";
import { withTransaction, type Sql } from "../learning/store.ts";
import { safeStorageKey, type AssetLifecycle, type StorageScopeBrand, type StoredObject } from "./object-store.ts";

/** The largest file the database keeps: a short video's takes and its render fit; anything larger needs Drive. */
export const DATABASE_OBJECT_MAX_BYTES = 50 * 1024 * 1024;

export const DATABASE_OBJECT_TOO_LARGE =
  `This file is larger than ${DATABASE_OBJECT_MAX_BYTES / (1024 * 1024)} MB, which is the most Meridian keeps in its own database. Connect Google Drive in Settings, Connections to keep larger files. Nothing was stored.`;

export type DatabasePutInput = {
  organizationId: string;
  brandId: StorageScopeBrand;
  key: string;
  mimeType: string;
  bytes: Uint8Array;
  lifecycle?: AssetLifecycle;
};

type ExistingRow = { id: string; provider: string; mime_type: string; size_bytes: string | number; sha256: string; lifecycle: string };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function storedObject(input: { organizationId: string; brandId: StorageScopeBrand; key: string; mimeType: string; sha256: string; lifecycle: string; bytes: Uint8Array }): StoredObject {
  return {
    key: input.key,
    organizationId: input.organizationId,
    brandId: input.brandId,
    mimeType: input.mimeType,
    checksum: input.sha256,
    size: input.bytes.byteLength,
    version: 1,
    lifecycle: input.lifecycle as AssetLifecycle,
    bytes: input.bytes,
  };
}

export function createDatabaseObjectStore(sql: Sql) {
  async function existing(tx: Sql, organizationId: string, brandId: StorageScopeBrand, key: string): Promise<ExistingRow | null> {
    const rows = await tx<ExistingRow>`
      select id, provider, mime_type, size_bytes, sha256, lifecycle from storage_objects
      where organization_id = ${organizationId} and brand_id is not distinct from ${brandId} and name = ${key}
      limit 1
    `;
    return rows[0] ?? null;
  }

  return {
    id: "database" as const,

    async put(input: DatabasePutInput): Promise<StoredObject> {
      const key = safeStorageKey(input.key);
      if (!input.organizationId.trim()) throw new Error("No workspace is in scope, so nothing was stored.");
      if (input.bytes.byteLength === 0) throw new Error("An empty file is not stored.");
      if (input.bytes.byteLength > DATABASE_OBJECT_MAX_BYTES) throw new Error(DATABASE_OBJECT_TOO_LARGE);
      const sha256 = sha256Hex(input.bytes);
      const lifecycle = input.lifecycle ?? "stored";
      return withTransaction(sql, async (tx) => {
        const id = `sobj_${randomUUID()}`;
        const inserted = await tx<{ id: string }>`
          insert into storage_objects (
            id, organization_id, brand_id, provider, provider_file_id, name, mime_type, size_bytes, sha256, lifecycle, metadata, created_at, updated_at
          ) values (
            ${id}, ${input.organizationId}, ${input.brandId}, 'database', ${id}, ${key}, ${input.mimeType}, ${input.bytes.byteLength}, ${sha256},
            ${lifecycle}, ${JSON.stringify({ key })}::jsonb, now(), now()
          )
          on conflict (organization_id, brand_id, name) do nothing
          returning id
        `;
        if (inserted.length === 1) {
          await tx`
            insert into storage_blobs (storage_object_id, organization_id, bytes, size_bytes)
            values (${id}, ${input.organizationId}, decode(${Buffer.from(input.bytes).toString("base64")}, 'base64'), ${input.bytes.byteLength})
          `;
          return storedObject({ ...input, key, sha256, lifecycle });
        }
        // The key is taken. The same bytes are the same object (a retry); anything else is refused, never overwritten.
        const row = await existing(tx, input.organizationId, input.brandId, key);
        if (!row) throw new Error("The stored file's record is missing after its insert. Nothing was stored.");
        if (row.sha256 !== sha256 || Number(row.size_bytes) !== input.bytes.byteLength) {
          throw new Error("A different file is already stored under this name. The new file was not stored.");
        }
        return storedObject({ ...input, key, sha256, lifecycle: row.lifecycle, mimeType: row.mime_type });
      });
    },

    async get(organizationId: string, brandId: StorageScopeBrand, key: string): Promise<StoredObject | null> {
      const cleanKey = safeStorageKey(key);
      const rows = await sql<{ mime_type: string; sha256: string; lifecycle: string; body: string }>`
        select o.mime_type, o.sha256, o.lifecycle, encode(b.bytes, 'base64') as body
        from storage_objects o
        join storage_blobs b on b.storage_object_id = o.id and b.organization_id = o.organization_id
        where o.organization_id = ${organizationId} and o.brand_id is not distinct from ${brandId} and o.name = ${cleanKey}
          and o.provider = 'database'
        limit 1
      `;
      const row = rows[0];
      if (!row) return null;
      const bytes = new Uint8Array(Buffer.from(row.body, "base64"));
      // The bytes are checked against their record, so a damaged row is never served as the file.
      if (sha256Hex(bytes) !== row.sha256) throw new Error("The stored file does not match its record, so it was not read.");
      return storedObject({ organizationId, brandId, key: cleanKey, mimeType: row.mime_type, sha256: row.sha256, lifecycle: row.lifecycle, bytes });
    },

    /** Removes one database object and its bytes. Returns true when there was one. */
    async remove(organizationId: string, brandId: StorageScopeBrand, key: string): Promise<boolean> {
      const rows = await sql<{ id: string }>`
        delete from storage_objects
        where organization_id = ${organizationId} and brand_id is not distinct from ${brandId} and name = ${safeStorageKey(key)}
          and provider = 'database'
        returning id
      `;
      return rows.length > 0;
    },
  };
}

export type DatabaseObjectStore = ReturnType<typeof createDatabaseObjectStore>;
