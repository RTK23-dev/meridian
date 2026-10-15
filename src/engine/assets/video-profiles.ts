// The video models' profiles for produce_shot (Bible 10.1, 10.3). The route table names the video models (config/routes.ts); GET
// /videos/models (PROVIDER_APIS.md, OpenRouter) says what each one takes. This loader reads that listing through the gateway, for one
// workspace's credential, and maps each routed model to a VideoProfile (openrouterVideo.ts videoProfilesFromListing).
//
// Fail closed, and say why. A model the listing does not name, or whose entry does not parse, is left out with its reason. A listing
// that cannot be read leaves every routed model out, with the reason (a missing key is NOT_CONNECTED). No profile means no video model
// is eligible, and the caller refuses the shot with those reasons; nothing is guessed.
//
// Caching (one loader per runtime). A listing that was read is kept for the loader's life, per workspace. A listing that failed is not
// kept, so the next call reads again (the listing is free). Concurrent calls for one workspace share one read.

import { EngineError } from "../contracts/errors.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { notConnectedReason } from "../media/stt-connection.ts";
import { classifyError } from "./classify.ts";
import { isVideoClass, listVideoModels, videoProfilesFromListing, type VideoProfile } from "./providers/openrouterVideo.ts";

/** The video classes whose routed models the listing is read for (Bible 10.3). */
export const VIDEO_ROUTE_CLASSES = ["video.cinematic", "video.budget", "video.i2v_pinned"] as const;

/** A routed video model the loader left out, and why. The reason is the engine's own text, never the provider's. */
export type VideoProfileGap = { model: string; reason: string };

export type VideoProfileLoader = {
  /** The routed OpenRouter video models, in route order, each once. */
  readonly models: readonly string[];
  /** The profiles of the routed models the listing names, read for one workspace. Models it does not name are left out. */
  loadVideoProfiles(organizationId: string): Promise<ReadonlyMap<string, VideoProfile>>;
  /** The models the last load for this workspace left out, with their reasons. Empty before any load. */
  gapsFor(organizationId: string): readonly VideoProfileGap[];
};

type Read = { ok: boolean; profiles: ReadonlyMap<string, VideoProfile>; gaps: VideoProfileGap[] };

/** The routed OpenRouter model of each video class, in route order, each model once. A null model is not routed. */
export function routedVideoModels(gateway: Gateway): string[] {
  const models: string[] = [];
  for (const capability of VIDEO_ROUTE_CLASSES) {
    for (const route of gateway.routes(capability)) {
      if (route.provider.id !== "openrouter" || route.model === null) continue;
      if (!models.includes(route.model)) models.push(route.model);
    }
  }
  return models;
}

/** Why the listing could not be read. A config error is a missing connection, so it carries the NOT_CONNECTED prefix. */
function listingFailure(error: unknown): string {
  const detail = classifyError(error).message;
  if (error instanceof EngineError && error.kind === "config") {
    return notConnectedReason(`GET /videos/models cannot be read: ${detail}`);
  }
  return `GET /videos/models could not be read: ${detail}`;
}

/** The video profile loader over the gateway. Its models are the route table's; its listing is GET /videos/models for the workspace. */
export function videoProfileLoader(options: { gateway: Gateway }): VideoProfileLoader {
  const models = routedVideoModels(options.gateway);
  const reads = new Map<string, Promise<Read>>();
  const gaps = new Map<string, readonly VideoProfileGap[]>();

  async function read(organizationId: string): Promise<Read> {
    let listing: unknown;
    try {
      listing = await listVideoModels(options.gateway, organizationId);
    } catch (error) {
      const reason = listingFailure(error);
      return { ok: false, profiles: new Map(), gaps: models.map((model) => ({ model, reason })) };
    }
    const parsed = videoProfilesFromListing(listing);
    // A listing with no data array is a failed listing, not an empty catalogue.
    if (parsed.rejected.some((entry) => entry.id === null) && parsed.profiles.size === 0) {
      const reason = "GET /videos/models could not be read: the listing has no data array";
      return { ok: false, profiles: new Map(), gaps: models.map((model) => ({ model, reason })) };
    }
    const profiles = new Map<string, VideoProfile>();
    const found: VideoProfileGap[] = [];
    for (const model of models) {
      const profile = parsed.profiles.get(model);
      if (profile !== undefined) {
        profiles.set(model, profile);
        continue;
      }
      const rejected = parsed.rejected.find((entry) => entry.id === model);
      found.push({
        model,
        reason:
          rejected === undefined
            ? `GET /videos/models does not name ${model}`
            : `GET /videos/models lists ${model}, but ${rejected.reason}`,
      });
    }
    return { ok: true, profiles, gaps: found };
  }

  return {
    models,
    async loadVideoProfiles(organizationId) {
      let pending = reads.get(organizationId);
      if (pending === undefined) {
        pending = read(organizationId);
        reads.set(organizationId, pending);
      }
      const result = await pending;
      if (!result.ok && reads.get(organizationId) === pending) reads.delete(organizationId);
      gaps.set(organizationId, result.gaps);
      return result.profiles;
    },
    gapsFor(organizationId) {
      return gaps.get(organizationId) ?? [];
    },
  };
}

/**
 * The reasons no video model of a class can be used, or null when at least one routed OpenRouter model of the class has a profile.
 * A non-video class is never refused here (its adapters do not read the listing). Sends nothing.
 */
export function noEligibleVideoModel(input: {
  gateway: Gateway;
  modelClass: string;
  profiles: ReadonlyMap<string, VideoProfile>;
  gaps: readonly VideoProfileGap[];
}): string[] | null {
  if (!isVideoClass(input.modelClass)) return null;
  const routes = input.gateway
    .routes(input.modelClass)
    .filter((route) => route.provider.id === "openrouter" && route.model !== null);
  if (routes.length === 0) {
    return [`${input.modelClass} has no OpenRouter model routed, so no video model can be called`];
  }
  if (routes.some((route) => input.profiles.has(route.model))) return null;
  return routes.map(
    (route) => input.gaps.find((gap) => gap.model === route.model)?.reason ?? `${route.model} has no profile from GET /videos/models in this composition`,
  );
}
