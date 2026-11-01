// The cookbook editor's edit rules (round 3, K20b3): one control's value, and one role's instruction. Pure, so the rules are tested without a
// browser. The rules are the same ones the validator and the server apply on save (K20b3b), so the editor refuses first and the server
// checks again. Imports only the leaf control rules, so the browser can load it.

import { fitsControl, type Control, type ControlValue } from "../../lib/meridian/cookbooks/controls.ts";

export type ControlEdit = { ok: true; values: Record<string, ControlValue> } | { ok: false; reason: string };

/** The longest instruction a role can carry (the cookbook schema's limit for one role). */
export const INSTRUCTION_MAX_CHARACTERS = 4000;

export type InstructionEdit = { ok: true; text: string } | { ok: false; reason: string };

/** Sets one control's value, when the control exists and the value fits it (its bounds, its options, its length). */
export function setControlValue(controls: readonly Control[], values: Readonly<Record<string, ControlValue>>, id: string, value: ControlValue): ControlEdit {
  const control = controls.find((candidate) => candidate.id === id);
  if (control === undefined) return { ok: false, reason: `There is no control ${id}.` };
  if (!fitsControl(control, value)) return { ok: false, reason: `${control.label}: that value is outside what the control allows.` };
  return { ok: true, values: { ...values, [id]: value } };
}

/** One role's instruction text: it must say something, and fit the schema's limit. */
export function instructionEdit(text: string): InstructionEdit {
  if (text.trim() === "") return { ok: false, reason: "An instruction cannot be empty. Remove the role instead." };
  if (text.length > INSTRUCTION_MAX_CHARACTERS) {
    return { ok: false, reason: `An instruction is at most ${INSTRUCTION_MAX_CHARACTERS} characters; this one is ${text.length}.` };
  }
  return { ok: true, text };
}
