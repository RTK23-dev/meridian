/**
 * Pure parts of the brain autosave. The brain is read with the same schema the Save button uses, so autosave cannot
 * accept a value the button would refuse. A brain has changes when its trimmed values differ from the saved brain, so a
 * stray trailing space does not count as an edit.
 */
import { sameFormValues } from "@/components/forms/form-rules";
import type { BrainValues } from "@/lib/meridian/brain";
import { brainValuesSchema } from "@/lib/meridian/schemas/brain";

export type BrainRead = { ok: true; values: BrainValues } | { ok: false; message: string };

/** Reads the form's raw values exactly as Save does. The first failing rule is the message. */
export function readBrain(raw: unknown): BrainRead {
  const parsed = brainValuesSchema.safeParse(raw);
  if (parsed.success) return { ok: true, values: parsed.data };
  return { ok: false, message: parsed.error.issues[0]?.message ?? "A field cannot be saved as entered." };
}

/** True when the form would save something different from the saved brain. An invalid form counts as changed. */
export function brainChanged(raw: unknown, saved: BrainValues | null): boolean {
  const read = readBrain(raw);
  if (!read.ok || !saved) return true;
  return !sameFormValues(read.values, saved);
}

export type AutosaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "not-saved"; message: string };

export function savedTimeLabel(at: Date): string {
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
