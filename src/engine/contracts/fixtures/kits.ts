// One valid fixture per kit type (Bible section 13). Kits are read-only to the engine.

import type { CharacterSheet, Persona, ProductKit, StyleKit, VoiceKit } from "../index.ts";

export const styleKitFixture: StyleKit = {
  styleKitId: "sk_fixture",
  version: 3,
  pageId: "page_fixture",
  palette: {
    primary: "#1B1B1B",
    secondary: "#F2F2F2",
    accent: "#FF6B35",
    text: "#101010",
    background: "#FAFAF7",
  },
  fonts: { display: "Fraunces", body: "Inter", captions: "Inter" },
  captionStyle: {
    component: "captions.karaoke",
    highlight: "#FFD60A",
    weight: 700,
    case: "upper",
  },
  lut: "store://luts/warm-kitchen.cube",
  motionIntensity: 2,
  preferredTypes: ["ugc_presenter", "product_hero", "coded_graphics"],
  bannedTypes: ["cartoon_generated"],
  musicGenres: ["lofi", "funk"],
  outroMs: 0,
  stickers: ["sticker_star"],
};

export const personaFixture: Persona = {
  personaId: "persona_fixture",
  version: 2,
  pageId: "page_fixture",
  portraits: [
    "store://personas/fixture/portrait-1.png",
    "store://personas/fixture/portrait-2.png",
    "store://personas/fixture/portrait-3.png",
  ],
  description: "Late-20s home cook, warm and direct",
  wardrobe: "Plain grey crew-neck",
  setting: "Bright kitchen, morning light",
  voiceId: "voice_fixture",
  wordsPerMinute: 150,
  isAiGenerated: true,
};

export const characterSheetFixture: CharacterSheet = {
  characterId: "char_fixture",
  version: 1,
  kind: "rigged_svg",
  rigUri: "store://rigs/fixture-mascot.svg",
  poses: ["idle", "point"],
  visemes: ["A", "E", "O", "M", "rest"],
};

export const productKitFixture: ProductKit = {
  productKitId: "pk_fixture",
  version: 1,
  sku: "SKU-FIX-001",
  heroImages: [
    { uri: "store://products/fixture-blender-front.png", angle: "front" },
    { uri: "store://products/fixture-blender-detail.png", angle: "detail" },
  ],
  cutouts: ["store://products/fixture-blender-cutout.png"],
  colours: ["#1B1B1B", "#F2F2F2"],
  name: "Fixture Blender",
  approvedClaims: [
    {
      claimId: "claim_fixture_1",
      text: "Makes four smoothies in under two minutes",
      proofUri: "store://proof/fixture-claim-1.pdf",
    },
  ],
  forbidden: ["cures", "guaranteed"],
};

export const voiceKitFixture: VoiceKit = {
  voiceId: "voice_fixture",
  provider: "fixture-tts",
  providerVoiceId: "fixture-voice-01",
  direction: "Warm, direct, slightly playful",
};
