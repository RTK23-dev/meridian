// Thresholds and limits (Bible sections 5, 6, 8.3, 10.4, 11.3, 12, 16.3). Tuned values are Tunable; hard rules are
// constants. Nothing outside this folder hard-codes these numbers.

import { tunable } from "./tunable.ts";

export const thresholds = {
  version: "thresholds@2",

  // 5.1 jobs: infrastructure retries and quality redos. Constants.
  jobs: {
    maxAttempts: 3,
    qualityRedosPerShot: 2,
    leaseMs: { claude: 120_000, generation: 600_000, render: 300_000 },
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
