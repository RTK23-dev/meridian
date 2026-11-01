// The cookbook editor's edit rules (round 3, K20b3): one control's value, and one role's instruction. Pure, so the rules are tested without a
// browser. The rules are the same ones the validator and the server apply on save (K20b3b), so the editor refuses first and the server
// checks again. Imports only the leaf control rules, so the browser can load it.

import { fitsControl, type Control, type ControlValue } from "../../lib/meridian/cookbooks/controls.ts";
import type { Cookbook } from "../../lib/meridian/cookbooks/schema.ts";

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

/** One change the editor makes: a control's default, or the text of one instruction (by its place in the cookbook's list). */
export type CookbookEdit = { kind: "control"; id: string; value: ControlValue } | { kind: "instruction"; index: number; text: string };

export type CookbookEdits = { ok: true; cookbook: Cookbook } | { ok: false; reason: string };

/**
 * A copy of the cookbook with the edits applied. The original is never changed. Each edit is checked by the same rules as above; the first
 * one that fails stops the whole set, so nothing half-applied is returned. The server checks the whole cookbook again on save (K20b3b).
 */
export function applyEdits(cookbook: Cookbook, edits: readonly CookbookEdit[]): CookbookEdits {
  const controls: Control[] = cookbook.controls.map((control) => ({ ...control }) as Control);
  const instructions = cookbook.instructions.map((instruction) => ({ ...instruction }));
  for (const edit of edits) {
    if (edit.kind === "control") {
      const control = controls.find((candidate) => candidate.id === edit.id);
      if (control === undefined) return { ok: false, reason: `There is no control ${edit.id}.` };
      if (!fitsControl(control, edit.value)) return { ok: false, reason: `${control.label}: that value is outside what the control allows.` };
      (control as { default: ControlValue }).default = edit.value;
    } else {
      const instruction = instructions[edit.index];
      if (instruction === undefined) return { ok: false, reason: `There is no instruction ${edit.index}.` };
      const checked = instructionEdit(edit.text);
      if (!checked.ok) return { ok: false, reason: checked.reason };
      instruction.text = checked.text;
    }
  }
  return { ok: true, cookbook: { ...cookbook, controls, instructions } };
}
