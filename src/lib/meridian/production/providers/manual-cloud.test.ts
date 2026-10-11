import assert from "node:assert/strict";
import test from "node:test";
import { ManualCloudProvider, MANUAL_HANDOFF_TTL_MS, MANUAL_UPLOAD_SETTLE_MS, isHandoffExpired, isUploadSettled } from "./manual-cloud.ts";
import type { CreativeSpec } from "../types.ts";

// The provider depends on the Drive client. These tests use a stub with the same methods, so no Drive call is made.

type DriveFile = { fileId: string; name: string; mimeType: string; size: number; modifiedTime: string | null };

function driveStub(options: { files?: DriveFile[]; folderFails?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    health: async () => ({ status: "HEALTHY", detail: "stub" }),
    ensureOutputFolder: async (input: { jobId: string }) => {
      calls.push(`folder:${input.jobId}`);
      if (options.folderFails) throw new Error("folder create refused");
      return `https://drive.google.com/drive/folders/folder-${input.jobId}`;
    },
    put: async (input: { path: string }) => {
      calls.push(`put:${input.path}`);
      return { webViewLink: "https://drive.google.com/file/stub" };
    },
    syncDropFolder: async () => options.files ?? [],
  };
}

const spec = {
  organizationId: "org-manual",
  brandId: "brand-manual",
  title: "Kitchen demo",
  aspectRatio: "9:16",
  durationTargetSeconds: 8,
  hookLine: "Tired of smelly sponges?",
  script: "A demo.",
  scenes: [],
} as unknown as CreativeSpec;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test("the output folder is created at submit, before the handoff is announced", async () => {
  const drive = driveStub();
  const job = await new ManualCloudProvider(drive as never).submitJob(spec);
  assert.equal(job.status, "WAITING_FOR_EXTERNAL_ARTIFACT");
  assert.ok(drive.calls[0]?.startsWith("folder:"), "the folder exists before the manifest is written");
  assert.ok(job.dropFolderUrl?.includes("/folders/folder-"), "the handoff points at the output folder, not the manifest");
});

test("a submit whose output folder cannot be created is refused as a preflight failure, not left waiting", async () => {
  const job = await new ManualCloudProvider(driveStub({ folderFails: true }) as never).submitJob(spec);
  assert.equal(job.status, "PREFLIGHT_FAILED");
  assert.match(job.error ?? "", /OUTPUT_FOLDER_UNAVAILABLE/);
});

test("a file that is still uploading is not an artifact yet", async () => {
  const justNow = new Date(Date.now() - 5_000).toISOString();
  const drive = driveStub({ files: [{ fileId: "f1", name: "ad.mp4", mimeType: "video/mp4", size: 1000, modifiedTime: justNow }] });
  const job = await new ManualCloudProvider(drive as never).checkJobStatus("job-1", {
    organizationId: "org-manual",
    brandId: "brand-manual",
    createdAt: ago(60_000),
  });
  assert.equal(job.status, "WAITING_FOR_EXTERNAL_ARTIFACT");
  assert.equal(job.outputArtifactId, undefined);
  assert.equal(job.metadata?.uploadInProgress, true);
});

test("a video that has stopped changing is rendered", async () => {
  const settled = new Date(Date.now() - MANUAL_UPLOAD_SETTLE_MS - 60_000).toISOString();
  const drive = driveStub({ files: [{ fileId: "f2", name: "ad.mp4", mimeType: "video/mp4", size: 1000, modifiedTime: settled }] });
  const job = await new ManualCloudProvider(drive as never).checkJobStatus("job-2", {
    organizationId: "org-manual",
    brandId: "brand-manual",
    createdAt: ago(60_000),
  });
  assert.equal(job.status, "RENDERED");
  assert.equal(job.outputArtifactId, "f2");
});

test("a handoff nobody completes expires instead of waiting forever", async () => {
  const job = await new ManualCloudProvider(driveStub() as never).checkJobStatus("job-3", {
    organizationId: "org-manual",
    brandId: "brand-manual",
    createdAt: ago(MANUAL_HANDOFF_TTL_MS + 60_000),
  });
  assert.equal(job.status, "FAILED");
  assert.match(job.error ?? "", /MANUAL_HANDOFF_EXPIRED/);
});

test("the pure time rules: an unknown modified time is not settled, and a missing created time does not expire", () => {
  assert.equal(isUploadSettled(null, Date.now()), false);
  assert.equal(isUploadSettled(ago(MANUAL_UPLOAD_SETTLE_MS - 1000), Date.now()), false);
  assert.equal(isUploadSettled(ago(MANUAL_UPLOAD_SETTLE_MS + 1000), Date.now()), true);
  assert.equal(isHandoffExpired("not-a-date", Date.now()), false);
});
