// The live model list the orchestrator chooses from. The snapshot is read from OpenRouter's public listings (text models, image
// models, speech models and video models) and each entry is kept with its kind and modalities. Prices are not in the snapshot: the
// gateway's catalog (gateway/catalog.ts) supplies them for the cost estimate. The snapshot is untrusted data: every entry is
// parsed with zod, and a row that does not parse is dropped with its reason, never guessed.
//
// Nothing here names a model. A model is in the snapshot because the listing said so.

import { z } from "zod";

export const CATALOG_KINDS = ["text", "image", "speech", "video"] as const;
export const catalogKindSchema = z.enum(CATALOG_KINDS);
export type CatalogKind = z.infer<typeof catalogKindSchema>;

/** The prices the engine prices a call from: USD per unit, or null when the listing does not state that unit. */
export const catalogPricingSchema = z.object({
  promptUsdPerToken: z.number().nonnegative().nullable(),
  completionUsdPerToken: z.number().nonnegative().nullable(),
  imageUsd: z.number().nonnegative().nullable(),
  usdPerSecond1080p: z.number().nonnegative().nullable(),
});
export type CatalogPricing = z.infer<typeof catalogPricingSchema>;

export const catalogEntrySchema = z.object({
  id: z.string().regex(/^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i),
  name: z.string().min(1).max(200),
  kind: catalogKindSchema,
  input_modalities: z.array(z.string()).nullable(),
  output_modalities: z.array(z.string()).nullable(),
  pricing: catalogPricingSchema,
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogSnapshotSchema = z.object({
  source: z.string(),
  takenAt: z.string(),
  entries: z.array(z.unknown()),
});

/** A row an endpoint exclusion (config/model-exclusions.ts) removed from one listing, with the endpoint and the reason. */
export type CatalogExclusion = { id: string; endpoint: string; reason: string };

export type CatalogLoad = {
  takenAt: string;
  byId: Map<string, CatalogEntry>;
  /** Rows that did not parse, with their index, so the caller can show how many were dropped and why. */
  dropped: { index: number; reason: string }[];
  /** Rows an endpoint exclusion removed. Empty for a recorded snapshot, which is loaded without exclusions. */
  excluded: CatalogExclusion[];
};

/**
 * Parse a snapshot. A bad row is dropped with its reason; a bad envelope throws, because then there is no list at all and the
 * orchestrator must not run. A duplicate id keeps the first row.
 */
export function loadCatalog(raw: unknown): CatalogLoad {
  const envelope = catalogSnapshotSchema.parse(raw);
  const byId = new Map<string, CatalogEntry>();
  const dropped: { index: number; reason: string }[] = [];
  envelope.entries.forEach((row, index) => {
    const parsed = catalogEntrySchema.safeParse(row);
    if (!parsed.success) {
      dropped.push({ index, reason: parsed.error.issues[0]?.message ?? "does not parse" });
      return;
    }
    if (byId.has(parsed.data.id)) {
      dropped.push({ index, reason: `duplicate id ${parsed.data.id}` });
      return;
    }
    byId.set(parsed.data.id, parsed.data);
  });
  return { takenAt: envelope.takenAt, byId, dropped, excluded: [] };
}
