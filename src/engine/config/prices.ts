// Price table (Bible 10.3, October 2026 list prices). A null usd means the price is unknown: it is token-priced,
// priced per model, marked "verify", or the vendor is not yet chosen. A null price is never a guess and never 0.
// Prices are replaced by reconciled actuals once the ledger has 50 calls (10.3), so they are not Tunable here.

import type { ModelClass } from "../contracts/plan.ts";

export type PriceUnit =
  | "per_second"
  | "per_image"
  | "per_minute"
  | "per_million_characters"
  | "per_million_output_tokens"
  | "per_token"
  | "per_call"
  | "per_model";

export type Price = {
  readonly unit: PriceUnit;
  readonly usd: number | null;
  /**
   * list_oct_2026: a list price checked for this table. third_party_unverified: a price from a third-party source, not checked against
   * the vendor's own price page. openrouter_listing (owner decision 2026-10-17): the price OpenRouter's public listing shows, read
   * 2026-10-17 and not checked against the vendor's page. The owner's live run verifies any of them before it is relied on (Bible 10.3).
   */
  readonly source: "list_oct_2026" | "third_party_unverified" | "openrouter_listing";
};

const LIST = "list_oct_2026" as const;

const priceEntries = {
    // video.cinematic, in priority order (10.3).
    kling_v3_standard: { unit: "per_second", usd: 0.126, source: LIST },
    veo_3_1_fast: { unit: "per_second", usd: 0.1, source: LIST },
    seedance_2_5: { unit: "per_second", usd: 0.1028, source: LIST },

    // video.budget.
    seedance_2_0_mini: { unit: "per_second", usd: 0.0336, source: LIST },
    wan_3_0: { unit: "per_second", usd: 0.0425, source: LIST },
    veo_3_1_lite: { unit: "per_second", usd: 0.05, source: LIST },

    // video.i2v_pinned: the price depends on which model passes the first-and-last-frame test in E2.
    i2v_pinned_model: { unit: "per_model", usd: null, source: LIST },

    // avatar.
    heygen_avatar_iv: { unit: "per_second", usd: 0.05, source: LIST },

    // image.keyframe.
    seedream_5_flash: { unit: "per_image", usd: 0.018, source: LIST },
    seedream_4_5: { unit: "per_image", usd: 0.04, source: LIST },

    // image.edit: token-priced.
    nano_banana_2: { unit: "per_token", usd: null, source: LIST },
    gpt_image_2: { unit: "per_token", usd: null, source: LIST },

    // tts. Eleven v4 is the Bible's $40 per million characters. Gemini 3.8 Flash TTS is $9 per million output tokens on OpenRouter's
    // listing (owner decision 2026-10-17). Its output tokens are not known before the call, so the speech adapter never estimates it.
    eleven_v4: { unit: "per_million_characters", usd: 40, source: LIST },
    gemini_3_8_flash_tts: { unit: "per_million_output_tokens", usd: 9, source: "openrouter_listing" },

    // Speech-to-text: the vendor is Deepgram (owner decision 2026-10-16, Bible 20.2). Nova-3 pre-recorded at $0.0043 a minute is from
    // third-party sources, not checked against Deepgram's own price page, so it is unverified until the owner's live run.
    deepgram_nova3_prerecorded: { unit: "per_minute", usd: 0.0043, source: "third_party_unverified" },
    // The generic speech-to-text placeholder before the vendor was chosen. It stays null: nothing is priced from it.
    stt_vendor: { unit: "per_minute", usd: null, source: LIST },

    // Lip-sync, background removal and upscaling: vendors are chosen in E2.
    lipsync_vendor: { unit: "per_call", usd: null, source: LIST },
    background_removal_vendor: { unit: "per_call", usd: null, source: LIST },
    upscaling_vendor: { unit: "per_call", usd: null, source: LIST },

    // Stock: free with a key (licence check in E2).
    pexels: { unit: "per_call", usd: 0, source: LIST },
    pixabay: { unit: "per_call", usd: 0, source: LIST },

    // Coded components and existing assets add no provider cost.
    code_component: { unit: "per_call", usd: 0, source: LIST },
    existing_asset: { unit: "per_call", usd: 0, source: LIST },

    // Render. HyperFrames cloud is marked "verify" in the Bible; Remotion Lambda has no number.
    render_hyperframes_cloud: { unit: "per_minute", usd: null, source: LIST },
    render_remotion_lambda: { unit: "per_minute", usd: null, source: LIST },
    render_shotstack: { unit: "per_minute", usd: 0.2, source: LIST },
} as const satisfies Record<string, Price>;

export type PriceKey = keyof typeof priceEntries;

/** A Claude token rate in USD per million tokens (Bible 11.1), for the estimate and the list-price fallback. */
export type TokenRate = { readonly inputUsdPerMillion: number; readonly outputUsdPerMillion: number };

/**
 * Claude token rates (Bible 11.1), keyed by the OpenRouter model id in config/routes.ts. Opus 5.5 ($4 / $20) and Sonnet 5.5
 * ($2 / $10) are the rates Bible 11.1 uses. Haiku is costed at Haiku 4.5's $1 / $5 until Haiku 5.5's rate is confirmed (owner
 * check, Bible 11.1), so the Haiku entry is not yet a confirmed price. Cached-input reads ($0.20 per million) and Batch pricing
 * (half price) are not modelled: the route cannot use them yet. A model with no entry has no estimate, and its call refuses.
 * Config tests check that these keys are exactly the Claude models the route table names.
 */
const tokenRateEntries = {
  "anthropic/claude-opus-5.5": { inputUsdPerMillion: 4, outputUsdPerMillion: 20 },
  "anthropic/claude-sonnet-5.5": { inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  "anthropic/claude-haiku-5.5": { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
} as const satisfies Record<string, TokenRate>;

export type ClaudeModelId = keyof typeof tokenRateEntries;

export const prices = {
  version: "prices@2",

  entries: priceEntries,

  /** Claude token rates (Bible 11.1). claude/rates.ts keeps its own copy until the lead points it at this table. */
  tokenRates: tokenRateEntries,

  /** The default priced route for each model class: the first provider in 10.3 priority order. */
  routeFor: {
    "video.cinematic": "kling_v3_standard",
    "video.budget": "seedance_2_0_mini",
    "video.i2v_pinned": "i2v_pinned_model",
    avatar: "heygen_avatar_iv",
    "image.keyframe": "seedream_5_flash",
    "image.edit": "nano_banana_2",
    tts: "eleven_v4",
    lipsync: "lipsync_vendor",
  } as const satisfies Record<ModelClass, PriceKey>,

  /** The price key for each non-generated source kind (7.1: coded graphics $0, stock free, existing asset). */
  sourceRoutes: {
    stock: "pexels",
    component: "code_component",
    asset: "existing_asset",
  } as const satisfies Record<"stock" | "component" | "asset", PriceKey>,
} as const;

/** The price for a key. Throws nothing: an unknown price is returned as usd null for the caller to refuse. */
export function priceFor(key: PriceKey): Price {
  return priceEntries[key];
}
