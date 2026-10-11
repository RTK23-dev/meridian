/**
 * Pure parts of the brain autosave. The brain is read with the same schema the Save button uses, so autosave cannot
 * accept a value the button would refuse. A brain has changes when a trimmed field differs from the saved brain, so a
 * stray trailing space does not count as an edit. Only the fields that differ are sent to the server.
 */
import { brainChanges, type BrainValues } from "../../lib/meridian/brain.ts";
import { brainValuesSchema } from "../../lib/meridian/schemas/brain.ts";

export type BrainRead = { ok: true; values: BrainValues } | { ok: false; message: string };

/** Reads the form's raw values exactly as Save does. The first failing rule is the message. */
export function readBrain(raw: unknown): BrainRead {
  const parsed = brainValuesSchema.safeParse(raw);
  if (parsed.success) return { ok: true, values: parsed.data };
  return { ok: false, message: parsed.error.issues[0]?.message ?? "A field cannot be saved as entered." };
}

/**
 * The fields the form would send, measured against the saved brain. An invalid form, or a missing baseline, has no list of
 * changes that can be trusted, so it returns null.
 */
export function changesFrom(raw: unknown, saved: BrainValues | null): Partial<BrainValues> | null {
  const read = readBrain(raw);
  if (!read.ok || !saved) return null;
  return brainChanges(read.values, saved);
}

/** True when the form would save something different from the saved brain. An invalid form, or no baseline, counts as changed. */
export function brainChanged(raw: unknown, saved: BrainValues | null): boolean {
  const changes = changesFrom(raw, saved);
  return changes === null || Object.keys(changes).length > 0;
}

export type AutosaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "not-saved"; message: string };

export function savedTimeLabel(at: Date): string {
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
