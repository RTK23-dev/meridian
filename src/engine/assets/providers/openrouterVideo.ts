// OpenRouter video generation (Bible 10.1, PROVIDER_APIS.md "Video"), one adapter per routed model.
//
// Why this adapter builds its own submit request: gateway.submitVideo sends the capability's first target model and has no
// frame_images field, so it cannot send the model of a fallback target or a first-and-last-frame request. The request goes
// through the gateway's authenticated call (gateway.call), with the model taken from gateway.routes(). Polling uses the
// gateway's pollVideo, which takes only the job id.
//
// The idempotency key is not sent: PROVIDER_APIS.md documents no idempotency header for video. It is recorded in the ledger
// only (see STATUS.md, the open risk of a billed retry).

import { z } from "zod";
import { EngineError } from "../../contracts/errors.ts";
import type { AssetSpec, ProviderCapabilities, ProviderPoll } from "../../contracts/assets.ts";
import type { ModelClass } from "../../contracts/plan.ts";
import type { Gateway, ResolvedRoute } from "../../gateway/gateway.ts";
import { pollVideo } from "../../gateway/openrouter.ts";
import { jsonBody } from "../../gateway/errors.ts";
import { callProvider, ensureOk, listPriceUsd, UNVERIFIED_CAPABILITIES, type AdapterConnection, type RoutedAdapter } from "../adapter.ts";
import { ProviderCallError, providerErrorForFailedJob } from "../classify.ts";
import { normaliseHttpsUrl } from "../normalise.ts";

const PROVIDER = "openrouter";

/** The submit call has its own timeout. A poll is bounded by the router's poll deadline. */
export const VIDEO_SUBMIT_TIMEOUT_MS = 60_000;

/** The resolution and aspect the engine asks for (1080 x 1920, Bible section 1). */
export const VIDEO_RESOLUTION = "1080p";
export const VIDEO_ASPECT = "9:16";

export type VideoClass = "video.cinematic" | "video.budget" | "video.i2v_pinned";

export function isVideoClass(value: string): value is VideoClass {
  return value === "video.cinematic" || value === "video.budget" || value === "video.i2v_pinned";
}

/** What GET /videos/models says about one model, reduced to what the router and the adapter need. */
export type VideoProfile = {
  model: string;
  canonicalSlug: string | null;
  capabilities: ProviderCapabilities;
  durations: number[];
  resolutions: string[];
  frameImages: string[];
};

// PROVIDER_APIS.md lists these fields. Anything else in an entry is ignored; an entry that does not parse is rejected by id.
const videoModelEntry = z.looseObject({
  id: z.string().min(1),
  canonical_slug: z.string().min(1).optional(),
  generate_audio: z.boolean().optional(),
  supported_durations: z.array(z.number().positive()).optional(),
  supported_resolutions: z.array(z.string()).optional(),
  supported_aspect_ratios: z.array(z.string()).optional(),
  supported_frame_images: z.array(z.string()).optional(),
});

const videoListingSchema = z.looseObject({ data: z.array(z.unknown()) });

export type VideoProfileListing = {
  profiles: Map<string, VideoProfile>;
  rejected: Array<{ id: string | null; reason: string }>;
};

/**
 * Builds the profiles from a GET /videos/models answer. A model with no supported durations, or one whose entry does not
 * parse, is rejected with its reason, so it is never routed on a guess. Refs are not in the listing, so refsMax is 0.
 */
export function videoProfilesFromListing(body: unknown): VideoProfileListing {
  const listing = videoListingSchema.safeParse(body);
  if (!listing.success) return { profiles: new Map(), rejected: [{ id: null, reason: "the listing has no data array" }] };
  const profiles = new Map<string, VideoProfile>();
  const rejected: Array<{ id: string | null; reason: string }> = [];
  for (const raw of listing.data.data) {
    const parsed = videoModelEntry.safeParse(raw);
    if (!parsed.success) {
      const id = typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : null;
      rejected.push({ id, reason: "the entry does not match the listing shape" });
      continue;
    }
    const entry = parsed.data;
    const durations = [...(entry.supported_durations ?? [])].sort((a, b) => a - b);
    if (durations.length === 0) {
      rejected.push({ id: entry.id, reason: "no supported durations" });
      continue;
    }
    const frameImages = entry.supported_frame_images ?? [];
    profiles.set(entry.id, {
      model: entry.id,
      canonicalSlug: entry.canonical_slug ?? null,
      capabilities: {
        maxSeconds: durations[durations.length - 1] as number,
        minSeconds: durations[0] as number,
        firstFrame: frameImages.includes("first_frame"),
        lastFrame: frameImages.includes("last_frame"),
        refsMax: 0,
        audio: entry.generate_audio === true,
        aspect: entry.supported_aspect_ratios ?? [],
      },
      durations,
      resolutions: entry.supported_resolutions ?? [],
      frameImages,
    });
  }
  return { profiles, rejected };
}

/** GET /videos/models through the gateway (free). Throws a typed error when it cannot be read. */
export async function listVideoModels(gateway: Gateway, organizationId: string | null): Promise<unknown> {
  const response = await callProvider(gateway, { provider: PROVIDER, organizationId, method: "GET", path: "/videos/models" });
  ensureOk(response);
  return jsonBody(PROVIDER, response);
}

const submitAnswer = z.looseObject({ id: z.string().min(1).max(200) });

