// The route table (owner decision 2026-10-14, PHASE_LOG): which provider and model serve each capability. OpenRouter is the
// default platform for every model API. Switching a model or a provider is a change to this file, not to code; the gateway
// (src/engine/gateway) reads it and nothing else decides where a call goes.
//
// A model is null when its id is not known yet (the vendor is open, or the OpenRouter id has not been checked). A null model
// is never guessed: the gateway refuses the capability until it is set. `verified` is false until a live call (or the
// OpenRouter models listing, gateway/openrouter.ts verifyRoutes) has confirmed the id; the owner's live run checks them.

import { MODEL_CLASSES } from "../contracts/plan.ts";
import type { PriceKey } from "./prices.ts";

export const CAPABILITIES = [
  // Claude roles (Bible 11.1): Opus for direction, Sonnet for analysis and structured writing, Haiku for checks and volume.
  "llm.direction",
  "llm.analysis",
  "llm.check",
  ...MODEL_CLASSES,
  "stt",
  "stock",
  "render.cloud",
  "render.fallback",
  "media.functions",
  // Instagram discovery at volume (Factory Gather). Apify actors, not model APIs: the "model" is the actor id.
  "discovery.instagram",
  "discovery.instagram.creator",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type RouteTarget = {
  provider: string;
  model: string | null;
  /** The price table entry for the call, or null when the provider bills per token and reports the cost itself. */
  priceKey: PriceKey | null;
  verified: boolean;
};

export type Route = {
  /** In priority order. The first target is the route; the rest are fallbacks for the asset router (Bible 10.4). */
  targets: RouteTarget[];
  /** Why the capability has no usable target, when it has none. */
  note?: string;
};

const openrouter = (model: string | null, priceKey: PriceKey | null, verified = false): RouteTarget => ({
  provider: "openrouter",
  model,
  priceKey,
  verified,
});

export const routes = {
  version: "routes@1",

  table: {
    "llm.direction": { targets: [openrouter("anthropic/claude-opus-5.5", null)] },
    "llm.analysis": { targets: [openrouter("anthropic/claude-sonnet-5.5", null)] },
    "llm.check": { targets: [openrouter("anthropic/claude-haiku-5.5", null)] },

    // Bible 10.3, in priority order. The first price key matches prices.routeFor, so the estimate and the call agree.
    "video.cinematic": {
      targets: [
        openrouter(null, "kling_v3_standard"),
        openrouter(null, "seedance_2_5"),
      ],
      note: "Model ids come from the live catalog (Bible 10.5), not from this table.",
    },
    "video.budget": {
      targets: [openrouter(null, "seedance_2_0_mini"), openrouter(null, "wan_3_0")],
      note: "Model ids come from the live catalog (Bible 10.5), not from this table.",
    },
    "video.i2v_pinned": {
      targets: [openrouter(null, "i2v_pinned_model")],
      note: "Chosen by the first-and-last-frame test in E2 (Bible 20.3 item 2).",
    },
    avatar: { targets: [openrouter(null, "heygen_avatar_iv")], note: "HeyGen Avatar IV via OpenRouter: to verify, Bible 20.3 item 3." },
    "image.keyframe": {
      targets: [openrouter(null, "seedream_5_flash"), openrouter(null, "seedream_4_5")],
      note: "The OpenRouter id of Seedream 5.0 Flash is not checked yet; Seedream 4.5's id is from OpenRouter's image docs.",
    },
    "image.edit": {
      targets: [openrouter(null, "nano_banana_2"), openrouter(null, "gpt_image_2")],
      note: "The OpenRouter image model ids are set in E2.",
    },
    // Speech (Bible 10.3; owner decision 2026-10-17). The ids are from OpenRouter's public listing, read 2026-10-17, and are unverified
    // live. A page's voice belongs to one provider (its voice kit names it), so a target of another vendor is not used for that page
    // (assets/providers/openrouterSpeech.ts). The Gemini target is priced per output token, which no call can know before it is made,
    // so the router refuses to estimate it and it is not used until the owner sets a basis for that estimate.
    tts: {
      targets: [openrouter(null, "eleven_v4"), openrouter(null, "gemini_3_8_flash_tts")],
      note: "Model ids come from the live catalog (Bible 10.5), not from this table.",
    },
    lipsync: { targets: [], note: "The lip-sync vendor is chosen in E2." },

    // Speech-to-text (owner decision 2026-10-16, Bible 10.3, 20.2): Deepgram pre-recorded /v1/listen with word timestamps, called
    // directly rather than through OpenRouter. The gateway lists the deepgram provider (gateway/providers.ts) and its credential
    // (gateway/meridian.ts). Without a Deepgram key the route returns NOT_CONNECTED and sends nothing.
    stt: {
      targets: [{ provider: "deepgram", model: "nova-3", priceKey: "deepgram_nova3_prerecorded", verified: false }],
      note: "Deepgram is a gateway provider. Its target is unverified until a live run: no live call has been made from this table.",
    },
    // Stock video (Bible 10.3), in priority order. "videos" names the endpoint family, not a model.
    stock: {
      targets: [
        { provider: "pexels", model: "videos", priceKey: "pexels", verified: false },
        { provider: "pixabay", model: "videos", priceKey: "pixabay", verified: false },
      ],
    },
    "render.cloud": {
      targets: [{ provider: "heygen", model: "hyperframes", priceKey: "render_hyperframes_cloud", verified: false }],
    },
    "render.fallback": {
      targets: [{ provider: "shotstack", model: "edit-v1", priceKey: "render_shotstack", verified: false }],
    },
    "media.functions": { targets: [{ provider: "media_functions", model: "ffmpeg", priceKey: null, verified: false }] },

    // Apify actors (docs/engine/PROVIDER_APIS.md, Apify). The price is unknown until the owner confirms the plan, so the
    // priceKey is null and no cost is estimated. "verified" stays false until the owner's live run.
    "discovery.instagram": {
      targets: [{ provider: "apify", model: "apify~instagram-hashtag-scraper", priceKey: null, verified: false }],
    },
    "discovery.instagram.creator": {
      targets: [{ provider: "apify", model: "apify~instagram-reel-scraper", priceKey: null, verified: false }],
    },
  } satisfies Record<Capability, Route>,
} as const;

export type RouteTable = Record<Capability, Route>;

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}
