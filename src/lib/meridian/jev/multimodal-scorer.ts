/**
 * JEV Multimodal Scorer
 *
 * Evaluates multimodal creative DNA across short-form video assets:
 * - Correlates initial 3-second visual features (motion intensity, face presence,
 *   typography, contrast, text density) with predicted and historical hook retention.
 * - Scores speech prosody and audio energy (WPM, silence ratio, energy curve).
 * - Mines customer objections and skepticism markers from audience comments.
 * - Evaluates narrative beat pacing across the 6-beat sequence.
 *
 * Pure, deterministic functions. No hallucinated metrics; missing features yield default baselines.
 */

import { clamp01 } from "../domain.ts";
import type { NarrativeBeat } from "./account-engine.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SceneVisualFeatures = {
  /** Motion intensity in the opening 3 seconds (0-1). */
  motionIntensity?: number;
  /** Presence of a human face/presenter gaze in opening 3s (0-1 or boolean 0/1). */
  facePresence?: number;
  /** Text density / on-screen graphic ratio (0-1). Too high causes clutter. */
  textDensity?: number;
  /** Visual contrast ratio (normalized 0-1). */
  contrastRatio?: number;
  /** Typography boldness and readability (0-1). */
  typographyWeight?: number;
  /** Shot cut cadence / average cut length in seconds (e.g. 1.5 - 3.5s). */
  avgCutLengthSec?: number;
};

export type AudioProsodyFeatures = {
  /** Average words per minute in the audio track (typical range 120-220). */
  speechWpm?: number;
  /** Normalized RMS audio energy (0-1). */
  audioEnergy?: number;
  /** Proportion of silence or dead air in opening 5s (0-1). Lower is better. */
  silenceRatio?: number;
  /** Background music tempo in BPM, if present. */
  musicBpm?: number;
};

export type NarrativeBeatScore = {
  beat: NarrativeBeat;
  presenceScore: number;
  durationSec: number;
  qualityScore: number;
  notes: string;
};

export type MultimodalInput = {
  visual: SceneVisualFeatures;
  audio?: AudioProsodyFeatures;
  comments?: string[];
  historicalThreeSecondRetention?: number;
  historicalCompletionRate?: number;
};

export type MultimodalEvaluation = {
  /** Overall creative DNA score [0, 1]. */
  overallDnaScore: number;
  /** Predicted 3-second hook retention [0, 1]. */
  predictedHookRetention: number;
  /** Visual hook strength [0, 1]. */
  hookVisualScore: number;
  /** Audio prosody score [0, 1]. */
  audioProsodyScore: number;
  /** Pacing score [0, 1]. */
  pacingScore: number;
  /** Extracted customer objections from comment signals. */
  detectedObjections: string[];
  /** Detailed component breakdown. */
  breakdown: {
    motionContribution: number;
    faceContribution: number;
    typographyContribution: number;
    textClutterPenalty: number;
    audioEnergyContribution: number;
    speechPacingContribution: number;
  };
};

// ---------------------------------------------------------------------------
// Model Weights & Constants
// ---------------------------------------------------------------------------

/**
 * Seed prior weights for predicting 3s short-form hook retention based on
 * initial visual & audio stimuli heuristics.
 * Origin: seed_prior (heuristic baseline). Not empirically calibrated until
 * fitted against real first-party telemetry outcomes.
 */
export const HOOK_RETENTION_WEIGHTS_VERSION = "v1-seed" as const;
export const HOOK_RETENTION_PARAMETER_STATE = "seed_prior" as const;

export const HOOK_RETENTION_WEIGHTS = {
  version: HOOK_RETENTION_WEIGHTS_VERSION,
  state: HOOK_RETENTION_PARAMETER_STATE,
  bias: -0.40,
  motionIntensity: 1.15,
  facePresence: 0.90,
  typographyWeight: 0.75,
  contrastRatio: 0.60,
  textClutterPenalty: -1.10, // penalty applied when textDensity > 0.65
  audioEnergy: 0.65,
  silencePenalty: -1.30,
};

/**
 * Optimal short-form speech speed range in Words Per Minute.
 * Between 140 and 190 WPM captures attention without overwhelming.
 */
export const OPTIMAL_SPEECH_WPM = {
  min: 130,
  targetMin: 150,
  targetMax: 185,
  max: 220,
};

