import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
  ProviderHealth,
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

  async health(): Promise<ProviderHealth> {
    const baseUrl = process.env.HYPIT_BASE_URL?.trim();
    if (!baseUrl) {
      return {
        id: this.id,
        state: "NOT_CONFIGURED",
        capabilities: [],
        detail: "HYPIT_BASE_URL is not set.",
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      id: this.id,
      state: "HEALTHY",
      capabilities: ["timelineEditing", "voiceoverGeneration"],
      detail: `Hypit runtime configured at ${baseUrl}.`,
      checkedAt: new Date().toISOString(),
    };
  }

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    const baseUrl = process.env.HYPIT_BASE_URL?.trim();
    const costEstimate = spec.durationTargetSeconds * this.capabilities.costPerSecondEstimateUsd;

    if (!baseUrl) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "NOT_CONFIGURED",
        costEstimateUsd: costEstimate,
        error: "Hypit runtime is not configured (HYPIT_BASE_URL unset).",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const jobId = `prod_hypit_${globalThis.crypto.randomUUID()}`;

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
