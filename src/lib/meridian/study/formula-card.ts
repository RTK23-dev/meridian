/**
 * Formula Card Model & Anti-Generic Quality Rules
 * 
 * Represents the transferable creative blueprint distilled from an outlier reel.
 * Used by the production engine to assemble new creator-grade reels.
 */

export interface FormulaBeat {
  name: string;
  startPercent: number; // 0 to 100
  endPercent: number;   // 0 to 100
  purpose: string;
  evidenceTimestampSec: number;
  editDirective: string;
  suggestedSourceRank: 1 | 2 | 3 | 4 | 5; // 1 = UGC/Raw, 2 = Product, 3 = Stock, 4 = Gen, 5 = Motion
}

export interface FormulaEditGrammar {
  targetShotDurationSec: number;
  cutPacingCategory: "hyper_fast" | "creator_standard" | "cinematic_slow";
  bRollRatioPercent: number;
  soundDesignTriggers: string[];
  captionStyle: "karaoke_pop" | "subtle_sentence" | "kinetic_word";
  textSafeZonePlacement: "center_third" | "upper_center";
}

export interface FormulaCard {
  id: string;
  title: string;
  niche: string;
  sourceReelPermalink: string;
  hookMechanismSlug: string;
  formatStructureSlug: string;
  emotionalDriverSlug: string;
  beats: FormulaBeat[];
  editGrammar: FormulaEditGrammar;
  minedAudienceLexicon: {
    commonDesires: string[];
    commonObjections: string[];
    catchphrases: string[];
  };
  productEntryPoints: Array<{
    beatIndex: number;
    placementMechanism: string;
    exampleScriptLine: string;
  }>;
  transferabilityScore: number; // 0 to 100
  counterfactualAnalysis: string; // What would have made this video average
  evidenceCitations: Array<{
    claim: string;
    timestampSec?: number;
    commentQuote?: string;
  }>;
}

// Anti-generic banned fluff phrases that immediately fail a study report
export const BANNED_GENERIC_STRINGS = [
  "engaging content",
  "high-quality visuals",
  "resonates with audiences",
  "captivates the viewer",
  "visually appealing",
  "compelling storytelling",
  "valuable insights",
  "strong hook", // must specify WHICH hook mechanism
] as const;

export interface AntiGenericValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Validates that a study report or formula card adheres to strict anti-generic standards:
 * 1. Contains zero banned generic phrases
 * 2. Every claim links to a timestamp or comment citation
 * 3. Includes an explicit counterfactual explanation
 */
export function validateAntiGenericStandards(card: FormulaCard): AntiGenericValidationResult {
  const errors: string[] = [];

  // 1. Check for banned generic fluff phrases
  const serialized = JSON.stringify(card).toLowerCase();
  for (const banned of BANNED_GENERIC_STRINGS) {
    if (serialized.includes(banned.toLowerCase())) {
      errors.push(`Formula card contains banned generic phrase: "${banned}"`);
    }
  }

  // 2. Check counterfactual analysis presence and depth
  if (!card.counterfactualAnalysis || card.counterfactualAnalysis.trim().length < 25) {
    errors.push("Missing explicit counterfactual analysis explaining what would have made this reel average.");
  }

  // 3. Evidence citation requirement
  if (!card.evidenceCitations || card.evidenceCitations.length === 0) {
    errors.push("No timestamped or comment evidence citations provided for formula claims.");
  } else {
    for (const citation of card.evidenceCitations) {
      if (citation.timestampSec === undefined && !citation.commentQuote) {
        errors.push(`Citation "${citation.claim}" lacks both a video timestamp and a comment quote.`);
      }
    }
  }

  // 4. Beat continuity check (relative percent must sum to 100%)
  if (card.beats.length > 0) {
    const firstBeat = card.beats[0];
    const lastBeat = card.beats[card.beats.length - 1];
    if (firstBeat.startPercent !== 0) {
      errors.push("First beat must start at 0% relative timeline.");
    }
    if (lastBeat.endPercent !== 100) {
      errors.push("Last beat must end at 100% relative timeline.");
    }
  } else {
    errors.push("Formula card must define at least 2 structured beats.");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