// Known objection markers mined from social comments
const OBJECTION_PATTERNS: Array<{ regex: RegExp; category: string; label: string }> = [
  { regex: /\b(does it (actually )?work|is this real|real or fake|scam|legit)\b/i, category: "efficacy", label: "Efficacy / Authenticity skepticism" },
  { regex: /\b(expensive|pricey|overpriced|costs? too much|worth the money|waste of money)\b/i, category: "price", label: "Price / Value objection" },
  { regex: /\b(side effects?|allergic|break ?out|irritat|safe for)\b/i, category: "safety", label: "Safety / Side-effect concern" },
  { regex: /\b(how long (to|until|does it take)|results take|see results)\b/i, category: "timeline", label: "Time-to-result uncertainty" },
  { regex: /\b(shipping|delivery|took forever|never arrived|tracking)\b/i, category: "logistics", label: "Shipping / Logistics complaint" },
  { regex: /\b(return( policy)?|refund|money back guarantee)\b/i, category: "risk", label: "Return / Guarantee reassurance" },
  { regex: /\b(smell|taste|texture|greasy|sticky|heavy)\b/i, category: "sensory", label: "Sensory / Usability concern" },
  { regex: /\b(better than|compared to|vs\b|alternative)\b/i, category: "competition", label: "Competitor comparison inquiry" },
];

// ---------------------------------------------------------------------------
// Core Scoring Functions (Pure)
// ---------------------------------------------------------------------------

/**
 * Predicts 3-second hook retention probability from initial visual and audio stimuli.
 * Uses a logistic sigmoid function over empirical seed weights (not calibrated against outcomes).
 */
export function predictHookRetention(
  visual: SceneVisualFeatures,
  audio?: AudioProsodyFeatures,
): { predictedRetention: number; logit: number; contributions: Record<string, number> } {
  const motionContrib = visual.motionIntensity !== undefined ? clamp01(visual.motionIntensity) * HOOK_RETENTION_WEIGHTS.motionIntensity : 0;
  const faceContrib = visual.facePresence !== undefined ? clamp01(visual.facePresence) * HOOK_RETENTION_WEIGHTS.facePresence : 0;
  const typoContrib = visual.typographyWeight !== undefined ? clamp01(visual.typographyWeight) * HOOK_RETENTION_WEIGHTS.typographyWeight : 0;
  const contrastContrib = visual.contrastRatio !== undefined ? clamp01(visual.contrastRatio) * HOOK_RETENTION_WEIGHTS.contrastRatio : 0;
  const textDensity = visual.textDensity !== undefined ? clamp01(visual.textDensity) : 0;

  // Clutter penalty kicks in when text density exceeds 0.5
  const clutterExcess = Math.max(0, textDensity - 0.50) * 2; // scaled 0..1 for density 0.5..1.0
  const clutterPenalty = clutterExcess * HOOK_RETENTION_WEIGHTS.textClutterPenalty;

  let audioEnergyContrib = 0;
  let silencePenalty = 0;

  if (audio) {
    if (audio.audioEnergy !== undefined) {
      const energy = clamp01(audio.audioEnergy);
      audioEnergyContrib = energy * HOOK_RETENTION_WEIGHTS.audioEnergy;
    }
    if (audio.silenceRatio !== undefined) {
      const silence = clamp01(audio.silenceRatio);
      silencePenalty = silence * HOOK_RETENTION_WEIGHTS.silencePenalty;
    }
  }

  const logit =
    HOOK_RETENTION_WEIGHTS.bias +
    motionContrib +
    faceContrib +
    typoContrib +
    contrastContrib +
    clutterPenalty +
    audioEnergyContrib +
    silencePenalty;

  // Logistic sigmoid 1 / (1 + exp(-logit))
  const predictedRetention = clamp01(1 / (1 + Math.exp(-logit)));

  return {
    predictedRetention,
    logit,
    contributions: {
      motion: motionContrib,
      face: faceContrib,
      typography: typoContrib,
      contrast: contrastContrib,
      clutterPenalty,
      audioEnergy: audioEnergyContrib,
      silencePenalty,
    },
  };
}

/**
 * Scores speech pacing and prosody based on Words Per Minute and silence ratio.
 */
export function scoreSpeechProsody(audio?: AudioProsodyFeatures): {
  prosodyScore: number;
  wpmScore: number;
  energyScore: number;
  silencePenalty: number;
} {
  if (!audio) {
    return { prosodyScore: 0.5, wpmScore: 0.5, energyScore: 0.5, silencePenalty: 0 };
  }

  const wpm = audio.speechWpm;
  let wpmScore = 0.5;

  if (wpm === undefined) {
    wpmScore = 0.5;
  } else if (wpm <= 0) {
    wpmScore = 0.2; // music-only or silent
  } else if (wpm >= OPTIMAL_SPEECH_WPM.targetMin && wpm <= OPTIMAL_SPEECH_WPM.targetMax) {
    wpmScore = 1.0; // sweet spot
  } else if (wpm < OPTIMAL_SPEECH_WPM.targetMin) {
    // too slow
    const deficit = OPTIMAL_SPEECH_WPM.targetMin - wpm;
    wpmScore = clamp01(1.0 - (deficit / (OPTIMAL_SPEECH_WPM.targetMin - OPTIMAL_SPEECH_WPM.min || 1)) * 0.7);
  } else {
    // too fast
    const excess = wpm - OPTIMAL_SPEECH_WPM.targetMax;
    wpmScore = clamp01(1.0 - (excess / (OPTIMAL_SPEECH_WPM.max - OPTIMAL_SPEECH_WPM.targetMax || 1)) * 0.7);
  }

  const energyScore = audio.audioEnergy !== undefined ? clamp01(audio.audioEnergy) : 0.5;
  const silence = audio.silenceRatio !== undefined ? clamp01(audio.silenceRatio) : 0;
  const silencePenalty = silence * 0.5;

  const prosodyScore = clamp01(wpmScore * 0.45 + energyScore * 0.45 - silencePenalty + 0.1);

  return { prosodyScore, wpmScore, energyScore, silencePenalty };
}

