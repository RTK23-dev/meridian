// OpenRouter images (Bible 10.3 image.keyframe and image.edit; PROVIDER_APIS.md "Images"). A synchronous API: submit makes the
// call, decodes the base64 bytes, validates them and stores them through the MediaStore. poll then returns the stored uri. The result
// travels in the job reference (encodeImageResult), not in this process, so a poll made by another worker reads the same answer.
//
// A paid answer is never lost to a later failure: if decoding, validation or storage fails after OpenRouter billed the call,
// the result is a failed poll that still carries usage.cost, so the router records the real bill.
//
// Reference images. A spec's references, and its first frame when it has one (the image the call starts from, image-to-image), are
// sent as `input_references`, in that order. The element shape (`{ type: "image_url", image_url: { url } }`) is the one OpenRouter's
// image generation guide documents, checked 2026-10-15 (PROVIDER_APIS.md, "Input references"). The guide states no maximum count of
// reference images, so IMAGE_REFERENCES_MAX is unverified until the owner's live run. Every reference must be an https URL the
// provider can fetch: a store uri is not, so it is refused before any call (no money is spent on a call the provider cannot read).
// A last frame is refused the same way.
// Every call asks for one image; a second take is the caller's second call with a new seed.

import { adapters } from "../../config/adapters.ts";
import { z } from "zod";
import { EngineError } from "../../contracts/errors.ts";
import type { AssetSpec, ProviderCapabilities, ProviderPoll } from "../../contracts/assets.ts";
import type { ModelClass } from "../../contracts/plan.ts";
import { contentHash } from "../../contracts/hash.ts";
import type { Gateway, ResolvedRoute } from "../../gateway/gateway.ts";
import { jsonBody } from "../../gateway/errors.ts";
import { callProvider, ensureOk, listPriceUsd, UNVERIFIED_CAPABILITIES, type AdapterConnection, type MediaStore, type RoutedAdapter } from "../adapter.ts";
import { normaliseHttpsUrl, normaliseImage, decodeBase64Strict, OUTPUT_LIMITS } from "../normalise.ts";
import { excerpt } from "../classify.ts";

const PROVIDER = "openrouter";

/** Image calls are synchronous but can take a while. */
export const IMAGE_TIMEOUT_MS = adapters.timeoutsMs.image.value;

/**
 * The reference images one image call takes (the first frame counts as one). UNVERIFIED: OpenRouter's image generation guide
 * (checked 2026-10-15) states no maximum, and says only that the number accepted varies by provider. This is an initial bound
 * that the owner's live run replaces with the measured limit. A spec with more is refused before any call.
 */
export const IMAGE_REFERENCES_MAX = 4;

/** One element of `input_references`, as OpenRouter's image generation guide documents it (see the file header). */
export type ImageReference = { type: "image_url"; image_url: { url: string } };

/**
 * The input references of one image call, in order: the first frame, then the references. Every one must be an https URL the
 * provider can fetch. Throws invalid_input (no call is made) for a last frame, for too many, or for a URL that is not https.
 */
export function imageReferencesOf(spec: AssetSpec): ImageReference[] {
  if (spec.lastFrame !== undefined) {
    throw new EngineError("invalid_input", "image models take no last frame in this adapter; no call is made");
  }
  const urls = [...(spec.firstFrame === undefined ? [] : [spec.firstFrame]), ...spec.refs];
  if (urls.length > IMAGE_REFERENCES_MAX) {
    throw new EngineError("invalid_input", `image models take ${IMAGE_REFERENCES_MAX} references; the spec has ${urls.length}; no call is made`);
  }
  return urls.map((url) => {
    const checked = normaliseHttpsUrl(url);
    if (!checked.ok) {
      throw new EngineError("invalid_input", `a reference image must be an https URL the provider can fetch: ${checked.reason}; no call is made`);
    }
    return { type: "image_url", image_url: { url: checked.value } };
  });
}

/** The capabilities of an image route: one 9:16 image, a first frame as a reference, and up to IMAGE_REFERENCES_MAX references. */
export const IMAGE_CAPABILITIES: ProviderCapabilities = {
  ...UNVERIFIED_CAPABILITIES,
  firstFrame: true,
  refsMax: IMAGE_REFERENCES_MAX,
  aspect: ["9:16"],
};

/**
 * The result of one image call, as the poll reports it. A paid answer keeps its bill (actualUsd) when it fails after OpenRouter billed
 * it. The message is ours (a short reason written by this code), never provider text.
 */
export type ImageResult = { state: "done"; uri: string; mediaType: string; actualUsd?: number } | { state: "failed"; message: string; actualUsd?: number };

const imageResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("done"),
    uri: z.string().min(1).max(OUTPUT_LIMITS.urlMaxLength),
    mediaType: z.string().min(1),
    actualUsd: z.number().nonnegative().finite().optional(),
  }),
  z.object({
    state: z.literal("failed"),
    message: z.string().min(1).max(200),
    actualUsd: z.number().nonnegative().finite().optional(),
  }),
]);

const IMAGE_REF_PREFIX = "image:";

