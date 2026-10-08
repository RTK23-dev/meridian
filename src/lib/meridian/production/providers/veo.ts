/**
 * Google Veo Production Provider Adapter
 *
 * Interfaces with Google Veo text-to-video / image-to-video foundation models.
 */

import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
} from "../types.ts";

export class VeoProvider implements ProductionProvider {
  readonly id = "veo";
  readonly capabilities: ProductionCapabilities = {
    textToVideo: true,
    imageToVideo: true,
    timelineEditing: false,
    voiceoverGeneration: false,
    zeroSpend: false,
    averageLatencySeconds: 90,
    costPerSecondEstimateUsd: 0.20,
  };

  private jobs = new Map<string, ProductionJob>();

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    const jobId = `prod_veo_${globalThis.crypto.randomUUID()}`;
    const costEstimate = spec.durationTargetSeconds * this.capabilities.costPerSecondEstimateUsd;

    const job: ProductionJob = {
      jobId,
      organizationId: spec.organizationId,
      brandId: spec.brandId,
      creativeSpec: spec,
      providerId: this.id,
      status: "QUEUED",
      costEstimateUsd: costEstimate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.jobs.set(jobId, job);
    return job;
  }

  async checkJobStatus(jobId: string): Promise<ProductionJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    return job;
  }
}
