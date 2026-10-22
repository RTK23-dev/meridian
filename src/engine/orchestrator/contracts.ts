// The orchestrator's plan (owner direction, 2026-10-20): the orchestrating model the user selects reads the whole brief and returns
// a graph of steps. Nothing in this file names a model. Every model id in a plan is checked against the live OpenRouter catalog
// (catalog.ts) before a step may run, and the orchestrator model itself is one of those live ids. The plan is untrusted model
// output: it is parsed with zod and validated, and it is never executed.

import { z } from "zod";

export const ORCHESTRATOR_PLAN_VERSION = "orchestrator-plan@1";

/** The steps a plan can draw. Each one does one job; how it is done is the model's choice, within its kind. */
export const NODE_KINDS = [
  "reference", // an asset the user supplied (a viral reference, a product photo, a brand file). No model call.
  "analysis", // a text model reads something and returns structure (what the reference does, what the brand needs).
  "script", // a text model writes lines or a shot list.
  "visual", // an image model makes or edits a still.
  "video", // a video model makes a moving shot.
  "voice", // a speech model reads the script.
  "avatar", // a video model makes a presenter shot.
  "edit", // deterministic cut, timing and grade. No model call.
  "compose", // deterministic layout of the stills, shots and captions. No model call.
  "render", // the final encode. No model call.
] as const;

export const nodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof nodeKindSchema>;

/** A live OpenRouter model id, written vendor/model. The id is only a reference; the catalog decides whether it exists. */
export const modelRefSchema = z.object({
  provider: z.literal("openrouter"),
  id: z.string().regex(/^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i, "a model id is vendor/model"),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

/**
 * One step of the plan. `params` is flat on purpose (strings, numbers, booleans, null, no nesting): it is what the handler reads
 * and what the cache key hashes, and a flat record is easy to show and to edit surgically on the canvas.
 */
export const planNodeSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "a step id is a short lowercase slug"),
    kind: nodeKindSchema,
    title: z.string().min(1).max(120),
    why: z.string().min(1).max(500),
    dependsOn: z.array(z.string().max(40)).max(12),
    model: modelRefSchema.nullable(),
    params: z
      .record(z.string().max(40), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]))
      .default({}),
    /** The engine's estimate of this step's cost in USD. Null when unknown; a paid step with a null estimate does not run. */
    estimateUsd: z.number().nonnegative().nullable(),
  })
  .strict();
export type PlanNode = z.infer<typeof planNodeSchema>;

export const orchestratorPlanSchema = z
  .object({
    version: z.literal(ORCHESTRATOR_PLAN_VERSION),
    /** The model the user chose to orchestrate this run. It wrote this plan. */
    orchestrator: modelRefSchema,
    budgetUsd: z.number().positive(),
    nodes: z.array(planNodeSchema).min(1).max(60),
  })
  .strict();
export type OrchestratorPlan = z.infer<typeof orchestratorPlanSchema>;

/** What the executor reports for each step, in order. The canvas draws from these. */
// queued: an asset the provider accepted and has not finished. Its poll is durable (orchestrator_asset_jobs); a later run reads the stored output.
export const NODE_STATES = ["planned", "running", "done", "cache_hit", "skipped", "failed", "not_connected", "paused", "queued"] as const;
export const nodeStateSchema = z.enum(NODE_STATES);
export type NodeState = z.infer<typeof nodeStateSchema>;

export const nodeEventSchema = z
  .object({
    nodeId: z.string(),
    state: nodeStateSchema,
    outputHash: z.string().nullable(),
    costUsd: z.number().nonnegative().nullable(),
    reason: z.string().max(500).nullable(),
  })
  .strict();
export type NodeEvent = z.infer<typeof nodeEventSchema>;
