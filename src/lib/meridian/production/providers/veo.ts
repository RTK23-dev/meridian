import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
  ProviderHealth,
} from "../types.ts";

export type VideoCapability = {
  supportedDurations: number[];
  supportedAspectRatios: string[];
  supportedResolutions: string[];
  imageToVideo: boolean;
  videoToVideo: boolean;
  referenceImages: boolean;
  nativeAudio: boolean;
};

export const VEO_MODEL_CAPABILITIES: Record<string, VideoCapability> = {
  "veo-3.1-generate-preview": {
    supportedDurations: [8],
    supportedAspectRatios: ["9:16", "16:9"],
    supportedResolutions: ["720p", "1080p"],
    imageToVideo: false,
    videoToVideo: false,
    referenceImages: false,
    nativeAudio: true,
  },
  "veo-2.0-generate-001": {
    supportedDurations: [5, 6, 7, 8],
    supportedAspectRatios: ["9:16", "16:9"],
    supportedResolutions: ["720p"],
    imageToVideo: false,
    videoToVideo: false,
    referenceImages: false,
    nativeAudio: false,
  },
};

export class VeoProvider implements ProductionProvider {
  readonly id = "veo";
  readonly capabilities: ProductionCapabilities = {
    textToVideo: true,
    imageToVideo: false,
    timelineEditing: false,
    voiceoverGeneration: false,
    zeroSpend: false,
    averageLatencySeconds: 90,
    costPerSecondEstimateUsd: 0.20,
  };

  private fetchImpl: typeof fetch;

  constructor(options?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = options?.fetchImpl || globalThis.fetch;
  }

  private getApiKey(): string | undefined {
    return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  }

  private getModel(): string {
    return process.env.MERIDIAN_VEO_MODEL?.trim() || "veo-2.0-generate-001";
  }

  getModelCapability(model = this.getModel()): VideoCapability {
    return VEO_MODEL_CAPABILITIES[model] || VEO_MODEL_CAPABILITIES["veo-2.0-generate-001"] || VEO_MODEL_CAPABILITIES["veo-3.1-generate-preview"];
  }

  async health(): Promise<ProviderHealth> {
    const key = this.getApiKey();
    if (!key) {
      return {
        id: this.id,
        state: "NOT_CONFIGURED",
        capabilities: [],
        detail: "Google Veo requires GEMINI_API_KEY or GOOGLE_API_KEY environment variable.",
        checkedAt: new Date().toISOString(),
      };
    }

    const model = this.getModel();
    const { modelCapabilityRegistry } = await import("../registry.ts");
    const lifecycle = modelCapabilityRegistry.checkModelLifecycle(model);

    if (!lifecycle.usable) {
      return {
        id: this.id,
        state: "UNAVAILABLE",
        capabilities: [],
        detail: lifecycle.warning || `Veo model '${model}' is unavailable.`,
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      id: this.id,
      state: "CONFIGURED",
      capabilities: ["textToVideo"],
      detail: `Configured with model ${model}.${lifecycle.warning ? ` Warning: ${lifecycle.warning}` : ""}`,
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
        error: "Google Veo API credentials are not configured.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const model = this.getModel();
    const capability = this.getModelCapability(model);

    if (!capability.supportedDurations.includes(spec.durationTargetSeconds)) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: costEstimate,
        error: `Unsupported duration: ${spec.durationTargetSeconds}s for model '${model}'. Veo requires exact duration in [${capability.supportedDurations.join(", ")}] seconds.`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    if (!capability.supportedAspectRatios.includes(spec.aspectRatio)) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: costEstimate,
        error: `Unsupported aspect ratio: ${spec.aspectRatio} for model '${model}'. Supported ratios: ${capability.supportedAspectRatios.join(", ")}.`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const prompt = spec.hookLine ? `${spec.hookLine}\n${spec.script}` : spec.script;

    try {
      const res = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            instances: [
              {
                prompt,
              },
            ],
            parameters: {
              aspectRatio: spec.aspectRatio,
              durationSeconds: spec.durationTargetSeconds || 5,
            },
          }),
        },
      );

      if (!res.ok) {
        const errorText = await res.text();
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "FAILED",
          costEstimateUsd: costEstimate,
          error: `Veo API submission rejected (${res.status}): ${errorText}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const operation = (await res.json()) as { name?: string; done?: boolean; error?: { message: string } };
      if (!operation.name) {
        return {
          jobId: "",
          organizationId: spec.organizationId,
          brandId: spec.brandId,
          creativeSpec: spec,
          providerId: this.id,
          status: "FAILED",
          costEstimateUsd: costEstimate,
          error: "Veo API returned response without operation name.",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      return {
        jobId: operation.name,
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: operation.done ? "RENDERED" : "RUNNING",
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
        error: `Failed to connect to Veo API: ${err instanceof Error ? err.message : String(err)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async checkJobStatus(jobId: string): Promise<ProductionJob> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("Cannot check Veo job status: API key not configured.");
    }

    const res = await this.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/${jobId}`,
      {
        headers: {
          "x-goog-api-key": apiKey,
        },
      },
    );

    if (!res.ok) {
      throw new Error(`Veo polling failed (${res.status}): ${await res.text()}`);
    }

    const operation = (await res.json()) as {
      name?: string;
      done?: boolean;
      error?: { message: string };
      response?: {
        generatedVideos?: Array<{ video?: { uri?: string } }>;
        generateVideoResponse?: {
          generatedSamples?: Array<{ video?: { uri?: string } }>;
        };
      };
    };

    if (operation.error) {
      return {
        jobId,
        organizationId: "",
        brandId: "",
        creativeSpec: {} as CreativeSpec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: 0,
        error: operation.error.message,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const videoUri =
      operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
      operation.response?.generatedVideos?.[0]?.video?.uri;

    return {
      jobId,
      organizationId: "",
      brandId: "",
      creativeSpec: {} as CreativeSpec,
      providerId: this.id,
      status: operation.done ? "RENDERED" : "RUNNING",
      costEstimateUsd: 0,
      outputArtifactId: videoUri,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}
