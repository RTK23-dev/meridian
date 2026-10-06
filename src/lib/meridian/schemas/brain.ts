import { z } from "zod";
import { AUTOMATION_LEVELS, BRAIN_FIELDS, type BrainValues } from "../brain.ts";

const brainFieldSchema = z.string().trim().max(4000, "This field must be 4000 characters or fewer.");
const brainFields = Object.fromEntries(BRAIN_FIELDS.map((field) => [field.key, brainFieldSchema])) as Record<(typeof BRAIN_FIELDS)[number]["key"], typeof brainFieldSchema>;

export const brainValuesSchema = z.object({
  ...brainFields,
  automationLevel: z.enum(AUTOMATION_LEVELS),
}) satisfies z.ZodType<BrainValues>;

export type BrainFieldsInput = z.input<typeof brainValuesSchema>;
