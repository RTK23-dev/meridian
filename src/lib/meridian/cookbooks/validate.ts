// validateCookbook (round 3, K2): the shape from schema.ts, then the rules a shape cannot express. Every problem is returned with the
// field that caused it. A cookbook that passes can be resolved (K3) and rendered without guessing what a control means.
//
// The rules, in the order the design lists them (docs/planning/COOKBOOK_PRESETS_PLAN.md, section 3):
//   1. A control can only set a path the cookbook owns: a step parameter, the style's look, or a declared component variable.
//   2. A slider's range, and a linear map's output range, stays inside the engine's bound for that path (the style look is 0 to 1;
//      a component variable is bounded by its declaration).
//   3. Ids are unique; steps form no cycle; every reference names something that exists.
//   4. Nothing is an expression. This is enforced by the strict schema (no extra keys, no code-like values).
//   5. Instruction text is bounded, per instruction and in total.
//   6. Unknown prices stay unknown. The resolver (K3) owns prices; the validator only checks that a way names a price source.
//
// Plus: a cookbook that offers agent mode must have a free way (coded or upload) for every required ingredient, and its structure
// must be contiguous.

import { PALETTE_ROLES, type Control, type ControlValue, type PaletteRole } from "./controls.ts";
import { cookbookSchema, type Cookbook } from "./schema.ts";
import { LOOK_PRESETS } from "../../../engine/contracts/edl.ts";

export type ValidationContext = {
  /** The declared controls of each compose component (controlsOfComponent, K1). A component path is settable only when declared. */
  components?: Readonly<Record<string, readonly Control[]>>;
};

export type ValidationResult = { ok: true; cookbook: Cookbook } | { ok: false; issues: string[] };

const MAX_INSTRUCTIONS_CHARS = 16000;

type Bound = { min: number; max: number };
type Target = { type: "boolean" | "number" | "string"; bound?: Bound; options?: readonly string[] };

