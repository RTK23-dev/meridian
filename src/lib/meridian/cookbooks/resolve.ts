// resolveCookbook (round 3, K3): a validated cookbook and the person's control values become what a run needs. Pure: the same inputs give
// the same output, byte for byte, so a run can record exactly what made it (valuesHash, and the resolved steps).
//
// What it works out:
//   - the values (defaults, then the person's), each checked against its control;
//   - each step: on or off (its toggles and its `when`), with its parameters after the bindings;
//   - each ingredient: the way chosen, and its cost class. A coded component or an upload is free. A visual type is priced by
//     shotCost (the engine's table). A model class is priced by its route in config/prices.ts, per second, per image or per call.
//     Anything else is unknown, and stays unknown (CLAUDE.md rule 1): it is never 0;
//   - the modes the choices allow: agent mode only when every chosen way is free; engine mode when the cookbook offers it and nothing
//     that is required is still unchosen;
//   - the requirements in plain words, the badge, and the estimate (the known paid lines, with the unknown ones named);
//   - the request fields, the orchestrator's plan template, and the brief an agent session follows.

import { contentHash } from "../../../engine/contracts/hash.ts";
import type { LookPreset } from "../../../engine/contracts/edl.ts";
import { shotCost } from "../../../engine/plan/cost.ts";
import { priceFor, prices } from "../../../engine/config/prices.ts";
import { RECIPES } from "../../../engine/plan/tables.ts";
import type { Control, ControlValue, CookbookRole, Scalar } from "./controls.ts";
import { fitsControl, validateCookbook, type ValidationContext } from "./validate.ts";
import type { Check, Cookbook, CookbookGrammar, Ingredient, Instruction, Step, Way } from "./schema.ts";

export type CostLine = { kind: "free" } | { kind: "paid"; usd: number; basis: string } | { kind: "unknown"; reason: string };

export type ResolvedIngredient = {
  id: string;
  kind: Ingredient["kind"];
  label: string;
  need: Ingredient["need"];
  /** chosen: a way is picked. needs_choice: required and not picked. not_needed: optional or none, not picked. */
  status: "chosen" | "needs_choice" | "not_needed";
  way: { id: string; label: string } | null;
  cost: CostLine | null;
};

export type ResolvedStep = {
  id: string;
  kind: Step["kind"];
  label: string;
  enabled: boolean;
  /** Why the step is off, in words. Null when it is on. */
  offReason: string | null;
  after: string[];
  params: Record<string, Scalar>;
  uses: Step["uses"];
};

export type CookbookMode = "agent" | "engine";

type ResolvedStepCost = { stepId: string; label: string; cost: CostLine };

export type ResolvedCookbook = {
  cookbookId: string;
  version: number;
  label: string;
  values: Record<string, ControlValue>;
  valuesHash: string;
  lengthMs: number;
  modes: CookbookMode[];
  requirements: string[];
  badge: string;
  estimate: { knownUsd: number; unknown: string[] };
  ingredients: ResolvedIngredient[];
  steps: ResolvedStep[];
  instructions: Partial<Record<CookbookRole, string[]>>;
  /** styleKitId is null when the theme page decides the style. */
  style: { styleKitId: string | null; look: { preset: string; strength: number } | null };
  checks: Check[];
  grammar: CookbookGrammar;
  /** Fields for buildProductionRequest (K12). */
  request: {
    styleKitId: string | null;
    lengthMs: number;
    look: { preset: string; strength: number } | null;
    componentProps: Record<string, Record<string, Scalar>>;
  };
  /** The orchestrator's plan nodes for the enabled steps (K16). estimateUsd is null where the step's own cost is not priced here. */
  planTemplate: Array<{
    id: string;
    kind: Step["kind"];
    title: string;
    why: string;
    dependsOn: string[];
    model: null;
    params: Record<string, string | number | boolean | null>;
    estimateUsd: null;
  }>;
  /** The brief an agent session follows in agent mode (K24). It states the rule: no paid call. */
  agentBrief: string;
};

