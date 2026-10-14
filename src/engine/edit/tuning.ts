// Editor tuning for Bible 8.2 (initial values). Section 8.3 limits and the loudness and safe-zone numbers already live in
// config/thresholds.ts (thresholds.edit, thresholds.postRender), and the editor reads them from there. The numbers below are
// the 8.2 steps' own constants, which no config file holds yet. They are named here, never written inline in the logic, and
// edit/STATUS.md asks the lead to move them into config/ (a file this workstream does not own).

export const EDIT_TUNING = {
  version: "edit-tuning@1",

  // 8.2 step 3: a cut moves to a word gap of at least gapMinMs within windowMs. With music, to a beat within beatWindowMs.
  cutSnap: { gapMinMs: 80, windowMs: 250, beatWindowMs: 120 },

  // 8.2 step 4: a shot longer than longShare x its target is split; shorter than shortShare x its target merges with a neighbour
  // of the same type. Both are checked against the 8.3 limits as well (thresholds.edit).
  fit: { shortShare: 0.5, longShare: 1.5 },

  // 8.2 step 5: the first cut lands at hookFirstCutMs scaled to our duration; the hook caption is on screen by captionByMs and
  // motion starts by motionWithinMs.
  hook: { captionByMs: 500, motionWithinMs: 300 },

  // 8.2 steps 6 and 10: an optional punch-in is skipped within this distance of another effect.
  effectClashMs: 300,

  // 8.2 step 12: the loop cross-fade covers the last loopMs of the timeline.
  loopMs: 500,

  // 8.2 steps 10 and 13: punch-in scale. The base amplitude is the grammar's punchInScale (at least minScale) scaled by the kit's
  // motionIntensity: (intensity + 1) / intensityDivisor, so intensity 0 keeps a small move and intensity 3 the full one.
  // The seeded jitter is within +/- jitterShare of the base. The result is held inside [minScale, maxScale].
  punch: { minScale: 1.02, floorScale: 1.01, maxScale: 1.5, jitterShare: 0.1, intensityDivisor: 4 },

  // 8.2 step 11: music sits under speech at baseGainDb and is ducked by duckDb while speech plays.
  music: { baseGainDb: -12, duckDb: -18 },

  // 8.2 step 9 and the compiler's limits (compose/components/captions.karaoke/props.ts): captions per clip and words per caption.
  captions: { maxPerClip: 60, maxWordsPerCaption: 8, breakPattern: /[.!?;:,]$/ },

  // Audio gain the compiler plays (HyperFrames caps data-volume at +12 dB, compose/compiler.ts MAX_VOLUME).
  maxDrawableGainDb: 12,

  // The gain is set from the measured loudness of the voice, so the result lands on the target to within rounding.
  loudnessRoundingLufs: 0.05,

  // Transitions and effects the compiler draws (compose/compiler.ts). speed_ramp and zoom transitions are refused there.
  drawableTransitions: ["hard", "fade", "whip"],
  drawableEffects: ["punch_in", "shake", "flash"],

  // Caption layout. These mirror compose/components/captions.karaoke/component.html (the band tops, left, width and the box
  // height of one 104 px line). edit/geometry.test.ts reads that template and fails if the two drift apart.
  geometry: {
    captionLeftShare: 0.06,
    captionWidthShare: 0.82,
    captionHeightShare: 0.07,
    captionTopShare: { upper: 0.16, middle: 0.47, lower: 0.6 },
    // Where a presenter's face is assumed when the presenter clip has no face box (initial, until the take gate measures it).
    assumedFaceBox: { x: 0.2, y: 0.1, w: 0.6, h: 0.4 },
  },
} as const;

export type CaptionBand = keyof typeof EDIT_TUNING.geometry.captionTopShare;
