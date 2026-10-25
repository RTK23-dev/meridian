import type { Transport, TransportRequest, TransportResponse } from "./http.ts";

/**
 * A path that reaches a paid provider or changes something outside Meridian, and has no ledger hold or idempotency guard yet. Each one
 * is off. Its default transport refuses before any request is made, so the refusal sends nothing and records nothing as sent. A test
 * that injects a transport still exercises the module's own logic, which is how the module is tested without a live call.
 *
 * Turning one on needs its guard first: a hold in `providers/generation-ledger.ts`, or an idempotency key with a receipt and an
 * uncertain state, plus a fixture test. Then it is removed from this list, and its gate is replaced by the real transport.
 */
export const DISABLED_CAPABILITIES = {
  "decision.openai": "OpenAI decision calls are not held in the ledger.",
  "decision.typesafe_jev": "TypeSafe JEV decision calls are not held in the ledger.",
  "perception.gemini": "Gemini perception calls are not held in the ledger.",
  "generation.higgsfield_video": "Higgsfield video generation is not held in the ledger.",
  "generation.gemini_omni": "Gemini omni generation is not held in the ledger.",
  "generation.gemini_image": "Gemini image generation is not held in the ledger.",
  "embeddings.external": "The paid embeddings API is not held in the ledger.",
  "drive.write": "Google Drive writes, including resumable uploads, have no idempotency key, so a retry can duplicate a file.",
  "alerts.webhook": "Alert webhooks have no idempotency key or guard.",
  "email.send": "Outbound email has no idempotency key or guard, so a retry can send twice.",
  "hypit.client": "The Hypit client and its runs have no idempotency guard in this code.",
  "publish.facebook": "Facebook writes carry no idempotency key. The guarded path is the organic publish with receipts.",
  "publish.instagram": "Instagram writes carry no idempotency key.",
  "publish.tiktok": "TikTok writes carry no idempotency key.",
  "publish.youtube": "YouTube writes carry no idempotency key.",
  "publish.paused_action": "The paused publish action has no test that proves its idempotency.",
  "publish.meta_video_upload": "The Meta video upload is not verified idempotent.",
  "ads.meta_write": "Meta ad writes are not verified idempotent here. The paused ad path (repurpose-paused-ad.ts) is the guarded one.",
  "ads.google_ads_write": "Google Ads writes have no guard.",
  "ads.tiktok_write": "TikTok ad calls, including writes, have no guard.",
} as const;

export type DisabledCapability = keyof typeof DISABLED_CAPABILITIES;

/** The error a disabled capability throws. It means nothing was sent, so no caller may treat it as an outcome that might have billed. */
export class CapabilityDisabledError extends Error {
  readonly capability: DisabledCapability;

  constructor(capability: DisabledCapability) {
    super(`${DISABLED_CAPABILITIES[capability]} This path is off in this build, so nothing was sent.`);
    this.name = "CapabilityDisabledError";
    this.capability = capability;
  }
}

export function isCapabilityDisabledError(error: unknown): error is CapabilityDisabledError {
  return error instanceof CapabilityDisabledError;
}

/** A transport that refuses every request for one disabled capability. It never calls the network. */
export function gatedTransport(capability: DisabledCapability): Transport {
  return async (_request: TransportRequest): Promise<TransportResponse> => {
    throw new CapabilityDisabledError(capability);
  };
}

/** The fetch replacement for code that calls fetch directly. It never calls the network. */
export function gatedFetch(capability: DisabledCapability): typeof fetch {
  return async () => {
    throw new CapabilityDisabledError(capability);
  };
}
