// A reviewer's change to one shot (review inbox actions edit_prompt and change_visual_type, Bible 12.5). Pure: the decision is data, parsed
// and checked here before the engine sees it. The change is a replacement of the shot's spec (D7), so only what the produce path makes is
// offered: a cinematic shot from a prompt, and stock footage from a search query. Any other visual type is refused, never guessed.

import { z } from "zod";
import type { ShotSpec } from "../contracts/plan.ts";

/** The longest prompt or query a reviewer can write for a shot. A longer one is refused, not cut (fail closed). */
export const SHOT_DECISION_TEXT_MAX = 1000;
export const SHOT_DECISION_QUERY_MAX = 200;

/** The visual types a reviewer can change a shot to. Each one is a source the produce path makes. */
export const CHANGEABLE_VISUAL_TYPES = ["cinematic", "stock_footage"] as const;

const promptSchema = z.string().trim().min(1).max(SHOT_DECISION_TEXT_MAX);
const querySchema = z.string().trim().min(1).max(SHOT_DECISION_QUERY_MAX);

export const shotDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit_prompt"), prompt: promptSchema }).strict(),
  z
    .object({
      action: z.literal("change_visual_type"),
      visualType: z.enum(CHANGEABLE_VISUAL_TYPES),
      prompt: promptSchema.optional(),
      query: querySchema.optional(),
    })
    .strict(),
]);
export type ShotDecision = z.infer<typeof shotDecisionSchema>;

/** A replacement of the shot's visual type and source (the remake's D7 input). */
export type ShotChange = { visualType: ShotSpec["visualType"]; source: ShotSpec["source"] };

export type ShotChangeOutcome = { ok: true; change: ShotChange } | { ok: false; reason: string };

/** The replacement a decision makes of a shot, or the reason it cannot be made. Pure. */
export function shotChangeFor(shot: ShotSpec, decision: ShotDecision): ShotChangeOutcome {
  if (decision.action === "edit_prompt") {
    if (shot.source.kind !== "generate") return { ok: false, reason: "only a generated shot has a prompt to edit" };
    return { ok: true, change: { visualType: shot.visualType, source: { ...shot.source, prompt: decision.prompt } } };
  }
  if (decision.visualType === "stock_footage") {
    if (decision.query === undefined) return { ok: false, reason: "write the search query for the stock footage" };
    const minMs = shot.endMs - shot.startMs;
    return { ok: true, change: { visualType: "stock_footage", source: { kind: "stock", query: decision.query, minMs } } };
  }
  const prompt = decision.prompt ?? (shot.source.kind === "generate" ? shot.source.prompt : undefined);
  if (prompt === undefined) return { ok: false, reason: "write the prompt for the cinematic shot" };
  return { ok: true, change: { visualType: "cinematic", source: { kind: "generate", modelClass: "video.cinematic", prompt, refs: [], takes: 2 } } };
}
