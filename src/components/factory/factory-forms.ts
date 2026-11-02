/**
 * Client rules for the two factory forms. The server checks these inputs with plain code in its validators, not with a zod
 * schema that could be imported, so the same limits and messages are repeated here. The level rule uses the server's own
 * parseFactoryLevel, which lives in a module the page already loads.
 */
import { z } from "zod";
import { parseFactoryLevel } from "@/lib/meridian/factory/autopilot";

/** startFactoryRun: the niche is trimmed, required and at most 80 characters. */
export const factoryRunSchema = z.object({
  niche: z.string().trim().min(1, "Niche is required.").max(80, "Niche is too long."),
});

const levelField = z.string().refine((value) => parseFactoryLevel(value) !== null, "Choose factory levels 0–3.");

/** setFactoryControls: levels are 0 to 3, and the running level cannot pass the ceiling. The spend caps are set on the billing page. */
export const factoryControlsSchema = z.object({
  level: levelField,
  ceiling: levelField,
}).superRefine((value, context) => {
  const level = parseFactoryLevel(value.level);
  const ceiling = parseFactoryLevel(value.ceiling);
  if (level !== null && ceiling !== null && level > ceiling) {
    context.addIssue({ code: "custom", path: ["level"], message: "The running level cannot exceed the ceiling." });
  }
});

export type FactoryControlsInput = z.input<typeof factoryControlsSchema>;

/** The payload setFactoryControls receives: the level and the ceiling. */
export function factoryControlsPayload(values: FactoryControlsInput) {
  return { level: Number(values.level), ceiling: Number(values.ceiling) };
}
