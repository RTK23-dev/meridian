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
} from "../types.ts";

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
  private jobs = new Map<string, ProductionJob>();

  constructor(drive = googleDriveClient) {
    this.drive = drive;
  }

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
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
      instructions: "Place the finished MP4 video artifact into the output folder.",
    };

    let dropFolderUrl: string | undefined;

    try {
      // Attempt to write manifest into Drive drop folder
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
      const uploadRes = await this.drive.put({
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        path: `production/inputs/${jobId}/manifest.json`,
        mimeType: "application/json",
        bytes: manifestBytes,
      });
      dropFolderUrl = uploadRes.webViewLink;
    } catch {
      // When Drive is disconnected or offline, fallback without crashing
      dropFolderUrl = undefined;
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.jobs.set(jobId, job);
    return job;
  }

  async checkJobStatus(jobId: string): Promise<ProductionJob> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Check if output artifact has been uploaded to Drive
    try {
      const outputs = await this.drive.syncDropFolder({
        organizationId: job.organizationId,
        brandId: job.brandId,
        jobId,
      });

      const videoFile = outputs.find((f) => f.mimeType.includes("video") || f.name.endsWith(".mp4"));
      if (videoFile) {
        job.status = "RENDERED";
        job.outputArtifactId = videoFile.fileId;
        job.updatedAt = new Date().toISOString();
      }
    } catch {
      // Keep existing waiting status if Drive scan fails
    }

    return job;
  }
}
