import { z } from "zod";

export const researchCollectionSchema = z.object({
  searchTerms: z.string().trim().min(1, "Enter a brand, product, or category.").max(100, "Search terms must be 100 characters or fewer."),
  country: z.string().trim().length(2, "Enter a two-letter country code.").transform((value) => value.toUpperCase()).pipe(z.string().regex(/^[A-Z]{2}$/, "Enter a two-letter country code.")),
  limit: z.preprocess((value) => value == null ? 50 : value, z.coerce.number().int("Choose a whole-number limit.").min(1, "Limit must be at least 1 ad.").max(100, "Limit cannot exceed 100 ads.")),
});

const optionalHttpUrl = z.string().trim().max(500, "URL must be 500 characters or fewer.").nullish().transform((value) => value ?? "").transform((value, context) => {
  if (!value) return "";
  let parsed: URL;
  try { parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); }
  catch { context.addIssue({ code: "custom", message: "Enter a valid web URL." }); return z.NEVER; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    context.addIssue({ code: "custom", message: "URL must use http or https." });
    return z.NEVER;
  }
  return parsed.toString();
});

export const competitorFieldsSchema = z.object({
  name: z.string().trim().min(1, "Competitor name is required.").max(120, "Name must be 120 characters or fewer."),
  website: optionalHttpUrl,
  notes: z.string().trim().max(1000, "Notes must be 1000 characters or fewer.").nullish().transform((value) => value ?? ""),
  kind: z.enum(["direct", "adjacent", "inspirational"]).catch("direct"),
});

export const publicPageSchema = z.object({ url: optionalHttpUrl.pipe(z.string().min(1, "Enter a public page URL.")) });

export type ResearchCollectionFields = z.input<typeof researchCollectionSchema>;
export type ResearchCollection = z.output<typeof researchCollectionSchema>;
export type CompetitorFields = z.input<typeof competitorFieldsSchema>;
export type CompetitorFieldsOutput = z.output<typeof competitorFieldsSchema>;
export type PublicPageFields = z.input<typeof publicPageSchema>;
