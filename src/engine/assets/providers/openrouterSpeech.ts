// OpenRouter speech (Bible 10.3 tts; PROVIDER_APIS.md "Speech"). POST /audio/speech returns raw MP3 bytes with the generation
// id in a header and no cost. The cost is therefore the price table's estimate, flagged as an estimate by the ledger (the
// router passes no actual). The bytes are validated and stored through the MediaStore.
//
// The voice is a per-page setting (the voice kit), so the adapter takes it at construction. No voice means not connected:
// a request without a voice is never sent. Voice cloning (input_references) is not used without the owner's approval.

import { EngineError } from "../../contracts/errors.ts";
import type { AssetSpec, ProviderPoll } from "../../contracts/assets.ts";
import type { ModelClass } from "../../contracts/plan.ts";
import { contentHash } from "../../contracts/hash.ts";
import type { Gateway, ResolvedRoute } from "../../gateway/gateway.ts";
import { callProvider, ensureOk, listPriceUsd, UNVERIFIED_CAPABILITIES, type AdapterConnection, type MediaStore, type RoutedAdapter } from "../adapter.ts";
import { normaliseSpeech } from "../normalise.ts";
import { excerpt } from "../classify.ts";

const PROVIDER = "openrouter";

export const SPEECH_TIMEOUT_MS = 120_000;

export type OpenRouterSpeechOptions = {
  gateway: Gateway;
  organizationId: string | null;
  workspaceId: string;
  route: ResolvedRoute;
  media: MediaStore;
  /** The provider-specific voice id from the page's voice kit. Null means the adapter is not connected. */
  voice: string | null;
};

/** One OpenRouter speech model as a RoutedAdapter. Priced per million characters of the script text. */
export function openRouterSpeechAdapter(options: OpenRouterSpeechOptions): RoutedAdapter {
  const { gateway, organizationId, workspaceId, route, media, voice } = options;
  const model = route.model;
  if (route.capability !== "tts") throw new EngineError("config", `openRouterSpeechAdapter cannot serve ${route.capability}`);
  const modelClass: ModelClass = "tts";
  const results = new Map<string, ProviderPoll>();
  const details = new Map<string, { generationId?: string; mediaType: string }>();

  return {
    id: `${PROVIDER}:${model}`,
    providerId: PROVIDER,
    modelClass,
    capabilities: UNVERIFIED_CAPABILITIES,

    price(spec: AssetSpec) {
      const characters = [...spec.prompt].length;
      return { estimateUsd: listPriceUsd(route.priceKey, "per_million_characters", characters / 1_000_000) };
    },

    async connection(organization: string | null): Promise<AdapterConnection> {
      if (voice === null || voice.trim() === "") return { connected: false, reason: "this page has no voice id; no speech request is made" };
      const connection = await gateway.connection(PROVIDER, organization);
      return connection.connected ? { connected: true } : { connected: false, reason: connection.reason ?? "OpenRouter is not connected" };
    },

    async submit(spec: AssetSpec, key: string): Promise<{ jobRef: string }> {
      if (voice === null) throw new EngineError("config", "this page has no voice id; no speech request is made");
      if (spec.refs.length > 0) throw new EngineError("invalid_input", "speech takes no reference images in this adapter");
      const jobRef = `speech:${key}`;
      const response = await callProvider(gateway, {
        provider: PROVIDER,
        organizationId,
        method: "POST",
        path: "/audio/speech",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: spec.prompt, voice, response_format: "mp3" }),
        timeoutMs: SPEECH_TIMEOUT_MS,
      });
      ensureOk(response);
      const generationId = response.headers["x-generation-id"];
      const declared = response.headers["content-type"] ?? "";
      const checked = normaliseSpeech(response.body, declared);
      if (!checked.ok) {
        results.set(jobRef, { state: "failed", error: { kind: "unknown", retryable: false, message: checked.reason } });
        return { jobRef };
      }
      let stored: { uri: string };
      try {
        stored = await media.put({
          workspaceId,
          bytes: checked.value.bytes,
          mediaType: checked.value.mediaType,
          contentHash: contentHash(checked.value.bytes),
        });
      } catch (error) {
        results.set(jobRef, {
          state: "failed",
          error: {
            kind: "unknown",
            retryable: false,
            message: `the speech could not be stored: ${excerpt(error instanceof Error ? error.message : "unknown error")}`,
          },
        });
        return { jobRef };
      }
      details.set(jobRef, { mediaType: checked.value.mediaType, ...(generationId === undefined ? {} : { generationId }) });
      results.set(jobRef, { state: "done", uri: stored.uri });
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