// A failed job's text is provider output. It names a policy refusal only through POLICY_PATTERN; it is never executed.
function reclassifyPoll(poll: ProviderPoll): ProviderPoll {
  if (poll.state !== "failed" || poll.error === undefined) return poll;
  return { ...poll, error: providerErrorForFailedJob(poll.error) };
}

function frameImage(url: string, frameType: "first_frame" | "last_frame") {
  const checked = normaliseHttpsUrl(url);
  if (!checked.ok) {
    throw new EngineError("invalid_input", `the ${frameType.replace("_", " ")} must be an https URL the provider can fetch: ${checked.reason}`);
  }
  return { type: "image_url", image_url: { url: checked.value }, frame_type: frameType };
}

export type OpenRouterVideoOptions = {
  gateway: Gateway;
  organizationId: string | null;
  route: ResolvedRoute;
  /** The model's verified profile. Null when GET /videos/models has not confirmed the model; then it is not connected. */
  profile: VideoProfile | null;
};

/** One OpenRouter video model as a RoutedAdapter. The model comes from the route table, never from this file. */
export function openRouterVideoAdapter(options: OpenRouterVideoOptions): RoutedAdapter {
  const { gateway, organizationId, route, profile } = options;
  const model = route.model;
  if (!isVideoClass(route.capability)) {
    throw new EngineError("config", `openRouterVideoAdapter cannot serve ${route.capability}`);
  }
  const modelClass: ModelClass = route.capability;
  const capabilities = profile?.capabilities ?? UNVERIFIED_CAPABILITIES;

  return {
    id: `${PROVIDER}:${model}`,
    providerId: PROVIDER,
    modelClass,
    capabilities,

    price(spec: AssetSpec) {
      return { estimateUsd: listPriceUsd(route.priceKey, "per_second", spec.durationMs / 1000) };
    },

    async connection(organization: string | null): Promise<AdapterConnection> {
      if (profile === null) {
        return { connected: false, reason: `${model} has no verified capabilities from GET /videos/models; no request is made` };
      }
      const connection = await gateway.connection(PROVIDER, organization);
      return connection.connected ? { connected: true } : { connected: false, reason: connection.reason ?? "OpenRouter is not connected" };
    },

    async submit(spec: AssetSpec, _key: string): Promise<{ jobRef: string }> {
      if (profile === null) throw new EngineError("config", `${model} has no verified capabilities; no request is made`);
      const seconds = spec.durationMs / 1000;
      if (!Number.isInteger(seconds)) {
        throw new EngineError("invalid_input", `${model} takes whole seconds; ${spec.durationMs} ms is not one`);
      }
      if (!profile.durations.includes(seconds)) {
        throw new EngineError("invalid_input", `${model} supports ${profile.durations.join(", ")} seconds, not ${seconds}`);
      }
      if (!profile.resolutions.includes(VIDEO_RESOLUTION)) {
        throw new EngineError("invalid_input", `${model} does not list ${VIDEO_RESOLUTION}`);
      }
      if (spec.aspect !== VIDEO_ASPECT || !profile.capabilities.aspect.includes(VIDEO_ASPECT)) {
        throw new EngineError("invalid_input", `${model} does not list the ${VIDEO_ASPECT} aspect`);
      }
      if (spec.refs.length > profile.capabilities.refsMax) {
        throw new EngineError("invalid_input", `${model} takes no reference images; the spec has ${spec.refs.length}`);
      }
      const frames = [];
      if (spec.firstFrame !== undefined) {
        if (!profile.capabilities.firstFrame) throw new EngineError("invalid_input", `${model} has no first-frame support`);
        frames.push(frameImage(spec.firstFrame, "first_frame"));
      }
      if (spec.lastFrame !== undefined) {
        if (!profile.capabilities.lastFrame) throw new EngineError("invalid_input", `${model} has no last-frame support`);
        frames.push(frameImage(spec.lastFrame, "last_frame"));
      }

      const response = await callProvider(gateway, {
        provider: PROVIDER,
        organizationId,
        method: "POST",
        path: "/videos",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: spec.prompt,
          duration: seconds,
          aspect_ratio: VIDEO_ASPECT,
          resolution: VIDEO_RESOLUTION,
          // The voice track is generated separately and is the clock (Bible principle 2), so the model's own audio is off.
          generate_audio: false,
          ...(frames.length > 0 ? { frame_images: frames } : {}),
        }),
        timeoutMs: VIDEO_SUBMIT_TIMEOUT_MS,
      });
      ensureOk(response);
      const answer = submitAnswer.safeParse(jsonBody(PROVIDER, response));
      if (!answer.success) {
        throw new ProviderCallError({ kind: "unknown", retryable: false, message: "the submit answer carried no job id" });
      }
      return { jobRef: answer.data.id };
    },

    async poll(jobRef: string): Promise<ProviderPoll> {
      const poll = await pollVideo(gateway, organizationId, jobRef);
      if (poll.state === "done" && poll.uri !== undefined) {
        const checked = normaliseHttpsUrl(poll.uri);
        if (!checked.ok) {
          return { state: "failed", error: { kind: "unknown", retryable: false, message: `the video URL is refused: ${checked.reason}` } };
        }
        return { ...poll, uri: checked.value };
      }
      return reclassifyPoll(poll);
    },

    detailsFor(): undefined {
      return undefined;
    },
  };
}
