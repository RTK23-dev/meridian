/**
 * Studio videos through the workspace's OpenRouter key (owner direction 2026-11-06), with the video model the workspace chose under Settings,
 * Models ("Studio video model"). It is a Studio video provider like Gemini Omni or Higgsfield: the router selects it, the job row and its
 * reservation exist before the call, the poller checks it, and the shared finalizer downloads, stores and verifies the video.
 *
 * What the model takes, and its price, come from OpenRouter's live video listing (GET /videos/models, read through the engine's gateway
 * for this workspace): its supported durations and aspect ratios, and its per-second price at 1080p. The router offers the model only for
 * a duration and ratio it lists, and estimates the job from that price; a model whose price the listing does not state is not priced, so
 * automatic selection refuses it. Submit and poll use the engine's OpenRouter video calls (gateway/openrouter.ts), so the key is added by
 * the gateway and sent only to OpenRouter. A cost is recorded only when OpenRouter reports one.
 */
import { createGateway, type Gateway } from "../../../engine/gateway/gateway.ts";
import { fetchHttpTransport } from "../../../engine/gateway/transport.ts";
import { meridianCredentialSource } from "../../../engine/gateway/meridian.ts";
import { pollVideo, submitVideo } from "../../../engine/gateway/openrouter.ts";
import { listVideoModels, videoProfilesFromListing } from "../../../engine/assets/providers/openrouterVideo.ts";
import { EngineError } from "../../../engine/contracts/errors.ts";
import { generationCredentialStatus } from "../providers/chat.server.ts";
import { storedMediaModel } from "../settings/media-models.ts";
import { loadDefaultSql } from "../credentials/resolve.ts";
import { providerPromptOf, type CreativeSpec, type ProductionCapabilities, type ProductionJob, type ProductionProvider, type ProviderHealth } from "./types.ts";

export const OPENROUTER_VIDEO_PROVIDER_ID = "openrouter_video";
/** The registry model id this provider is offered under: the video model the workspace chose, read when the job is made. */
export const OPENROUTER_VIDEO_SEAT_MODEL = "studio-video-model";

/** What the workspace's chosen video model takes and costs, from the live listing. */
export type VideoOffer = {
  model: string;
  /** USD per second at `resolution`, as the listing states it (with audio when only that is stated, as an upper bound), or null. */
  pricePerSecondUsd: number | null;
  /** The resolution the job asks for, the one the price is stated for; undefined lets the model use its default. */
  resolution: string | undefined;
  durations: number[];
  aspectRatios: string[];
  resolutions: string[];
};
export type VideoOfferRead = VideoOffer | { unavailable: string };

type Deps = {
  gateway?: Gateway;
  stored?: (organizationId: string) => Promise<string | null>;
  credentialStatus?: typeof generationCredentialStatus;
};

let defaultGatewayCache: Gateway | null = null;
function defaultGateway(): Gateway {
  defaultGatewayCache ??= createGateway({ transport: fetchHttpTransport, credentials: meridianCredentialSource() });
  return defaultGatewayCache;
}

async function defaultStored(organizationId: string): Promise<string | null> {
  return storedMediaModel(await loadDefaultSql(), organizationId, "studio_video");
}

const numberOf = (raw: unknown): number | null => {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * The per-second price a Studio job would pay for a listed video model, and the resolution it is stated for. The listing prices video by
 * option (pricing_skus): 1080p is preferred, then 720p, then the model's other listed resolutions, each at its own price. A Studio job asks
 * for no audio, so where only the with-audio price is stated, that price is used as the bound. Without a resolution-specific price, the
 * model's default price applies and no resolution is asked for. Null when the listing states no usable price: the job is not priced.
 */
export function studioVideoPrice(entry: { pricing_skus?: unknown; supported_resolutions?: unknown }): { usdPerSecond: number; resolution: string | undefined } | null {
  const skus = (entry.pricing_skus ?? {}) as Record<string, unknown>;
  const listed = Array.isArray(entry.supported_resolutions) ? entry.supported_resolutions.filter((item): item is string => typeof item === "string") : [];
  const order = [...["1080p", "720p"].filter((r) => listed.includes(r)), ...listed.filter((r) => r !== "1080p" && r !== "720p")];
  for (const resolution of order) {
    const price = numberOf(skus[`duration_seconds_${resolution}`]) ?? numberOf(skus[`duration_seconds_with_audio_${resolution}`]);
    if (price !== null) return { usdPerSecond: price, resolution };
  }
  const fallback = numberOf(skus.duration_seconds) ?? numberOf(skus.duration_seconds_with_audio);
  return fallback === null ? null : { usdPerSecond: fallback, resolution: undefined };
}

/** The listing entry for one model, or null. */
function entryOf(body: unknown, model: string): Record<string, unknown> | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  return (data.find((item) => (item as { id?: unknown })?.id === model) as Record<string, unknown> | undefined) ?? null;
}

