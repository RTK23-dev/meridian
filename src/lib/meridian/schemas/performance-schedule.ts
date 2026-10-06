import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.").refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Enter a valid date.");

export const performanceScheduleSchema = z.object({
  provider: z.enum(["meta", "tiktok", "google"]),
  creativeId: z.string().trim().min(1, "Enter a creative id.").max(80),
  externalAdId: z.string().trim().min(1, "Enter the provider ad id.").max(120),
  currency: z.string().trim().length(3, "Use a three-letter currency code.").transform((value) => value.toUpperCase()),
  timezone: z.string().trim().min(1, "Enter a timezone.").max(80),
  startDate: date,
  endDate: date,
  everySeconds: z.coerce.number().int("Cadence must be a whole number of seconds.").min(60, "Cadence must be at least 60 seconds.").max(2_592_000, "Cadence cannot exceed 30 days."),
}).superRefine((value, context) => {
  if (value.endDate < value.startDate) context.addIssue({ code: "custom", path: ["endDate"], message: "End date must be on or after the start date." });
});

export type PerformanceScheduleFields = z.input<typeof performanceScheduleSchema>;
export type PerformanceSchedule = z.output<typeof performanceScheduleSchema>;
