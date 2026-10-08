/**
 * Higgsfield Provider
 *
 * Async video generation via Higgsfield AI platform:
 * - Uses Bearer-less Key auth header (Authorization: Key <api_key>)
 * - Posts to requests endpoint and retains request_id, status_url, and cancel_url
 * - Polls returned status_url or /requests/<request_id>/status
 * - Never invents job IDs or guesses unreturned endpoints
 */

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
      state: "CONFIGURED",
      capabilities: ["textToVideo", "imageToVideo"],
      detail: "Higgsfield generative video API key configured.",
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
      const res = await this.fetchImpl("https://api.higgsfield.ai/v1/requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Key ${apiKey}`,
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

      const data = (await res.json()) as {
        id?: string;
        job_id?: string;
        request_id?: string;
        status?: string;
        status_url?: string;
        cancel_url?: string;
      };

      const requestId = data.request_id || data.id || data.job_id;
      const statusUrl = data.status_url;
      const cancelUrl = data.cancel_url;
      const externalId = requestId || statusUrl;

      if (!externalId) {
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "FAILED",
          costEstimateUsd: costEstimate,
          error: "Higgsfield response missing request_id or status_url.",
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
        metadata: {
          requestId,
          statusUrl,
          cancelUrl,
        },
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

  async checkJobStatus(jobId: string, metadata?: Record<string, unknown>): Promise<ProductionJob> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("Cannot check Higgsfield job status: API key not configured.");
    }

    const pollUrl =
      typeof metadata?.statusUrl === "string"
        ? metadata.statusUrl
        : jobId.startsWith("http")
          ? jobId
          : `https://api.higgsfield.ai/requests/${encodeURIComponent(jobId)}/status`;

    const res = await this.fetchImpl(pollUrl, {
      headers: {
        Authorization: `Key ${apiKey}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Higgsfield poll failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as {
      status?: string;
      error?: string;
      video_url?: string;
      video?: { url?: string };
      output?: { url?: string };
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
        metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const isComplete = data.status === "completed" || data.status === "succeeded";
    const videoUrl = data.video?.url || data.video_url || data.output?.url;

    return {
      jobId,
      organizationId: "",
      brandId: "",
      creativeSpec: {} as CreativeSpec,
      providerId: this.id,
      status: isComplete ? "RENDERED" : data.status === "failed" ? "FAILED" : "RUNNING",
      costEstimateUsd: 0,
      outputArtifactId: videoUrl,
      metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async cancelJob(jobId: string, metadata?: Record<string, unknown>): Promise<void> {
    const apiKey = this.getApiKey();
    if (!apiKey) return;

    const cancelUrl =
      typeof metadata?.cancelUrl === "string"
        ? metadata.cancelUrl
        : `https://api.higgsfield.ai/requests/${encodeURIComponent(jobId)}/cancel`;

    try {
      await this.fetchImpl(cancelUrl, {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
        },
      });
    } catch {
      // Best-effort cancellation
    }
  }
}
