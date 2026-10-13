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
  readonly source: "list_oct_2026";
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

    // tts.
    eleven_v4: { unit: "per_million_characters", usd: 40, source: LIST },
    gemini_3_8_flash_tts: { unit: "per_million_output_tokens", usd: null, source: LIST },

    // Speech-to-text: the vendor is an open owner decision (Bible 20.2).
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

export const prices = {
  version: "prices@1",

  entries: priceEntries,

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