/**
 * Evaluates video pacing from shot cut cadence.
 * Short-form video requires dynamic pacing (average cut 1.5 - 2.8 seconds).
 */
export function scoreShotPacing(avgCutLengthSec?: number): number {
  if (avgCutLengthSec === undefined || avgCutLengthSec <= 0) return 0.5;
  if (avgCutLengthSec >= 1.2 && avgCutLengthSec <= 2.8) return 1.0;
  if (avgCutLengthSec < 1.2) {
    // Overly chaotic
    return clamp01(0.7 + (avgCutLengthSec / 1.2) * 0.3);
  }
  // Too static / boring (> 4.0s without cut)
  const penalty = Math.min(1.0, (avgCutLengthSec - 2.8) / 3.0);
  return clamp01(1.0 - penalty * 0.8);
}

/**
 * Mines customer objections and doubts from social media comments.
 * Returns distinct objection category labels discovered in the dataset.
 */
export function extractObjectionsFromComments(comments?: string[]): string[] {
  if (!comments || comments.length === 0) return [];

  const found = new Set<string>();
  for (const comment of comments) {
    if (!comment || typeof comment !== "string") continue;
    for (const pattern of OBJECTION_PATTERNS) {
      if (pattern.regex.test(comment)) {
        found.add(pattern.label);
      }
    }
  }

  return Array.from(found).sort();
}

/**
 * Full multimodal creative evaluation combining visual, audio, pacing, and signals.
 */
export function evaluateMultimodalCreative(input: MultimodalInput): MultimodalEvaluation {
  const { visual, audio, comments } = input;

  // 1. Hook Retention Prediction
  const hookResult = predictHookRetention(visual, audio);

  // 2. Audio prosody
  const prosody = scoreSpeechProsody(audio);

  // 3. Pacing
  const pacingScore = scoreShotPacing(visual.avgCutLengthSec);

  // 4. Hook visual score (isolated visual elements)
  const hookVisualScore = clamp01(
    (visual.motionIntensity !== undefined ? clamp01(visual.motionIntensity) * 0.35 : 0) +
    (visual.facePresence !== undefined ? clamp01(visual.facePresence) * 0.30 : 0) +
    (visual.typographyWeight !== undefined ? clamp01(visual.typographyWeight) * 0.20 : 0) +
    (visual.contrastRatio !== undefined ? clamp01(visual.contrastRatio) * 0.15 : 0),
  );

  // 5. Objection mining
  const detectedObjections = extractObjectionsFromComments(comments);

  // 6. Overall Creative DNA Score
  // If historical metrics exist, blend them with model predictions; otherwise use predictions
  let retentionFactor = hookResult.predictedRetention;
  if (input.historicalThreeSecondRetention !== undefined && input.historicalThreeSecondRetention > 0) {
    // 60% empirical measurement, 40% model prediction
    retentionFactor = clamp01(
      input.historicalThreeSecondRetention * 0.6 + hookResult.predictedRetention * 0.4,
    );
  }

  let completionFactor = 0.5;
  if (input.historicalCompletionRate !== undefined && input.historicalCompletionRate > 0) {
    completionFactor = clamp01(input.historicalCompletionRate);
  }

  const overallDnaScore = clamp01(
    retentionFactor * 0.40 +
    prosody.prosodyScore * 0.25 +
    pacingScore * 0.20 +
    completionFactor * 0.15,
  );

  return {
    overallDnaScore,
    predictedHookRetention: hookResult.predictedRetention,
    hookVisualScore,
    audioProsodyScore: prosody.prosodyScore,
    pacingScore,
    detectedObjections,
    breakdown: {
      motionContribution: hookResult.contributions.motion ?? 0,
      faceContribution: hookResult.contributions.face ?? 0,
      typographyContribution: hookResult.contributions.typography ?? 0,
      textClutterPenalty: hookResult.contributions.clutterPenalty ?? 0,
      audioEnergyContribution: hookResult.contributions.audioEnergy ?? 0,
      speechPacingContribution: prosody.wpmScore,
    },
  };
}
