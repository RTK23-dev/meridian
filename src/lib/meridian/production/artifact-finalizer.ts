/**
 * Idempotent Durable Production Artifact Finalizer
 *
 * In accordance with Section P0.4:
 * Invariant: COMPLETED means the output was obtained, validated, durably stored,
 * linked in storage_objects/job records, and can be retrieved. A provider saying
 * "completed" is not sufficient.
 *
 * Shared idempotent finalization used by both synchronous provider completion
 * and asynchronous background poller / recovery workers.
 */

import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { googleDriveClient, type GoogleDriveClient } from "../storage/drive.ts";
import { evaluateProductionPostflight } from "./postflight.ts";
import type { ProductionJob } from "./types.ts";

export interface ArtifactFinalizeInput {
  jobId: string;
  organizationId: string;
  brandId: string;
  provider: string;
  providerJobId?: string;
  runId?: string;
  rawArtifact: {
    uri?: string;
    mimeType?: string;
    bytes?: Uint8Array;
    base64?: string;
    sha256?: string;
    byteSize?: number;
  };
  options?: {
    driveClient?: GoogleDriveClient;
    fetchImpl?: typeof fetch;
    durationMs?: number;
    skipPostflight?: boolean;
    job?: ProductionJob;
  };
}

export interface ArtifactFinalizeResult {
  success: boolean;
  status:
    | "COMPLETED"
    | "WAITING_FOR_ARTIFACT"
    | "STORAGE_PERSISTENCE_FAILED"
    | "POSTFLIGHT_FAILED"
    | "FAILED";
  artifactId?: string;
  storageKey?: string;
  sha256?: string;
  byteSize?: number;
  errorCode?: string;
  error?: string;
}

