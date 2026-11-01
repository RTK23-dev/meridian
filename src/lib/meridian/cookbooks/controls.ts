// The control schema shared by compose components and cookbooks (round 3, K1). A control is a toggle, a slider, a select, a text box or a
// colour pick from the style kit. Each control says what it binds to: a parameter path, a step on or off, an ingredient's way, or an
// instruction for a role. A component's `data-composition-variables` declaration is read into the same shape, so one form renders both.
//
// Data only: a binding is one of four fixed shapes, never an expression, so a control can never run code (cookbook rule 4).

import { z } from "zod";

import { COOKBOOK_INSTRUCTION_ROLES, cookbookInstructionRoleSchema } from "../../../engine/contracts/cookbook-roles.ts";

/** The roles a cookbook instruction can reach: the engine contract's list (contract v12), so the two cannot drift. */
export const COOKBOOK_ROLES = COOKBOOK_INSTRUCTION_ROLES;
export const cookbookRoleSchema = cookbookInstructionRoleSchema;
export type CookbookRole = z.infer<typeof cookbookRoleSchema>;

/** The colour roles of a style kit (styleKitSchema.palette). A colour control picks one of these, never a free colour. */
export const PALETTE_ROLES = ["primary", "secondary", "accent", "text", "background"] as const;
export const paletteRoleSchema = z.enum(PALETTE_ROLES);
export type PaletteRole = z.infer<typeof paletteRoleSchema>;

/** Dotted names: `pace`, `component.band`, `captions.karaoke.durationMs`. Used for control ids, paths, step ids and ingredient ids. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;
export const nameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(NAME_PATTERN, { message: "use letters, digits and underscores, with dots between parts, starting with a letter" });

export const controlIdSchema = nameSchema;
export const pathSchema = nameSchema;
export const stepIdSchema = nameSchema;
export const ingredientIdSchema = nameSchema;

export const scalarSchema = z.union([z.string().max(2000), z.number().finite(), z.boolean()]);
export type Scalar = z.infer<typeof scalarSchema>;

/** A linear map from a control's range to a parameter's range. Both ends of the input range must differ. */
export const linearMapSchema = z
  .strictObject({
    in: z.tuple([z.number().finite(), z.number().finite()]),
    out: z.tuple([z.number().finite(), z.number().finite()]),
  })
  .refine((map) => map.in[0] !== map.in[1], { message: "the input range must not be empty" });

export const bindingSchema = z.union([
  z.strictObject({
    set: pathSchema,
    map: z
      .union([z.strictObject({ linear: linearMapSchema }), z.strictObject({ table: z.record(z.string(), scalarSchema) })])
      .optional(),
  }),
  z.strictObject({ enable: stepIdSchema }),
  z.strictObject({ choose: z.strictObject({ ingredient: ingredientIdSchema }) }),
  z.strictObject({ instruct: z.strictObject({ role: cookbookRoleSchema, text: z.string().min(1).max(4000) }) }),
]);
export type Binding = z.infer<typeof bindingSchema>;

const base = {
  id: controlIdSchema,
  label: z.string().min(1).max(80),
  help: z.string().max(240).optional(),
  binds: z.array(bindingSchema).max(16),
};

export const toggleControlSchema = z.strictObject({
  ...base,
  kind: z.literal("toggle"),
  default: z.boolean(),
});

export const sliderControlSchema = z
  .strictObject({
    ...base,
    kind: z.literal("slider"),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive(),
    default: z.number().finite(),
    unit: z.string().max(12).optional(),
  })
  .superRefine((slider, ctx) => {
    if (!(slider.min < slider.max)) ctx.addIssue({ code: "custom", path: ["max"], message: "max must be above min" });
    if (slider.default < slider.min || slider.default > slider.max) {
      ctx.addIssue({ code: "custom", path: ["default"], message: "default must be between min and max" });
    }
  });

export const selectControlSchema = z
  .strictObject({
    ...base,
    kind: z.literal("select"),
    options: z.array(z.strictObject({ value: z.string().min(1).max(120), label: z.string().min(1).max(120) })).min(1).max(50),
    default: z.string().min(1).max(120),
  })
  .superRefine((select, ctx) => {
    const values = select.options.map((option) => option.value);
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "option values must be unique" });
    }
    if (!values.includes(select.default)) {
      ctx.addIssue({ code: "custom", path: ["default"], message: "default must be one of the options" });
    }
  });

export const textControlSchema = z
  .strictObject({
    ...base,
    kind: z.literal("text"),
    maxLength: z.int().min(1).max(2000),
    default: z.string().max(2000),
  })
  .superRefine((text, ctx) => {
    if (text.default.length > text.maxLength) {
      ctx.addIssue({ code: "custom", path: ["default"], message: "default is longer than maxLength" });
    }
  });

