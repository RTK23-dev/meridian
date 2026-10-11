/**
 * Pure parts of the brain autosave. The brain is read with the same schema the Save button uses, so autosave cannot
 * accept a value the button would refuse. A brain has changes when its trimmed values differ from the saved brain, so a
 * stray trailing space does not count as an edit.
 */
import { sameFormValues } from "../forms/form-rules.ts";
import type { BrainValues } from "../../lib/meridian/brain.ts";
import { brainValuesSchema } from "../../lib/meridian/schemas/brain.ts";

export type BrainRead = { ok: true; values: BrainValues } | { ok: false; message: string };

/** Reads the form's raw values exactly as Save does. The first failing rule is the message. */
export function readBrain(raw: unknown): BrainRead {
  const parsed = brainValuesSchema.safeParse(raw);
  if (parsed.success) return { ok: true, values: parsed.data };
  return { ok: false, message: parsed.error.issues[0]?.message ?? "A field cannot be saved as entered." };
}

/**
 * True when the form would save something different from the saved brain. Both sides go through the same read, so a stray
 * space in either one is not an edit. An invalid form, or a missing baseline, counts as changed.
 */
export function brainChanged(raw: unknown, saved: BrainValues | null): boolean {
  const read = readBrain(raw);
  const baseline = saved ? readBrain(saved) : null;
  if (!read.ok || !baseline?.ok) return true;
  return !sameFormValues(read.values, baseline.values);
}

export type AutosaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "not-saved"; message: string };

export function savedTimeLabel(at: Date): string {
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
