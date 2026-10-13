// Consistency kits (Bible section 13). Kits are read-only to the engine; each carries a version.

import { z } from "zod";
import { visualTypeSchema } from "./plan.ts";
import { hexColourSchema } from "./primitives.ts";

/** A reference to one kit version, as carried by a ValidatedRequest. */
export const kitRefSchema = z.object({
  id: z.string().min(1),
  version: z.int().positive(),
});
export type KitRef = z.infer<typeof kitRefSchema>;

export const CAPTION_COMPONENTS = ["captions.karaoke", "captions.boxed", "captions.minimal"] as const;

export const styleKitSchema = z.object({
  styleKitId: z.string().min(1),
  version: z.int().positive(),
  pageId: z.string().min(1),
  palette: z.object({
    primary: hexColourSchema,
    secondary: hexColourSchema,
    accent: hexColourSchema,
    text: hexColourSchema,
    background: hexColourSchema,
  }),
  fonts: z.object({
    display: z.string().min(1),
    body: z.string().min(1),
    captions: z.string().min(1),
  }),
  captionStyle: z.object({
    component: z.enum(CAPTION_COMPONENTS),
    highlight: hexColourSchema,
    weight: z.union([z.literal(400), z.literal(500), z.literal(700)]),
    case: z.enum(["sentence", "upper"]),
  }),
  lut: z.string().min(1).optional(),
  motionIntensity: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  preferredTypes: z.array(visualTypeSchema),
  bannedTypes: z.array(visualTypeSchema),
  musicGenres: z.array(z.string().min(1)),
  outroMs: z.int().nonnegative(),
  stickers: z.array(z.string().min(1)),
});
export type StyleKit = z.infer<typeof styleKitSchema>;

export const personaSchema = z.object({
  personaId: z.string().min(1),
  version: z.int().positive(),
  pageId: z.string().min(1),
  portraits: z.array(z.string().min(1)).min(3).max(5),
  description: z.string().min(1),
  wardrobe: z.string().min(1),
  setting: z.string().min(1),
  voiceId: z.string().min(1),
  wordsPerMinute: z.number().positive().finite(),
  isAiGenerated: z.literal(true),
  consentRecord: z.string().min(1).optional(),
});
export type Persona = z.infer<typeof personaSchema>;

export const characterSheetSchema = z.object({
  characterId: z.string().min(1),
  version: z.int().positive(),
  kind: z.enum(["rigged_svg", "generated"]),
  rigUri: z.string().min(1).optional(),
  poses: z.array(z.string().min(1)).optional(),
  visemes: z.array(z.string().min(1)).optional(),
  references: z.array(z.string().min(1)).optional(),
  styleNotes: z.string().min(1).optional(),
});
export type CharacterSheet = z.infer<typeof characterSheetSchema>;

export const productKitSchema = z.object({
  productKitId: z.string().min(1),
  version: z.int().positive(),
  sku: z.string().min(1),
  heroImages: z.array(
    z.object({
      uri: z.string().min(1),
      angle: z.enum(["front", "side", "back", "detail", "in_use"]),
    }),
  ),
  cutouts: z.array(z.string().min(1)),
  colours: z.array(z.string().min(1)),
  logoUri: z.string().min(1).optional(),
  name: z.string().min(1),
  approvedClaims: z.array(
    z.object({
      claimId: z.string().min(1),
      text: z.string().min(1),
      proofUri: z.string().min(1),
    }),
  ),
  forbidden: z.array(z.string().min(1)),
});
export type ProductKit = z.infer<typeof productKitSchema>;

export const voiceKitSchema = z.object({
  voiceId: z.string().min(1),
  provider: z.string().min(1),
  providerVoiceId: z.string().min(1),
  direction: z.string().min(1),
  consentRecord: z.string().min(1).optional(),
});
export type VoiceKit = z.infer<typeof voiceKitSchema>;
