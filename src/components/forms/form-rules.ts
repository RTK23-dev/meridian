/**
 * Pure rules shared by the forms: when a form counts as dirty, when Escape or a navigation may close it, which key
 * combination submits it, and how two sets of form values are compared. Kept free of React so each rule can be tested
 * directly.
 */

/** A dialog, sheet or screen that holds a form closes at once when the form is clean, and asks first when it is not. */
export type CloseDecision = "close" | "confirm-discard";

export function closeDecision(dirty: boolean): CloseDecision {
  return dirty ? "confirm-discard" : "close";
}

/** Navigation is blocked only while a form has unsaved edits. A clean form never blocks. */
export function shouldBlockNavigation(dirty: boolean): boolean {
  return dirty;
}

export type ShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
};

/** Cmd+Enter on a Mac, Ctrl+Enter elsewhere. Any other modifier, and IME composition, does not submit. */
export function isSubmitShortcut(event: ShortcutEvent): boolean {
  if (event.key !== "Enter" || event.isComposing) return false;
  if (event.altKey || event.shiftKey) return false;
  return event.metaKey || event.ctrlKey;
}

/**
 * Two sets of form values are the same when every key holds the same primitive, or the same list of primitives.
 * A key missing on one side counts as different from an empty string.
 */
export function sameFormValues(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const a = left[key];
    const b = right[key];
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      if (a.some((item, index) => !Object.is(item, b[index]))) return false;
      continue;
    }
    if (!Object.is(a, b)) return false;
  }
  return true;
}

export type AutosaveDecision = "save" | "skip-read-only" | "skip-unchanged" | "report-invalid";

/**
 * What an autosave does when it wakes. A viewer never saves. A form with no change never saves. A form that fails
 * validation is not sent to the server; the person sees why instead. Only a changed, valid form saves.
 */
export function autosaveDecision(input: { canEdit: boolean; changed: boolean; valid: boolean }): AutosaveDecision {
  if (!input.canEdit) return "skip-read-only";
  if (!input.changed) return "skip-unchanged";
  if (!input.valid) return "report-invalid";
  return "save";
}

/** How long the brain waits after the last keystroke before it autosaves. Leaving a field saves at once. */
export const AUTOSAVE_DEBOUNCE_MS = 1500;
