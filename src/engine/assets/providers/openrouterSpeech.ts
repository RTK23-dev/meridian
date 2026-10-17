// OpenRouter speech (Bible 10.3 tts; PROVIDER_APIS.md "Speech"). POST /audio/speech returns raw MP3 bytes with the generation id in a
// header. The call's bill is read once, after the answer is stored, from the generation stats: GET /generation?id=<generation id>, the
// `data.total_cost` in USD (owner decision, lead, 2026-10-17). A miss (an error, no generation id, no total_cost, or stats not yet
// there) leaves the submit unsettled, as contract v6 says: no list price is booked as the cost. The bytes are validated and stored through
// the MediaStore. The read is not verified live (the owner's run).
//
// The voice is a per-page setting (the voice kit), so the adapter takes it at construction. No voice means not connected:
// a request without a voice is never sent. Voice cloning (input_references) is not used without the owner's approval.

import { z } from "zod";
import { adapters } from "../../config/adapters.ts";
import { EngineError } from "../../contracts/errors.ts";
import type { AssetSpec, ProviderPoll } from "../../contracts/assets.ts";
import type { ModelClass } from "../../contracts/plan.ts";
import { contentHash } from "../../contracts/hash.ts";
import type { Gateway, ResolvedRoute } from "../../gateway/gateway.ts";
import { bodyText } from "../../gateway/errors.ts";
import { callProvider, ensureOk, listPriceUsd, UNVERIFIED_CAPABILITIES, type AdapterConnection, type MediaStore, type RoutedAdapter } from "../adapter.ts";
import { normaliseSpeech } from "../normalise.ts";
import { excerpt } from "../classify.ts";

const PROVIDER = "openrouter";

export const SPEECH_TIMEOUT_MS = adapters.timeoutsMs.speech.value;

/** The generation stats answer: `data.total_cost` is the bill in USD. Other fields are not read. */
export const generationStatsSchema = z.object({ data: z.object({ total_cost: z.number() }) });

/**
 * The bill of one generation, from its stats, or null when it cannot be read. One read, no retry here: the caller records a miss as
 * unsettled. A non-finite or negative cost is a miss, never a bill of zero.
 */
export async function readGenerationBill(gateway: Gateway, organizationId: string | null, generationId: string): Promise<number | null> {
  let body: unknown;
  try {
    const response = await callProvider(gateway, {
      provider: PROVIDER,
      organizationId,
      method: "GET",
      path: `/generation?id=${encodeURIComponent(generationId)}`,
      timeoutMs: SPEECH_TIMEOUT_MS,
    });
    if (response.status !== 200) return null;
    body = JSON.parse(bodyText(response));
  } catch {
    return null;
  }
  const parsed = generationStatsSchema.safeParse(body);
  if (!parsed.success) return null;
  const cost = parsed.data.data.total_cost;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

export type OpenRouterSpeechOptions = {
  gateway: Gateway;
  organizationId: string | null;
  workspaceId: string;
  route: ResolvedRoute;
  media: MediaStore;
  /** The provider-specific voice id from the page's voice kit. Null means the adapter is not connected. */
  voice: string | null;
  /** The speaking rate (PROVIDER_APIS "speed"). 1 is the default and is not sent. The voice stage paces a take with it (Bible 6.3). */
  speed?: number;
};

/** The speaking rates the adapter accepts. Anything else is refused before a request is made. */
export const SPEECH_SPEED_RANGE = { min: 0.5, max: 2 } as const;

/** One OpenRouter speech model as a RoutedAdapter. Priced per million characters of the script text. */
export function openRouterSpeechAdapter(options: OpenRouterSpeechOptions): RoutedAdapter {
  const { gateway, organizationId, workspaceId, route, media, voice } = options;
  const speed = options.speed ?? 1;
  if (!Number.isFinite(speed) || speed < SPEECH_SPEED_RANGE.min || speed > SPEECH_SPEED_RANGE.max) {
    throw new EngineError("invalid_input", `the speech speed must be from ${SPEECH_SPEED_RANGE.min} to ${SPEECH_SPEED_RANGE.max}`);
  }
  const model = route.model;
  if (route.capability !== "tts") throw new EngineError("config", `openRouterSpeechAdapter cannot serve ${route.capability}`);
  const modelClass: ModelClass = "tts";
  const results = new Map<string, ProviderPoll>();
  const details = new Map<string, { generationId?: string; mediaType: string }>();
  /** The one bill read of each finished job: its cost, or null for a miss. */
  const bills = new Map<string, number | null>();

  return {
    // The speed is part of the identity: a take at another rate is another call, with its own cache key and breaker bucket.
    id: speed === 1 ? `${PROVIDER}:${model}` : `${PROVIDER}:${model}@speed=${speed}`,
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
        body: JSON.stringify({ model, input: spec.prompt, voice, response_format: "mp3", ...(speed === 1 ? {} : { speed }) }),
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
      const result = results.get(jobRef) ?? { state: "failed" as const, error: { kind: "unknown" as const, retryable: false, message: "no result for this job" } };
      if (result.state !== "done") return result;
      // The bill is read once for a finished job: a miss is remembered too, so the stats are not asked again (the router settles on it).
      if (!bills.has(jobRef)) {
        const generationId = details.get(jobRef)?.generationId;
        bills.set(jobRef, generationId === undefined ? null : await readGenerationBill(gateway, organizationId, generationId));
      }
      const bill = bills.get(jobRef) ?? null;
      return bill === null ? result : { ...result, actualUsd: bill };
    },

    detailsFor(jobRef: string) {
      return details.get(jobRef);
    },
  };
}
