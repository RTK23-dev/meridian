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

export type HiggsfieldModelDefinition = {
  path: string;
  supportedAspectRatios: string[];
  buildPayload: (spec: CreativeSpec) => Record<string, unknown>;
};

export const HIGGSFIELD_MODELS: Record<string, HiggsfieldModelDefinition> = {
  "higgsfield-video-v1": {
    path: "/higgsfield/video/v1.0",
    supportedAspectRatios: ["9:16", "16:9", "1:1"],
    buildPayload: (spec: CreativeSpec) => ({
      prompt: spec.hookLine ? `${spec.hookLine}\n${spec.script}` : spec.script,
      duration: spec.durationTargetSeconds,
      aspect_ratio: spec.aspectRatio,
    }),
  },
  "dop-v1": {
    path: "/higgsfield/dop/v1.0",
    supportedAspectRatios: ["9:16", "16:9"],
    buildPayload: (spec: CreativeSpec) => ({
      prompt: spec.hookLine ? `${spec.hookLine}\n${spec.script}` : spec.script,
      duration: spec.durationTargetSeconds,
      aspect_ratio: spec.aspectRatio,
      camera_motion: "pan_zoom_auto",
    }),
  },
  "genjutsu-v1": {
    path: "/higgsfield/genjutsu/restyle/v1.0",
    supportedAspectRatios: ["9:16", "16:9"],
    buildPayload: (spec: CreativeSpec) => ({
      prompt: spec.hookLine ? `${spec.hookLine}\n${spec.script}` : spec.script,
      duration: spec.durationTargetSeconds,
      aspect_ratio: spec.aspectRatio,
    }),
  },
  "seedance-v1": {
    path: "/seedance/v1.0",
    supportedAspectRatios: ["9:16", "16:9"],
    buildPayload: (spec: CreativeSpec) => ({
      prompt: spec.hookLine ? `${spec.hookLine}\n${spec.script}` : spec.script,
      duration: spec.durationTargetSeconds,
      aspect_ratio: spec.aspectRatio,
    }),
  },
};

export const HiggsfieldModelRegistry = HIGGSFIELD_MODELS;

export type HiggsfieldModel = keyof typeof HIGGSFIELD_MODELS;

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

  getModel(): HiggsfieldModel {
    const configured = process.env.HIGGSFIELD_MODEL?.trim();
    if (configured && configured in HIGGSFIELD_MODELS) {
      return configured as HiggsfieldModel;
    }
    return "higgsfield-video-v1";
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
      detail: `Higgsfield configured with model ${this.getModel()}.`,
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

    const model = this.getModel();
    if (spec.modelId && spec.modelId !== model) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: costEstimate,
        error: `CreativePlan model '${spec.modelId}' does not match configured provider model '${model}'.`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    const modelDef = HIGGSFIELD_MODELS[model] || HIGGSFIELD_MODELS["higgsfield-video-v1"];
    const endpoint = `https://api.higgsfield.ai${modelDef.path}`;
    const payload = modelDef.buildPayload(spec);

    try {
      const res = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Key ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorText = await res.text();
        const errorCode = res.status === 401 || res.status === 403
          ? "AUTH_FAILED"
          : res.status === 429
            ? "RATE_LIMITED"
            : "UPSTREAM_5XX";

        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "FAILED",
          costEstimateUsd: costEstimate,
          errorCode,
          error: `Higgsfield rejected submission (${res.status}) [${errorCode}]: ${errorText}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      let data: any;
      try {
        data = await res.json();
      } catch {
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "FAILED",
          costEstimateUsd: costEstimate,
          errorCode: "MALFORMED_RESPONSE",
          error: "Higgsfield returned malformed JSON response.",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const requestId = data.request_id || data.id || data.job_id;
      const statusUrl = data.status_url;
      const cancelUrl = data.cancel_url;

      if (!requestId || !statusUrl) {
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "FAILED",
          costEstimateUsd: costEstimate,
          errorCode: "MALFORMED_RESPONSE",
          error: "Higgsfield response missing required request_id or status_url contract fields.",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const status = data.status === "completed"
        ? "RENDERED"
        : data.status === "queued"
          ? "QUEUED"
          : "RUNNING";

      return {
        jobId: requestId,
        providerJobId: requestId,
        requestId,
        statusUrl,
        cancelUrl,
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status,
        costEstimateUsd: costEstimate,
        submittedAt: new Date().toISOString(),
        metadata: {
          requestId,
          statusUrl,
          cancelUrl,
          model,
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
          : `https://api.higgsfield.ai/v1/requests/${encodeURIComponent(jobId)}/status`;

    const res = await this.fetchImpl(pollUrl, {
      headers: {
        Authorization: `Key ${apiKey}`,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Higgsfield poll unauthorized (401/403): ${errText}`);
      }
      if (res.status === 429) {
        throw new Error(`Higgsfield poll rate limited (429): ${errText}`);
      }
      throw new Error(`Higgsfield poll failed (${res.status}): ${errText}`);
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new Error("Higgsfield returned malformed JSON response during polling.");
    }

    if (data.error) {
      return {
        jobId,
        providerJobId: jobId,
        organizationId: "",
        brandId: "",
        creativeSpec: {} as CreativeSpec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: 0,
        error: data.error,
        errorCode: "UPSTREAM_ERROR",
        lastPolledAt: new Date().toISOString(),
        metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const isComplete = data.status === "completed" || data.status === "succeeded";
    const isQueued = data.status === "queued";
    const isFailed = data.status === "failed";
    const videoUrl = data.video?.url || data.video_url || data.output?.url;

    return {
      jobId,
      providerJobId: jobId,
      organizationId: "",
      brandId: "",
      creativeSpec: {} as CreativeSpec,
      providerId: this.id,
      status: isComplete ? "RENDERED" : isQueued ? "QUEUED" : isFailed ? "FAILED" : "RUNNING",
      costEstimateUsd: 0,
      outputArtifactId: videoUrl,
      artifactId: videoUrl,
      lastPolledAt: new Date().toISOString(),
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
        : `https://api.higgsfield.ai/v1/requests/${encodeURIComponent(jobId)}/cancel`;

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
