/**
 * Google Gemini Omni Video Provider
 *
 * Implements Google's Gemini Omni video generation/editing via the official
 * Gemini Interactions API contract:
 * POST https://generativelanguage.googleapis.com/v1beta/interactions
 * Model: gemini-omni-1.1-flash
 *
 * Distinct adapter from Veo (which uses predictLongRunning).
 */

import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
  ProviderHealth,
} from "../types.ts";
import { modelCapabilityRegistry } from "../registry.ts";

export interface OmniInteractionStep {
  step_id?: string;
  status?: string;
  outputs?: Array<{
    type?: string;
    uri?: string;
    mime_type?: string;
    data?: string;
  }>;
}

export interface OmniInteractionResponse {
  interaction_id?: string;
  id?: string;
  status?: string;
  state?: string;
  steps?: OmniInteractionStep[];
  error?: {
    code?: number;
    message?: string;
  };
}

export class GeminiOmniVideoProvider implements ProductionProvider {
  readonly id = "google_omni";
  readonly capabilities: ProductionCapabilities = {
    textToVideo: true,
    imageToVideo: true,
    timelineEditing: true,
    voiceoverGeneration: true,
    zeroSpend: false,
    averageLatencySeconds: 45,
    costPerSecondEstimateUsd: 0.15,
  };

  private fetchImpl: typeof fetch;

  constructor(options?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = options?.fetchImpl || globalThis.fetch;
  }

  private getApiKey(): string | undefined {
    return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  }

  private getModel(): string {
    return process.env.MERIDIAN_OMNI_MODEL?.trim() || "gemini-omni-1.1-flash";
  }

  async health(): Promise<ProviderHealth> {
    const key = this.getApiKey();
    if (!key) {
      return {
        id: this.id,
        state: "NOT_CONFIGURED",
        capabilities: [],
        detail: "Google Gemini Omni requires GEMINI_API_KEY or GOOGLE_API_KEY environment variable.",
        checkedAt: new Date().toISOString(),
      };
    }

    const model = this.getModel();
    const lifecycle = modelCapabilityRegistry.checkModelLifecycle(model);

    if (!lifecycle.usable) {
      return {
        id: this.id,
        state: "UNAVAILABLE",
        capabilities: [],
        detail: lifecycle.warning || `Model '${model}' is unavailable.`,
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      id: this.id,
      state: "CONFIGURED",
      capabilities: ["textToVideo", "imageToVideo", "timelineEditing"],
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
        error: "Google Gemini Omni API credentials are not configured.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const model = this.getModel();
    const lifecycle = modelCapabilityRegistry.checkModelLifecycle(model);
    if (!lifecycle.usable) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: costEstimate,
        error: lifecycle.warning || `Model '${model}' is unavailable.`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const prompt = spec.hookLine ? `${spec.hookLine}\n${spec.script}` : spec.script;
    const meridianJobId = `job-omni-${globalThis.crypto.randomUUID()}`;

    const payload = {
      model,
      input: {
        prompt,
        task: "text-to-video",
        parameters: {
          aspect_ratio: spec.aspectRatio,
          duration_seconds: spec.durationTargetSeconds || 5,
        },
      },
    };

    try {
      const res = await this.fetchImpl(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(payload),
        }
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
          error: `Interactions API error (${res.status}): ${errorText.slice(0, 300)}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const body = (await res.json()) as OmniInteractionResponse;
      const interactionId = body.interaction_id || body.id || `interactions/${meridianJobId}`;

      // Check if steps completed immediately
      const completedStep = body.steps?.find((s) => s.status === "COMPLETED");
      const videoOutput = completedStep?.outputs?.find((o) => o.type === "video" || o.uri?.endsWith(".mp4"));

      const isCompleted = body.status === "COMPLETED" || !!videoOutput;

      return {
        jobId: meridianJobId,
        meridianJobId,
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        providerJobId: interactionId,
        operationName: interactionId,
        status: isCompleted ? "COMPLETED" : "RUNNING",
        costEstimateUsd: costEstimate,
        outputArtifactId: videoOutput?.uri,
        metadata: {
          model,
          apiFamily: "interactions",
          interactionId,
          videoUri: videoOutput?.uri,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: costEstimate,
        error: `Failed to submit Omni job: ${err.message}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async checkJobStatus(jobId: string, metadata?: Record<string, unknown>): Promise<ProductionJob> {
    const apiKey = this.getApiKey();
    const interactionId = (metadata?.interactionId as string) || (metadata?.operationName as string) || jobId;

    if (!apiKey) {
      return {
        jobId,
        organizationId: "",
        brandId: "",
        creativeSpec: {} as any,
        providerId: this.id,
        status: "NOT_CONFIGURED",
        costEstimateUsd: 0,
        error: "Google Gemini Omni API credentials not configured.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    try {
      const cleanId = interactionId.startsWith("interactions/")
        ? interactionId
        : `interactions/${interactionId}`;

      const res = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/${cleanId}`,
        {
          headers: {
            "x-goog-api-key": apiKey,
          },
        }
      );

      if (!res.ok) {
        const errorText = await res.text();
        return {
          jobId,
          organizationId: "",
          brandId: "",
          creativeSpec: {} as any,
          providerId: this.id,
          status: "FAILED",
          costEstimateUsd: 0,
          error: `Failed to poll Omni interaction (${res.status}): ${errorText.slice(0, 300)}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const body = (await res.json()) as OmniInteractionResponse;
      const completedStep = body.steps?.find((s) => s.status === "COMPLETED");
      const videoOutput = completedStep?.outputs?.find((o) => o.type === "video" || o.uri?.endsWith(".mp4"));

      if (body.error) {
        return {
          jobId,
          organizationId: "",
          brandId: "",
          creativeSpec: {} as any,
          providerId: this.id,
          status: "FAILED",
          costEstimateUsd: 0,
          error: body.error.message || "Omni interaction failed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const isDone = body.status === "COMPLETED" || body.state === "COMPLETED" || !!videoOutput;

      return {
        jobId,
        organizationId: "",
        brandId: "",
        creativeSpec: {} as any,
        providerId: this.id,
        providerJobId: interactionId,
        status: isDone ? "COMPLETED" : "RUNNING",
        costEstimateUsd: 0,
        outputArtifactId: videoOutput?.uri,
        metadata: {
          ...metadata,
          interactionId,
          videoUri: videoOutput?.uri,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      return {
        jobId,
        organizationId: "",
        brandId: "",
        creativeSpec: {} as any,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: 0,
        error: `Network error polling Omni job: ${err.message}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }
}

export const geminiOmniVideoProvider = new GeminiOmniVideoProvider();