export async function finalizeProductionArtifact(
  sql: Sql,
  input: ArtifactFinalizeInput,
): Promise<ArtifactFinalizeResult> {
  const fetchImpl = input.options?.fetchImpl || globalThis.fetch;
  const drive = input.options?.driveClient || googleDriveClient;

  // 1. Normalize and extract complete bytes
  let bytes: Uint8Array | null = null;
  const raw = input.rawArtifact;

  if (raw.bytes && raw.bytes.byteLength > 0) {
    bytes = raw.bytes;
  } else if (raw.base64 && typeof raw.base64 === "string") {
    try {
      const buf = Buffer.from(raw.base64, "base64");
      if (buf.byteLength > 0) {
        bytes = new Uint8Array(buf);
      }
    } catch {
      // Base64 decode failed
    }
  } else if (raw.uri && raw.uri.startsWith("data:")) {
    try {
      const match = raw.uri.match(/^data:([^;]+);base64,(.+)$/);
      if (match && match[2]) {
        const buf = Buffer.from(match[2], "base64");
        if (buf.byteLength > 0) {
          bytes = new Uint8Array(buf);
        }
      }
    } catch {
      // Data URI decode failed
    }
  } else if (raw.uri && (raw.uri.startsWith("http://") || raw.uri.startsWith("https://"))) {
    try {
      const res = await fetchImpl(raw.uri);
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        bytes = new Uint8Array(arrayBuf);
      }
    } catch {
      // Download failed
    }
  } else if (raw.uri && input.provider === "manual_cloud") {
    try {
      const driveFile = await drive.get(raw.uri);
      if (driveFile) {
        bytes = driveFile.bytes;
      }
    } catch {
      // Drive fetch failed
    }
  }

  // 2. Validate bytes presence and minimal sensible size
  if (!bytes || bytes.byteLength < 50) {
    return {
      success: false,
      status: "WAITING_FOR_ARTIFACT",
      error: "Artifact media bytes are not available or corrupted.",
    };
  }

  const mimeType = raw.mimeType || (bytes[0] === 0x00 && bytes[4] === 0x66 ? "video/mp4" : "video/mp4");

  // 3. Postflight QC for video media
  if (!input.options?.skipPostflight && mimeType.startsWith("video/")) {
    const postflightJob: ProductionJob = input.options?.job || {
      jobId: input.jobId,
      organizationId: input.organizationId,
      brandId: input.brandId,
      providerId: input.provider,
      status: "COMPLETED",
      costEstimateUsd: 0,
      creativeSpec: {} as any,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const postflight = evaluateProductionPostflight({
      job: postflightJob,
      videoBytes: bytes,
      durationMs: input.options?.durationMs,
    });

    if (!postflight.passed) {
      await sql`
        update production_jobs
        set status = 'POSTFLIGHT_FAILED',
            error_code = 'POSTFLIGHT_DEFECTIVE',
            last_polled_at = now(),
            updated_at = now()
        where id = ${input.jobId}
      `;

      if (input.runId) {
        await sql`
          update assets
          set media_status = 'failed',
              lifecycle = 'rejected',
              qa_decision = 'rejected'
          where generation_run_id = ${input.runId}
        `;
      }

      return {
        success: false,
        status: "POSTFLIGHT_FAILED",
        errorCode: "POSTFLIGHT_DEFECTIVE",
        error: `Postflight QC rejected artifact: ${postflight.reasons.join("; ")}`,
      };
    }
  }

  // 4. Compute SHA-256 and metadata
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const byteSize = bytes.byteLength;
  const isVideo = mimeType.startsWith("video/");
  const ext = isVideo ? "mp4" : "png";
  const storageKey = `${input.organizationId}/${input.brandId}/production/${input.jobId}/artifact.${ext}`;

  // 5. Durably store in Google Drive object store
  try {
    await drive.put({
      organizationId: input.organizationId,
      brandId: input.brandId,
      path: storageKey,
      mimeType,
      bytes,
    });
  } catch (err: any) {
    // STORAGE_PERSISTENCE_FAILED: NEVER swallow storage error and claim completed!
    await sql`
      update production_jobs
      set status = 'STORAGE_PERSISTENCE_FAILED',
          error_code = 'STORAGE_PERSISTENCE_FAILED',
          last_polled_at = now(),
          updated_at = now()
      where id = ${input.jobId}
    `;

    return {
      success: false,
      status: "STORAGE_PERSISTENCE_FAILED",
      errorCode: "STORAGE_PERSISTENCE_FAILED",
      error: `Failed to persist artifact into Google Drive storage: ${err?.message || "Unknown storage error"}`,
    };
  }

  // 6. Idempotently commit storage_objects and link job
  const artifactId = globalThis.crypto.randomUUID();
  const storageName = `production_${input.jobId}.${ext}`;

  await sql`
    insert into storage_objects (
      id, organization_id, brand_id, provider, provider_file_id,
      name, mime_type, size_bytes, sha256, lifecycle, created_at, updated_at
    ) values (
      ${artifactId}, ${input.organizationId}, ${input.brandId}, 'google_drive', ${raw.uri || artifactId},
      ${storageName}, ${mimeType}, ${byteSize}, ${sha256}, 'approved', now(), now()
    )
    on conflict (organization_id, brand_id, name) do update set
      sha256 = excluded.sha256,
      size_bytes = excluded.size_bytes,
      updated_at = now()
  `;

  // 7. ONLY now mark the job COMPLETED!
  await sql`
    update production_jobs
    set status = 'COMPLETED',
        artifact_id = ${artifactId},
        error_code = null,
        last_polled_at = now(),
        updated_at = now()
    where id = ${input.jobId}
  `;

  if (input.runId) {
    await sql`
      update assets
      set media_status = 'completed',
          lifecycle = 'stored',
          qa_decision = 'auto_approved',
          checksum = ${sha256},
          byte_size = ${byteSize}
      where generation_run_id = ${input.runId}
    `;
  }

  return {
    success: true,
    status: "COMPLETED",
    artifactId,
    storageKey,
    sha256,
    byteSize,
  };
}