export function validateCookbook(input: unknown, context: ValidationContext = {}): ValidationResult {
  const parsed = cookbookSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "cookbook"}: ${issue.message}`) };
  }
  const cookbook = parsed.data;
  const issues: string[] = [];

  // 3. Unique ids.
  duplicatesOf(cookbook.steps.map((step) => step.id)).forEach((id) => issues.push(`steps.${id}: the id is used more than once`));
  duplicatesOf(cookbook.ingredients.map((ingredient) => ingredient.id)).forEach((id) =>
    issues.push(`ingredients.${id}: the id is used more than once`),
  );
  duplicatesOf(cookbook.controls.map((control) => control.id)).forEach((id) => issues.push(`controls.${id}: the id is used more than once`));
  duplicatesOf(cookbook.modes).forEach((mode) => issues.push(`modes: ${mode} is listed more than once`));
  duplicatesOf(cookbook.checks.map((check) => check.measure)).forEach((measure) =>
    issues.push(`checks.${measure}: the measure is checked more than once`),
  );
  for (const ingredient of cookbook.ingredients) {
    duplicatesOf(ingredient.ways.map((way) => way.id)).forEach((id) => issues.push(`ingredients.${ingredient.id}.ways.${id}: the id is used more than once`));
  }

  // 3. Steps: references exist, and no cycle.
  const stepIds = new Set(cookbook.steps.map((step) => step.id));
  for (const step of cookbook.steps) {
    for (const dependency of step.after) {
      if (!stepIds.has(dependency)) issues.push(`steps.${step.id}.after: ${dependency} is not a step`);
    }
  }
  const cycle = findCycle(cookbook.steps.map((step) => [step.id, step.after] as const));
  if (cycle !== null) issues.push(`steps: the steps depend on each other in a loop (${cycle.join(" -> ")})`);

  // Controls by id, for the conditions and bindings below.
  const controls = new Map(cookbook.controls.map((control) => [control.id, control] as const));
  const ingredientIds = new Map(cookbook.ingredients.map((ingredient) => [ingredient.id, ingredient] as const));

  // Conditions: the control exists, and the value fits the control's kind.
  const checkCondition = (where: string, condition: { control: string; equals?: unknown; in?: unknown[]; atLeast?: number; atMost?: number }) => {
    const control = controls.get(condition.control);
    if (control === undefined) {
      issues.push(`${where}: the condition names control ${condition.control}, which does not exist`);
      return;
    }
    if (condition.atLeast !== undefined || condition.atMost !== undefined) {
      if (control.kind !== "slider") issues.push(`${where}: atLeast and atMost need a slider, and ${control.id} is a ${control.kind}`);
    }
    const values = [...(condition.equals === undefined ? [] : [condition.equals]), ...(condition.in ?? [])];
    for (const value of values) {
      if (!fitsControl(control, value as ControlValue)) {
        issues.push(`${where}: ${JSON.stringify(value)} does not fit control ${control.id}`);
      }
    }
  };
  for (const step of cookbook.steps) if (step.when) checkCondition(`steps.${step.id}.when`, step.when);
  cookbook.instructions.forEach((instruction, index) => {
    if (instruction.when) checkCondition(`instructions[${index}].when`, instruction.when);
  });

  // 1 and 2. Bindings: each one names a path the cookbook owns, of the right type, inside the engine's bound.
  for (const control of cookbook.controls) {
    control.binds.forEach((bind, index) => {
      const where = `controls.${control.id}.binds[${index}]`;
      if ("set" in bind) {
        const target = targetOf(bind.set, cookbook, context);
        if (typeof target === "string") {
          issues.push(`${where}: ${target}`);
          return;
        }
        if (typeOfControl(control) !== target.type) {
          issues.push(`${where}: ${control.id} is a ${control.kind}, and ${bind.set} takes a ${target.type}`);
        }
        if (control.kind === "slider" && target.bound) {
          if (control.min < target.bound.min || control.max > target.bound.max) {
            issues.push(`${where}: the slider range ${control.min} to ${control.max} is outside ${target.bound.min} to ${target.bound.max}`);
          }
          const linear = bind.map && "linear" in bind.map ? bind.map.linear : undefined;
          if (linear && (Math.min(...linear.out) < target.bound.min || Math.max(...linear.out) > target.bound.max)) {
            issues.push(`${where}: the mapped output ${linear.out.join(" to ")} is outside ${target.bound.min} to ${target.bound.max}`);
          }
        }
        if (control.kind === "select" && target.options) {
          for (const option of control.options) {
            if (!target.options.includes(option.value)) issues.push(`${where}: option ${option.value} is not allowed for ${bind.set}`);
          }
        }
      } else if ("enable" in bind) {
        if (!stepIds.has(bind.enable)) issues.push(`${where}: enable names step ${bind.enable}, which does not exist`);
        if (control.kind !== "toggle") issues.push(`${where}: enable needs a toggle, and ${control.id} is a ${control.kind}`);
      } else if ("choose" in bind) {
        const ingredient = ingredientIds.get(bind.choose.ingredient);
        if (ingredient === undefined) {
          issues.push(`${where}: choose names ingredient ${bind.choose.ingredient}, which does not exist`);
        } else {
          if (control.kind !== "select") issues.push(`${where}: choose needs a select, and ${control.id} is a ${control.kind}`);
          const ways = new Set(ingredient.ways.map((way) => way.id));
          if (control.kind === "select") {
            for (const option of control.options) {
              if (!ways.has(option.value)) issues.push(`${where}: option ${option.value} is not a way of ingredient ${ingredient.id}`);
            }
          }
        }
      }
    });
  }

  // 5. Instructions in total.
  const total = cookbook.instructions.reduce((sum, instruction) => sum + instruction.text.length, 0);
  if (total > MAX_INSTRUCTIONS_CHARS) issues.push(`instructions: ${total} characters in total, over the ${MAX_INSTRUCTIONS_CHARS} limit`);

  // Agent mode: every required ingredient has a free way.
  if (cookbook.modes.includes("agent")) {
    for (const ingredient of cookbook.ingredients) {
      if (ingredient.need !== "required") continue;
      if (!ingredient.ways.some((way) => way.coded === true || way.upload === true)) {
        issues.push(`modes.agent: required ingredient ${ingredient.id} has no free way (a coded component or an upload)`);
      }
    }
  }

  // Structure: contiguous beats, each with a positive length.
  cookbook.grammar.structure.forEach((beat, index) => {
    if (beat.toMs <= beat.fromMs) issues.push(`grammar.structure[${index}]: the ${beat.role} beat ends before it starts`);
    if (index > 0) {
      const before = cookbook.grammar.structure[index - 1];
      if (before && before.toMs !== beat.fromMs) {
        issues.push(`grammar.structure[${index}]: the ${beat.role} beat starts at ${beat.fromMs} ms, not where the last one ends (${before.toMs} ms)`);
      }
    }
  });

  return issues.length === 0 ? { ok: true, cookbook } : { ok: false, issues };
}

/** The value type and engine bound of a settable path, or a reason it is not settable. */
function targetOf(path: string, cookbook: Cookbook, context: ValidationContext): Target | string {
  // Step and component names may contain dots, so the key or variable is the last part and the name is everything between.
  const parts = path.split(".");
  if (parts[0] === "step" && parts.length >= 3) {
    const key = parts[parts.length - 1] ?? "";
    const stepId = parts.slice(1, -1).join(".");
    const step = cookbook.steps.find((candidate) => candidate.id === stepId);
    if (step === undefined) return `path ${path} names step ${stepId}, which does not exist`;
    const value = step.params[key];
    if (value === undefined) return `path ${path} is not a parameter of step ${step.id}`;
    return { type: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string" };
  }
  if (path === "style.look.strength") {
    if (cookbook.style.look === undefined) return "path style.look.strength needs a look on the style";
    return { type: "number", bound: { min: 0, max: 1 } };
  }
  if (path === "style.look.preset") {
    if (cookbook.style.look === undefined) return "path style.look.preset needs a look on the style";
    return { type: "string", options: LOOK_PRESETS };
  }
  if (parts[0] === "component" && parts.length >= 3) {
    const variable = parts[parts.length - 1] ?? "";
    const component = parts.slice(1, -1).join(".");
    const declared = context.components?.[component]?.find((control) => control.id === `${component}.${variable}`);
    if (declared === undefined) return `path ${path} is not a declared variable of component ${component}`;
    if (!cookbook.steps.some((step) => step.uses.component === component)) {
      return `path ${path} needs a step that uses component ${component}`;
    }
    if (declared.kind === "slider") return { type: "number", bound: { min: declared.min, max: declared.max } };
    if (declared.kind === "select") return { type: "string", options: declared.options.map((option) => option.value) };
    if (declared.kind === "toggle") return { type: "boolean" };
    return { type: "string" };
  }
  return `path ${path} is not settable: use step.<id>.<parameter>, style.look.strength, style.look.preset or component.<name>.<variable>`;
}

function typeOfControl(control: Control): Target["type"] {
  if (control.kind === "toggle") return "boolean";
  if (control.kind === "slider") return "number";
  return "string";
}

function fitsControl(control: Control, value: ControlValue): boolean {
  switch (control.kind) {
    case "toggle":
      return typeof value === "boolean";
    case "slider":
      return typeof value === "number" && value >= control.min && value <= control.max;
    case "select":
      return typeof value === "string" && control.options.some((option) => option.value === value);
    case "text":
      return typeof value === "string" && value.length <= control.maxLength;
    case "colour":
      return typeof value === "string" && (PALETTE_ROLES as readonly string[]).includes(value) && control.roles.includes(value as PaletteRole);
  }
}

function duplicatesOf<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const repeated = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

/** A loop in the dependency graph, as the ids along it, or null. Depth-first with three colours. */
function findCycle(edges: ReadonlyArray<readonly [string, readonly string[]]>): string[] | null {
  const after = new Map(edges.map(([id, deps]) => [id, deps] as const));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === "done") return null;
    if (current === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of after.get(id) ?? []) {
      const found = visit(dependency);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const [id] of edges) {
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

