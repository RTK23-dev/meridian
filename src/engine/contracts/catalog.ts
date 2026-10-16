// One OpenRouter catalog candidate (Bible 10.5 step 1, contract v7). The gateway reads the catalog, caches it with its read time,
// and turns each model into one of these. A candidate with no usable price is not representable: `price` is required and its
// `usd` must be positive, so a call that could not be reserved cannot be a candidate.

import { z } from "zod";
import { modelClassSchema } from "./plan.ts";

/** How the catalog prices one unit of the model's output. `usd` is the rate for one such unit, not a charge. */
export const CATALOG_PRICE_UNITS = ["per_second", "per_image", "per_request", "per_token"] as const;
export const catalogPriceUnitSchema = z.enum(CATALOG_PRICE_UNITS);
export type CatalogPriceUnit = z.infer<typeof catalogPriceUnitSchema>;

/**
 * What the catalog says the model can do. Each field is null when the catalog does not say, and null is never read as
 * "yes" or as 0: the candidate filter refuses a shot that needs a capability the catalog leaves unknown.
 */
export const catalogCapabilitiesSchema = z.object({
  minSeconds: z.number().finite().nonnegative().nullable(),
  maxSeconds: z.number().finite().positive().nullable(),
  aspectRatios: z.array(z.string().min(1)).nullable(),
  resolutions: z.array(z.string().min(1)).nullable(),
  firstFrame: z.boolean().nullable(),
  lastFrame: z.boolean().nullable(),
  refsMax: z.int().nonnegative().nullable(),
  audio: z.boolean().nullable(),
});
export type CatalogCapabilities = z.infer<typeof catalogCapabilitiesSchema>;

export const catalogPriceSchema = z.object({
  unit: catalogPriceUnitSchema,
  /** The rate for one unit, in USD. Positive: a zero or missing rate is not a usable price. Rates may be below one cent. */
  usd: z.number().finite().positive(),
  /** The OpenRouter price line the rate comes from, when the catalog names one. */
  sku: z.string().min(1).nullable(),
});
export type CatalogPrice = z.infer<typeof catalogPriceSchema>;

export const modelCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    modelClasses: z.array(modelClassSchema).min(1),
    capabilities: catalogCapabilitiesSchema,
    price: catalogPriceSchema,
    readAt: z.iso.datetime(),
  })
  .refine(
    (entry) => {
      const { minSeconds, maxSeconds } = entry.capabilities;
      return minSeconds === null || maxSeconds === null || maxSeconds >= minSeconds;
    },
    { message: "capabilities.maxSeconds must not be below capabilities.minSeconds" },
  );
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;
