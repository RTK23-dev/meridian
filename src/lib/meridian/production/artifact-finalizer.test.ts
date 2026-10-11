import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { estimateBase64DecodedBytes, finalizeProductionArtifact, type ArtifactFinalizeInput } from "./artifact-finalizer.ts";
import type { Sql } from "../learning/store.ts";
import type { GoogleDriveClient } from "../storage/drive.ts";
import { WEBM_TRACK_AUDIO, WEBM_TRACK_VIDEO, webmFixture } from "../testing/webm-fixture.ts";

/** A small cap, so the one-byte-over tests stay small. The default cap is tested in artifact-download.test.ts. */
const CAP = 512;

const MP4_HEAD = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d]);

/** An MP4 of exactly `size` bytes: an ftyp box, then zero padding. */
function mp4Of(size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  out.set(MP4_HEAD.subarray(0, Math.min(size, MP4_HEAD.length)));
  return out;
}

/** A storage fake. It records every statement and every Drive write, and reads back what was written. */
function storageFixture(modality = "video") {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const drivePuts: Array<{ path: string; mimeType: string; bytes: Uint8Array }> = [];
  const driveFiles = new Map<string, Uint8Array>();
  let storedRow: Record<string, unknown> | undefined;
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    statements.push({ query, values });
    if (query.includes("select id, modality from production_jobs")) return [{ id: String(values[0]), modality }];
    if (query.includes("insert into storage_objects")) {
      storedRow = { id: values[0], provider_file_id: values[3], mime_type: values[5], size_bytes: values[6], sha256: values[7] };
      return [];
    }
    if (query.includes("select id, provider_file_id, size_bytes, sha256, mime_type")) return storedRow ? [storedRow] : [];
    return [];
  }) as unknown as Sql;
  const drive = {
    put: async (input: { path: string; mimeType: string; bytes: Uint8Array }) => {
      drivePuts.push(input);
      const fileId = `drive-${drivePuts.length}`;
      driveFiles.set(fileId, input.bytes);
      return { fileId };
    },
    get: async (fileId: string) => {
      const bytes = driveFiles.get(fileId);
      return bytes ? { fileId, bytes, name: "artifact", mimeType: "" } : null;
    },
    delete: async () => {},
    health: async () => ({ status: "CONFIGURED" as const, configured: true }),
  } as unknown as GoogleDriveClient;
  return { sql, drive, statements, drivePuts };
}

/** Runs `run` and counts the Buffer.from calls that decode a large string, which is how a base64 payload is decoded. */
async function countLargeDecodes<T>(run: () => Promise<T>): Promise<{ value: T; decodes: number }> {
  const original = Buffer.from;
  let decodes = 0;
  const counting = (value: unknown, ...rest: unknown[]) => {
    if (typeof value === "string" && value.length > 1_000) decodes += 1;
    return (original as unknown as (...args: unknown[]) => Buffer).call(Buffer, value, ...rest);
  };
  Buffer.from = counting as unknown as typeof Buffer.from;
  try {
    return { value: await run(), decodes };
  } finally {
    Buffer.from = original;
  }
}

/** The four input forms a provider artifact can arrive in, each carrying the same bytes. */
const INPUT_FORMS: Array<{ form: string; rawFor: (bytes: Uint8Array) => ArtifactFinalizeInput["rawArtifact"] }> = [
  { form: "raw bytes", rawFor: (bytes) => ({ bytes }) },
  { form: "base64", rawFor: (bytes) => ({ base64: Buffer.from(bytes).toString("base64") }) },
  { form: "data: URI", rawFor: (bytes) => ({ uri: `data:video/mp4;base64,${Buffer.from(bytes).toString("base64")}` }) },
];

function finalizeWith(sql: Sql, drive: GoogleDriveClient, rawArtifact: ArtifactFinalizeInput["rawArtifact"], provider = "google_omni") {
  return finalizeProductionArtifact(sql, {
    jobId: "job-cap-1",
    organizationId: "org-1",
    brandId: "brand-1",
    provider,
    rawArtifact,
    options: { driveClient: drive, maxBytes: CAP },
  });
}

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
    if (query.includes("select id, modality from production_jobs")) return [{ id: "job-sync-101", modality: "video" }];
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
    if (strings.join("?").includes("select id, modality from production_jobs")) return [];
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
    if (query.includes("select id, modality from production_jobs")) return [{ id: "job-fail-storage-1", modality: "video" }];
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
    if (query.includes("select id, modality from production_jobs")) return [{ id: "job-waiting-1", modality: "video" }];
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
    if (query.includes("select id, modality from production_jobs")) return [{ id: "job-retry", modality: "video" }];
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

