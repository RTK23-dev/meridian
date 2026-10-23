// The video models' profiles for produce_shot (Bible 10.1, 10.3). GET /videos/models (PROVIDER_APIS.md, OpenRouter) says what each video
// model takes. This loader reads that listing through the gateway, for one workspace's credential, and keeps a VideoProfile for every
// model the listing names (openrouterVideo.ts videoProfilesFromListing). The live listing is the source: no model id is named here.
//
// Fail closed, and say why. A listing entry that does not parse is left out with its reason. A listing that cannot be read leaves no
// profile, with the reason (a missing key is NOT_CONNECTED). No profile means no video model is eligible, and the caller refuses the
// shot with those reasons; nothing is guessed.
//
// Caching (one loader per runtime). A listing that was read is kept for the loader's life, per workspace. A listing that failed is not
// kept, so the next call reads again (the listing is free). Concurrent calls for one workspace share one read.

import { isDisabledModel } from "../config/model-policy.ts";
import { EngineError } from "../contracts/errors.ts";
import type { Gateway } from "../gateway/gateway.ts";
import { notConnectedReason } from "../media/stt-connection.ts";
import { classifyError } from "./classify.ts";
import { isVideoClass, listVideoModels, videoProfilesFromListing, type VideoProfile } from "./providers/openrouterVideo.ts";

/** A listing entry the loader left out, and why. The reason is the engine's own text, never the provider's. */
export type VideoProfileGap = { model: string; reason: string };

export type VideoProfileLoader = {
  /** The profiles of the video models the listing names, read for one workspace. Entries it cannot use are left out. */
  loadVideoProfiles(organizationId: string): Promise<ReadonlyMap<string, VideoProfile>>;
  /** The entries the last load for this workspace left out, with their reasons. Empty before any load. */
  gapsFor(organizationId: string): readonly VideoProfileGap[];
};

type Read = { ok: boolean; profiles: ReadonlyMap<string, VideoProfile>; gaps: VideoProfileGap[] };

/** Why the listing could not be read. A config error is a missing connection, so it carries the NOT_CONNECTED prefix. */
function listingFailure(error: unknown): string {
  const detail = classifyError(error).message;
  if (error instanceof EngineError && error.kind === "config") {
    return notConnectedReason(`GET /videos/models cannot be read: ${detail}`);
  }
  return `GET /videos/models could not be read: ${detail}`;
}

const LISTING = "GET /videos/models";

/**
 * The video profile loader over the gateway. Its profiles are every video model the workspace's GET /videos/models names, except the models
 * of a family the workspace has switched off (owner direction 2026-10-23): those have no profile, so no route can call them. The families
 * come from `familiesFor`, read on every load, as the catalog's policy reads them (gateway/catalog-policy.ts).
 */
export function videoProfileLoader(options: {
  gateway: Gateway;
  familiesFor?: (organizationId: string) => Promise<readonly string[]>;
}): VideoProfileLoader {
  const reads = new Map<string, Promise<Read>>();
  const gaps = new Map<string, readonly VideoProfileGap[]>();

  async function read(organizationId: string): Promise<Read> {
    let listing: unknown;
    try {
      listing = await listVideoModels(options.gateway, organizationId);
    } catch (error) {
      const reason = listingFailure(error);
      return { ok: false, profiles: new Map(), gaps: [{ model: LISTING, reason }] };
    }
    const parsed = videoProfilesFromListing(listing);
    // A listing with no data array is a failed listing, not an empty catalogue.
    if (parsed.rejected.some((entry) => entry.id === null) && parsed.profiles.size === 0) {
      const reason = "GET /videos/models could not be read: the listing has no data array";
      return { ok: false, profiles: new Map(), gaps: [{ model: LISTING, reason }] };
    }
    const found: VideoProfileGap[] = parsed.rejected
      .filter((entry) => entry.id !== null)
      .map((entry) => ({ model: entry.id as string, reason: `${LISTING} lists ${entry.id}, but ${entry.reason}` }));
    return { ok: true, profiles: parsed.profiles, gaps: found };
  }

  return {
    async loadVideoProfiles(organizationId) {
      let pending = reads.get(organizationId);
      if (pending === undefined) {
        pending = read(organizationId);
        reads.set(organizationId, pending);
      }
      const result = await pending;
      if (!result.ok && reads.get(organizationId) === pending) reads.delete(organizationId);
      const families = options.familiesFor === undefined ? [] : await options.familiesFor(organizationId);
      const profiles = new Map<string, VideoProfile>();
      const switchedOff: VideoProfileGap[] = [];
      for (const [model, profile] of result.profiles) {
        if (isDisabledModel(model, families)) switchedOff.push({ model, reason: `${model} is switched off by the workspace's model policy` });
        else profiles.set(model, profile);
      }
      gaps.set(organizationId, [...result.gaps, ...switchedOff]);
      return profiles;
    },
    gapsFor(organizationId) {
      return gaps.get(organizationId) ?? [];
    },
  };
}

/**
 * The reasons no video model can be called for a video class, or null when the listing gave at least one video model a profile.
 * A non-video class is never refused here (its adapters do not read the listing). Sends nothing.
 */
export function noEligibleVideoModel(input: {
  modelClass: string;
  profiles: ReadonlyMap<string, VideoProfile>;
  gaps: readonly VideoProfileGap[];
}): string[] | null {
  if (!isVideoClass(input.modelClass)) return null;
  if (input.profiles.size > 0) return null;
  if (input.gaps.length > 0) return input.gaps.map((gap) => gap.reason);
  return [`${LISTING} named no video model with a profile, so ${input.modelClass} has no model to call`];
}
