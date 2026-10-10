import type {
  CreativeSpec,
  ProductionCapabilities,
  ProductionJob,
  ProductionProvider,
  ProviderHealth,
} from "../types.ts";
import type { Sql } from "../../learning/store.ts";
import { loadDefaultSql, resolveCredential, type CredentialEnv } from "../../credentials/resolve.ts";
import { credentialStateOf, type CredentialResolution } from "../../credentials/contract.ts";

/** A workspace's usable key, or the reason there is none. The provider is never called without a usable key. */
type KeyAccess = { ok: true; apiKey: string } | { ok: false; reason: string };

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
    supportedDurations: [5, 6, 7, 8],
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
  private readonly sql?: Sql;
  private readonly env?: CredentialEnv;
  private readonly lookup?: (organizationId: string) => Promise<CredentialResolution>;

  /**
   * No key is held here. Veo uses the workspace's production credential for each call, and the deployment key only when
   * PRODUCTION_SHARED_DEFAULT=deployment is set.
   */
  constructor(options?: {
    fetchImpl?: typeof fetch;
    sql?: Sql;
    env?: CredentialEnv;
    lookup?: (organizationId: string) => Promise<CredentialResolution>;
  }) {
    this.fetchImpl = options?.fetchImpl || globalThis.fetch;
    this.sql = options?.sql;
    this.env = options?.env;
    this.lookup = options?.lookup;
  }

  /** The workspace's production credential, by the shared resolver. Nothing is cached between calls. */
  private async credentialFor(organizationId: string): Promise<CredentialResolution> {
    if (this.lookup) return this.lookup(organizationId);
    const sql = this.sql ?? (await loadDefaultSql());
    return resolveCredential(sql, organizationId, "production", this.env ?? process.env);
  }

  /** The usable key for this workspace, or the reason there is none. A failed read is "no call", never a fallback. */
  private async keyFor(organizationId: string | undefined): Promise<KeyAccess> {
    if (!organizationId) {
      return { ok: false, reason: "Google Veo needs a workspace production credential, and no workspace was given. No request was sent." };
    }
    try {
      const resolution = await this.credentialFor(organizationId);
      if (resolution.status === "ready") return { ok: true, apiKey: resolution.secret };
      return { ok: false, reason: resolution.reason };
    } catch {
      return { ok: false, reason: "The workspace's Gemini production credential could not be read. No request was sent." };
    }
  }

  private getModel(): string {
    return process.env.MERIDIAN_VEO_MODEL?.trim() || "veo-3.1-generate-preview";
  }

  getModelCapability(model = this.getModel()): VideoCapability | undefined {
    return model ? VEO_MODEL_CAPABILITIES[model] : undefined;
  }

  /** Without a workspace there is no key to check, so this reports only that a workspace credential is needed. */
  async health(): Promise<ProviderHealth> {
    return {
      id: this.id,
      state: "NOT_CONFIGURED",
      capabilities: [],
      detail: "Google Veo needs a workspace production credential. Readiness is checked for a workspace, and none was given.",
      checkedAt: new Date().toISOString(),
    };
  }

  /** Readiness for one workspace. A workspace whose key is not usable is never reported as ready. */
  async healthFor(organizationId: string): Promise<ProviderHealth> {
    let state: ReturnType<typeof credentialStateOf>;
    try {
      state = credentialStateOf(await this.credentialFor(organizationId));
    } catch {
      return { id: this.id, state: "UNAVAILABLE", capabilities: [], detail: "The workspace's Gemini production credential could not be checked.", checkedAt: new Date().toISOString() };
    }
    if (state.state !== "usable") {
      return { id: this.id, state: "NOT_CONFIGURED", capabilities: [], detail: state.reason ?? "No Gemini production credential is available.", checkedAt: new Date().toISOString() };
    }

    const model = this.getModel();
    if (!model) {
      return {
        id: this.id,
        state: "NOT_CONFIGURED",
        capabilities: [],
        detail: "No Veo model configured via MERIDIAN_VEO_MODEL. For Google video generation, Gemini Omni (gemini-omni-1.1-flash) is recommended.",
        checkedAt: new Date().toISOString(),
      };
    }

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

    if (lifecycle.state === "DEPRECATED") {
      return {
        id: this.id,
        state: "DEPRECATED",
        capabilities: ["textToVideo"],
        detail: `Veo model '${model}' is a deprecated preview endpoint scheduled for shutdown on 2026-10-22. Excluded from automatic fallback routing; usable only when explicitly selected as a specialist capability. Replacement: ${lifecycle.replacement ?? "gemini-omni-1.1-flash"}`,
        checkedAt: new Date().toISOString(),
      };
    }

    const source = state.source === "workspace" ? "this workspace's saved key" : "the deployment's shared default key";
    return {
      id: this.id,
      state: "CONFIGURED",
      capabilities: ["textToVideo"],
      detail: `Configured with model ${model}, using ${source}.`,
      checkedAt: new Date().toISOString(),
    };
  }

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    const access = await this.keyFor(spec.organizationId);
    const costEstimate = spec.durationTargetSeconds * this.capabilities.costPerSecondEstimateUsd;

    if (!access.ok) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "NOT_CONFIGURED",
        costEstimateUsd: costEstimate,
        error: access.reason,
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
    const capability = this.getModelCapability(model);

    if (!capability) {
      return {
        jobId: "",
        organizationId: spec.organizationId,
        brandId: spec.brandId,
        creativeSpec: spec,
        providerId: this.id,
        status: "FAILED",
        costEstimateUsd: costEstimate,
        error: `Unknown or unconfigured Veo model '${model}'.`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

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
            "x-goog-api-key": access.apiKey,
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

  /**
   * The poll uses the key of the workspace that owns the job, which the job's metadata names. Without a usable key it
   * throws, as it did without a key before, so the poller retries and no request is sent.
   */
  async checkJobStatus(jobId: string, metadata?: Record<string, unknown>): Promise<ProductionJob> {
    const owner = typeof metadata?.organizationId === "string" ? metadata.organizationId : undefined;
    const access = await this.keyFor(owner);
    if (!access.ok) {
      throw new Error(`Cannot check Veo job status: ${access.reason}`);
    }

    const res = await this.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/${jobId}`,
      {
        headers: {
          "x-goog-api-key": access.apiKey,
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
