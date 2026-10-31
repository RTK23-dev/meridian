// The cookbook schema (round 3, K2): `meridian.cookbook/v1`. A cookbook is a versioned recipe for one kind of video: its ingredients (what
// it needs and how each need can be met), its steps (the orchestrator's node kinds), its instructions per role, its style, its grammar
// targets, its controls (K1) and its checks. This file is the shape only. validate.ts holds the rules that a shape cannot express.
//
// Data only: no expression, no code, no URL. Unknown keys are refused (strict objects), so a cookbook cannot carry a field nobody reads.

import { z } from "zod";
import { beatRoleSchema, modelClassSchema, visualTypeSchema } from "../../../engine/contracts/index.ts";
import { LOOK_PRESETS } from "../../../engine/contracts/edl.ts";
import { nodeKindSchema } from "../../../engine/orchestrator/contracts.ts";
import { controlSchema, cookbookRoleSchema, controlIdSchema, ingredientIdSchema, nameSchema, scalarSchema, stepIdSchema } from "./controls.ts";

export const COOKBOOK_SCHEMA = "meridian.cookbook/v1";
export const COOKBOOK_FAMILIES = ["explainer", "ugc", "product", "listicle", "story", "other"] as const;
export const COOKBOOK_MODES = ["agent", "engine"] as const;
export const COOKBOOK_SCOPES = ["builtin", "workspace"] as const;
export const INGREDIENT_KINDS = [
  "voice",
  "music",
  "presenter",
  "ugc_footage",
  "generated_video",
  "generated_image",
  "stock",
  "product_kit",
  "persona",
  "reference",
] as const;
export const INGREDIENT_NEEDS = ["required", "optional", "none"] as const;

/** The measures a cookbook's checks compare, named as `compare.ts` reports them. A check on any other name is refused. */
export const CHECK_MEASURES = [
  "durationMs",
  "hardCuts",
  "firstCutMs",
  "shotP25Ms",
  "shotP50Ms",
  "shotP75Ms",
  "zoomJumps",
  "punchInsPer10s",
  "interruptMedianMs",
  "meanMotion",
  "integratedLufs",
  "loudnessRangeLu",
  "loopDistance",
] as const;
export const checkMeasureSchema = z.enum(CHECK_MEASURES);

/** A condition on one control's value. Exactly the forms below: equality, membership, or a bound on a slider. */
export const conditionSchema = z
  .strictObject({
    control: controlIdSchema,
    equals: scalarSchema.optional(),
    in: z.array(scalarSchema).min(1).max(20).optional(),
    atLeast: z.number().finite().optional(),
    atMost: z.number().finite().optional(),
  })
  .refine((condition) => [condition.equals, condition.in, condition.atLeast, condition.atMost].some((part) => part !== undefined), {
    message: "a condition needs equals, in, atLeast or atMost",
  });
export type Condition = z.infer<typeof conditionSchema>;

/**
 * One way to meet an ingredient. A coded component or a person's upload costs nothing to make (agent mode can use it). A model class
 * or a visual type is priced by the engine's tables when the cookbook is resolved.
 */
export const waySchema = z
  .strictObject({
    id: nameSchema,
    label: z.string().min(1).max(80),
    coded: z.boolean().optional(),
    upload: z.boolean().optional(),
    modelClass: modelClassSchema.optional(),
    visualType: visualTypeSchema.optional(),
  })
  .refine((way) => way.coded === true || way.upload === true || way.modelClass !== undefined || way.visualType !== undefined, {
    message: "a way names a coded component, an upload, a model class or a visual type",
  });
export type Way = z.infer<typeof waySchema>;

export const ingredientSchema = z.strictObject({
  id: ingredientIdSchema,
  kind: z.enum(INGREDIENT_KINDS),
  label: z.string().min(1).max(80),
  need: z.enum(INGREDIENT_NEEDS),
  ways: z.array(waySchema).min(1).max(12),
});
export type Ingredient = z.infer<typeof ingredientSchema>;

export const stepSchema = z.strictObject({
  id: stepIdSchema,
  kind: nodeKindSchema,
  label: z.string().min(1).max(80),
  /** Steps that must finish first. A cycle is refused by the validator. */
  after: z.array(stepIdSchema).max(20).default([]),
  /** When the step runs. Absent means it always runs. */
  when: conditionSchema.optional(),
  uses: z
    .strictObject({
      component: nameSchema.optional(),
      visualType: visualTypeSchema.optional(),
      modelClass: modelClassSchema.optional(),
      role: cookbookRoleSchema.optional(),
    })
    .default({}),
  /** Default parameter values. A control can set one of these by path (`step.<id>.<key>`). */
  params: z.record(nameSchema, scalarSchema).default({}),
});
export type Step = z.infer<typeof stepSchema>;

export const instructionSchema = z.strictObject({
  role: cookbookRoleSchema,
  text: z.string().min(1).max(4000),
  when: conditionSchema.optional(),
});
export type Instruction = z.infer<typeof instructionSchema>;

export const cookbookStyleSchema = z.strictObject({
  styleKitId: z.string().min(1).max(120),
  look: z
    .strictObject({
      preset: z.enum(LOOK_PRESETS),
      strength: z.number().min(0).max(1),
    })
    .optional(),
});
export type CookbookStyle = z.infer<typeof cookbookStyleSchema>;

export const cookbookGrammarSchema = z.strictObject({
  /** The beats in order. Each starts where the one before ends (the validator checks this). */
  structure: z
    .array(
      z.strictObject({
        role: beatRoleSchema,
        fromMs: z.int().nonnegative(),
        toMs: z.int().positive(),
      }),
    )
    .max(40),
  /** The rule that makes a cut register, in words (from the reference's cut measures). */
  cutRule: z.string().max(600).optional(),
});
export type CookbookGrammar = z.infer<typeof cookbookGrammarSchema>;

export const checkSchema = z.strictObject({
  measure: checkMeasureSchema,
  target: z.number().finite(),
  tolerance: z.number().finite().nonnegative(),
});
export type Check = z.infer<typeof checkSchema>;

export const cookbookSchema = z.strictObject({
  schema: z.literal(COOKBOOK_SCHEMA),
  cookbookId: z.string().regex(/^ck_[a-z0-9_]{3,60}$/, { message: "a cookbook id starts with ck_ and uses lower-case letters, digits and underscores" }),
  version: z.int().min(1),
  label: z.string().min(1).max(80),
  summary: z.string().min(1).max(400),
  family: z.enum(COOKBOOK_FAMILIES),
  scope: z.enum(COOKBOOK_SCOPES),
  parent: z
    .strictObject({
      cookbookId: z.string().regex(/^ck_[a-z0-9_]{3,60}$/),
      version: z.int().min(1),
    })
    .optional(),
  modes: z.array(z.enum(COOKBOOK_MODES)).min(1).max(2),
  ingredients: z.array(ingredientSchema).max(20),
  steps: z.array(stepSchema).min(1).max(40),
  instructions: z.array(instructionSchema).max(40),
  style: cookbookStyleSchema,
  grammar: cookbookGrammarSchema,
  controls: z.array(controlSchema).max(40),
  checks: z.array(checkSchema).max(20),
});
export type Cookbook = z.infer<typeof cookbookSchema>;
