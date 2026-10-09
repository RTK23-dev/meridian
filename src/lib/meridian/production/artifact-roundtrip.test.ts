import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { finalizeProductionArtifact } from "./artifact-finalizer.ts";
import { createGoogleDriveObjectStore } from "../storage/object-store.ts";
import type { Sql } from "../learning/store.ts";
import type { GoogleDriveClient, DriveFileMetadata } from "../storage/drive.ts";

test("Artifact Finalizer Round-Trip: Finalize -> Drive Object Store Get -> Byte-Identical Media", async () => {
  const validMp4Bytes = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41payload-video-sample-bytes-exceeding-fifty-bytes");
  const expectedSha256 = createHash("sha256").update(validMp4Bytes).digest("hex");

  const driveStorage = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const mockDrive: GoogleDriveClient = {
    put: async (input: any): Promise<DriveFileMetadata> => {
      const fileId = `drive-file-${Date.now()}`;
      driveStorage.set(fileId, { bytes: input.bytes, mimeType: input.mimeType });
      return {
        fileId,
        name: "artifact.mp4",
        mimeType: input.mimeType,
        size: input.bytes.byteLength,
        checksum: expectedSha256,
        webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
      };
    },
    get: async (fileId: string) => {
      const stored = driveStorage.get(fileId);
      if (!stored) throw new Error("File not found on Drive");
      return {
        id: fileId,
        name: "artifact.mp4",
        mimeType: stored.mimeType,
        bytes: stored.bytes,
        sizeBytes: stored.bytes.byteLength,
        createdTime: new Date().toISOString(),
      };
    },
    delete: async () => {},
    health: async () => ({ status: "HEALTHY", detail: "ok", latencyMs: 5 }),
  } as unknown as GoogleDriveClient;

  // In-memory SQL simulation for storage_objects and production_jobs
  const dbStorageObjects = new Map<string, any>();

  const mockSql = (async (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?");
    if (query.includes("select id from production_jobs")) return [{ id: values[0] }];
    if (query.includes("insert into storage_objects")) {
      const [id, orgId, brandId, providerFileId, name, mimeType, sizeBytes, sha256] = values;
      dbStorageObjects.set(`${orgId}:${brandId}:${name}`, {
        id,
        organization_id: orgId,
        brand_id: brandId,
        provider: "google_drive",
        provider_file_id: providerFileId,
        name,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        sha256,
      });
      return [];
    }
    if (query.includes("from storage_objects")) {
      const [orgId, brandId, name] = values;
      const found = dbStorageObjects.get(`${orgId}:${brandId}:${name}`);
      return found ? [found] : [];
    }
    if (query.includes("update production_jobs")) {
      return [];
    }
    return [];
  }) as unknown as Sql;

  const jobId = "job-roundtrip-42";
  const orgId = "org-rt";
  const brandId = "brand-rt";

  // 1. Finalize production artifact
  const finalResult = await finalizeProductionArtifact(mockSql, {
    jobId,
    organizationId: orgId,
    brandId,
    provider: "google_omni",
    rawArtifact: {
      bytes: new Uint8Array(validMp4Bytes),
      mimeType: "video/mp4",
    },
    options: {
      driveClient: mockDrive,
    },
  });

  assert.equal(finalResult.success, true);
  assert.equal(finalResult.status, "COMPLETED");
  assert.equal(finalResult.sha256, expectedSha256);
  assert.ok(finalResult.storageKey);

  // 2. Lookup object using createGoogleDriveObjectStore contract
  const metadataRepo = {
    upsert: async () => {},
    getByKey: async (lookupOrg: string, lookupBrand: string, lookupKey: string) => {
      const found = dbStorageObjects.get(`${lookupOrg}:${lookupBrand}:${lookupKey}`);
      if (!found) return null;
      return {
        organizationId: found.organization_id,
        brandId: found.brand_id,
        key: found.name,
        providerFileId: found.provider_file_id,
        mimeType: found.mime_type,
        sizeBytes: Number(found.size_bytes),
        sha256: found.sha256,
        lifecycle: "stored" as const,
      };
    },
  };

  const objectStore = createGoogleDriveObjectStore(mockDrive, { metadataRepo });
  const retrieved = await objectStore.get(orgId, brandId, finalResult.storageKey!);

  assert.ok(retrieved, "Stored artifact must be retrievable via objectStore.get using returned storageKey");
  assert.equal(retrieved.key, finalResult.storageKey);
  assert.equal(retrieved.size, validMp4Bytes.byteLength);
  assert.deepEqual(Buffer.from(retrieved.bytes), validMp4Bytes, "Retrieved bytes must be identical to finalized bytes");
});
