/**
 * Short-Form Slop & Craft Quality Gates
 * 
 * Enforces the creator quality bar:
 * 1. AI Slop Gate: Blocks morphing faces, garbled video text, plastic skin, and monotone TTS
 * 2. Craft Gate: Checks safe zone bounds, first-frame visual interrupt, and loudness (-14 LUFS)
 */

import { validateReelsSafeZones, type SafeZoneBox } from "../study/perception-extensions.ts";

export interface ShotQualityMetrics {
  shotIndex: number;
  sourceRank: number;
  hasFaceMorphingArtifacts: boolean;
  hasGarbledVideoText: boolean;
  temporalFlickerScore: number; // 0.0 to 1.0 (higher = worse flicker)
  hasPlasticSkinBlur: boolean;
}

export interface CompositionCraftMetrics {
  firstFrameHasVisualInterest: boolean;
  measuredLufs: number; // target: -14 LUFS +/- 1.5
  textOverlays: Array<{ text: string; box: SafeZoneBox }>;
  voiceIsMonotoneRobot: boolean;
}

export interface QualityGateEvaluationResult {
  passed: boolean;
  failedGates: string[];
  remediationSuggestions: string[];
}

export class SlopAndCraftGateEvaluator {
  /**
   * Evaluates video composition against Slop and Craft quality gates.
   */
  static evaluate(
    shots: ShotQualityMetrics[],
    craft: CompositionCraftMetrics
  ): QualityGateEvaluationResult {
    const failedGates: string[] = [];
    const suggestions: string[] = [];

    // 1. Slop Gate: Check shots for generative artifacts
    for (const shot of shots) {
      if (shot.hasFaceMorphingArtifacts) {
        failedGates.push(`SLOP_GATE_FAIL: Shot ${shot.shotIndex} exhibits facial morphing/distortion`);
        suggestions.push(`Replace shot ${shot.shotIndex} with real UGC footage (Rank 1) or regenerate candidate.`);
      }
      if (shot.hasGarbledVideoText) {
        failedGates.push(`SLOP_GATE_FAIL: Shot ${shot.shotIndex} contains garbled AI text artifacts`);
        suggestions.push(`Remove generative text and use clean rendered motion typography overlay (Rank 5).`);
      }
      if (shot.temporalFlickerScore > 0.6) {
        failedGates.push(`SLOP_GATE_FAIL: Shot ${shot.shotIndex} has excessive temporal flicker (${shot.temporalFlickerScore})`);
        suggestions.push(`Apply temporal smoothing filter or swap clip.`);
      }
    }

    // 2. Craft Gate: Safe zone text validation
    const safeZoneCheck = validateReelsSafeZones(craft.textOverlays);
    if (!safeZoneCheck.isSafe) {
      for (const violation of safeZoneCheck.violations) {
        failedGates.push(`CRAFT_GATE_FAIL: Text "${violation.text}" clips Instagram ${violation.zone}`);
        suggestions.push(`Reposition "${violation.text}" into central safe zone.`);
      }
    }

    // 3. Craft Gate: First frame visual interrupt test
    if (!craft.firstFrameHasVisualInterest) {
      failedGates.push("CRAFT_GATE_FAIL: First frame lacks visual pattern interrupt");
      suggestions.push("Add punch-in zoom, vibrant color pop, or motion in opening 0.3 seconds.");
    }

    // 4. Craft Gate: Loudness check (-14 LUFS +/- 1.5)
    if (craft.measuredLufs < -16.0 || craft.measuredLufs > -12.0) {
      failedGates.push(`CRAFT_GATE_FAIL: Loudness ${craft.measuredLufs} LUFS outside -14 +/- 1.5 target`);
      suggestions.push("Re-normalize master audio track to -14.0 LUFS.");
    }

    // 5. Craft Gate: Voice naturalness
    if (craft.voiceIsMonotoneRobot) {
      failedGates.push("CRAFT_GATE_FAIL: Voiceover is detected as flat, monotone robot TTS");
      suggestions.push("Use recorded creator VO or apply expressive prosody breaks with VoiceDirector.");
    }

    return {
      passed: failedGates.length === 0,
      failedGates,
      remediationSuggestions: suggestions,
    };
  }
}
