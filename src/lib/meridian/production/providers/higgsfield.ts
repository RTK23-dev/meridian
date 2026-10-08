import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
  ProviderHealth,
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

  private fetchImpl: typeof fetch;

  constructor(options?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = options?.fetchImpl || globalThis.fetch;
  }

  private getApiKey(): string | undefined {
    return process.env.HIGGSFIELD_API_KEY?.trim();
  }

  async health(): Promise<ProviderHealth> {
    const key = this.getApiKey();
    if (!key) {
      return {
        id: this.id,
        state: "NOT_CONFIGURED",
        capabilities: [],
        detail: "Higgsfield requires HIGGSFIELD_API_KEY environment variable.",
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      id: this.id,
      state: "HEALTHY",
      capabilities: ["textToVideo", "imageToVideo"],
      detail: "Higgsfield generative video API configured.",
      checkedAt: new Date().toISOString(),
    };
  }

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    const apiKey = this.getApiKey();
    const costEstimate = spec.durationTargetSeconds * this.capabilities.costPerSecondEstimateUsd;

    if (!apiKey) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "NOT_CONFIGURED",
        costEstimateUsd: costEstimate,
        error: "Higgsfield API credentials are not configured.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    try {
      const res = await this.fetchImpl("https://api.higgsfield.ai/v1/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          prompt: spec.hookLine ? `${spec.hookLine}\n${spec.script}` : spec.script,
          duration: spec.durationTargetSeconds,
          aspect_ratio: spec.aspectRatio,
        }),
      });

      if (!res.ok) {
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "FAILED",
          costEstimateUsd: costEstimate,
          error: `Higgsfield rejected submission (${res.status}): ${await res.text()}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const data = (await res.json()) as { id?: string; job_id?: string; status?: string };
      const externalId = data.id || data.job_id;

      if (!externalId) {
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "FAILED",
          costEstimateUsd: costEstimate,
          error: "Higgsfield response missing job ID.",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      return {
        jobId: externalId,
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: data.status === "completed" ? "RENDERED" : "RUNNING",
        costEstimateUsd: costEstimate,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: costEstimate,
        error: `Failed to contact Higgsfield API: ${err instanceof Error ? err.message : String(err)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async checkJobStatus(jobId: string): Promise<ProductionJob> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("Cannot check Higgsfield job status: API key not configured.");
    }

    const res = await this.fetchImpl(`https://api.higgsfield.ai/v1/status/${jobId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Higgsfield poll failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      status?: string;
      error?: string;
      video_url?: string;
    };

    if (data.error) {
      return {
        jobId,
        organizationId: "",
        brandId: "",
        creativeSpec: {} as CreativeSpec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: 0,
        error: data.error,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      jobId,
      organizationId: "",
      brandId: "",
      creativeSpec: {} as CreativeSpec,
      providerId: this.id,
      status: data.status === "completed" ? "RENDERED" : "RUNNING",
      costEstimateUsd: 0,
      outputArtifactId: data.video_url,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}
