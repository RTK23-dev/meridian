// Similarity checks of check_take (Bible 6.7 step 2, 12.2): the product against its hero image, the presenter's face against
// the persona, and the take's palette against the style kit. The scorer is an interface. No embedding vendor is chosen
// (Bible 20.2), and local models are forbidden (CLAUDE.md), so the default scorer answers not_connected. A check whose
// scorer is not connected is missing evidence: it routes to review and never passes.

import { thresholds } from "../../config/thresholds.ts";
import { EngineError } from "../../contracts/errors.ts";
import { check, notEvaluated } from "../gates/common.ts";
import type { SimilarityKind, SimilarityOutcome, TakeRow, TakeShot } from "./types.ts";

/** What the scorer is asked, by kind. The frames are the take's frames as data URLs (the same frames the Critic sees). */
export type SimilarityRequest =
  | { kind: "product_vs_hero"; takeId: string; frames: readonly string[]; heroUris: readonly string[] }
  | { kind: "face_vs_persona"; takeId: string; frames: readonly string[]; portraitUris: readonly string[] }
  | { kind: "palette_vs_style_kit"; takeId: string; frames: readonly string[]; paletteHex: readonly string[] };

/**
 * A similarity scorer. A call returns a score in 0 to 1 (for palette, the share of pixels inside the palette), or
 * not_connected with the reason. A call that fails throws an EngineError: the stage retries it, and nothing is scored.
 */
export interface SimilarityScorer {
  /** Names the scorer in logs and in the check detail, for example "similarity:not_connected". */
  readonly id: string;
  score(request: SimilarityRequest): Promise<SimilarityOutcome>;
}

export const NOT_CONNECTED_REASON =
  "no embedding or palette service is connected: the vendor is an open owner decision (Bible 20.2)";

/** The default scorer until a vendor is chosen and routed. It never scores. */
export function notConnectedScorer(reason: string = NOT_CONNECTED_REASON): SimilarityScorer {
  return {
    id: "similarity:not_connected",
    async score(): Promise<SimilarityOutcome> {
      return { status: "not_connected", reason };
    },
  };
}

/** The kinds this shot must be checked for: product and persona when the shot shows them, and the palette always. */
export function requiredSimilarityKinds(shot: TakeShot): SimilarityKind[] {
  const kinds: SimilarityKind[] = [];
  if (shot.product !== null) kinds.push("product_vs_hero");
  if (shot.persona !== null) kinds.push("face_vs_persona");
  kinds.push("palette_vs_style_kit");
  return kinds;
}

const RULES: Record<SimilarityKind, { rule: string; gold: "take:product_match" | "take:persona_match" | "take:palette_match" }> = {
  product_vs_hero: { rule: "product_match", gold: "take:product_match" },
  face_vs_persona: { rule: "persona_match", gold: "take:persona_match" },
  palette_vs_style_kit: { rule: "palette_match", gold: "take:palette_match" },
};

function limitOf(kind: SimilarityKind): number {
  if (kind === "product_vs_hero") return thresholds.take.productMatchMin.value;
  if (kind === "face_vs_persona") return thresholds.take.personaMatchMin.value;
  return thresholds.take.paletteShareMin.value;
}

function unevaluated(reason: string): SimilarityOutcome {
  return { status: "not_evaluated", reason };
}

/**
 * Runs every similarity check the shot needs. A kind whose input is missing (no frames, no hero image, no portrait, no
 * palette) is not_evaluated and the scorer is not called. A scored answer must be a finite number from 0 to 1, or the call
 * throws: a scorer that answers out of range has failed.
 */
export async function scoreSimilarity(
  scorer: SimilarityScorer,
  input: { takeId: string; frames: readonly string[] | null; shot: TakeShot; paletteHex: readonly string[] },
): Promise<Partial<Record<SimilarityKind, SimilarityOutcome>>> {
  const results: Partial<Record<SimilarityKind, SimilarityOutcome>> = {};
  for (const kind of requiredSimilarityKinds(input.shot)) {
    if (input.frames === null || input.frames.length === 0) {
      results[kind] = unevaluated("the take has no valid frames to compare");
      continue;
    }
    const request = requestFor(kind, input);
    if (request === null) {
      results[kind] = unevaluated(missingInputReason(kind));
      continue;
    }
    const outcome = await scorer.score(request);
    if (outcome.status === "scored" && !(Number.isFinite(outcome.score) && outcome.score >= 0 && outcome.score <= 1)) {
      throw new EngineError("provider", `scorer ${scorer.id} returned a ${kind} score outside 0 to 1`, { stage: "check_take" });
    }
    results[kind] = outcome;
  }
  return results;
}

function requestFor(
  kind: SimilarityKind,
  input: { takeId: string; frames: readonly string[] | null; shot: TakeShot; paletteHex: readonly string[] },
): SimilarityRequest | null {
  const frames = input.frames ?? [];
  if (kind === "product_vs_hero") {
    const heroUris = input.shot.product?.heroUris ?? [];
    return heroUris.length === 0 ? null : { kind, takeId: input.takeId, frames, heroUris };
  }
  if (kind === "face_vs_persona") {
    const portraitUris = input.shot.persona?.portraitUris ?? [];
    return portraitUris.length === 0 ? null : { kind, takeId: input.takeId, frames, portraitUris };
  }
  return input.paletteHex.length === 0 ? null : { kind, takeId: input.takeId, frames, paletteHex: input.paletteHex };
}

function missingInputReason(kind: SimilarityKind): string {
  if (kind === "product_vs_hero") return "the shot shows a product but has no hero image to compare";
  if (kind === "face_vs_persona") return "the shot shows a persona but has no portrait to compare";
  return "the style kit has no palette to compare";
}

/**
 * The rows of the similarity checks the shot needs. Only a scored result is measured. Any other outcome, or no outcome at
 * all for a required kind, is missing evidence.
 */
export function similarityRows(shot: TakeShot, outcomes: Partial<Record<SimilarityKind, SimilarityOutcome>>): TakeRow[] {
  return requiredSimilarityKinds(shot).map((kind): TakeRow => {
    const { rule, gold } = RULES[kind];
    const outcome = outcomes[kind];
    if (outcome === undefined) {
      return { check: notEvaluated(rule, "no similarity result was recorded for this check"), evidence: "missing", gold };
    }
    if (outcome.status === "not_connected") {
      return { check: notEvaluated(rule, `the scorer is not connected: ${outcome.reason}`), evidence: "missing", gold };
    }
    if (outcome.status === "not_evaluated") {
      return { check: notEvaluated(rule, outcome.reason), evidence: "missing", gold };
    }
    if (!(Number.isFinite(outcome.score) && outcome.score >= 0 && outcome.score <= 1)) {
      return { check: notEvaluated(rule, "the recorded score is not a number from 0 to 1"), evidence: "missing", gold };
    }
    const limit = limitOf(kind);
    return {
      check: check(rule, outcome.score >= limit, {
        value: outcome.score,
        limit,
        detail: `scored by ${outcome.scorer}`,
      }),
      evidence: "measured",
      gold,
    };
  });
}