/** The video models a Studio video seat can take, from the live video listing read for this workspace: each with its name and Studio price. */
export async function studioVideoModels(organizationId: string, gateway: Gateway = defaultGateway()): Promise<{ ok: true; models: Array<{ id: string; name: string; usdPerSecond: number | null }> } | { ok: false; reason: string }> {
  let body: unknown;
  try {
    body = await listVideoModels(gateway, organizationId);
  } catch (error) {
    return { ok: false, reason: `OpenRouter's video listing could not be read: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}` };
  }
  const profiles = videoProfilesFromListing(body).profiles;
  const models = [...profiles.keys()].filter((id) => !id.startsWith("~")).map((id) => {
    const entry = entryOf(body, id) ?? {};
    return { id, name: typeof entry.name === "string" && entry.name ? entry.name : id, usdPerSecond: studioVideoPrice(entry)?.usdPerSecond ?? null };
  });
  models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { ok: true, models };
}

function health(configured: boolean, detail: string): ProviderHealth {
  return { id: OPENROUTER_VIDEO_PROVIDER_ID, state: configured ? "CONFIGURED" : "NOT_CONFIGURED", capabilities: ["text-to-video"], detail, checkedAt: new Date().toISOString() };
}

const now = () => new Date().toISOString();

export class OpenRouterStudioVideoProvider implements ProductionProvider {
  readonly id = OPENROUTER_VIDEO_PROVIDER_ID;
  /**
   * The provider-wide price is not declared (NaN reads as unknown): each workspace's model has its own, which the router reads with
   * offerFor for that workspace.
   */
  readonly capabilities: ProductionCapabilities = {
    textToVideo: true,
    imageToVideo: false,
    timelineEditing: false,
    voiceoverGeneration: false,
    zeroSpend: false,
    averageLatencySeconds: 180,
    costPerSecondEstimateUsd: Number.NaN,
  };
  private readonly deps: Deps;

  constructor(deps: Deps = {}) {
    this.deps = deps;
  }

  private gateway(): Gateway {
    return this.deps.gateway ?? defaultGateway();
  }

  private stored(organizationId: string): Promise<string | null> {
    return (this.deps.stored ?? defaultStored)(organizationId);
  }

  async health(): Promise<ProviderHealth> {
    return health(false, "OpenRouter Studio videos need a workspace: its OpenRouter key and its Studio video model.");
  }

  /** Ready only with a usable OpenRouter key and a chosen Studio video model. No request is made. */
  async healthFor(organizationId: string): Promise<ProviderHealth> {
    let model: string | null;
    try {
      model = await this.stored(organizationId);
    } catch {
      return health(false, "The workspace's Studio video model could not be read.");
    }
    if (!model) return health(false, "No Studio video model is chosen in Settings, Models, so OpenRouter does not make Studio videos.");
    const key = await (this.deps.credentialStatus ?? generationCredentialStatus)(organizationId);
    if (key.status !== "ready") return health(false, key.reason);
    return health(true, `Studio videos use ${model} through the workspace's OpenRouter key.`);
  }