/**
 * The job reference of an image call: its result, base64url-encoded in the reference itself. An image call is synchronous, so the
 * answer exists before the router holds the job; keeping it in the reference means the poller (which may be another process, with
 * another adapter instance) reads the same answer, and nothing is lost to a restart.
 */
export function encodeImageResult(result: ImageResult): string {
  return `${IMAGE_REF_PREFIX}${Buffer.from(JSON.stringify(result), "utf8").toString("base64url")}`;
}

/** The result a job reference carries, or null when the reference is not one this adapter wrote (fail closed). */
export function decodeImageResult(jobRef: string): ImageResult | null {
  if (!jobRef.startsWith(IMAGE_REF_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(jobRef.slice(IMAGE_REF_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = imageResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const imageAnswer = z.looseObject({
  data: z
    .array(z.looseObject({ b64_json: z.string().min(1), media_type: z.string().optional() }))
    .min(1),
  usage: z.looseObject({ cost: z.number().finite().nonnegative().optional() }).optional(),
});

export type OpenRouterImageOptions = {
  gateway: Gateway;
  organizationId: string | null;
  workspaceId: string;
  route: ResolvedRoute;
  media: MediaStore;
};

/** One OpenRouter image model as a RoutedAdapter. The model comes from the route table. */
export function openRouterImageAdapter(options: OpenRouterImageOptions): RoutedAdapter {
  const { gateway, organizationId, workspaceId, route, media } = options;
  const model = route.model;
  if (route.capability !== "image.keyframe" && route.capability !== "image.edit") {
    throw new EngineError("config", `openRouterImageAdapter cannot serve ${route.capability}`);
  }
  const modelClass: ModelClass = route.capability;

  return {
    id: `${PROVIDER}:${model}`,
    providerId: PROVIDER,
    modelClass,
    // Images have no duration and no last frame. The aspect is the one PROVIDER_APIS.md documents for images.
    capabilities: IMAGE_CAPABILITIES,

    price() {
      return { estimateUsd: listPriceUsd(route.priceKey, "per_image", 1) };
    },

    async connection(organization: string | null): Promise<AdapterConnection> {
      const connection = await gateway.connection(PROVIDER, organization);
      return connection.connected ? { connected: true } : { connected: false, reason: connection.reason ?? "OpenRouter is not connected" };
    },

    async submit(spec: AssetSpec, _key: string): Promise<{ jobRef: string }> {
      // Checked before any call: a reference the provider cannot read is refused here, and nothing is spent on it.
      const references = imageReferencesOf(spec);
      const response = await callProvider(gateway, {
        provider: PROVIDER,
        organizationId,
        method: "POST",
        path: "/images",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: spec.prompt,
          n: 1,
          aspect_ratio: "9:16",
          output_format: "png",
          seed: spec.seed,
          ...(references.length > 0 ? { input_references: references } : {}),
        }),
        timeoutMs: IMAGE_TIMEOUT_MS,
      });
      ensureOk(response);
      const answer = imageAnswer.safeParse(jsonBody(PROVIDER, response));
      if (!answer.success) return { jobRef: encodeImageResult({ state: "failed", message: "the image answer did not match its shape" }) };
      const billed = answer.data.usage?.cost;
      const billedField = billed === undefined ? {} : { actualUsd: billed };
      const fail = (message: string): { jobRef: string } => ({ jobRef: encodeImageResult({ state: "failed", message, ...billedField }) });
      const item = answer.data.data[0];
      if (item === undefined || item.media_type === undefined) return fail("the image answer named no media type");

      const decoded = decodeBase64Strict(item.b64_json);
      if (!decoded.ok) return fail(decoded.reason);
      const checked = normaliseImage(decoded.value, item.media_type);
      if (!checked.ok) return fail(checked.reason);

      let stored: { uri: string };
      try {
        stored = await media.put({
          workspaceId,
          bytes: checked.value.bytes,
          mediaType: checked.value.mediaType,
          contentHash: contentHash(checked.value.bytes),
        });
      } catch (error) {
        return fail(`the image could not be stored: ${excerpt(error instanceof Error ? error.message : "unknown error")}`);
      }
      return { jobRef: encodeImageResult({ state: "done", uri: stored.uri, mediaType: checked.value.mediaType, ...billedField }) };
    },

    async poll(jobRef: string): Promise<ProviderPoll> {
      const result = decodeImageResult(jobRef);
      if (result === null) return { state: "failed", error: { kind: "unknown", retryable: false, message: "no result for this job" } };
      if (result.state === "done") {
        return { state: "done", uri: result.uri, ...(result.actualUsd === undefined ? {} : { actualUsd: result.actualUsd }) };
      }
      return {
        state: "failed",
        error: { kind: "unknown", retryable: false, message: result.message },
        ...(result.actualUsd === undefined ? {} : { actualUsd: result.actualUsd }),
      };
    },

    detailsFor(jobRef: string) {
      const result = decodeImageResult(jobRef);
      return result !== null && result.state === "done" ? { mediaType: result.mediaType } : undefined;
    },
  };
}
