// The shot's asset spec and its prompt, the plan and the model choices a shot is made with, and the reservation the stage needs.
// Moved out of engine/jobs/handlers/produce-shot.ts unchanged (coding loop, T9b). produce-shot.ts re-exports the public names.

import { EngineError, assetSpecSchema, scenePlanSchema, type AssetSpec, type ShotSpec } from "../../contracts/index.ts";
import { readJobInputs, type StoredArtifact } from "../artifact-store.ts";
import { modelChoicesSchema } from "../../contracts/model-choices.ts";
import { modelChoiceSchema, type ModelChoice } from "../../contracts/assets.ts";
import { SINGLE_CALL_OUTPUT } from "../../plan/model-choices.ts";
import { promptWithDirectives } from "../remake.ts";
import { stableId, seedFor } from "../stable-id.ts";
import { epochOf, type StageContext } from "../types.ts";
import { TAKE_WIDTH, TAKE_HEIGHT, HINT_PATTERN } from "./produce-shot-types.ts";
import type { ShotChoices } from "./produce-shot-types.ts";

export function promptWithHints(prompt: string, hints: readonly string[]): string {
  const safe = [...new Set(hints)].filter((hint) => HINT_PATTERN.test(hint)).sort().slice(0, 8);
  if (safe.length === 0) return prompt;
  return `${prompt} Avoid: ${safe.map((hint) => hint.replace(/_/g, " ")).join(", ")}.`;
}

/**
 * The asset spec of one generate call (Bible 10.1). It is built from the plan's shot, the attempt and the hints, so a replay
 * builds the same spec with the same cache key, and a redo (a new attempt, with hints) builds a new one.
 */
export function assetSpecFor(input: {
  requestId: string;
  shot: ShotSpec;
  attempt: number;
  hints: readonly string[];
  /** The reviewer's directions for a remade shot (remake.ts). They join the prompt after the rules. Absent: none. */
  directives?: readonly string[];
  subject?: string;
  /** The orchestrator's model for this call, from the request's model_choices (Bible 10.5). Absent or null: the route table applies. */
  modelChoice?: ModelChoice | null;
}): AssetSpec {
  const source = input.shot.source;
  if (source.kind !== "generate") {
    throw new EngineError("invalid_input", `${input.shot.shotId} is a ${source.kind} shot and has no asset spec`, { stage: "produce_shot" });
  }
  // The label names the job's subject: a master shot's subject is its id, and a variant's shot has its own (variants/work.ts), so the
  // variant's take is never the master's take, nor the cached answer of the master's call.
  const label = `${input.requestId}|${input.subject ?? input.shot.shotId}|${input.attempt}`;
  const spec = {
    schema: "meridian.asset_spec/v1" as const,
    specId: stableId("asp_", `asset|${label}`),
    shotId: input.shot.shotId,
    modelClass: source.modelClass,
    prompt: promptWithDirectives(promptWithHints(source.prompt, input.hints), input.directives ?? []),
    refs: [...source.refs],
    ...(source.firstFrame === undefined ? {} : { firstFrame: source.firstFrame }),
    ...(source.lastFrame === undefined ? {} : { lastFrame: source.lastFrame }),
    durationMs: input.shot.endMs - input.shot.startMs,
    aspect: "9:16" as const,
    width: TAKE_WIDTH,
    height: TAKE_HEIGHT,
    seed: seedFor(label),
    takes: source.takes,
    modelChoice: input.modelChoice ?? null,
  };
  return assetSpecSchema.parse(spec);
}

/** The take id of one produce job: the same job always names the same take. */

export async function planShotOf(ctx: StageContext): Promise<{ shot: ShotSpec; planArtifactId: string; choices: ShotChoices }> {
  const inputs = await readJobInputs(ctx.sql, { organizationId: ctx.organizationId, requestId: ctx.requestId, inputArtifactIds: ctx.payload.inputArtifactIds });
  const planned = inputs.find((input) => input.envelope.type === "scene_plan");
  if (!planned) throw new EngineError("invalid_input", `${ctx.stage} needs its scene_plan input artifact`, { stage: ctx.stage });
  const plan = scenePlanSchema.safeParse(planned.envelope.body);
  if (!plan.success) throw new EngineError("invalid_input", "the scene plan does not parse", { stage: ctx.stage });
  const shotId = shotIdOf(ctx);
  const shot = plan.data.shots.find((candidate) => candidate.shotId === shotId);
  if (!shot) throw new EngineError("invalid_input", `the scene plan has no shot ${shotId}`, { stage: ctx.stage });
  return { shot, planArtifactId: planned.envelope.artifactId, choices: withReviewerChoice(shotChoicesOf(inputs, shot), shot, ctx.payload.details) };
}

