import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { finalizeProductionArtifact } from "./artifact-finalizer.ts";
import type { Sql } from "../learning/store.ts";
import type { GoogleDriveClient } from "../storage/drive.ts";

test("finalizeProductionArtifact: persists valid media bytes to Drive and commits COMPLETED", async () => {
  const validMp4Bytes = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41payload-video-sample-bytes");
  const expectedSha256 = createHash("sha256").update(validMp4Bytes).digest("hex");

  const storedDrivePuts: Array<{ path: string; bytes: Uint8Array; mimeType: string }> = [];
  const mockDrive = {
    put: async (input: any) => {
      storedDrivePuts.push(input);
      return { fileId: "drive-file-123", webViewLink: "https://drive.google.com/test" };
    },
    get: async () => ({
      fileId: "drive-file-123",
      bytes: new Uint8Array(validMp4Bytes),
      name: "artifact.mp4",
      mimeType: "video/mp4",
    }),
    delete: async () => {},
    health: async () => ({ status: "CONFIGURED" as const, configured: true }),
  };

  const queries: string[] = [];
  let stored: { id: string; provider_file_id: string; size_bytes: number; sha256: string; mime_type: string } | undefined;
  const mockSql = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes("select id from production_jobs")) return [{ id: "job-sync-101" }];
    if (query.includes("insert into storage_objects")) {
      const values = _values as unknown[];
      stored = { id: String(values[0]), provider_file_id: String(values[3]), mime_type: String(values[5]), size_bytes: Number(values[6]), sha256: String(values[7]) };
    }
    if (query.includes("select id, provider_file_id, size_bytes, sha256, mime_type")) return stored ? [stored] : [];
    return [];
  }) as unknown as Sql;

  const result = await finalizeProductionArtifact(mockSql, {
    jobId: "job-sync-101",
    organizationId: "org-1",
    brandId: "brand-1",
    provider: "google_omni",
    runId: "run-1",
    rawArtifact: {
      bytes: new Uint8Array(validMp4Bytes),
      mimeType: "video/mp4",
    },
    options: {
      driveClient: mockDrive as unknown as GoogleDriveClient,
    },
  });

  assert.ok(result.success, JSON.stringify(result));
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.sha256, expectedSha256);
  assert.equal(result.byteSize, validMp4Bytes.byteLength);
  assert.equal(result.mimeType, "video/mp4");
  assert.equal(storedDrivePuts.length, 1);
  assert.equal(storedDrivePuts[0].path, "org-1/brand-1/production/job-sync-101/artifact.mp4");
  assert.ok(queries.some((q) => q.includes("insert into storage_objects")));
  assert.ok(queries.some((q) => q.includes("status = 'COMPLETED'")));
  assert.ok(queries.filter((q) => q.includes("update production_jobs")).every((q) =>
    q.includes("organization_id = ?") && q.includes("brand_id = ?"),
  ), "Every job transition must be tenant scoped.");
});

test("finalizeProductionArtifact: refuses a job outside the supplied tenant before storage", async () => {
  let drivePuts = 0;
  const sql = (async (strings: TemplateStringsArray) => {
    if (strings.join("?").includes("select id from production_jobs")) return [];
    return [];
  }) as unknown as Sql;
  const drive = {
    put: async () => { drivePuts += 1; return { fileId: "unexpected" }; },
    get: async () => null,
    delete: async () => {},
    health: async () => ({ status: "CONFIGURED" as const, configured: true }),
  };
  const result = await finalizeProductionArtifact(sql, {
    jobId: "another-tenant-job", organizationId: "org-1", brandId: "brand-1", provider: "google_omni",
    rawArtifact: { bytes: new Uint8Array(Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41payload-video-sample-bytes")) },
    options: { driveClient: drive as unknown as GoogleDriveClient },
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "PRODUCTION_JOB_SCOPE_MISMATCH");
  assert.equal(drivePuts, 0);
});

test("finalizeProductionArtifact: Drive storage failure fails closed with STORAGE_PERSISTENCE_FAILED", async () => {
  const validMp4Bytes = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41payload-video-sample-bytes");

  const mockFailingDrive = {
    put: async () => {
      throw new Error("Google Drive 503 Service Unavailable");
    },
    get: async () => null,
    delete: async () => {},
    health: async () => ({ status: "CONFIGURED" as const, configured: true }),
  };

  const queries: string[] = [];
  const mockSql = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes("select id from production_jobs")) return [{ id: "job-fail-storage-1" }];
    return [];
  }) as unknown as Sql;

  const result = await finalizeProductionArtifact(mockSql, {
    jobId: "job-fail-storage-1",
    organizationId: "org-1",
    brandId: "brand-1",
    provider: "google_omni",
    rawArtifact: {
      bytes: new Uint8Array(validMp4Bytes),
      mimeType: "video/mp4",
    },
    options: {
      driveClient: mockFailingDrive as unknown as GoogleDriveClient,
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "STORAGE_PERSISTENCE_FAILED");
  assert.equal(result.errorCode, "STORAGE_PERSISTENCE_FAILED");
  // Crucial invariant: never mark COMPLETED when storage fails!
  assert.ok(!queries.some((q) => q.includes("status = 'COMPLETED'")));
  assert.ok(queries.some((q) => q.includes("status = 'STORAGE_PERSISTENCE_FAILED'")));
});

test("finalizeProductionArtifact: missing bytes returns WAITING_FOR_ARTIFACT", async () => {
  const mockDrive = {
    put: async () => ({ fileId: "1", webViewLink: "" }),
    get: async () => null,
    delete: async () => {},
    health: async () => ({ status: "CONFIGURED" as const, configured: true }),
  };

  const queries: string[] = [];
  const mockSql = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes("select id from production_jobs")) return [{ id: "job-waiting-1" }];
    return [];
  }) as unknown as Sql;

  const result = await finalizeProductionArtifact(mockSql, {
    jobId: "job-waiting-1",
    organizationId: "org-1",
    brandId: "brand-1",
    provider: "google_omni",
    rawArtifact: {},
    options: {
      driveClient: mockDrive as unknown as GoogleDriveClient,
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "WAITING_FOR_ARTIFACT");
});

test("finalizeProductionArtifact: verified retry reuses the stored artifact", async () => {
  const bytes = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41payload-video-sample-bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let puts = 0;
  let gets = 0;
  const drive = {
    put: async () => { puts += 1; return { fileId: "unexpected" }; },
    get: async (fileId: string) => {
      gets += 1;
      assert.equal(fileId, "drive-existing");
      return { fileId, bytes: new Uint8Array(bytes), name: "artifact.mp4", mimeType: "video/mp4" };
    },
    delete: async () => {},
    health: async () => ({ status: "CONFIGURED" as const, configured: true }),
  };
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("select id from production_jobs")) return [{ id: "job-retry" }];
    if (query.includes("from storage_objects")) {
      return [{ id: "artifact-existing", provider_file_id: "drive-existing", sha256, size_bytes: bytes.byteLength, mime_type: "video/mp4" }];
    }
    return [];
  }) as unknown as Sql;

  const result = await finalizeProductionArtifact(sql, {
    jobId: "job-retry",
    organizationId: "org-1",
    brandId: "brand-1",
    provider: "google_omni",
    rawArtifact: { bytes: new Uint8Array(bytes) },
    options: { driveClient: drive as unknown as GoogleDriveClient },
  });

  assert.ok(result.success, JSON.stringify(result));
  assert.equal(result.artifactId, "artifact-existing");
  assert.equal(puts, 0, "Retry must not create another Drive object");
  assert.equal(gets, 1, "Existing object must be downloaded and verified");
});
