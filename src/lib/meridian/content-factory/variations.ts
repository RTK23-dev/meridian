// Video variations: one reusable source draft (a reference video, Market research and a plain instruction) becomes N original draft videos
// in one bounded batch. This file holds the pure rules: the fixed angles, the exact split of the batch budget in cents, and what a source
// draft must have. The service writes; nothing here starts a video or calls a provider.

import { MASTER_COST_FLOOR_USD } from "../factory/run-settings.ts";
import { MAX_BATCH_ITEMS } from "./batch.ts";

export const MIN_VARIATIONS = 2;
export const DEFAULT_VARIATIONS = 3;
export const MAX_VARIATIONS = MAX_BATCH_ITEMS;
/** The most one video may be given, in cents. */
export const MAX_ITEM_CENTS = 100_000;
/** The most a whole batch may be given, in cents. The batch service holds the same limit in dollars. */
export const MAX_BATCH_CENTS = 100_000 * 100;
/** The fewest characters a plain instruction needs to count as one. */
export const MIN_INSTRUCTION_CHARS = 10;

const RULES =
  "Use the reference video only for transferable structure and pacing. Write new wording and make new visuals. Never copy its footage, words, voice or music. " +
  "Ground every claim in the attached brand and Market evidence, and leave out any claim that evidence does not support.";

export type VariationAngle = { id: string; label: string; focus: string };

/** Twenty fixed, distinct structural angles. A variation is given one, in order, so the same count always gives the same set. */
export const VARIATION_ANGLES: readonly VariationAngle[] = [
  { id: "problem_first", label: "Problem first", focus: "Open on the problem the viewer already has, then show the way out." },
  { id: "result_first", label: "Result first", focus: "Open on the finished result, then show how it came about." },
  { id: "myth_bust", label: "Myth bust", focus: "Name a common belief in the first seconds, then correct it with evidence." },
  { id: "before_after", label: "Before and after", focus: "Build the video on a clear contrast between the starting state and the end state." },
  { id: "one_minute_how_to", label: "Quick how-to", focus: "Teach one step-by-step task in a tight sequence of short beats." },
  { id: "customer_voice", label: "Customer voice", focus: "Frame the video around a need a real customer type has, in plain words." },
  { id: "proof_stack", label: "Proof stack", focus: "Lead with the strongest supported fact, then add each further piece of proof." },
  { id: "comparison", label: "Fair comparison", focus: "Set two approaches side by side and judge them on supported points only." },
  { id: "question_hook", label: "Question hook", focus: "Open on one sharp question the viewer wants answered, and answer it by the end." },
  { id: "fast_list", label: "Fast list", focus: "Move through a numbered list at a quick pace, one idea per beat." },
  { id: "story_beat", label: "Small story", focus: "Tell a short story with a clear turn, using only events the evidence supports." },
  { id: "objection_handle", label: "Objection handled", focus: "Raise the most common hesitation, then answer it directly." },
  { id: "behind_the_scenes", label: "Behind the scenes", focus: "Show how the product or service is made or done, using supported detail." },
  { id: "day_in_use", label: "A day in use", focus: "Follow the product through one ordinary use from start to finish." },
  { id: "mistake_to_avoid", label: "Mistake to avoid", focus: "Point out one common mistake, then show the better way." },
  { id: "checklist", label: "Checklist", focus: "Give a short checklist the viewer can follow, ending on the one that matters most." },
  { id: "pattern_interrupt", label: "Pattern interrupt", focus: "Break the viewer's expectation in the first second, then deliver a clear point." },
  { id: "slow_reveal", label: "Slow reveal", focus: "Hold back the key detail until late, with a steady build to it." },
  { id: "direct_offer", label: "Direct offer", focus: "State the offer plainly and early, then give the reasons it is worth taking." },
  { id: "quiet_demo", label: "Quiet demo", focus: "Show the product working with few words and clear visuals." },
] as const;

/** The instruction one variation is given on top of the source draft's own. Fixed text, so it never carries anything from the reference. */
export function angleInstruction(angle: VariationAngle): string {
  return `Variation angle: ${angle.label}. ${angle.focus} ${RULES}`;
}

export type Cents = number;

/** The batch budget in whole cents, or null when it is not a positive amount of at most two decimals. */
export function centsOf(usd: number): Cents | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const cents = Math.round(usd * 100);
  if (Math.abs(usd * 100 - cents) > 1e-6) return null;
  return cents;
}

/** The fewest cents one video may be given: the master cost floor, rounded up. */
export function minItemCents(): Cents {
  return Math.ceil(MASTER_COST_FLOOR_USD * 100 - 1e-9);
}

export type BudgetSplit = { ok: true; cents: Cents[] } | { ok: false; reason: string };

/**
 * Splits the total across the videos in whole cents, exactly: the parts add up to the total, and no two differ by more than one cent. Each
 * part must reach the master cost floor and stay within the per-video limit, or nothing is split.
 */
export function splitBudget(totalUsd: number, count: number): BudgetSplit {
  if (!Number.isInteger(count) || count < MIN_VARIATIONS || count > MAX_VARIATIONS) {
    return { ok: false, reason: `Choose between ${MIN_VARIATIONS} and ${MAX_VARIATIONS} variations.` };
  }
  const total = centsOf(totalUsd);
  if (total === null) return { ok: false, reason: "The batch budget must be a positive amount in dollars, with at most two decimals." };
  if (total > MAX_BATCH_CENTS) return { ok: false, reason: "The batch budget is above the most a batch may be given." };
  const base = Math.floor(total / count);
  const extra = total - base * count;
  const floor = minItemCents();
  if (base < floor) {
    const needed = ((floor * count) / 100).toFixed(2);
    return { ok: false, reason: `The budget cannot cover ${count} videos. Each needs at least $${(floor / 100).toFixed(2)}, so ${count} need at least $${needed} in all.` };
  }
  const cents = Array.from({ length: count }, (_, index) => base + (index < extra ? 1 : 0));
  if (Math.max(...cents) > MAX_ITEM_CENTS) {
    return { ok: false, reason: `Each video may be given at most $${(MAX_ITEM_CENTS / 100).toLocaleString("en-US")}. Lower the budget or make more variations.` };
  }
  return { ok: true, cents };
}

export type SourceFacts = {
  status: string;
  brandId: string | null;
  hasReferenceVideo: boolean;
  marketAttachments: number;
  /** Messages with no beat role, as plain text. */
  instructions: string[];
  /** Messages that are hand-written script lines. A copy would repeat them word for word in every variation. */
  scriptLines: number;
};

/** Why a draft cannot be a source, in plain words, or null when it can. The first problem found. */
export function sourceProblem(facts: SourceFacts): string | null {
  if (facts.status !== "draft") return "Only a draft can be used as the source. A video that has started is already in production.";
  if (facts.brandId === null) return "The source draft has no brand, so variations cannot be made from it.";
  if (!facts.hasReferenceVideo) return "The source draft has no uploaded reference video. Upload the video file first. A link to a post is not a video file.";
  if (facts.marketAttachments < 1) return "The source draft has no Market research attached. Attach at least one Market record so the claims have evidence.";
  if (facts.scriptLines > 0) return "The source draft has hand-written script lines, and every variation would repeat them word for word. Remove the script lines and keep plain instructions.";
  if (!facts.instructions.some((text) => text.trim().length >= MIN_INSTRUCTION_CHARS)) {
    return `The source draft has no plain-language instruction. Write at least one, of ${MIN_INSTRUCTION_CHARS} characters or more.`;
  }
  return null;
}
