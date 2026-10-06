import { z } from "zod";

const productText = (label: string, maximum: number) => z.string()
  .trim()
  .max(maximum, `${label} must be ${maximum} characters or fewer.`)
  .optional()
  .default("");

const productUrl = z.string()
  .trim()
  .max(500, "Product URL must be 500 characters or fewer.")
  .optional()
  .default("")
  .transform((value, context) => {
    if (!value) return "";
    let parsed: URL;
    try {
      parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      context.addIssue({ code: "custom", message: "Product URL must be a valid URL." });
      return z.NEVER;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Product URL must use http or https." });
      return z.NEVER;
    }
    return parsed.toString();
  });

export const productFieldsSchema = z.object({
  name: z.string().trim().min(1, "Product name is required.").max(160, "Product name must be 160 characters or fewer."),
  description: productText("Description", 4000),
  features: productText("Features", 4000),
  benefits: productText("Benefits", 4000),
  price: productText("Price", 80),
  url: productUrl,
  allowedClaims: productText("Allowed claims", 2000),
  prohibitedClaims: productText("Prohibited claims", 2000),
});

export type ProductFields = z.infer<typeof productFieldsSchema>;
export type ProductFieldsInput = z.input<typeof productFieldsSchema>;
