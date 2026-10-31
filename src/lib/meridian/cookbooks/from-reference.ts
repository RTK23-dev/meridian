// A draft cookbook from a reference video (round 3, K25): what was done by hand for the 3D explainer on 2026-10-31, as code. It takes the
// reference's measures (the media functions, as compare.ts reports them) and writes a draft cookbook whose checks are the measured targets.
// It can write only what the measures support. Everything else (the beats, the style, the voice, the instructions) is listed as unknown, not
// guessed, and the draft is engine-only until a person reviews it (fail closed, CLAUDE.md rule 1).

import type { Measures } from "./checks.ts";
import { validateCookbook } from "./validate.ts";
import type { Check, Cookbook } from "./schema.ts";

export type DraftResult =
  | { ok: true; cookbook: Cookbook; unknown: string[] }
  | { ok: false; issues: string[] };

const CHECK_KEYS: Array<[Check["measure"], string, number]> = [
  // Each measure with the tolerance a person would accept, in the measure's own unit.
  ["hardCuts", "hardCuts", 1],
  ["firstCutMs", "firstCutMs", 300],
  ["shotP50Ms", "shotP50Ms", 800],
  ["zoomJumps", "zoomJumps", 2],
  ["interruptMedianMs", "interruptMedianMs", 400],
  ["integratedLufs", "integratedLufs", 1],
];

export function draftFromMeasures(input: { cookbookId: string; label: string; durationMs: number; measures: Measures }): DraftResult {
  const unknown: string[] = [];
  const checks: Check[] = [];
  for (const [measure, key, tolerance] of CHECK_KEYS) {
    const value = input.measures[key];
    if (typeof value === "number" && Number.isFinite(value)) checks.push({ measure, target: value, tolerance });
    else unknown.push(`${measure}: not measured, so no check is written for it`);
  }
  unknown.push("structure: the beats need the reference's segments (the analysis), so the draft has none");
  unknown.push("style: the draft names no style kit; the brand's theme page decides it");
  unknown.push("instructions: the draft has none; a person writes them");
  unknown.push("ingredients: the draft names none; add the ingredients the recipe needs");

  const draft: Cookbook = {
    schema: "meridian.cookbook/v1",
    cookbookId: input.cookbookId,
    version: 1,
    label: input.label,
    summary: `A draft from a reference of ${Math.round(input.durationMs / 1000)} seconds. Review it before use: it is engine-only until then.`,
    family: "other",
    scope: "workspace",
    modes: ["engine"],
    ingredients: [],
    steps: [{ id: "render", kind: "render", label: "Render 9:16", after: [], uses: {}, params: {} }],
    instructions: [],
    grammar: { structure: [] },
    controls: [],
    checks,
  };
  const checked = validateCookbook(draft);
  if (!checked.ok) return { ok: false, issues: checked.issues };
  return { ok: true, cookbook: checked.cookbook, unknown };
}
