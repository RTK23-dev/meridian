/**
 * Higgsfield Production Provider Adapter
 *
 * Interfaces with Higgsfield AI generative camera and video models.
 */

import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
} from "../types.ts";

export class HiggsfieldProvider implements ProductionProvider {
  readonly id = "higgsfield";
  readonly capabilities: ProductionCapabilities = {
    textToVideo: true,
    imageToVideo: true,
    timelineEditing: false,
    voiceoverGeneration: false,
    zeroSpend: false,
    averageLatencySeconds: 60,
    costPerSecondEstimateUsd: 0.15,
  };

  private jobs = new Map<string, ProductionJob>();

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    const jobId = `prod_hf_${globalThis.crypto.randomUUID()}`;
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
