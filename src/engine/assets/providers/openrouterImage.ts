// OpenRouter images (Bible 10.3 image.keyframe and image.edit; PROVIDER_APIS.md "Images"). A synchronous API: submit makes the
// call, decodes the base64 bytes, validates them and stores them through the MediaStore. poll then returns the stored uri.
//
// A paid answer is never lost to a later failure: if decoding, validation or storage fails after OpenRouter billed the call,
// the result is a failed poll that still carries usage.cost, so the router records the real bill.
//
// Reference images (input_references) are not sent: their shape is not in PROVIDER_APIS.md, so a spec with references or
// frames is refused before any call. Every call asks for one image; a second take is the caller's second call with a new seed.

import { z } from "zod";
import { EngineError } from "../../contracts/errors.ts";
import type { AssetSpec, ProviderPoll } from "../../contracts/assets.ts";
import type { ModelClass } from "../../contracts/plan.ts";
import { contentHash } from "../../contracts/hash.ts";
import type { Gateway, ResolvedRoute } from "../../gateway/gateway.ts";
import { jsonBody } from "../../gateway/errors.ts";
import { callProvider, ensureOk, listPriceUsd, UNVERIFIED_CAPABILITIES, type AdapterConnection, type MediaStore, type RoutedAdapter } from "../adapter.ts";
import { normaliseImage, decodeBase64Strict } from "../normalise.ts";
import { excerpt } from "../classify.ts";

const PROVIDER = "openrouter";

/** Image calls are synchronous but can take a while. */
export const IMAGE_TIMEOUT_MS = 120_000;

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
  const results = new Map<string, ProviderPoll>();
  const details = new Map<string, { mediaType: string }>();

  return {
    id: `${PROVIDER}:${model}`,
    providerId: PROVIDER,
    modelClass,
    // Images have no duration, frames or references here. The aspect is the one PROVIDER_APIS.md documents for images.
    capabilities: { ...UNVERIFIED_CAPABILITIES, aspect: ["9:16"] },

    price() {
      return { estimateUsd: listPriceUsd(route.priceKey, "per_image", 1) };
    },

    async connection(organization: string | null): Promise<AdapterConnection> {
      const connection = await gateway.connection(PROVIDER, organization);
      return connection.connected ? { connected: true } : { connected: false, reason: connection.reason ?? "OpenRouter is not connected" };
    },

    async submit(spec: AssetSpec, key: string): Promise<{ jobRef: string }> {
      if (spec.refs.length > 0 || spec.firstFrame !== undefined || spec.lastFrame !== undefined) {
        throw new EngineError("invalid_input", "image models take no references or frames in this adapter; no call is made");
      }
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
        }),
        timeoutMs: IMAGE_TIMEOUT_MS,
      });
      ensureOk(response);
      const jobRef = `image:${key}`;
      const answer = imageAnswer.safeParse(jsonBody(PROVIDER, response));
      if (!answer.success) {
        results.set(jobRef, { state: "failed", error: { kind: "unknown", retryable: false, message: "the image answer did not match its shape" } });
        return { jobRef };
      }
      const billed = answer.data.usage?.cost;
      const item = answer.data.data[0];
      const fail = (message: string): { jobRef: string } => {
        results.set(jobRef, {
          state: "failed",
          error: { kind: "unknown", retryable: false, message },
          ...(billed === undefined ? {} : { actualUsd: billed }),
        });
        return { jobRef };
      };
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
      details.set(jobRef, { mediaType: checked.value.mediaType });
      results.set(jobRef, {
        state: "done",
        uri: stored.uri,
        ...(billed === undefined ? {} : { actualUsd: billed }),
      });
      return { jobRef };
    },

    async poll(jobRef: string): Promise<ProviderPoll> {
      return results.get(jobRef) ?? { state: "failed", error: { kind: "unknown", retryable: false, message: "no result for this job" } };
    },

    detailsFor(jobRef: string) {
      return details.get(jobRef);
    },
  };
}
