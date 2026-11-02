// The unsent draft of a cookbook's settings (round 3, K17): what a person changed but has not saved, kept per person, workspace and cookbook,
// so it survives a reload. A value is saved a short pause after the last change (the debounce). Only a value that fits its control is kept or
// restored, so data read back from storage is checked before it is used. Pure apart from the storage and the timers, which are passed in, so
// the rules are tested without a browser. The panel that shows these values is mounted by K18.

import { fitsControl, type ControlValue } from "../../lib/meridian/cookbooks/controls.ts";
import type { Cookbook } from "../../lib/meridian/cookbooks/schema.ts";
import { createDebouncer, DRAFT_SAVE_DELAY_MS, type DebounceTimers } from "../../lib/progress/debounce.ts";
import { createDraftStore, draftKey, type DraftScope, type DraftStorage } from "../../lib/progress/draft-store.ts";

/** The starting values with no saved draft: the base value where it fits, else the default. */
function restoredBase(cookbook: Pick<Cookbook, "controls">, base: Readonly<Record<string, ControlValue>>): Record<string, ControlValue> {
  return restoredValues(cookbook, null, base);
}

/**
 * Each control's starting value: the saved draft's value where the draft has one that fits its control; otherwise the base value (the value a
 * proposal resolved for the pick), if it fits; otherwise the control's default.
 */
export function restoredValues(
  cookbook: Pick<Cookbook, "controls">,
  saved: unknown,
  base: Readonly<Record<string, ControlValue>> = {},
): Record<string, ControlValue> {
  const stored = typeof saved === "object" && saved !== null && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const values: Record<string, ControlValue> = {};
  for (const control of cookbook.controls) {
    const candidate = stored[control.id];
    const isValue = typeof candidate === "boolean" || typeof candidate === "number" || typeof candidate === "string";
    const baseValue = base[control.id];
    if (isValue && fitsControl(control, candidate)) values[control.id] = candidate;
    else if (baseValue !== undefined && fitsControl(control, baseValue)) values[control.id] = baseValue;
    else values[control.id] = control.default;
  }
  return values;
}

export type SettingsDraft = {
  /** The values the settings show now: the draft's, or the defaults. */
  values(): Record<string, ControlValue>;
  /** Sets one control's value and schedules the save. A value that does not fit its control, or an unknown control, is ignored. */
  change(id: string, value: ControlValue): void;
  /** Saves a waiting change now, without waiting for the pause. */
  flush(): void;
  /** Drops the saved draft and any waiting save, and returns the values to the defaults (after a save, or on Discard). */
  discard(): void;
};

export function createSettingsDraft(input: {
  cookbook: Pick<Cookbook, "controls">;
  /** The starting values when there is no saved draft: the proposal's resolved values for the pick. */
  base?: Readonly<Record<string, ControlValue>>;
  scope: DraftScope;
  storage: DraftStorage;
  timers: DebounceTimers<unknown>;
  delayMs?: number;
}): SettingsDraft {
  const store = createDraftStore(input.storage);
  const key = draftKey(input.scope);
  const start = restoredBase(input.cookbook, input.base ?? {});
  let values = restoredValues(input.cookbook, store.read(key), input.base ?? {});
  const debounce = createDebouncer(input.delayMs ?? DRAFT_SAVE_DELAY_MS, input.timers);

  // A draft that equals the starting values is not kept: there is nothing to restore, so the stored draft is removed.
  const persist = () => {
    const differs = input.cookbook.controls.some((control) => values[control.id] !== start[control.id]);
    if (differs) store.write(key, values);
    else store.clear(key);
  };

  return {
    values: () => ({ ...values }),
    change(id, value) {
      const control = input.cookbook.controls.find((candidate) => candidate.id === id);
      if (control === undefined || !fitsControl(control, value)) return;
      values = { ...values, [id]: value };
      debounce.call(persist);
    },
    flush() {
      debounce.flush();
    },
    discard() {
      debounce.cancel();
      values = { ...start };
      store.clear(key);
    },
  };
}
