import { z } from "zod";

const optionalText = (label: string, maximum: number) => z.string()
  .trim()
  .max(maximum, `${label} must be ${maximum} characters or fewer.`)
  .optional()
  .default("");

const optionalHttpUrl = z.string()
  .trim()
  .max(500, "Website must be 500 characters or fewer.")
  .optional()
  .default("")
  .transform((value, context) => {
    if (!value) return "";
    let parsed: URL;
    try {
      parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      context.addIssue({ code: "custom", message: "Website must be a valid URL." });
      return z.NEVER;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Website must use http or https." });
      return z.NEVER;
    }
    return parsed.toString();
  });

export const brandIdentitySchema = z.object({
  name: z.string().trim().min(1, "Brand name is required.").max(120, "Brand name must be 120 characters or fewer."),
  description: optionalText("Description", 2000),
  category: optionalText("Category", 120),
  industry: optionalText("Industry", 120),
  website: optionalHttpUrl,
  country: optionalText("Country", 80),
  sells: optionalText("What you sell", 500),
  targetCustomers: optionalText("Target customer", 1000),
});

export const newBrandSchema = brandIdentitySchema.extend({
  sells: z.string().trim().min(1, "Tell us what the brand sells.").max(500, "What you sell must be 500 characters or fewer."),
});

export type BrandIdentity = z.infer<typeof brandIdentitySchema>;
export type BrandIdentityInput = z.input<typeof brandIdentitySchema>;
export type NewBrandFields = z.infer<typeof newBrandSchema>;
export type NewBrandFieldsInput = z.input<typeof newBrandSchema>;