export const colourControlSchema = z
  .strictObject({
    ...base,
    kind: z.literal("colour"),
    roles: z.array(paletteRoleSchema).min(1).max(5),
    default: paletteRoleSchema,
  })
  .superRefine((colour, ctx) => {
    if (new Set(colour.roles).size !== colour.roles.length) {
      ctx.addIssue({ code: "custom", path: ["roles"], message: "roles must be unique" });
    }
    if (!colour.roles.includes(colour.default)) {
      ctx.addIssue({ code: "custom", path: ["default"], message: "default must be one of the roles" });
    }
  });

export const controlSchema = z.discriminatedUnion("kind", [
  toggleControlSchema,
  sliderControlSchema,
  selectControlSchema,
  textControlSchema,
  colourControlSchema,
]);
export type Control = z.infer<typeof controlSchema>;
export type ControlKind = Control["kind"];

/** The value a control takes: a boolean, a number, a string (text, select) or a palette role. */
export type ControlValue = boolean | number | string;

/** The default value of each control, by id. Pure. */
export function defaultsOf(controls: readonly Control[]): Record<string, ControlValue> {
  const out: Record<string, ControlValue> = {};
  for (const control of controls) out[control.id] = control.default;
  return out;
}

// --- Component declarations ------------------------------------------------------------------------------------------------------

/** One entry of a component's `data-composition-variables` (see the component.html files). */
export const componentVariableSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: z.string().min(1).max(60),
    type: z.literal("enum"),
    label: z.string().min(1).max(80),
    default: z.string().min(1),
    options: z.array(z.strictObject({ value: z.string().min(1), label: z.string().min(1) })).min(1),
  }),
  z.strictObject({
    id: z.string().min(1).max(60),
    type: z.literal("number"),
    label: z.string().min(1).max(80),
    default: z.number().finite(),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive(),
    unit: z.string().max(12).optional(),
  }),
  z.strictObject({
    id: z.string().min(1).max(60),
    type: z.literal("string"),
    label: z.string().min(1).max(80),
    default: z.string().max(2000),
  }),
]);
export type ComponentVariable = z.infer<typeof componentVariableSchema>;

export type ParseResult = { ok: true; controls: Control[] } | { ok: false; issues: string[] };

/** The `data-composition-variables` JSON of a component.html file, or null when the attribute is missing. Pure. */
export function declarationOf(html: string): string | null {
  const match = /data-composition-variables='([^']*)'/.exec(html);
  return match?.[1] ?? null;
}

/**
 * Reads one component's declaration into controls. Each control binds to `component.<component name>.<variable id>`, so a cookbook can set it.
 * Every problem is returned with the component, the entry and the field that failed. Nothing is guessed.
 */
export function controlsOfComponent(componentName: string, html: string): ParseResult {
  const raw = declarationOf(html);
  if (raw === null) return { ok: false, issues: [`${componentName}: no data-composition-variables attribute`] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, issues: [`${componentName}: data-composition-variables is not JSON`] };
  }
  if (!Array.isArray(json)) return { ok: false, issues: [`${componentName}: data-composition-variables is not a list`] };

  const controls: Control[] = [];
  const issues: string[] = [];
  json.forEach((entry, index) => {
    const where = `${componentName}[${index}]`;
    const parsed = componentVariableSchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push(`${where} ${issue.path.join(".") || "(entry)"}: ${issue.message}`);
      }
      return;
    }
    const variable = parsed.data;
    const id = `${componentName}.${variable.id}`;
    const binds = [{ set: `component.${componentName}.${variable.id}` }];
    const candidate = toControl(variable, id, binds);
    const checked = controlSchema.safeParse(candidate);
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        issues.push(`${where} (${variable.id}) ${issue.path.join(".") || "(control)"}: ${issue.message}`);
      }
      return;
    }
    controls.push(checked.data);
  });
  return issues.length === 0 ? { ok: true, controls } : { ok: false, issues };
}

function toControl(variable: ComponentVariable, id: string, binds: Binding[]): unknown {
  if (variable.type === "enum") {
    return { id, kind: "select", label: variable.label, binds, default: variable.default, options: variable.options };
  }
  if (variable.type === "number") {
    return {
      id,
      kind: "slider",
      label: variable.label,
      binds,
      default: variable.default,
      min: variable.min,
      max: variable.max,
      step: variable.step,
      ...(variable.unit === undefined ? {} : { unit: variable.unit }),
    };
  }
  return { id, kind: "text", label: variable.label, binds, default: variable.default, maxLength: Math.max(200, variable.default.length) };
}
