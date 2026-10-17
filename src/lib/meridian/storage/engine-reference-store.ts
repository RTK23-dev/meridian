/**
 * The store of a reference video for the engine's analyze_reference stage (Bible 5.2, 6.2 step 1 and step 7). A user uploads the example
 * reel to Meridian's store, and the request names it by its store uri (store://<key>). The engine reads the bytes once, analyses them,
 * and then releases them: Bible 6.2 says the source media is deleted within 24 hours of analysis, and the stage deletes it when the
 * analysis ends, pass or fail.
 *
 * The read goes through the engine's object store (engineObjectStore). The release deletes the Drive file the object's index row names,
 * then the index row, so the object is no longer found. A release of an object that is already gone does nothing. Nothing here logs the
 * bytes or the file ids.
 *
 * The engine reads this through its ReferenceSource port (src/engine/analyze/reference.ts), built in the engine's composition root. The
 * engine never imports this file.
 */
import type { Sql } from "../../db.ts";
import { engineObjectStore } from "./engine-media-link.ts";
import { createSqlStorageMetadataRepository } from "./object-store.ts";

/** The reference store's shape: the read the engine's source port needs, and the release it calls once the analysis ends. */
export type EngineReferenceStore = {
  get(organizationId: string, brandId: string, key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  release(organizationId: string, brandId: string, key: string): Promise<void>;
};

/** What the reference store reads and deletes: the object store (Meridian's Drive-backed store in production, a fake in tests). */
export type ReferenceObjects = {
  get(organizationId: string, brandId: string, key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  delete(organizationId: string, fileId: string): Promise<void>;
};

/**
 * The reference store of a database. Production passes nothing: the objects are Meridian's Drive-backed store, indexed by Postgres
 * (storage_objects). A test passes its own objects, so no Drive call is made.
 */
export function engineReferenceStore(sql: Sql, objects: ReferenceObjects = engineObjectStore(sql)): EngineReferenceStore {
  return {
    async get(organizationId, brandId, key) {
      const object = await objects.get(organizationId, brandId, key);
      return object === null ? null : { bytes: object.bytes, mimeType: object.mimeType };
    },
    async release(organizationId, brandId, key) {
      const record = await createSqlStorageMetadataRepository(sql).getByKey(organizationId, brandId, key);
      if (record === null) return;
      await objects.delete(organizationId, record.providerFileId);
      await sql`
        delete from storage_objects
        where organization_id = ${organizationId} and brand_id = ${brandId} and name = ${key}
      `;
    },
  };
}
