// The cookbook editor's edit rules (round 3, K20b3 and K20c): one control's value, one role's instruction, and one step's label or setting.
// Pure, so the rules are tested without a browser. The rules are the same ones the validator and the server apply on save (K20b3b), so the
// editor refuses first and the server checks again. Imports only the leaf control rules, so the browser can load it.

import { fitsControl, scalarSchema, type Control, type ControlValue, type Scalar } from "../../lib/meridian/cookbooks/controls.ts";
import type { Cookbook, Step } from "../../lib/meridian/cookbooks/schema.ts";

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

/** The longest label a step can carry (the cookbook schema's limit for a step). */
export const STEP_LABEL_MAX_CHARACTERS = 80;

export type StepLabelEdit = { ok: true; label: string } | { ok: false; reason: string };

/** A step's label: trimmed, it must say something and fit the schema's limit. The label stored is the trimmed text. */
export function stepLabelEdit(label: string): StepLabelEdit {
  const trimmed = label.trim();
  if (trimmed === "") return { ok: false, reason: "A step needs a label. Give it a short name." };
  if (trimmed.length > STEP_LABEL_MAX_CHARACTERS) {
    return { ok: false, reason: `A step label is at most ${STEP_LABEL_MAX_CHARACTERS} characters; this one is ${trimmed.length}.` };
  }
  return { ok: true, label: trimmed };
}

export type StepParamEdit = { ok: true; value: Scalar } | { ok: false; reason: string };

/**
 * One setting of a step. The step keeps the settings it has: a key it does not have is refused, and so is a value of another kind (a
 * number stays a number). The schema's own check runs too: a finite number, a string of at most 2000 characters.
 */
export function stepParamValue(step: Step, key: string, value: Scalar): StepParamEdit {
  if (!Object.hasOwn(step.params, key)) return { ok: false, reason: `${step.label} has no setting ${key}.` };
  const current = step.params[key];
  if (typeof current !== typeof value) return { ok: false, reason: `${step.label}: ${key} takes a ${typeof current}, not a ${typeof value}.` };
  if (!scalarSchema.safeParse(value).success) return { ok: false, reason: `${step.label}: ${key} is not a value the cookbook accepts.` };
  return { ok: true, value };
}

/**
 * One change the editor makes: a control's default, the text of one instruction (by its place in the cookbook's list), or one step's label
 * or one of its settings (by the step's place in the list).
 */
export type CookbookEdit =
  | { kind: "control"; id: string; value: ControlValue }
  | { kind: "instruction"; index: number; text: string }
  | { kind: "step-label"; index: number; label: string }
  | { kind: "step-param"; index: number; key: string; value: Scalar };

export type CookbookEdits = { ok: true; cookbook: Cookbook } | { ok: false; reason: string };

/**
 * A copy of the cookbook with the edits applied. The original is never changed. Each edit is checked by the same rules as above; the first
 * one that fails stops the whole set, so nothing half-applied is returned. The server checks the whole cookbook again on save (K20b3b).
 */
export function applyEdits(cookbook: Cookbook, edits: readonly CookbookEdit[]): CookbookEdits {
  const controls: Control[] = cookbook.controls.map((control) => ({ ...control }) as Control);
  const instructions = cookbook.instructions.map((instruction) => ({ ...instruction }));
  const steps = cookbook.steps.map((step) => ({ ...step, params: { ...step.params } }));
  for (const edit of edits) {
    if (edit.kind === "control") {
      const control = controls.find((candidate) => candidate.id === edit.id);
      if (control === undefined) return { ok: false, reason: `There is no control ${edit.id}.` };
      if (!fitsControl(control, edit.value)) return { ok: false, reason: `${control.label}: that value is outside what the control allows.` };
      (control as { default: ControlValue }).default = edit.value;
    } else if (edit.kind === "instruction") {
      const instruction = instructions[edit.index];
      if (instruction === undefined) return { ok: false, reason: `There is no instruction ${edit.index}.` };
      const checked = instructionEdit(edit.text);
      if (!checked.ok) return { ok: false, reason: checked.reason };
      instruction.text = checked.text;
    } else {
      const step = steps[edit.index];
      if (step === undefined) return { ok: false, reason: `There is no step ${edit.index}.` };
      if (edit.kind === "step-label") {
        const checked = stepLabelEdit(edit.label);
        if (!checked.ok) return { ok: false, reason: checked.reason };
        step.label = checked.label;
      } else {
        const checked = stepParamValue(step, edit.key, edit.value);
        if (!checked.ok) return { ok: false, reason: checked.reason };
        step.params = { ...step.params, [edit.key]: checked.value };
      }
    }
  }
  return { ok: true, cookbook: { ...cookbook, controls, instructions, steps } };
}

/** The server calls that save an edited cookbook, in order (K20b3b part 2). A built-in cookbook is copied first: its id is reserved, and admins
 * maintain copies of built-ins (D5). A workspace cookbook is saved as its next version under its own id. */
export type SaveStep =
  | { action: "fork"; from: { cookbookId: string; version: number }; newCookbookId: string }
  | { action: "save"; cookbook: Cookbook };

/** A copy id for a built-in's copy: the prefix the workspace uses for copies the people make. */
export const COPY_PREFIX = "ck_my_";

export function planSave(input: { source: "builtin" | "workspace"; original: Cookbook; edited: Cookbook; newCopyId: string }): SaveStep[] {
  if (input.source === "workspace") return [{ action: "save", cookbook: input.edited }];
  if (!input.newCopyId.startsWith(COPY_PREFIX)) throw new Error(`a copy id starts with ${COPY_PREFIX}`);
  return [
    { action: "fork", from: { cookbookId: input.original.cookbookId, version: input.original.version }, newCookbookId: input.newCopyId },
    { action: "save", cookbook: { ...input.edited, cookbookId: input.newCopyId, scope: "workspace" as const } },
  ];
}

/** The server calls the save runs: a fork and a save. Passed in, so the sequence and its failures are tested without a server. */
export type SaveCalls = {
  fork: (input: { brandId: string; cookbookId: string; version: number; newCookbookId: string; shareWithWorkspace: false }) => Promise<{ ok: boolean; reason?: string }>;
  save: (input: { brandId: string; cookbook: Cookbook }) => Promise<{ ok: boolean; reason?: string }>;
};

export type SaveOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Runs a save plan in order, stopping at the first failure. If the copy was made and its edited version was then refused, the reason says the
 * copy exists with the cookbook's own text, so nothing is reported as saved that was not.
 */
export async function runSavePlan(brandId: string, steps: readonly SaveStep[], calls: SaveCalls): Promise<SaveOutcome> {
  let copied = false;
  for (const step of steps) {
    if (step.action === "fork") {
      const made = await calls.fork({ brandId, cookbookId: step.from.cookbookId, version: step.from.version, newCookbookId: step.newCookbookId, shareWithWorkspace: false });
      if (!made.ok) return { ok: false, reason: made.reason ?? "The copy was not made." };
      copied = true;
    } else {
      const saved = await calls.save({ brandId, cookbook: step.cookbook });
      if (!saved.ok) {
        const why = saved.reason ?? "The edits were not saved.";
        return { ok: false, reason: copied ? `The copy was made with the cookbook's own text, but the edits were not saved: ${why}` : why };
      }
    }
  }
  return { ok: true };
}
