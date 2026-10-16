// Thresholds and limits (Bible sections 5, 6, 8.3, 10.4, 11.3, 12, 16.3). Tuned values are Tunable; hard rules are
// constants. Nothing outside this folder hard-codes these numbers.

import { tunable } from "./tunable.ts";

/** The Claude job lease (Bible 5.1: 2 minutes for a Claude call). The plan lease is built from it. */
const CLAUDE_LEASE_MS = 120_000;

export const thresholds = {
  version: "thresholds@3",

  // 5.1 jobs: infrastructure retries and quality redos. Constants.
  // Leases (5.1): claude 2 minutes, generation 10 minutes, render 5 minutes (Bible). `plan` is not in the Bible. The plan job
  // runs up to three Claude calls in sequence (request classification, planner, director check) under one lease, so its lease
  // is three Claude leases: 3 x 2 minutes = 6 minutes (plan/STATUS.md, open point 2). It moves with the Claude lease.
  jobs: {
    maxAttempts: 3,
    qualityRedosPerShot: 2,
    leaseMs: { claude: CLAUDE_LEASE_MS, generation: 600_000, render: 300_000, plan: 3 * CLAUDE_LEASE_MS },
  },

  // 5.3, 6.7, 12.2: below this critic confidence the request pauses for a human.
  escalation: {
    criticConfidence: tunable(0.6, 0.3, 0.9),
  },

  // 6.1 intake and 12.1 request gate: speech may run over maxMs by this share.
  intake: {
    speechOverrunShare: tunable(0.1, 0.02, 0.3),
  },

  // 6.2 analyze_reference and 12.1 dna gate.
  reference: {
    framesPerSecond: 2,
    maxFrames: 60,
    minSegments: 3,
  },

  // 6.3 voice and 12.1 voice gate.
  voice: {
    wordErrorRateMax: tunable(0.03, 0.005, 0.1),
    paceRetries: 2,
  },

  // 6.4 plan and 12.1 plan gate.
  plan: {
    shotTilingToleranceFrames: 1,
    validationAttemptsBeforeEscalation: 2,
  },

  // 6.7 check_take and 12.2 take gate.
  take: {
    durationTolerance: tunable(0.1, 0.02, 0.3),
    rubricFrames: 6,
    blackOrFrozenFramesMax: tunable(2, 1, 6),
    flickerMax: tunable(0.25, 0.05, 0.5),
    motionMin: tunable(0.05, 0.01, 0.2),
    productMatchMin: tunable(0.85, 0.7, 0.95),
    personaMatchMin: tunable(0.8, 0.6, 0.95),
    paletteShareMin: tunable(0.7, 0.5, 0.9),
    generatedWordsMax: 0,
    slopRubricItemMin: tunable(0.7, 0.5, 0.9),
  },

  // 8.3 rules on every EDL. Hard rules, constants.
  edit: {
    cutInsideWordMax: 0,
    shotLengthMinMs: 400,
    shotLengthMaxMs: 6000,
    captionWordsMin: 1,
    captionWordsMax: 3,
    captionTimingToleranceMs: 0,
    safeZoneShare: { top: 0.1, bottom: 0.2, right: 0.12 },
    blackFramesMaxFrames: 1,
    sameShotTypeMaxRun: 3,
  },

  // 8.2 the editor's build steps (edit/editor.ts), moved here from edit/tuning.ts at thresholds@3. A value the Bible gives is
  // a plain constant, with its section. A value the Bible does not give is an initial Tunable with a floor and a ceiling:
  // those bounds are proposals the lead confirms, and the Tunable does not mean the nightly loop moves it (16.2 names what
  // it moves). Times are integer milliseconds; shares and scales are plain numbers.
  editor: {
    // 8.2 step 3: a cut moves to the nearest word gap of at least gapMinMs within windowMs. With music on, to the nearest beat
    // within beatWindowMs, unless that lands inside a word.
    cutSnap: { gapMinMs: 80, windowMs: 250, beatWindowMs: 120 },

    // 8.2 step 4: a shot longer than longShare x its target splits; shorter than shortShare x its target merges with a
    // neighbour of the same type.
    fit: { shortShare: 0.5, longShare: 1.5 },

    // 8.2 step 5: motion starts within motionWithinMs; the hook caption is on screen by captionByMs.
    hook: { captionByMs: 500, motionWithinMs: 300 },

    // 8.2 steps 6 and 10: an optional punch-in is skipped within this distance of another effect. The Bible gives no distance.
    effectClashMs: tunable(300, 100, 1000),

    // 8.2 step 12: the loop cross-fade covers the last loopMs of the timeline.
    loopMs: 500,

    // 8.2 steps 10 and 13: punch-in scale. The full move is the grammar's punchInScale, at least minScale. Its amplitude for a
    // kit is 1 + (full - 1) x (motionIntensity + 1) / intensityDivisor, where motionIntensity is 0 to 3 (Bible 13), so
    // intensityDivisor 4 gives the full move at intensity 3 and a larger divisor softens it. The seeded jitter is within
    // jitterShare (Bible 8.2 step 13: within +-10 per cent). The result is held inside [floorScale, maxScale].
    punch: {
      minScale: tunable(1.02, 1, 1.2),
      floorScale: tunable(1.01, 1, 1.05),
      maxScale: tunable(1.5, 1.1, 2),
      jitterShare: 0.1,
      intensityDivisor: tunable(4, 4, 8),
    },

    // 8.2 step 11: music sits under speech at baseGainDb and is ducked by duckDb (Bible: 18 dB) while speech plays.
    music: { baseGainDb: tunable(-12, -24, -6), duckDb: -18 },

    captions: {
      // Captions per clip, and words per caption: the captions.karaoke component's schema limits (60 and 8,
      // compose/components/captions.karaoke/props.ts). The ceilings are those limits, so no tuning can exceed them.
      maxPerClip: tunable(60, 1, 60),
      maxWordsPerCaption: tunable(8, 1, 8),
      // 8.2 step 9: a caption may break after these marks. A regular expression source (a rule, not a number). The editor
      // builds it once with new RegExp(...).
      breakPattern: "[.!?;:,]$",
    },

    // The audio gain the compiler can draw: HyperFrames caps data-volume at +12 dB (compose/compiler.ts MAX_VOLUME, 3.98).
    // The ceiling is that cap, so a tuned value can only lower the gain.
    maxDrawableGainDb: tunable(12, 0, 12),

    // The voice gain is set from its measured loudness, so the result lands on the master target to within this rounding.
    loudnessRoundingLufs: tunable(0.05, 0.01, 0.5),

    // Caption layout, shares of the frame. These mirror compose/components/captions.karaoke/component.html (the box of one
    // 104 px line); edit/geometry.test.ts reads that template and fails if the two drift apart. The bounds keep a caption
    // inside the Bible 8.3 safe zones: the upper band starts at or below the top 10 per cent, and the lower band ends at or
    // above the bottom 20 per cent (0.6 + 0.07 = 0.67 at the initial values; the ceiling of 0.73 ends at 0.80).
    geometry: {
      captionLeftShare: tunable(0.06, 0, 0.12),
      captionWidthShare: tunable(0.82, 0.5, 0.88),
      captionHeightShare: tunable(0.07, 0.03, 0.15),
      captionTopShare: {
        upper: tunable(0.16, 0.1, 0.3),
        middle: tunable(0.47, 0.3, 0.6),
        lower: tunable(0.6, 0.45, 0.73),
      },
      // Where a presenter's face is assumed when the presenter clip has no face box, until the take gate measures it.
      assumedFaceBox: {
        x: tunable(0.2, 0, 0.4),
        y: tunable(0.1, 0, 0.4),
        w: tunable(0.6, 0.2, 1),
        h: tunable(0.4, 0.2, 1),
      },
    },
  },

  // 6.11 render and 12.3 render integrity. The platform size limit is not in the Bible: null means
  // the integrity gate refuses to pass on size until the owner sets it (fail closed).
  render: {
    fallbackAfterFailures: 2,
    durationToleranceMs: tunable(100, 34, 250),
    platformMaxBytes: null as number | null,
  },

  // 6.12 post_render_review and 12.3 post-render gate.
  postRender: {
    cutFrameWindow: 2,
    samplePositions: [0.1, 0.35, 0.65, 0.9],
    criticFinalFrames: 12,
    sonnetRecheckBelow: 0.6,
    loudnessTargetLufs: -14,
    loudnessToleranceLufs: tunable(1, 0.5, 2),
    truePeakMaxDbtp: -1,
    silenceMaxMs: tunable(700, 300, 1500),
    captionTimingToleranceMs: tunable(150, 50, 300),
    slideshowRiskMax: tunable(0.35, 0.2, 0.5),
  },

  // 12.3 slideshow risk (review/slideshowRisk.ts), moved from review/tuning.ts at thresholds@3. The Bible names the six dimensions
  // and the 0.35 limit (postRender.slideshowRiskMax), not their weights, formulas or word lists.
  // codedRunMax is plain: the Bible 19 E4 acceptance says five coded shots in a row is blocked, so four is the longest run that
  // passes. The weights are initial Tunables, equal at 1. The mean divides by their sum, and the floor of 0.5 keeps that sum
  // positive. The lists and the prefix are documented initial data (not numbers, so not Tunable); config.test.ts checks their
  // members against the contract enums.
  slideshow: {
    codedRunMax: 4,
    weights: {
      repetition: tunable(1, 0.5, 2),
      decorative_visuals: tunable(1, 0.5, 2),
      weak_motion: tunable(1, 0.5, 2),
      shot_intent: tunable(1, 0.5, 2),
      typography_over_reliance: tunable(1, 0.5, 2),
      unsupported_cinematic_claims: tunable(1, 0.5, 2),
    },
    // Decorative visuals: a shot illustrates its words when its text shares a content word with its beat. A word shorter than
    // contentWordMinLength does not count, and neither does a word in stopWords. The length is an integer.
    contentWordMinLength: tunable(4, 3, 6),
    stopWords: [
      "about", "after", "again", "against", "also", "because", "before", "being", "between", "could", "every", "from", "have", "here",
      "into", "just", "like", "more", "most", "much", "only", "other", "over", "should", "some", "such", "than", "that", "their", "them",
      "then", "there", "these", "they", "this", "those", "through", "very", "were", "what", "when", "where", "which", "while", "will",
      "with", "would", "your", "yours",
    ],
    // Typography over-reliance: a component whose picture is text. A kinetic_type shot is text-led by its type.
    textLedComponents: ["title.hook", "kinetic.punchline", "cta.card", "label.lower", "sticker.pop"],
    // Weak motion: an edit effect of one of these kinds inside a shot makes a still move (EFFECT_KINDS).
    motionEffectKinds: ["punch_in", "shake", "flash", "speed_ramp"],
    // Weak motion: a generation model class that makes a still image, not a moving one (MODEL_CLASSES).
    stillModelClasses: ["image.keyframe", "image.edit"],
    // Unsupported cinematic claims: the visual types that claim motion footage (VISUAL_TYPES), and the model class prefix that
    // makes a generated shot a moving one.
    cinematicClaimTypes: ["cinematic", "stock_footage"],
    motionModelClassPrefix: "video.",
  },

  // 6.14 deliver: sampling of delivered videos for human review.
  sampling: {
    baseShare: 0.05,
    newFormatShare: 1,
    newFormatPassesToRelax: 50,
    afterThresholdChangeShare: 0.2,
    afterThresholdChangeDays: 7,
  },

  // 10.4 concurrency buckets (one per provider class) and the circuit breaker. The Bible gives the 30% share, the
  // 10-minute window and the 10-minute skip. It gives no minimum sample, so `minSample` is an initial value (thresholds@2):
  // the breaker trips only after this many provider-side attempts in the window. Without it one failure in an empty window
  // trips the breaker (assets/STATUS.md, decision 4). Integer. Tunable.
  //
  // `minAttempts` (thresholds@2) is the unknown-score policy for provider reliability and latency (10.2). The Bible gives
  // no number. Below this many attempts in the reliability window a provider's reliability is unknown and left out of its
  // score, not scored as 0 or 1. The assets code does not read it yet (it treats any attempt as known). Integer. Tunable.
  router: {
    concurrency: { video: 10, image: 20, tts: 30 },
    breaker: { failureShare: 0.3, windowMs: 600_000, skipMs: 600_000, minSample: tunable(5, 1, 50) },
    minAttempts: tunable(10, 1, 100),
  },

  // 11.3 prompt challengers and 11.4 vision input size.
  claude: {
    challengerShare: tunable(0.1, 0.02, 0.5),
    visionMaxLongSidePx: 768,
  },

  // 12.4 gold sets and accuracy targets. Constants until the gold sets exist.
  goldSets: {
    examplesToStart: 200,
    recallTargetOnFailures: 0.9,
    falseFailMax: 0.1,
  },

  // 16.3 learning: holdout share of requests on last week's configuration.
  learning: {
    holdoutShare: 0.1,
  },
} as const;
