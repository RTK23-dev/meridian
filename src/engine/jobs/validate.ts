// Boundary checks for a stage's output (Video Engine Bible 17.2 rule 1: every boundary is validated with zod). A handler's
// output is untrusted until it parses: ids have their prefixes, gates and verdicts match their contracts, and the output
// answers the job that was asked, for the subject that was asked.

import { z } from "zod";
import { EngineError, decisionSchema, gateResultSchema, idSchema, modelClassSchema, takeVerdictSchema, visualTypeSchema } from "../contracts/index.ts";
import type { EnginePayload, ProduceHold, ShotSummary, StageOutput } from "./types.ts";

export const shotSummarySchema = z.object({
  shotId: idSchema("shot_"),
  visualType: visualTypeSchema,
  downgradeTo: visualTypeSchema.nullable(),
  sourceKind: z.enum(["generate", "stock", "component", "asset"]),
  modelClass: modelClassSchema.nullable(),
  takesWanted: z.union([z.literal(1), z.literal(2)]),
});

const artifactsSchema = z.record(z.string().min(1), idSchema("art_"));

/** Why a produce job made no take: a budget hold (paused with the reason) or a refusal (the planner's rewrite hint). */
export const produceHoldSchema: z.ZodType<ProduceHold> = z.union([
  z.object({ kind: z.literal("budget"), reason: z.string().min(1) }),
  z.object({ kind: z.literal("refused"), errorKind: z.enum(["content_policy", "invalid_input"]), hint: z.string().regex(/^[a-z0-9_.:-]{1,64}$/) }),
]);

function refuse(message: string, stage: string): never {
  throw new EngineError("invalid_input", message, { stage });
}

/** Parses one value against a schema, or refuses with the first issue named. */
function parseOrRefuse<T extends z.ZodType>(schema: T, value: unknown, what: string, stage: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuse(`${what} is not valid: ${issue ? `${issue.path.join(".") || "value"} ${issue.message}` : "unknown issue"}`, stage);
  }
  return parsed.data;
}

/** Returns the output if it answers this job. Throws invalid_input otherwise, so a bad result never reaches the graph. */
export function validateStageOutput(output: StageOutput, payload: EnginePayload): StageOutput {
  const stage = payload.stage;
  if (output.stage !== stage) refuse(`the result is for ${output.stage}, but the job is for ${stage}`, stage);
  if (output.subjectId !== payload.subjectId) refuse(`the result is for ${output.subjectId}, but the job is for ${payload.subjectId}`, stage);
  parseOrRefuse(artifactsSchema, output.artifacts, "the artifact map", stage);

  if ("gate" in output) parseOrRefuse(gateResultSchema, output.gate, `the ${output.gate.gate} gate`, stage);
  if (output.stage === "check_take") parseOrRefuse(takeVerdictSchema, output.verdict, "the take verdict", stage);
  if (output.stage === "plan") parseOrRefuse(z.array(shotSummarySchema), output.shots, "the plan's shots", stage);
  if (output.stage === "intake" || output.stage === "estimate_reserve") {
    if (output.budgetReservationId !== null) parseOrRefuse(idSchema("res_"), output.budgetReservationId, "the budget reservation id", stage);
  }
  if (output.stage === "produce_shot") {
    parseOrRefuse(idSchema("shot_"), output.shotId, "the shot id", stage);
    parseOrRefuse(z.int().nonnegative(), output.epoch, "the plan epoch", stage);
    if (output.takeId !== null) parseOrRefuse(idSchema("take_"), output.takeId, "the take id", stage);
    if ((output.takeId === null) !== (output.hold !== undefined)) {
      refuse("a produce result makes a take or holds, and names exactly one of them", stage);
    }
    if (output.hold !== undefined) parseOrRefuse(produceHoldSchema, output.hold, "the produce hold", stage);
    if (output.decisions !== undefined) parseOrRefuse(z.array(decisionSchema), output.decisions, "the produce decisions", stage);
  }
  if (output.stage === "check_take") {
    parseOrRefuse(idSchema("take_"), output.takeId, "the take id", stage);
    parseOrRefuse(idSchema("shot_"), output.shotId, "the shot id", stage);
  }
  if (output.stage === "variants") {
    for (const variant of output.variants) parseOrRefuse(idSchema("edl_"), variant.edlId, "a variant EDL id", stage);
  }
  if ("edlId" in output) parseOrRefuse(idSchema("edl_"), output.edlId, "the EDL id", stage);
  if (output.stage === "deliver") parseOrRefuse(idSchema("vid_"), output.manifestId, "the manifest's video id", stage);
  return output;
}

/** The shot summaries a plan reports, checked. */
export function parseShotSummaries(value: unknown, stage: string): ShotSummary[] {
  return parseOrRefuse(z.array(shotSummarySchema), value, "the shots", stage);
}
