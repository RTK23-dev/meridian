// The settings panel's model (round 3, K17): a cookbook's controls and their current values, as rows the panel draws. Pure, so the rules are
// tested without a browser. The panel (settings-panel.tsx) only draws these rows.

import type { Control, ControlValue } from "../../lib/meridian/cookbooks/controls.ts";
import type { Cookbook } from "../../lib/meridian/cookbooks/schema.ts";
import { fitsControl } from "../../lib/meridian/cookbooks/validate.ts";

export type SettingRow =
  | { id: string; kind: "toggle"; label: string; help: string | null; value: boolean }
  | { id: string; kind: "slider"; label: string; help: string | null; value: number; min: number; max: number; step: number; unit: string | null }
  | { id: string; kind: "select"; label: string; help: string | null; value: string; options: Array<{ value: string; label: string }> }
  | { id: string; kind: "text"; label: string; help: string | null; value: string; maxLength: number }
  | { id: string; kind: "colour"; label: string; help: string | null; value: string; roles: string[] };

/** The current value of each control: the person's, or the control's default. A value of the wrong kind is replaced by the default. */
export function currentValue(control: Control, values: Readonly<Record<string, ControlValue>>): ControlValue {
  const value = values[control.id];
  return value !== undefined && fitsControl(control, value) ? value : control.default;
}

/** One row per control, in the cookbook's order, with the value to show. */
export function settingRows(cookbook: Cookbook, values: Readonly<Record<string, ControlValue>>): SettingRow[] {
  return cookbook.controls.map((control): SettingRow => {
    const help = control.help ?? null;
    const value = currentValue(control, values);
    switch (control.kind) {
      case "toggle":
        return { id: control.id, kind: "toggle", label: control.label, help, value: value === true };
      case "slider":
        return {
          id: control.id,
          kind: "slider",
          label: control.label,
          help,
          value: typeof value === "number" ? value : control.default,
          min: control.min,
          max: control.max,
          step: control.step,
          unit: control.unit ?? null,
        };
      case "select":
        return { id: control.id, kind: "select", label: control.label, help, value: String(value), options: control.options.map((option) => ({ value: option.value, label: option.label })) };
      case "text":
        return { id: control.id, kind: "text", label: control.label, help, value: String(value), maxLength: control.maxLength };
      case "colour":
        return { id: control.id, kind: "colour", label: control.label, help, value: String(value), roles: [...control.roles] };
    }
  });
}