  /** What the chosen model takes and costs, from the live video listing for this workspace. The listing is free to read. */
  async offerFor(organizationId: string): Promise<VideoOfferRead> {
    const model = await this.stored(organizationId).catch(() => null);
    if (!model) return { unavailable: "No Studio video model is chosen." };
    let body: unknown;
    try {
      body = await listVideoModels(this.gateway(), organizationId);
    } catch (error) {
      return { unavailable: `OpenRouter's video listing could not be read: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}` };
    }
    const profile = videoProfilesFromListing(body).profiles.get(model);
    if (!profile) return { unavailable: `OpenRouter's video listing does not list ${model} with its durations.` };
    const price = studioVideoPrice(entryOf(body, model) ?? {});
    return {
      model,
      pricePerSecondUsd: price?.usdPerSecond ?? null,
      resolution: price?.resolution,
      durations: profile.durations,
      aspectRatios: profile.capabilities.aspect,
      resolutions: profile.resolutions,
    };
  }

  async submitJob(spec: CreativeSpec): Promise<ProductionJob> {
    const base = {
      jobId: "",
      organizationId: spec.organizationId,
      brandId: spec.brandId,
      creativeSpec: spec,
      providerId: this.id,
      costEstimateUsd: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    const offer = await this.offerFor(spec.organizationId);
    if ("unavailable" in offer) return { ...base, status: "NOT_CONFIGURED", error: `${offer.unavailable} No video was submitted.` };
    const costEstimateUsd = offer.pricePerSecondUsd === null ? 0 : offer.pricePerSecondUsd * spec.durationTargetSeconds;
    try {
      const submitted = await submitVideo(this.gateway(), {
        organizationId: spec.organizationId,
        capability: "video.cinematic",
        model: offer.model,
        prompt: providerPromptOf(spec),
        durationSeconds: spec.durationTargetSeconds,
        aspectRatio: spec.aspectRatio,
        resolution: offer.resolution,
        generateAudio: false,
      });
      return {
        ...base,
        jobId: submitted.jobId,
        providerJobId: submitted.jobId,
        status: "QUEUED",
        costEstimateUsd,
        submittedAt: now(),
        // The workspace that owns the job: a later poll uses that workspace's key, and no other.
        metadata: { organizationId: spec.organizationId, model: offer.model },
      };
    } catch (error) {
      const engineError = error instanceof EngineError ? error : null;
      const message = error instanceof Error ? error.message.slice(0, 300) : "unknown error";
      // Not connected, or a request refused before any work: nothing was accepted, so the job failed. Anything else may have been accepted.
      if (engineError?.kind === "config") return { ...base, status: "NOT_CONFIGURED", costEstimateUsd, error: message };
      if (engineError?.kind === "invalid_input") return { ...base, status: "FAILED", costEstimateUsd, errorCode: "REJECTED", error: message };
      return { ...base, status: "SUBMISSION_UNKNOWN", costEstimateUsd, errorCode: "SUBMISSION_UNKNOWN", error: message };
    }
  }

  async checkJobStatus(jobId: string, metadata?: Record<string, unknown>): Promise<ProductionJob> {
    const owner = typeof metadata?.organizationId === "string" ? metadata.organizationId : null;
    if (!owner) throw new Error("Cannot check an OpenRouter Studio video without the workspace that owns it.");
    const poll = await pollVideo(this.gateway(), owner, jobId);
    const reported = typeof poll.actualUsd === "number" ? poll.actualUsd : undefined;
    const job: ProductionJob = {
      jobId,
      providerJobId: jobId,
      organizationId: "",
      brandId: "",
      creativeSpec: {} as CreativeSpec,
      providerId: this.id,
      status: poll.state === "done" ? "RENDERED" : poll.state === "failed" ? "FAILED" : "RUNNING",
      costEstimateUsd: 0,
      lastPolledAt: now(),
      metadata: reported === undefined ? metadata : { ...metadata, costBasis: "provider_reported" },
      createdAt: now(),
      updatedAt: now(),
    };
    if (reported !== undefined) job.costActualUsd = reported;
    if (poll.state === "done" && poll.uri) {
      job.outputArtifactId = poll.uri;
      job.artifactId = poll.uri;
    }
    if (poll.state === "failed") job.error = poll.error?.message ?? "OpenRouter reported the video as failed.";
    return job;
  }
}
