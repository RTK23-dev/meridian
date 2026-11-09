/**
 * The store of a reference video for the engine's analyze_reference stage (Bible 5.2, 6.2 step 1 and step 7). A user uploads the example
 * reel to Meridian's store, and the request names it by its store uri (store://<key>). The engine reads the bytes once, analyses them,
 * and then releases them: Bible 6.2 says the source media is deleted within 24 hours of analysis, and the stage deletes it when the
 * analysis ends, pass or fail.
 *
 * The read goes through the engine's object store (engineObjectStore). The release deletes the Drive file the object's index row names,
 * then the index row, so the object is no longer found. A reference kept in Meridian's database (no Drive) goes with its index row.
 * brandId null is the workspace's own space (a request made without a brand). A release of an object that is already gone does nothing. Nothing here logs the
 * bytes or the file ids.
 *
 * The engine reads this through its ReferenceSource port (src/engine/analyze/reference.ts), built in the engine's composition root. The
 * engine never imports this file.
 */
import type { Sql } from "../../db.ts";
import { engineObjectStore } from "./engine-media-link.ts";

/** The reference store's shape: the read the engine's source port needs, and the release it calls once the analysis ends. */
export type EngineReferenceStore = {
  get(organizationId: string, brandId: string | null, key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  release(organizationId: string, brandId: string | null, key: string): Promise<void>;
};

/** What the reference store reads and deletes: the object store (Meridian's Drive-backed store in production, a fake in tests). */
export type ReferenceObjects = {
  get(organizationId: string, brandId: string | null, key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  /** Deletes a Drive file by its id. */
  delete(organizationId: string, fileId: string): Promise<void>;
};

/** Production's objects: Meridian's store for the read, Drive for the delete of a Drive file. */
function productionReferenceObjects(sql: Sql): ReferenceObjects {
  const store = engineObjectStore(sql);
  return {
    get: (organizationId, brandId, key) => store.get(organizationId, brandId, key),
    async delete(organizationId, fileId) {
      const { googleDriveClient } = await import("./drive.ts");
      await googleDriveClient.delete(fileId, organizationId);
    },
  };
}

/**
 * The reference store of a database. Production passes nothing: the objects are Meridian's Drive-backed store, indexed by Postgres
 * (storage_objects). A test passes its own objects, so no Drive call is made.
 */
export function engineReferenceStore(sql: Sql, objects: ReferenceObjects = productionReferenceObjects(sql)): EngineReferenceStore {
  return {
    async get(organizationId, brandId, key) {
      const object = await objects.get(organizationId, brandId, key);
      return object === null ? null : { bytes: object.bytes, mimeType: object.mimeType };
    },
    async release(organizationId, brandId, key) {
      const rows = await sql<{ provider: string; provider_file_id: string }>`
        select provider, provider_file_id from storage_objects
        where organization_id = ${organizationId} and brand_id is not distinct from ${brandId} and name = ${key}
        limit 1
      `;
      const record = rows[0];
      if (!record) return;
      // A Drive file is deleted in Drive first; a database file's bytes go with its row (storage_blobs cascades).
      if (record.provider !== "database") await objects.delete(organizationId, record.provider_file_id);
      await sql`
        delete from storage_objects
        where organization_id = ${organizationId} and brand_id is not distinct from ${brandId} and name = ${key}
      `;
    },
  };
}
