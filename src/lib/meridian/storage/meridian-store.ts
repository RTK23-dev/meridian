/**
 * Meridian's object store for video files: Google Drive when the workspace has connected it, Meridian's own database when it has not
 * (owner direction 2026-11-09: Drive is not a step a person must take before making a video). The engine, Create and the chat connector
 * all store through this one store.
 *
 * - A new file goes to Drive when Drive is set up for the workspace, else to the database (database-store.ts, up to 50 MB a file).
 *   A Drive that is set up but failing is still Drive: its error is reported, and the file is not moved elsewhere silently.
 * - A file is read from where its record says it is (storage_objects.provider), so files kept in the database stay readable after Drive
 *   is connected, and the reverse.
 * - brandId null is the workspace's own space: a video made without a brand.
 */
import type { Sql } from "../learning/store.ts";
import { createDatabaseObjectStore, DATABASE_OBJECT_MAX_BYTES } from "./database-store.ts";
import { createGoogleDriveObjectStore, createSqlStorageMetadataRepository, type AssetLifecycle, type StorageScopeBrand, type StoredObject } from "./object-store.ts";

export type ScopedPutInput = {
  organizationId: string;
  brandId: StorageScopeBrand;
  key: string;
  mimeType: string;
  bytes: Uint8Array;
  lifecycle?: AssetLifecycle;
};

/** The part of a store this one routes to. Production: the Drive-backed object store; tests pass a fake. */
export type ScopedObjectStore = {
  put(input: ScopedPutInput): Promise<StoredObject>;
  get(organizationId: string, brandId: StorageScopeBrand, key: string): Promise<StoredObject | null>;
};

/** Where a workspace's new files go, in words a person can act on. */
export type StorageHome = { kind: "drive"; detail: string } | { kind: "database"; detail: string };

const HOME_CACHE_MS = 60_000;
const homeCache = new Map<string, { home: StorageHome; at: number }>();

/**
 * Where the workspace's new files go. Drive when it is set up (connected in Settings, or the deployment's Google credentials); the
 * database when it is not. The answer is kept for a minute per workspace, so a run of writes checks Drive once.
 */
export async function storageHomeOf(organizationId: string): Promise<StorageHome> {
  const hit = homeCache.get(organizationId);
  if (hit && Date.now() - hit.at < HOME_CACHE_MS) return hit.home;
  const { GoogleDriveClient } = await import("./drive.ts");
  const health = await new GoogleDriveClient().health(organizationId).catch((error: unknown) => ({
    status: "UNAVAILABLE" as const,
    detail: error instanceof Error ? error.message : "Google Drive could not be checked.",
  }));
  const home: StorageHome = health.status === "NOT_CONFIGURED"
    ? { kind: "database", detail: databaseHomeDetail() }
    : { kind: "drive", detail: health.status === "HEALTHY" ? "Files are kept in this workspace's Google Drive." : `Files are kept in Google Drive, which is not answering: ${health.detail}` };
  homeCache.set(organizationId, { home, at: Date.now() });
  return home;
}

export function databaseHomeDetail(): string {
  return `Files are kept in Meridian's own database, up to ${DATABASE_OBJECT_MAX_BYTES / (1024 * 1024)} MB each, because Google Drive is not connected. Connecting Drive (Settings, Connections) keeps new files there instead.`;
}

/** Forgets the cached answer, for a workspace that has just connected or disconnected Drive. */
export function forgetStorageHome(organizationId: string): void {
  homeCache.delete(organizationId);
}

async function providerOf(sql: Sql, organizationId: string, brandId: StorageScopeBrand, key: string): Promise<string | null> {
  const rows = await sql<{ provider: string }>`
    select provider from storage_objects
    where organization_id = ${organizationId} and brand_id is not distinct from ${brandId} and name = ${key}
    limit 1
  `;
  return rows[0]?.provider ?? null;
}

export function createMeridianObjectStore(
  sql: Sql,
  deps: { drive?: ScopedObjectStore; home?: (organizationId: string) => Promise<StorageHome> } = {},
) {
  const drive: ScopedObjectStore = deps.drive ?? createGoogleDriveObjectStore(undefined, { metadataRepo: createSqlStorageMetadataRepository(sql) });
  const database = createDatabaseObjectStore(sql);
  const home = deps.home ?? storageHomeOf;

  return {
    id: "meridian" as const,
    async put(input: ScopedPutInput): Promise<StoredObject> {
      const provider = await providerOf(sql, input.organizationId, input.brandId, input.key.trim());
      // A key already kept somewhere stays there: the same bytes are a retry, different bytes are refused by that store.
      if (provider === "database") return database.put(input);
      if (provider !== null) return drive.put(input);
      return (await home(input.organizationId)).kind === "drive" ? drive.put(input) : database.put(input);
    },
    async get(organizationId: string, brandId: StorageScopeBrand, key: string): Promise<StoredObject | null> {
      const provider = await providerOf(sql, organizationId, brandId, key.trim());
      if (provider === "database") return database.get(organizationId, brandId, key);
      // No record and no Drive: there is nowhere else the file could be.
      if (provider === null && (await home(organizationId)).kind === "database") return null;
      return drive.get(organizationId, brandId, key);
    },
    /** Removes a file kept in the database. Drive files are removed by their own store. */
    removeFromDatabase: (organizationId: string, brandId: StorageScopeBrand, key: string) => database.remove(organizationId, brandId, key),
    home,
  };
}

export type MeridianObjectStore = ReturnType<typeof createMeridianObjectStore>;
