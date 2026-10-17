// OpenRouter speech (Bible 10.3 tts; owner decision 2026-10-17). The speech is OpenRouter's audio output, as its chat completions document
// it: POST /chat/completions with modalities ["text", "audio"], audio {voice, format: "mp3"} and stream: true. The answer is a server-sent
// event stream. Each event's delta.audio.data is a base64 chunk of the MP3; the chunks are decoded one by one and joined in order. The
// stream's id is the call's generation id. The bill is read once, right after the audio is stored (gateway/generation.ts). A miss leaves
// the submit unsettled (contract v6): no list price is booked as the cost, and the router records the generation id so the reconciler can
// read the bill later (budget/reconcile-holds.ts).
//
// UNVERIFIED LIVE. The request shape is the one the owner chose from OpenRouter's audio output documentation. Not confirmed by a live call:
//   1. that a speech model speaks the user message as it stands (the page's text is sent as the user's message);
//   2. the top-level `speed`, which that documentation does not name for audio output. It is sent only when the pace is not 1. The voice
//      stage's pacing depends on it, and the take's measured length decides the gate either way;
//   3. that the stream's id is the generation id the stats endpoint takes.
// The owner's live run records one take with its stream, its generation id and its bill.
//
// A page's voice belongs to one provider: the voice kit names it (voiceProvider), and a speech model is the page's only when its vendor is
// that provider (the vendor is the part of the model id before the slash). Any other model is not connected for that page, so the router
// never gives a voice id to a provider that does not own it. No voice means not connected: a request without a voice is never sent.
// Voice cloning (input_references) is not used without the owner's approval.

import { z } from "zod";
import { adapters } from "../../config/adapters.ts";
import { EngineError } from "../../contracts/errors.ts";
import type { AssetSpec, ProviderPoll } from "../../contracts/assets.ts";
import type { ModelClass } from "../../contracts/plan.ts";
import { contentHash } from "../../contracts/hash.ts";
import type { Gateway, ResolvedRoute } from "../../gateway/gateway.ts";
import { openRouterGenerationBill } from "../../gateway/generation.ts";
import { bodyText } from "../../gateway/errors.ts";
import { callProvider, ensureOk, listPriceUsd, UNVERIFIED_CAPABILITIES, type AdapterConnection, type MediaStore, type RoutedAdapter } from "../adapter.ts";
import { normaliseSpeech } from "../normalise.ts";
import { excerpt } from "../classify.ts";

const PROVIDER = "openrouter";

export const SPEECH_TIMEOUT_MS = adapters.timeoutsMs.speech.value;

/** The speaking rates the adapter accepts. Anything else is refused before a request is made. */
export const SPEECH_SPEED_RANGE = { min: 0.5, max: 2 } as const;

/**
 * One event of the stream. Only the fields read below are used, and every field is nullable: a provider may send null for a field it
 * has no value for, and that is not a refusal. Everything else in an event is untrusted and ignored.
 */
const streamEventSchema = z.object({
  id: z.string().nullish(),
  error: z.unknown().nullish(),
  choices: z
    .array(z.object({ delta: z.object({ audio: z.object({ data: z.string().nullish() }).nullish() }).nullish() }).nullish())
    .nullish(),
});

/** The audio of a finished stream, or why there is none. */
export type SpeechStream = { ok: true; bytes: Uint8Array; generationId: string | null } | { ok: false; reason: string };

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The audio of one server-sent event stream. A `data:` line is one JSON event, a line starting with `:` is a comment, and `data: [DONE]`
 * ends the stream. Each chunk of delta.audio.data is base64 on its own, so each is decoded on its own and the bytes are joined in order:
 * joining the base64 text first would corrupt a chunk whose length is not a multiple of four. The generation id is the first event's id.
 * A stream with an error event, a chunk that is not base64, no audio, or no [DONE] is refused. It is never completed from what came
 * before it, because the take would then be a guess.
 */
