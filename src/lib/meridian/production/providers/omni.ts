/**
 * Google Gemini Omni Video Provider
 *
 * Implements Google's Gemini Omni video generation/editing via the official
 * Gemini Interactions API REST contract:
 * POST https://generativelanguage.googleapis.com/v1beta/interactions
 * Model: gemini-omni-1.1-flash
 *
 * Request contract:
 * - Text-to-video: { model, input: string, response_format: { type: "video", aspect_ratio: "9:16" } }
 * - Image-to-video: { model, input: [...], generation_config: { video_config: { task: "image-to-video" } }, response_format: { type: "video", aspect_ratio: "9:16" } }
 *
 * Response contract:
 * - status: "completed" | "in_progress" | "failed"
 * - steps[].type === "model_output" -> content[].type === "video" -> mime_type & Base64 data
 * - Materializes bytes, verifies SHA-256 & byte size.
 */

import { createHash } from "node:crypto";
import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
  ProviderHealth,
} from "../types.ts";
import { modelCapabilityRegistry } from "../registry.ts";

export interface OmniInteractionContent {
  type?: string;
  mime_type?: string;
  data?: string;
  uri?: string;
}

export interface OmniInteractionStep {
  step_id?: string;
  type?: string;
  status?: string;
  content?: OmniInteractionContent[];
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
    return (
      process.env.MERIDIAN_GEMINI_OMNI_MODEL?.trim() ||
      process.env.MERIDIAN_OMNI_MODEL?.trim() ||
      "gemini-omni-1.1-flash"
    );
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
    const costEstimate = (spec.durationTargetSeconds || 5) * this.capabilities.costPerSecondEstimateUsd;

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

    // Official Gemini Interactions API payload format
    let payload: Record<string, unknown>;
    const aspectRatio = spec.aspectRatio || "9:16";

    const referenceUri = spec.sourceMediaUrl || (spec as any).referenceImageUri;

    if (referenceUri) {
      // Official Gemini Interactions API image-to-video input structure:
      // Array of typed input objects: image part followed by text instruction
      const isBase64 = referenceUri.startsWith("data:") || !referenceUri.startsWith("http");
      const base64Data = referenceUri.startsWith("data:")
        ? referenceUri.replace(/^data:[^;]+;base64,/, "")
        : referenceUri;
      const mimeType = referenceUri.startsWith("data:")
        ? (referenceUri.match(/^data:([^;]+);/)?.[1] || "image/jpeg")
        : "image/jpeg";

      payload = {
        model,
        input: [
          isBase64 && !referenceUri.startsWith("http")
            ? { type: "image", data: base64Data, mime_type: mimeType }
            : { type: "image", uri: referenceUri, mime_type: mimeType },
          { type: "text", text: prompt },
        ],
        response_format: {
          type: "video",
          aspect_ratio: aspectRatio,
        },
      };
    } else {
      // Direct text-to-video request format
      payload = {
        model,
        input: prompt,
        response_format: {
          type: "video",
          aspect_ratio: aspectRatio,
        },
      };
    }

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

      // Extract output video from documented steps[].content[] structure
      const parsed = this.extractVideoArtifact(body);

      const statusLower = (body.status || body.state || "").toLowerCase();
      const isCompleted = statusLower === "completed" || !!parsed;

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
        outputArtifactId: parsed?.uri,
        metadata: {
          model,
          apiFamily: "interactions",
          interactionId,
          videoUri: parsed?.uri,
          mimeType: parsed?.mimeType,
          sha256: parsed?.sha256,
          byteSize: parsed?.byteSize,
          videoBytesBase64: parsed?.videoBytesBase64,
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

      const parsed = this.extractVideoArtifact(body);
      const statusLower = (body.status || body.state || "").toLowerCase();
      const isDone = statusLower === "completed" || !!parsed;
      const isFailed = statusLower === "failed" || statusLower === "error";

      return {
        jobId,
        organizationId: "",
        brandId: "",
        creativeSpec: {} as any,
        providerId: this.id,
        providerJobId: interactionId,
        status: isFailed ? "FAILED" : isDone ? "COMPLETED" : "RUNNING",
        costEstimateUsd: 0,
        outputArtifactId: parsed?.uri,
        metadata: {
          ...metadata,
          interactionId,
          videoUri: parsed?.uri,
          mimeType: parsed?.mimeType,
          sha256: parsed?.sha256,
          byteSize: parsed?.byteSize,
          videoBytesBase64: parsed?.videoBytesBase64,
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

  /**
   * Extracts output video artifact from official steps/content REST response.
   */
  private extractVideoArtifact(body: OmniInteractionResponse): {
    uri: string;
    mimeType: string;
    sha256?: string;
    byteSize?: number;
    videoBytesBase64?: string;
  } | null {
    if (!body.steps || !Array.isArray(body.steps)) return null;

    for (const step of body.steps) {
      // 1. Documented REST structure: content[] with type === "video"
      if (step.content && Array.isArray(step.content)) {
        for (const item of step.content) {
          if (item.type === "video" || item.mime_type?.startsWith("video/")) {
            if (item.data) {
              const bytes = Buffer.from(item.data, "base64");
              if (bytes.byteLength > 0) {
                const sha256 = createHash("sha256").update(bytes).digest("hex");
                const mime = item.mime_type || "video/mp4";
                return {
                  uri: item.uri || `data:${mime};base64,${item.data}`,
                  mimeType: mime,
                  sha256,
                  byteSize: bytes.byteLength,
                  videoBytesBase64: item.data,
                };
              }
            } else if (item.uri) {
              return {
                uri: item.uri,
                mimeType: item.mime_type || "video/mp4",
              };
            }
          }
        }
      }

      // 2. Fallback to outputs[] format if present
      if (step.outputs && Array.isArray(step.outputs)) {
        for (const output of step.outputs) {
          if (output.type === "video" || output.uri?.endsWith(".mp4")) {
            return {
              uri: output.uri || "artifact://omni-rendered.mp4",
              mimeType: output.mime_type || "video/mp4",
            };
          }
        }
      }
    }

    return null;
  }
}

export const geminiOmniVideoProvider = new GeminiOmniVideoProvider();
