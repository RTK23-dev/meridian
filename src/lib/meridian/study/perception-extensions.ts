/**
 * Perception Extensions for Short-Form Organic Video Teardown
 * 
 * Extends base Creative DNA with short-form specific perception:
 * 1. Instagram Safe Zone Compliance: Detects if text overlays/stickers
 *    collide with Instagram's header, right action rail, or bottom caption/audio pill.
 * 2. Cut Velocity & Pacing: Computes scene cut frequency per second.
 * 3. Audio & Speech Dynamics: Analyzes speech rate (WPM) and pause timing.
 */

export interface CutPacingAnalysis {
  totalDurationMs: number;
  cutCount: number;
  averageShotDurationSec: number;
  cutsPerTenSeconds: number;
  pacingCategory: "hyper_fast" | "creator_standard" | "cinematic_slow";
}

/**
 * Analyzes video scene cuts to determine editing pace.
 */
export function analyzeCutPacing(
  sceneCutTimestampsSec: number[],
  durationSec: number
): CutPacingAnalysis {
  const safeDuration = Math.max(1, durationSec);
  const cutCount = sceneCutTimestampsSec.length;
  const shots = cutCount + 1;
  const avgShotDuration = safeDuration / shots;
  const cutsPer10s = (cutCount / safeDuration) * 10;

  let pacingCategory: CutPacingAnalysis["pacingCategory"] = "creator_standard";
  if (avgShotDuration <= 1.5 || cutsPer10s >= 6) {
    pacingCategory = "hyper_fast";
  } else if (avgShotDuration >= 4.0 || cutsPer10s <= 2) {
    pacingCategory = "cinematic_slow";
  }

  return {
    totalDurationMs: Math.round(safeDuration * 1000),
    cutCount,
    averageShotDurationSec: Number(avgShotDuration.toFixed(2)),
    cutsPerTenSeconds: Number(cutsPer10s.toFixed(1)),
    pacingCategory,
  };
}

export interface SpeechProsodyAnalysis {
  wordCount: number;
  durationSec: number;
  wordsPerMinute: number;
  isWithinSweetSpot: boolean; // 140 - 180 WPM
  silenceGapsCount: number;
}

/**
 * Analyzes speech prosody and tempo from transcript word timestamps.
 */
export function analyzeSpeechProsody(
  words: Array<{ word: string; startSec: number; endSec: number }>,
  totalDurationSec: number
): SpeechProsodyAnalysis {
  if (words.length === 0) {
    return {
      wordCount: 0,
      durationSec: totalDurationSec,
      wordsPerMinute: 0,
      isWithinSweetSpot: false,
      silenceGapsCount: 0,
    };
  }

  const wordCount = words.length;
  const speechTimeMinutes = Math.max(0.01, totalDurationSec / 60);
  const wpm = Math.round(wordCount / speechTimeMinutes);

  // Check for dead air / silence gaps (> 1.2s between words)
  let silenceGapsCount = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].startSec - words[i - 1].endSec;
    if (gap >= 1.2) {
      silenceGapsCount++;
    }
  }

  return {
    wordCount,
    durationSec: totalDurationSec,
    wordsPerMinute: wpm,
    isWithinSweetSpot: wpm >= 140 && wpm <= 180,
    silenceGapsCount,
  };
}
