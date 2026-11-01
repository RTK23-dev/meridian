// The read-only outline of one cookbook (round 3, K20b2): its steps in order, with what each step waits for and whether it is conditional,
// and its controls with their defaults. Pure, over the cookbook's plain data. The types are imported for typing only, so the browser can draw
// the outline without the engine.

import type { Control } from "../../lib/meridian/cookbooks/controls.ts";
import type { Cookbook } from "../../lib/meridian/cookbooks/schema.ts";

export type OutlineStep = { id: string; label: string; kind: string; waitsFor: string[]; conditional: boolean };
export type OutlineControl = { id: string; label: string; kind: Control["kind"]; defaultText: string };
export type Outline = { label: string; version: number; steps: OutlineStep[]; controls: OutlineControl[] };

/** A control's default, in words: a toggle reads On or Off, anything else as it is written. */
function defaultTextOf(control: Control): string {
  if (control.kind === "toggle") return control.default ? "On" : "Off";
  return String(control.default);
}

export function outlineOf(cookbook: Pick<Cookbook, "label" | "version" | "steps" | "controls">): Outline {
  return {
    label: cookbook.label,
    version: cookbook.version,
    steps: cookbook.steps.map((step) => ({
      id: step.id,
      label: step.label,
      kind: step.kind,
      waitsFor: [...step.after],
      conditional: step.when !== undefined,
    })),
    controls: cookbook.controls.map((control) => ({ id: control.id, label: control.label, kind: control.kind, defaultText: defaultTextOf(control) })),
  };
}