export type ResolveOptions = {
  /** The person's values, by control id. Controls not named take their defaults. */
  values?: Readonly<Record<string, ControlValue>>;
  /** The length of the video in ms. Costs and the request use it. */
  lengthMs: number;
  /** Characters of voice text, when known. A text-to-speech way is priced per character; without this it stays unknown. */
  voiceCharacters?: number;
  context?: ValidationContext;
};

export type ResolveResult = { ok: true; resolved: ResolvedCookbook } | { ok: false; issues: string[] };

const MAX_INSTRUCTIONS_CHARS = 16000;

export function resolveCookbook(input: unknown, options: ResolveOptions): ResolveResult {
  const checked = validateCookbook(input, options.context);
  if (!checked.ok) return { ok: false, issues: checked.issues };
  const cookbook = checked.cookbook;
  const issues: string[] = [];

  if (!Number.isFinite(options.lengthMs) || options.lengthMs <= 0) {
    return { ok: false, issues: ["lengthMs: the video length must be a positive number of milliseconds"] };
  }

  // 1. The values: defaults, then the person's, each checked against its control.
  const controls = new Map(cookbook.controls.map((control) => [control.id, control] as const));
  const values: Record<string, ControlValue> = {};
  for (const control of cookbook.controls) values[control.id] = control.default;
  for (const [id, value] of Object.entries(options.values ?? {})) {
    const control = controls.get(id);
    if (control === undefined) {
      issues.push(`values.${id}: the cookbook has no control ${id}`);
      continue;
    }
    if (!fitsControl(control, value)) {
      issues.push(`values.${id}: ${JSON.stringify(value)} does not fit the ${control.kind} control`);
      continue;
    }
    values[id] = value;
  }
  if (issues.length > 0) return { ok: false, issues };

  // 2. Bindings, in control order. Parameters start from the steps' defaults and the style's look.
  const stepParams = new Map<string, Record<string, Scalar>>(cookbook.steps.map((step) => [step.id, { ...step.params }]));
  const enabledBy = new Map<string, boolean[]>();
  const componentProps: Record<string, Record<string, Scalar>> = {};
  const look = cookbook.style?.look ? { ...cookbook.style.look } : null;
  const choices = new Map<string, string>();
  const chosenBy = new Map<string, string>();
  const bound: Instruction[] = [];

  for (const control of cookbook.controls) {
    const value = values[control.id] as ControlValue;
    for (const bind of control.binds) {
      if ("set" in bind) {
        const out = mapped(bind.set, value, bind.map, control, issues);
        if (out === undefined) continue;
        const parts = bind.set.split(".");
        if (parts[0] === "step" && parts.length >= 3) {
          const target = stepParams.get(parts.slice(1, -1).join("."));
          if (target) target[parts[parts.length - 1] as string] = out as Scalar;
        } else if (bind.set === "style.look.strength" && look) {
          look.strength = out as number;
        } else if (bind.set === "style.look.preset" && look) {
          look.preset = out as LookPreset;
        } else if (parts[0] === "component" && parts.length >= 3) {
          const variable = parts[parts.length - 1] as string;
          const component = parts.slice(1, -1).join(".");
          componentProps[component] = { ...(componentProps[component] ?? {}), [variable]: out as Scalar };
        }
      } else if ("enable" in bind) {
        enabledBy.set(bind.enable, [...(enabledBy.get(bind.enable) ?? []), value === true]);
      } else if ("choose" in bind) {
        const ingredient = bind.choose.ingredient;
        const previous = chosenBy.get(ingredient);
        if (previous !== undefined) {
          issues.push(`controls.${control.id}: ingredient ${ingredient} is already chosen by ${previous}`);
          continue;
        }
        chosenBy.set(ingredient, control.id);
        choices.set(ingredient, String(value));
      } else if ("instruct" in bind) {
        // A toggle adds its instruction when it is on. Any other control adds it on every run (see README).
        if (control.kind !== "toggle" || value === true) bound.push({ role: bind.instruct.role, text: bind.instruct.text });
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // 3. Steps: on when every toggle that enables them is on, and their `when` holds.
  const stepOn = new Map<string, { enabled: boolean; reason: string | null }>();
  for (const step of cookbook.steps) {
    const toggles = enabledBy.get(step.id) ?? [];
    if (toggles.includes(false)) {
      stepOn.set(step.id, { enabled: false, reason: "turned off" });
    } else if (step.when && !holds(step.when, values)) {
      stepOn.set(step.id, { enabled: false, reason: "its condition is not met" });
    } else {
      stepOn.set(step.id, { enabled: true, reason: null });
    }
  }
  const steps: ResolvedStep[] = cookbook.steps.map((step) => {
    const on = stepOn.get(step.id) ?? { enabled: true, reason: null };
    return {
      id: step.id,
      kind: step.kind,
      label: step.label,
      enabled: on.enabled,
      offReason: on.reason,
      after: [...step.after],
      params: { ...(stepParams.get(step.id) ?? {}) },
      uses: { ...step.uses },
    };
  });

  // 4. Instructions: the cookbook's own (when they hold) and the bound ones, grouped by role.
  const instructions: Partial<Record<CookbookRole, string[]>> = {};
  let total = 0;
  for (const instruction of [...cookbook.instructions.filter((item) => !item.when || holds(item.when, values)), ...bound]) {
    instructions[instruction.role] = [...(instructions[instruction.role] ?? []), instruction.text];
    total += instruction.text.length;
  }
  if (total > MAX_INSTRUCTIONS_CHARS) return { ok: false, issues: [`instructions: ${total} characters, over the ${MAX_INSTRUCTIONS_CHARS} limit`] };

  const estimateUnknown: string[] = [];
  let knownUsd = 0;
  // 4b. Steps that make a paid visual or call a model are priced too, even when no ingredient names them (a product-shot step, for example).
  // An enabled step that costs money, or whose cost is unknown, takes the run out of agent mode.
  const stepLines: ResolvedStepCost[] = [];
  for (const step of steps) {
    if (!step.enabled) continue;
    if (step.uses.visualType === undefined && step.uses.modelClass === undefined) continue;
    const synthetic: Way = {
      id: step.id,
      label: step.label,
      ...(step.uses.visualType === undefined ? {} : { visualType: step.uses.visualType }),
      ...(step.uses.modelClass === undefined ? {} : { modelClass: step.uses.modelClass }),
    };
    const cost = costOf(synthetic, options.lengthMs, options.voiceCharacters);
    stepLines.push({ stepId: step.id, label: step.label, cost });
    if (cost.kind === "paid") knownUsd += cost.usd;
    if (cost.kind === "unknown") estimateUnknown.push(`${step.label}: ${cost.reason}`);
  }

  // 5. Ingredients: the choice, its cost class, and the requirement in words.
  const ingredients: ResolvedIngredient[] = [];
  for (const ingredient of cookbook.ingredients) {
    const chosen = choices.get(ingredient.id);
    if (chosen === undefined) {
      ingredients.push({
        id: ingredient.id,
        kind: ingredient.kind,
        label: ingredient.label,
        need: ingredient.need,
        status: ingredient.need === "required" ? "needs_choice" : "not_needed",
        way: null,
        cost: null,
      });
      continue;
    }
    const way = ingredient.ways.find((candidate) => candidate.id === chosen);
    if (way === undefined) return { ok: false, issues: [`values: ${chosen} is not a way of ingredient ${ingredient.id}`] };
    const cost = costOf(way, options.lengthMs, options.voiceCharacters);
    ingredients.push({
      id: ingredient.id,
      kind: ingredient.kind,
      label: ingredient.label,
      need: ingredient.need,
      status: "chosen",
      way: { id: way.id, label: way.label },
      cost,
    });
    if (cost.kind === "paid") knownUsd += cost.usd;
    if (cost.kind === "unknown") estimateUnknown.push(`${ingredient.label}: ${cost.reason}`);
  }
  knownUsd = Math.round(knownUsd * 10000) / 10000;

  const needsChoice = ingredients.filter((item) => item.status === "needs_choice");
  const agentAllowed =
    cookbook.modes.includes("agent") &&
    ingredients.every((item) => item.status !== "needs_choice" && (item.cost === null || item.cost.kind === "free")) &&
    stepLines.every((line) => line.cost.kind === "free");
  const engineAllowed = cookbook.modes.includes("engine") && needsChoice.length === 0;
  const modes: CookbookMode[] = [];
  if (agentAllowed) modes.push("agent");
  if (engineAllowed) modes.push("engine");

  // 6. Requirements, badge and estimate.
  const requirements = ingredients
    .filter((item) => item.way !== null)
    .map((item) => `${item.label}: ${item.way?.label ?? ""}${costWords(item.cost)}`);
  for (const item of needsChoice) requirements.push(`${item.label}: choose one`);
  for (const line of stepLines) requirements.push(`${line.label}:${costWords(line.cost)}`);

  const badge = badgeFor({ needsChoice, unknown: estimateUnknown.length > 0, knownUsd, agentAllowed });

  // 7. The request, the plan template and the agent brief.
  const enabledSteps = steps.filter((step) => step.enabled);
  const resolvedLook = look ? { preset: look.preset, strength: look.strength } : null;
  const checks = [...cookbook.checks];
  const planTemplate = enabledSteps.map((step) => ({
    id: nodeIdOf(step.id),
    kind: step.kind,
    title: step.label,
    why: `From cookbook ${cookbook.cookbookId} version ${cookbook.version}`,
    dependsOn: step.after.filter((dependency) => enabledSteps.some((other) => other.id === dependency)).map(nodeIdOf),
    model: null as null,
    params: flatParams(step),
    estimateUsd: null as null,
  }));
  const agentBrief = briefFor(cookbook, options.lengthMs, enabledSteps, instructions, checks);

  const resolved: ResolvedCookbook = {
    cookbookId: cookbook.cookbookId,
    version: cookbook.version,
    label: cookbook.label,
    values,
    valuesHash: contentHash(values),
    lengthMs: options.lengthMs,
    modes,
    requirements,
    badge,
    estimate: { knownUsd, unknown: estimateUnknown },
    ingredients,
    steps,
    instructions,
    style: { styleKitId: cookbook.style?.styleKitId ?? null, look: resolvedLook },
    checks,
    grammar: cookbook.grammar,
    request: {
      styleKitId: cookbook.style?.styleKitId ?? null,
      lengthMs: options.lengthMs,
      look: resolvedLook,
      componentProps,
    },
    planTemplate,
    agentBrief,
  };
  return { ok: true, resolved };
}

/** The value a set binding writes: the control's value, or the mapped one. Undefined with an issue when a table has no entry. */
function mapped(
  path: string,
  value: ControlValue,
  map: { linear: { in: [number, number]; out: [number, number] } } | { table: Record<string, Scalar> } | undefined,
  control: Control,
  issues: string[],
): Scalar | undefined {
  if (map === undefined) return value as Scalar;
  if ("linear" in map) {
    if (typeof value !== "number") {
      issues.push(`controls.${control.id}: a linear map needs a number, and ${path} got ${JSON.stringify(value)}`);
      return undefined;
    }
    const [inLow, inHigh] = map.linear.in;
    const [outLow, outHigh] = map.linear.out;
    return outLow + ((value - inLow) * (outHigh - outLow)) / (inHigh - inLow);
  }
  const entry = map.table[String(value)];
  if (entry === undefined) {
    issues.push(`controls.${control.id}: the table for ${path} has no entry for ${JSON.stringify(value)}`);
    return undefined;
  }
  return entry;
}

/** Whether a condition holds for the values. A missing control value is not a value: the condition does not hold (fail closed). */
function holds(condition: { control: string; equals?: unknown; in?: unknown[]; atLeast?: number; atMost?: number }, values: Record<string, ControlValue>): boolean {
  const value = values[condition.control];
  if (value === undefined) return false;
  if (condition.equals !== undefined && value !== condition.equals) return false;
  if (condition.in !== undefined && !condition.in.includes(value)) return false;
  if (condition.atLeast !== undefined && !(typeof value === "number" && value >= condition.atLeast)) return false;
  if (condition.atMost !== undefined && !(typeof value === "number" && value <= condition.atMost)) return false;
  return true;
}

/** A way's cost class. A coded component and an upload cost nothing; a visual type and a model class are priced; the rest is unknown. */
function costOf(way: Way, lengthMs: number, voiceCharacters: number | undefined): CostLine {
  if (way.coded === true || way.upload === true) return { kind: "free" };
  // A component visual (coded graphics) is drawn in code: no model call, so it costs nothing.
  if (way.visualType !== undefined && RECIPES[way.visualType].kind === "component") return { kind: "free" };
  if (way.visualType !== undefined) {
    const shot = shotCost(way.visualType, lengthMs);
    if (!shot.known) return { kind: "unknown", reason: shot.reason };
    return { kind: "paid", usd: shot.totalUsd, basis: `${way.visualType} shot of ${Math.round(lengthMs / 1000)} s` };
  }
  if (way.modelClass !== undefined) {
    const routeKey = prices.routeFor[way.modelClass];
    const price = priceFor(routeKey);
    if (price.usd === null) return { kind: "unknown", reason: `${routeKey} has no known price` };
    let units: number | null;
    switch (price.unit) {
      case "per_second":
        units = lengthMs / 1000;
        break;
      case "per_minute":
        units = lengthMs / 60000;
        break;
      case "per_call":
      case "per_model":
      case "per_image":
        units = 1;
        break;
      case "per_million_characters":
        units = voiceCharacters === undefined ? null : voiceCharacters / 1_000_000;
        break;
      default:
        units = null;
    }
    if (units === null) {
      return { kind: "unknown", reason: `${routeKey} is priced ${price.unit}, and this way has no count for that unit` };
    }
    return { kind: "paid", usd: Math.round(price.usd * units * 10000) / 10000, basis: `${way.modelClass} via ${routeKey}` };
  }
  return { kind: "unknown", reason: "the way names no cost source" };
}

function costWords(cost: CostLine | null): string {
  if (cost === null) return "";
  if (cost.kind === "free") return " (free)";
  if (cost.kind === "paid") return ` (about $${cost.usd.toFixed(2)})`;
  return " (price unknown)";
}

/** The badge: what the person must still choose, then what is unknown, then what it costs, then whether it is free. Never 0 for unknown. */
function badgeFor(input: { needsChoice: ResolvedIngredient[]; unknown: boolean; knownUsd: number; agentAllowed: boolean }): string {
  if (input.needsChoice.length > 0) return `Choose ${input.needsChoice.map((item) => item.label.toLowerCase()).join(", ")}`;
  if (input.unknown) return "Price unknown";
  if (input.knownUsd > 0) return `Paid: about $${input.knownUsd.toFixed(2)}`;
  if (input.agentAllowed) return "Free in agent mode";
  return "Free";
}

/** The step's id as an orchestrator plan node id: lower case, underscores, at most 40 characters. */
export function nodeIdOf(stepId: string): string {
  return stepId.replace(/\./g, "_").toLowerCase().slice(0, 40);
}

function flatParams(step: ResolvedStep): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(step.params)) out[key.slice(0, 40)] = value;
  if (step.uses.component !== undefined) out.component = step.uses.component;
  if (step.uses.visualType !== undefined) out.visual_type = step.uses.visualType;
  if (step.uses.modelClass !== undefined) out.model_class = step.uses.modelClass;
  if (step.uses.role !== undefined) out.role = step.uses.role;
  return out;
}

function briefFor(
  cookbook: Cookbook,
  lengthMs: number,
  steps: ResolvedStep[],
  instructions: Partial<Record<CookbookRole, string[]>>,
  checks: Check[],
): string {
  const lines = [
    `Cookbook: ${cookbook.label} (${cookbook.cookbookId}, version ${cookbook.version}).`,
    `Length: ${Math.round(lengthMs / 1000)} seconds.`,
    "Rule: make the video with no paid provider call. Use only coded components, the person's uploads and local rendering.",
    "Steps, in order:",
    ...steps.map((step, index) => `${index + 1}. ${step.label} (${step.kind}).`),
  ];
  for (const role of Object.keys(instructions) as CookbookRole[]) {
    lines.push(`Instructions for ${role}:`, ...(instructions[role] ?? []).map((text) => `- ${text}`));
  }
  lines.push(`Checks against the reference: ${checks.map((check) => `${check.measure} ${check.target} (+/- ${check.tolerance})`).join("; ") || "none"}.`);
  return lines.join("\n");
}

