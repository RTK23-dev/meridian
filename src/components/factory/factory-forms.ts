/**
 * Client rules for the two factory forms. The server checks these inputs with plain code in its validators, not with a zod
 * schema that could be imported, so the same limits and messages are repeated here. The level rule uses the server's own
 * parseFactoryLevel, which lives in a module the page already loads.
 */
import { z } from "zod";
import { parseFactoryLevel } from "@/lib/meridian/factory/autopilot";
import { isCapAmount } from "@/lib/meridian/factory/cap-amount";

/** startFactoryRun: the niche is trimmed, required and at most 80 characters. */
export const factoryRunSchema = z.object({
  niche: z.string().trim().min(1, "Niche is required.").max(80, "Niche is too long."),
});

export type FactoryRunInput = z.input<typeof factoryRunSchema>;

const levelField = z.string().refine((value) => parseFactoryLevel(value) !== null, "Choose factory levels 0–3.");

/** A blank cap is not sent: the saved cap stays. A typed cap must be a number of dollars, zero or more. */
const capField = z.string().trim().refine((value) => isCapAmount(value), "Enter a dollar amount of 0 or more.");

/** setFactoryControls: levels are 0 to 3, caps are whole cents at zero or more, and the running level cannot pass the ceiling. */
export const factoryControlsSchema = z.object({
  level: levelField,
  ceiling: levelField,
  daily: capField,
  total: capField,
}).superRefine((value, context) => {
  const level = parseFactoryLevel(value.level);
  const ceiling = parseFactoryLevel(value.ceiling);
  if (level !== null && ceiling !== null && level > ceiling) {
    context.addIssue({ code: "custom", path: ["level"], message: "The running level cannot exceed the ceiling." });
  }
});

export type FactoryControlsInput = z.input<typeof factoryControlsSchema>;

/** The payload setFactoryControls receives. A blank cap keeps the saved cap, as it always has. */
export function factoryControlsPayload(values: FactoryControlsInput, saved: { dailyCents: number; totalCents: number }) {
  return {
    level: Number(values.level),
    ceiling: Number(values.ceiling),
    dailyCents: Math.round(Number(values.daily || saved.dailyCents / 100) * 100),
    totalCents: Math.round(Number(values.total || saved.totalCents / 100) * 100),
  };
}