for (const { form, rawFor } of INPUT_FORMS) {
  test(`finalizeProductionArtifact: a ${form} artifact one byte over the cap is refused before storage`, async () => {
    const fixture = storageFixture();
    const result = await finalizeWith(fixture.sql, fixture.drive, rawFor(mp4Of(CAP + 1)));
    assert.equal(result.success, false);
    assert.equal(result.status, "FAILED");
    assert.equal(result.errorCode, "ARTIFACT_TOO_LARGE");
    assert.equal(fixture.drivePuts.length, 0, "an oversized artifact never reaches Drive");
    assert.ok(!fixture.statements.some((s) => s.query.includes("insert into storage_objects")));
  });

  test(`finalizeProductionArtifact: a ${form} artifact at the cap is stored whole`, async () => {
    for (const size of [CAP - 1, CAP]) {
      const fixture = storageFixture();
      const bytes = mp4Of(size);
      const result = await finalizeWith(fixture.sql, fixture.drive, rawFor(bytes));
      assert.ok(result.success, `size ${size}: ${JSON.stringify(result)}`);
      assert.equal(result.byteSize, size);
      assert.equal(fixture.drivePuts[0]?.bytes.byteLength, size);
    }
  });
}

test("finalizeProductionArtifact: an encoded payload over the cap is refused before it is decoded", async () => {
  // 16 million characters decode to about 12 MB, far over the cap. The refusal must come from the encoded length alone.
  const huge = "A".repeat(4 * 4_000_000);
  const forms: ArtifactFinalizeInput["rawArtifact"][] = [{ base64: huge }, { uri: `data:video/mp4;base64,${huge}` }];
  for (const rawArtifact of forms) {
    const fixture = storageFixture();
    const { value: result, decodes } = await countLargeDecodes(() => finalizeWith(fixture.sql, fixture.drive, rawArtifact));
    assert.equal(result.errorCode, "ARTIFACT_TOO_LARGE", Object.keys(rawArtifact).join(","));
    assert.equal(decodes, 0, `${Object.keys(rawArtifact).join(",")} must not be decoded`);
    assert.equal(fixture.drivePuts.length, 0);
  }
});

test("finalizeProductionArtifact: a Drive artifact over the cap is refused before QC or storage", async () => {
  const fixture = storageFixture();
  const drive = {
    put: async () => {
      throw new Error("an oversized artifact must not be stored");
    },
    get: async () => ({ fileId: "drive-big", bytes: mp4Of(CAP + 1), name: "big.mp4", mimeType: "video/mp4" }),
    delete: async () => {},
    health: async () => ({ status: "CONFIGURED" as const, configured: true }),
  } as unknown as GoogleDriveClient;
  const result = await finalizeWith(fixture.sql, drive, { uri: "drive-big" }, "manual_cloud");
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "ARTIFACT_TOO_LARGE");
});

test("finalizeProductionArtifact: an HTTP artifact over the cap is refused with the same code", async () => {
  const fixture = storageFixture();
  const fetchImpl = (async () => new Response(mp4Of(CAP + 1), { status: 200 })) as unknown as typeof fetch;
  const result = await finalizeProductionArtifact(fixture.sql, {
    jobId: "job-cap-1",
    organizationId: "org-1",
    brandId: "brand-1",
    provider: "higgsfield",
    rawArtifact: { uri: "https://cdn.example.com/output.mp4" },
    options: { driveClient: fixture.drive, fetchImpl, maxBytes: CAP },
  });
  assert.equal(result.errorCode, "ARTIFACT_TOO_LARGE");
  assert.equal(fixture.drivePuts.length, 0);
});

test("estimateBase64DecodedBytes is exact for canonical base64 at every padding length", () => {
  for (let size = 0; size <= 64; size += 1) {
    assert.equal(estimateBase64DecodedBytes(Buffer.from(new Uint8Array(size).fill(7)).toString("base64")), size, `size ${size}`);
  }
});

/** Bytes that begin with the signature `head` and are zero-padded to `size`. The detector reads only the signature. */
function withHead(head: string | number[], size = 64): Uint8Array<ArrayBuffer> {
  const bytes = typeof head === "string" ? [...head].map((c) => c.charCodeAt(0)) : head;
  const out = new Uint8Array(size);
  out.set(bytes);
  return out;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];
const GIF89A = "GIF89a";
const PDF = "%PDF-1.7";
/** A WebM whose Tracks hold one video track, so postflight accepts it as a video container. */
const WEBM_VIDEO = webmFixture({ tracks: [WEBM_TRACK_VIDEO] });
/** A WebM whose only track is audio. It is detected as video, and postflight refuses it for lacking a video track. */
const WEBM_AUDIO_ONLY = webmFixture({ tracks: [WEBM_TRACK_AUDIO] });

