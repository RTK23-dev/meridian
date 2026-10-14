// Shared types of the take gate (Bible 6.7 and 12.2): the shot a take was made for, the frames, the similarity kinds, the
// gold-set keys, and the row every check becomes. Pure data; no function here reads a store or the network.

import { z } from "zod";
import { thresholds } from "../../config/thresholds.ts";
import type { GateCheck } from "../../contracts/gate.ts";
import { idSchema } from "../../contracts/ids.ts";
import { visualTypeSchema } from "../../contracts/plan.ts";
import { positiveMsSchema } from "../../contracts/primitives.ts";
import { takeFrameSchema } from "../../claude/roles/critic_take.ts";
import type { GoldMetrics } from "../gold.ts";

/** The shot a take was made for, from the plan. motionRequired is the planner's call; the gate does not guess it. */
export const takeShotSchema = z.object({
  shotId: idSchema("shot_"),
  visualType: visualTypeSchema,
  plannedDurationMs: positiveMsSchema,
  motionRequired: z.boolean(),
  /** Hero image URIs of the product the shot shows. Null when the shot shows no product, so no product check applies. */
  product: z.object({ heroUris: z.array(z.string().min(1)) }).nullable(),
  /** Portrait URIs of the persona on screen. Null when no persona is on screen, so no persona check applies. */
  persona: z.object({ portraitUris: z.array(z.string().min(1)) }).nullable(),
});
export type TakeShot = z.infer<typeof takeShotSchema>;

/** The take's frames for the Critic and the similarity scorer: exactly the rubric frame count (Bible 6.7). */
export const takeFramesSchema = z.array(takeFrameSchema).length(thresholds.take.rubricFrames);

/** The three similarity checks of Bible 6.7 step 2. */
export const SIMILARITY_KINDS = ["product_vs_hero", "face_vs_persona", "palette_vs_style_kit"] as const;
export type SimilarityKind = (typeof SIMILARITY_KINDS)[number];

/**
 * The gold sets a take check can block on (Bible 12.4). One per code check with a learned threshold, one per similarity
 * check, and one for the slop rubric (every rubric item shares the Critic's gold set).
 */
export const TAKE_GOLD_KEYS = [
  "take:duration_within_tolerance",
  "take:no_black_or_frozen_frames",
  "take:flicker_below_max",
  "take:motion_present",
  "take:product_match",
  "take:persona_match",
  "take:palette_match",
  "take:slop_rubric",
] as const;
export type TakeGoldKey = (typeof TAKE_GOLD_KEYS)[number];

export function isTakeGoldKey(value: string): value is TakeGoldKey {
  return (TAKE_GOLD_KEYS as readonly string[]).includes(value);
}

/** Gold metrics by gold-set key, as the gate reads them. A missing key means no gold set: the check cannot block. */
export type TakeGoldMetrics = Partial<Record<TakeGoldKey, GoldMetrics | undefined>>;

/** A similarity result for one kind. Only "scored" carries a number; the others are missing evidence (Bible 12). */
export type SimilarityOutcome =
  | { status: "scored"; score: number; scorer: string }
  | { status: "not_connected"; reason: string }
  | { status: "not_evaluated"; reason: string };

/**
 * One check and where its evidence came from. "missing" means the check could not be evaluated (a null measurement, a
 * scorer that is not connected, a Critic that gave no answer): it fails and routes to review, and it never blocks. "measured"
 * means the check ran. A measured failure blocks only when its gold set meets the target; a null gold means the check is an
 * escalation (the Critic is unsure) and never blocks.
 */
export type TakeRow = {
  check: GateCheck;
  evidence: "measured" | "missing";
  gold: TakeGoldKey | null;
};
