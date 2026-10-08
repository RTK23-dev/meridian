/**
 * Hypit Production Provider Adapter
 *
 * Adapts Hypit video assembly engine to the provider-neutral ProductionProvider interface.
 */

import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
} from "../types.ts";

export class HypitProvider implements ProductionProvider {
  readonly id = "hypit";
  readonly capabilities: ProductionCapabilities = {
    textToVideo: false,
    imageToVideo: false,
    timelineEditing: true,
    voiceoverGeneration: true,
    zeroSpend: false,
    averageLatencySeconds: 120,
    costPerSecondEstimateUsd: 0.05,
  };

  private jobs = new Map<string, ProductionJob>();

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    const jobId = `prod_hypit_${globalThis.crypto.randomUUID()}`;
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