test("finalizeProductionArtifact: each format a job's modality produces is stored under its canonical extension", async () => {
  const cases = [
    { modality: "video", bytes: mp4Of(64), ext: "mp4", mimeType: "video/mp4", skipPostflight: false },
    { modality: "video", bytes: WEBM_VIDEO, ext: "webm", mimeType: "video/webm", skipPostflight: false },
    // An animated GIF is video for production matching, so it completes a video job and is stored as a GIF.
    { modality: "video", bytes: withHead(GIF89A), ext: "gif", mimeType: "image/gif", skipPostflight: false },
    { modality: "image", bytes: withHead(PNG), ext: "png", mimeType: "image/png", skipPostflight: false },
    { modality: "image", bytes: withHead(JPEG), ext: "jpg", mimeType: "image/jpeg", skipPostflight: false },
    { modality: "image", bytes: withHead(WEBP), ext: "webp", mimeType: "image/webp", skipPostflight: false },
  ];
  for (const c of cases) {
    const fixture = storageFixture(c.modality);
    const result = await finalizeProductionArtifact(fixture.sql, {
      jobId: "job-format-1",
      organizationId: "org-1",
      brandId: "brand-1",
      provider: "google_omni",
      rawArtifact: { bytes: c.bytes },
      options: { driveClient: fixture.drive, skipPostflight: c.skipPostflight },
    });
    assert.ok(result.success, `${c.ext}: ${JSON.stringify(result)}`);
    assert.equal(result.status, "COMPLETED", c.ext);
    assert.equal(result.mimeType, c.mimeType, c.ext);
    assert.equal(fixture.drivePuts[0]?.path, `org-1/brand-1/production/job-format-1/artifact.${c.ext}`, c.ext);
    assert.ok(fixture.statements.some((s) => s.query.includes("status = 'COMPLETED'")), `${c.ext} marks the job COMPLETED`);
  }
});

test("finalizeProductionArtifact: an artifact of the wrong kind for the job's modality fails the job and never completes", async () => {
  const cases = [
    { modality: "image", bytes: withHead(PDF), label: "a PDF in an image job" },
    { modality: "image", bytes: withHead(GIF89A), label: "a GIF in an image job" },
    { modality: "image", bytes: mp4Of(64), label: "a video in an image job" },
    { modality: "image", bytes: WEBM_VIDEO, label: "a WebM video in an image job" },
    { modality: "video", bytes: withHead(PNG), label: "a PNG in a video job" },
    { modality: "video", bytes: withHead(JPEG), label: "a JPEG in a video job" },
    { modality: "video", bytes: withHead(PDF), label: "a PDF in a video job" },
    { modality: "audio", bytes: mp4Of(64), label: "any artifact in an audio job, which has no detector yet" },
  ];
  for (const c of cases) {
    const fixture = storageFixture(c.modality);
    const result = await finalizeProductionArtifact(fixture.sql, {
      jobId: "job-mismatch-1",
      organizationId: "org-1",
      brandId: "brand-1",
      provider: "google_omni",
      rawArtifact: { bytes: c.bytes },
      options: { driveClient: fixture.drive },
    });
    assert.equal(result.success, false, c.label);
    assert.equal(result.status, "FAILED", c.label);
    assert.equal(result.errorCode, "ARTIFACT_MODALITY_MISMATCH", c.label);
    assert.equal(fixture.drivePuts.length, 0, `${c.label}: nothing is stored`);
    assert.ok(!fixture.statements.some((s) => s.query.includes("status = 'COMPLETED'")), `${c.label}: never COMPLETED`);
    const failedRow = fixture.statements.find((s) => s.query.includes("error_code = 'ARTIFACT_MODALITY_MISMATCH'"));
    assert.ok(failedRow, `${c.label}: the job row is failed with the code`);
    assert.match(failedRow.query, /organization_id = .*brand_id = /s, `${c.label}: the failure is tenant scoped`);
  }
});

test("finalizeProductionArtifact: a WebM with no video track fails postflight in a video job and is never stored", async () => {
  const fixture = storageFixture("video");
  const result = await finalizeProductionArtifact(fixture.sql, {
    jobId: "job-webm-audio-1",
    organizationId: "org-1",
    brandId: "brand-1",
    provider: "google_omni",
    rawArtifact: { bytes: WEBM_AUDIO_ONLY },
    options: { driveClient: fixture.drive },
  });
  assert.equal(result.success, false);
  assert.equal(result.status, "POSTFLIGHT_FAILED");
  assert.equal(result.errorCode, "POSTFLIGHT_DEFECTIVE");
  assert.equal(fixture.drivePuts.length, 0, "nothing is stored");
  assert.ok(!fixture.statements.some((s) => s.query.includes("status = 'COMPLETED'")), "never COMPLETED");
});

test("finalizeProductionArtifact: a WebM with a video track completes a video job through postflight", async () => {
  const fixture = storageFixture("video");
  const result = await finalizeProductionArtifact(fixture.sql, {
    jobId: "job-webm-video-1",
    organizationId: "org-1",
    brandId: "brand-1",
    provider: "google_omni",
    rawArtifact: { bytes: WEBM_VIDEO },
    options: { driveClient: fixture.drive },
  });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.mimeType, "video/webm");
  assert.equal(fixture.drivePuts[0]?.path, "org-1/brand-1/production/job-webm-video-1/artifact.webm");
});
