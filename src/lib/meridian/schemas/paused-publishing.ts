import { z } from "zod";

const text = (maximum: number) => z.string().trim().max(maximum, `Must be ${maximum} characters or fewer.`).optional().default("");
const list = z.string().optional().default("").transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean));

export const pausedPublishingSchema = z.object({
  provider: z.enum(["meta", "tiktok", "google"]),
  creativeId: z.string().trim().min(1, "Choose a creative.").max(80),
  name: z.string().trim().min(1, "A campaign name is required.").max(120, "Name must be 120 characters or fewer."),
  dailyBudgetCents: z.coerce.number().finite().gt(0, "Enter a positive budget in cents.").transform(Math.round),
  countries: list.transform((values) => values.slice(0, 20)),
  locationIds: list.transform((values) => values.slice(0, 20)),
  pageId: text(80),
  link: text(500),
  message: text(500),
  scheduleStart: text(40),
  imageIds: list.transform((values) => values.slice(0, 10)),
  videoId: text(80),
  headlines: list.transform((values) => values.slice(0, 15)),
  descriptions: list.transform((values) => values.slice(0, 5)),
  cpcBidCents: z.preprocess((value) => value === "" || value == null || !Number.isFinite(Number(value)) ? 0 : value, z.coerce.number().transform(Math.round)),
});

export type PausedPublishingFields = z.input<typeof pausedPublishingSchema>;
export type PausedPublishing = z.output<typeof pausedPublishingSchema>;
