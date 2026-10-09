import assert from "node:assert/strict";
import test from "node:test";
import { finalizeProductionArtifact } from "./artifact-finalizer.ts";
import type { GoogleDriveClient } from "../storage/drive.ts";

test("Artifact Integrity: verifies downloaded bytes against uploaded SHA-256 before marking COMPLETED", async () => {
  const jobRows: any[] = [];
  let storedObject: any;
  const mockSql = (async (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join("?");
    if (query.includes("select id from production_jobs")) return [{ id: values[0] }];
    if (query.includes("insert into storage_objects")) {
      storedObject = { id: values[0], provider_file_id: values[3], mime_type: values[5], size_bytes: values[6], sha256: values[7] };
    }
    if (query.includes("from storage_objects")) return storedObject ? [storedObject] : [];
    if (query.includes("update production_jobs")) {
      jobRows.push({ query, values });
    }
    return [];
  }) as any;

  // Valid 100-byte PNG payload
  const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const payload = new Uint8Array(100);
  payload.set(pngHeader, 0);
  for (let i = 8; i < 100; i++) payload[i] = i;

  // 1. Successful byte round-trip
  const inMemoryStorage = new Map<string, Uint8Array>();
  const mockDrive: GoogleDriveClient = {
    async put(input: { path: string; bytes: Uint8Array; mimeType: string }) {
      const fileId = "drive-file-valid-1";
      inMemoryStorage.set(fileId, input.bytes);
      return { fileId, webViewLink: "https://drive.google.com/file/1" } as any;
    },
    async get(fileId: string) {
      const bytes = inMemoryStorage.get(fileId);
      if (!bytes) return null;
      return {
        fileId,
        name: "artifact.png",
        mimeType: "image/png",
        sizeBytes: bytes.byteLength,
        bytes,
      };
    },
  } as unknown as GoogleDriveClient;

  const result = await finalizeProductionArtifact(mockSql, {
    jobId: "job-int-1",
    organizationId: "org-int",
    brandId: "brand-int",
    provider: "google_image",
    rawArtifact: {
      bytes: payload,
    },
    options: {
      driveClient: mockDrive,
    },
  });

  assert.equal(result.success, true, "Valid byte round-trip must succeed");
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.byteSize, 100);

  // 2. Corrupted byte round-trip (e.g. storage bit-rot or byte truncation)
  const corruptDrive: GoogleDriveClient = {
    async put(_input: { path: string; bytes: Uint8Array; mimeType: string }) {
      return { fileId: "drive-file-corrupt", webViewLink: "" } as any;
    },
    async get(_fileId: string) {
      // Return altered bytes
      const corruptedBytes = new Uint8Array(payload);
      corruptedBytes[50] = (corruptedBytes[50] + 1) % 256; // flip byte
      return {
        fileId: "drive-file-corrupt",
        name: "artifact.png",
        mimeType: "image/png",
        sizeBytes: corruptedBytes.byteLength,
        bytes: corruptedBytes,
      };
    },
  } as unknown as GoogleDriveClient;

  const corruptResult = await finalizeProductionArtifact(mockSql, {
    jobId: "job-int-2",
    organizationId: "org-int",
    brandId: "brand-int",
    provider: "google_image",
    rawArtifact: {
      bytes: payload,
    },
    options: {
      driveClient: corruptDrive,
    },
  });

  assert.equal(corruptResult.success, false, "Corrupted bytes must fail closed");
  assert.equal(corruptResult.status, "STORAGE_PERSISTENCE_FAILED");
  assert.equal(corruptResult.errorCode, "ARTIFACT_INTEGRITY_MISMATCH");
});
