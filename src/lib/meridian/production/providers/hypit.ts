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

  private fetchImpl: typeof fetch;

  constructor(options?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = options?.fetchImpl || globalThis.fetch;
  }

  private getBaseUrl(): string | undefined {
    return process.env.HYPIT_BASE_URL?.trim();
  }

  private getToken(): string | undefined {
    return process.env.HYPIT_API_TOKEN?.trim() || process.env.HYPIT_API_KEY?.trim();
  }

  async health(): Promise<ProviderHealth> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      return {
        id: this.id,
        state: "NOT_CONFIGURED",
        capabilities: [],
        detail: "HYPIT_BASE_URL is not set.",
        checkedAt: new Date().toISOString(),
      };
    }

    try {
      const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, "")}/health`, {
        headers: this.getToken() ? { Authorization: `Bearer ${this.getToken()}` } : {},
      });
      if (res.ok) {
        return {
          id: this.id,
          state: "HEALTHY",
          capabilities: ["timelineEditing", "voiceoverGeneration"],
          detail: `Hypit runtime reachable at ${baseUrl}.`,
          checkedAt: new Date().toISOString(),
        };
      }
      return {
        id: this.id,
        state: "DEGRADED",
        capabilities: [],
        detail: `Hypit runtime returned status ${res.status}.`,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        id: this.id,
        state: "UNAVAILABLE",
        capabilities: [],
        detail: `Hypit runtime unreachable at ${baseUrl}.`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    const baseUrl = this.getBaseUrl();
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

    try {
      const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.getToken() ? { Authorization: `Bearer ${this.getToken()}` } : {}),
        },
        body: JSON.stringify({
          meridianJobId: `prod_hypit_${globalThis.crypto.randomUUID()}`,
          creativeSpec: spec,
          targetDurationSeconds: spec.durationTargetSeconds,
          aspectRatio: spec.aspectRatio,
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
          error: `Hypit rejected job submission (${res.status}): ${await res.text()}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const data = (await res.json()) as { id?: string; jobId?: string; status?: string };
      const externalId = data.id || data.jobId;
      if (!externalId) {
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "FAILED",
          costEstimateUsd: costEstimate,
          error: "Hypit response missing job ID.",
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
        status: data.status === "completed" || data.status === "succeeded" ? "RENDERED" : "RUNNING",
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
        error: `Failed to connect to Hypit process: ${err instanceof Error ? err.message : String(err)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async checkJobStatus(jobId: string): Promise<ProductionJob> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      throw new Error("Cannot check Hypit job status: HYPIT_BASE_URL is not configured.");
    }

    const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/jobs/${encodeURIComponent(jobId)}`, {
      headers: this.getToken() ? { Authorization: `Bearer ${this.getToken()}` } : {},
    });

    if (!res.ok) {
      throw new Error(`Hypit status poll failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      id?: string;
      status?: string;
      error?: string;
      outputArtifactId?: string;
    };

    let status: ProductionJob["status"] = "RUNNING";
    if (data.status === "succeeded" || data.status === "completed") status = "RENDERED";
    else if (data.status === "failed") status = "FAILED";
    else if (data.status === "queued") status = "QUEUED";

    return {
      jobId,
      organizationId: "",
      brandId: "",
      creativeSpec: {} as CreativeSpec,
      providerId: this.id,
      status,
      costEstimateUsd: 0,
      outputArtifactId: data.outputArtifactId,
      error: data.error,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async cancelJob(jobId: string): Promise<void> {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) return;
    try {
      await this.fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
        headers: this.getToken() ? { Authorization: `Bearer ${this.getToken()}` } : {},
      });
    } catch {
      // Best-effort cancellation
    }
  }
}