export function speechFromStream(text: string): SpeechStream {
  const chunks: Uint8Array[] = [];
  let generationId: string | null = null;
  let done = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]") {
      done = true;
      break;
    }
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return { ok: false, reason: "a stream event is not JSON" };
    }
    const parsed = streamEventSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "a stream event has an unexpected shape" };
    const event = parsed.data;
    if (event.error !== undefined && event.error !== null) {
      return { ok: false, reason: `the stream reported an error: ${excerpt(JSON.stringify(event.error))}` };
    }
    if (generationId === null && typeof event.id === "string" && event.id.length > 0) generationId = event.id;
    for (const choice of event.choices ?? []) {
      const data = choice?.delta?.audio?.data;
      if (data === undefined || data === null || data.length === 0) continue;
      if (!BASE64_PATTERN.test(data)) return { ok: false, reason: "a stream audio chunk is not base64" };
      chunks.push(new Uint8Array(Buffer.from(data, "base64")));
    }
  }
  if (!done) return { ok: false, reason: "the stream ended before its [DONE] event" };
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (total === 0) return { ok: false, reason: "the stream carried no audio" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes, generationId };
}

/** The vendor of an OpenRouter model id: the part before the slash ("elevenlabs" for "elevenlabs/eleven-v4"). */
export function vendorOf(model: string): string {
  return (model.split("/")[0] ?? "").trim().toLowerCase();
}

export type OpenRouterSpeechOptions = {
  gateway: Gateway;
  organizationId: string | null;
  workspaceId: string;
  route: ResolvedRoute;
  media: MediaStore;
  /** The provider-specific voice id from the page's voice kit (its providerVoiceId). Null means the adapter is not connected. */
  voice: string | null;
  /** The provider the page's voice belongs to (the voice kit's provider, for example "elevenlabs" or "google"). Null: not connected. */
  voiceProvider: string | null;
  /** The speaking rate (1 is the vendor's default and is not sent). The voice stage paces a take with it (Bible 6.3). */
  speed?: number;
};

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
  const belongsTo = options.voiceProvider === null ? "" : options.voiceProvider.trim().toLowerCase();
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
      if (belongsTo === "") {
        return { connected: false, reason: "this page's voice names no provider, so it is not matched to a speech model; no request is made" };
      }
      if (belongsTo !== vendorOf(model)) {
        return {
          connected: false,
          reason: `this page's voice belongs to ${belongsTo}, not to ${vendorOf(model)}, so this speech model does not speak it; no request is made`,
        };
      }
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
        path: "/chat/completions",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({
          model,
          modalities: ["text", "audio"],
          audio: { voice, format: "mp3" },
          messages: [{ role: "user", content: spec.prompt }],
          stream: true,
          ...(speed === 1 ? {} : { speed }),
        }),
        timeoutMs: SPEECH_TIMEOUT_MS,
      });
      ensureOk(response);
      const stream = speechFromStream(bodyText(response));
      if (!stream.ok) {
        results.set(jobRef, { state: "failed", error: { kind: "unknown", retryable: false, message: stream.reason } });
        return { jobRef };
      }
      const checked = normaliseSpeech(stream.bytes, "audio/mpeg");
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
      details.set(jobRef, {
        mediaType: checked.value.mediaType,
        ...(stream.generationId === null ? {} : { generationId: stream.generationId }),
      });
      results.set(jobRef, { state: "done", uri: stored.uri });
      return { jobRef };
    },

    async poll(jobRef: string): Promise<ProviderPoll> {
      const result = results.get(jobRef) ?? { state: "failed" as const, error: { kind: "unknown" as const, retryable: false, message: "no result for this job" } };
      if (result.state !== "done") return result;
      // The bill is read once for a finished job: a miss is remembered too, so the stats are not asked again (the router settles on it).
      if (!bills.has(jobRef)) {
        const generationId = details.get(jobRef)?.generationId;
        if (generationId === undefined) {
          bills.set(jobRef, null);
        } else {
          const read = await openRouterGenerationBill(gateway, { organizationId, generationId });
          bills.set(jobRef, read.status === "billed" ? read.usd : null);
        }
      }
      const bill = bills.get(jobRef) ?? null;
      return bill === null ? result : { ...result, actualUsd: bill };
    },

    detailsFor(jobRef: string) {
      return details.get(jobRef);
    },
  };
}