/**
 * The reviewer's model for a generated shot's remake (D11) replaces the orchestrator's choice for that call. It is carried in the job's
 * details, so the take is made by the model the reviewer picked, and the ledger prices it the same way (the reserve priced that pick).
 */
function withReviewerChoice(choices: ShotChoices, shot: ShotSpec, details: Record<string, unknown>): ShotChoices {
  if (details.modelChoice === undefined || details.modelChoice === null) return choices;
  if (shot.source.kind !== "generate") {
    throw new EngineError("invalid_input", `${shot.shotId} is a ${shot.source.kind} shot, which has no model to choose`, { stage: "produce_shot" });
  }
  const parsed = modelChoiceSchema.safeParse(details.modelChoice);
  if (!parsed.success || parsed.data.source !== "reviewer") {
    throw new EngineError("invalid_input", "the reviewer's model choice does not parse", { stage: "produce_shot" });
  }
  return new Map([...choices, [SINGLE_CALL_OUTPUT, parsed.data]]);
}

/** The model choices of one shot's calls, by output name. Empty when the job has no model_choices input. */

/**
 * The request's model choices for this shot (Bible 10.5, contract v8), from the job's model_choices input. A choice whose model class is
 * not the call's (an artifact that does not match this plan) is not used: that call keeps the route table, never another class's model.
 */
function shotChoicesOf(inputs: readonly StoredArtifact[], shot: ShotSpec): ShotChoices {
  const stored = inputs.find((input) => input.envelope.type === "model_choices");
  if (stored === undefined) return new Map();
  const parsed = modelChoicesSchema.safeParse(stored.envelope.body);
  if (!parsed.success) throw new EngineError("invalid_input", "the model choices do not parse", { stage: "produce_shot" });
  const classOf = new Map<string, string>();
  if (shot.source.kind === "generate") classOf.set(SINGLE_CALL_OUTPUT, shot.source.modelClass);
  if (shot.source.kind === "chain") for (const call of shot.source.calls) classOf.set(call.output, call.modelClass);
  const choices = new Map<string, ModelChoice>();
  for (const entry of parsed.data.choices) {
    if (entry.shotId !== shot.shotId || classOf.get(entry.output) !== entry.modelClass) continue;
    choices.set(entry.output, entry.modelChoice);
  }
  return choices;
}

/**
 * The plan shot a produce job makes. A master job's subject is its shot id. A variant's job has its own subject, and names its shot in its
 * details (variants/work.ts), so the shot is found in the variant's plan under its plan id.
 */
function shotIdOf(ctx: StageContext): string {
  const named = ctx.payload.details.shotId;
  return typeof named === "string" && named.length > 0 ? named : ctx.subjectId;
}

export function epochFor(ctx: StageContext): number {
  const epoch = epochOf(ctx.payload);
  if (epoch === undefined) throw new EngineError("invalid_input", "a produce job must name the plan epoch it was queued for", { stage: ctx.stage });
  return epoch;
}

export function attemptFor(ctx: StageContext): number {
  const attempt = Number(ctx.payload.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new EngineError("invalid_input", "a produce job's attempt is a whole number from 1", { stage: ctx.stage });
  return attempt;
}

// --- Chains (contract v5, Bible 7.1). A shot whose source is a chain makes its calls in order. Each call is one generation on the
// request's reservation: its own spec (so its own cache key, the input hash), its own ledger entry (the router writes it on the submit),
// and its own output, which a later call of the same chain reads by name. The last call's video is the shot's take. A chain that ends
// in an image (stop-motion frames) has no take: its closing component draws the frames (Bible 6.6), so the output names the component
// and holds no take. A refused or failed call stops the chain: no later call is made, and the hold names the call.
//
// Records (chain-store.ts, Bible 5.1). Each call is recorded before it is made, with its spec, and its output is recorded when it is
// made. A retry of the produce job reads those records: a made call is read back, and the call that follows is made with the spec it
// was recorded with. So a retry never makes a call twice for one key and never builds a second link for one input.

/** How far a chain has got: the index of its next call, when it started, and the outputs of the calls made. Carried on the poll. */

export function requireReservation(ctx: StageContext): string {
  if (ctx.payload.budgetReservationId === null) {
    throw new EngineError("invalid_input", "produce_shot is a paid stage and has no budget reservation (Bible 14)", { stage: ctx.stage });
  }
  return ctx.payload.budgetReservationId;
}
