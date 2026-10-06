import { z } from "zod";

const count = (label: string, optional = false) => z.preprocess(
  (value) => optional && (value === undefined || value === null || value === "") ? 0 : value === "" ? Number.NaN : value,
  z.coerce.number().int(`${label} must be a whole number.`).min(0, `${label} cannot be negative.`).max(1_000_000_000, `${label} is too large.`),
);

export const manualPerformanceSchema = z.object({
  observedOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.").refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Enter a valid date."),
  platform: z.string().trim().max(80, "Platform must be 80 characters or fewer.").optional().default(""),
  reach: count("Reach", true),
  impressions: count("Impressions"),
  clicks: count("Clicks"),
  conversions: count("Conversions"),
  spendCents: count("Spend"),
  revenueCents: count("Revenue"),
}).superRefine((value, context) => {
  if (value.clicks > value.impressions) context.addIssue({ code: "custom", path: ["clicks"], message: "Clicks cannot exceed impressions." });
  if (value.conversions > value.clicks) context.addIssue({ code: "custom", path: ["conversions"], message: "Conversions cannot exceed clicks." });
});

export type ManualPerformanceFields = z.input<typeof manualPerformanceSchema>;
export type ManualPerformance = z.output<typeof manualPerformanceSchema>;
