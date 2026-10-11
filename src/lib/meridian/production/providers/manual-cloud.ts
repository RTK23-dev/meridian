/**
 * ManualCloud Production Provider
 *
 * Zero-spend mode: prepares complete creative manifests and drop folders in Google Drive,
 * setting status to WAITING_FOR_EXTERNAL_ARTIFACT.
 *
 * Ingests finished MP4s dropped by editors/creators without incurring third-party API rendering fees.
 */

import { googleDriveClient, type GoogleDriveClient } from "../../storage/drive.ts";
import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
  ProviderHealth,
} from "../types.ts";

/** A finished upload is trusted only after it has stopped changing for this long. */
export const MANUAL_UPLOAD_SETTLE_MS = 2 * 60 * 1000;

/** A handoff nobody completes is failed after this long, rather than waiting forever. */
export const MANUAL_HANDOFF_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function isUploadSettled(modifiedTime: string | null, now: number): boolean {
  if (!modifiedTime) return false;
  const modified = Date.parse(modifiedTime);
  return Number.isFinite(modified) && now - modified >= MANUAL_UPLOAD_SETTLE_MS;
}

export function isHandoffExpired(createdAt: string, now: number): boolean {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && now - created >= MANUAL_HANDOFF_TTL_MS;
}

export class ManualCloudProvider implements ProductionProvider {
  readonly id = "manual_cloud";
  readonly capabilities: ProductionCapabilities = {
    textToVideo: false,
    imageToVideo: false,
    timelineEditing: true,
    voiceoverGeneration: false,
    zeroSpend: true,
    averageLatencySeconds: 3600,
    costPerSecondEstimateUsd: 0.0,
  };

  private drive: GoogleDriveClient;

  constructor(drive = googleDriveClient) {
    this.drive = drive;
  }

  async health(): Promise<ProviderHealth> {
    const driveHealth = await this.drive.health();
    if (driveHealth.status !== "HEALTHY") {
      return {
        id: this.id,
        state: driveHealth.status,
        capabilities: [],
        detail: `Google Drive is ${driveHealth.status.toLowerCase()}: ${driveHealth.detail}`,
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      id: this.id,
      state: "HEALTHY",
      capabilities: ["timelineEditing", "zeroSpend"],
      detail: "Google Drive connected for zero-spend artifact drop workflows.",
      checkedAt: new Date().toISOString(),
    };
  }

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    const driveHealth = await this.drive.health();
    if (driveHealth.status !== "HEALTHY") {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "PREFLIGHT_FAILED",
        costEstimateUsd: 0.0,
        costActualUsd: 0.0,
        error: "GOOGLE_DRIVE_NOT_CONFIGURED",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const jobId = `prod_mc_${globalThis.crypto.randomUUID()}`;

    // Prepare manifest
    const manifest = {
      jobId,
      title: spec.title,
      aspectRatio: spec.aspectRatio,
      durationTargetSeconds: spec.durationTargetSeconds,
      hookLine: spec.hookLine,
      script: spec.script,
      scenes: spec.scenes,
      instructions: "Place the finished MP4 video into the output folder named in outputFolderUrl. It is picked up once it has stopped changing.",
    };

    let dropFolderUrl: string | undefined;

    // The output folder is created at submit, so the place to put the finished file exists before anyone is asked to.
    let outputFolderUrl: string;
    try {
      outputFolderUrl = await this.drive.ensureOutputFolder({
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        jobId,
      });
    } catch (err) {
      return {
        jobId,
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "PREFLIGHT_FAILED",
        costEstimateUsd: 0.0,
        costActualUsd: 0.0,
        error: `OUTPUT_FOLDER_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    try {
      const manifestBytes = Buffer.from(JSON.stringify({ ...manifest, outputFolderUrl }, null, 2), "utf8");
      await this.drive.put({
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        path: `production/inputs/${jobId}/manifest.json`,
        mimeType: "application/json",
        bytes: manifestBytes,
      });
      dropFolderUrl = outputFolderUrl;
    } catch (err) {
      return {
        jobId,
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "PREFLIGHT_FAILED",
        costEstimateUsd: 0.0,
        costActualUsd: 0.0,
        error: `GOOGLE_DRIVE_NOT_CONFIGURED: ${err instanceof Error ? err.message : String(err)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const job: ProductionJob = {
      jobId,
      organizationId: spec.organizationId,
      brandId: spec.brandId,
      creativeSpec: spec,
      providerId: this.id,
      status: "WAITING_FOR_EXTERNAL_ARTIFACT",
      costEstimateUsd: 0.0,
      costActualUsd: 0.0,
      dropFolderUrl,
      metadata: {
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        dropFolderUrl,
        creativeSpec: spec,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return job;
  }

  async checkJobStatus(jobId: string, metadata?: Record<string, unknown>): Promise<ProductionJob> {
    const orgId = typeof metadata?.organizationId === "string" ? metadata.organizationId : "";
    const brandId = typeof metadata?.brandId === "string" ? metadata.brandId : "";
    const dropFolderUrl = typeof metadata?.dropFolderUrl === "string" ? metadata.dropFolderUrl : undefined;
    const createdAt = typeof metadata?.createdAt === "string" ? metadata.createdAt : new Date().toISOString();
    const now = Date.now();

    let status: ProductionJob["status"] = "WAITING_FOR_EXTERNAL_ARTIFACT";
    let outputArtifactId: string | undefined;
    let error: string | undefined;
    let uploadInProgress = false;

    if (isHandoffExpired(createdAt, now)) {
      status = "FAILED";
      error = "MANUAL_HANDOFF_EXPIRED: no finished file was placed in the output folder within the handoff window.";
    } else if (orgId && brandId) {
      try {
        const outputs = await this.drive.syncDropFolder({ organizationId: orgId, brandId, jobId });
        const videos = outputs.filter((f) => (f.mimeType.includes("video") || f.name.endsWith(".mp4")) && f.size > 0);
        // A file still being uploaded is not an artifact yet. Only a file that has stopped changing is taken.
        const settled = videos.find((f) => isUploadSettled(f.modifiedTime, now));
        if (settled) {
          status = "RENDERED";
          outputArtifactId = settled.fileId;
        } else if (videos.length > 0) {
          uploadInProgress = true;
        }
      } catch {
        // Keep waiting if the folder cannot be read; the handoff window still applies.
      }
    }

    return {
      jobId,
      organizationId: orgId,
      brandId,
      creativeSpec: (metadata?.creativeSpec as CreativeSpec) || ({} as CreativeSpec),
      providerId: this.id,
      status,
      costEstimateUsd: 0.0,
      costActualUsd: 0.0,
      dropFolderUrl,
      outputArtifactId,
      error,
      metadata: uploadInProgress ? { uploadInProgress: true } : undefined,
      createdAt,
      updatedAt: new Date().toISOString(),
    };
  }
}
