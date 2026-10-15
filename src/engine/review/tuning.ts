// Review values that config/ does not hold yet (Bible 12.3). The slideshow risk dimensions are named in the Bible, but it gives no
// weights, and the text-led and motion lists are read from the plan's components and the edit's effects. These are named here,
// never written inline in the logic. They are initial values: the lead moves them into config/thresholds.ts (a file this
// workstream does not own), and the gate then reads them from there. review/STATUS.md lists them for that move.

export const REVIEW_TUNING = {
  version: "review-tuning@1",

  // 12.3 acceptance: five coded shots in a row is blocked, so four is the longest run of coded shots (components) that passes. This is
  // not the 8.3 same-type limit (edit.sameShotTypeMaxRun), which counts one shot type; a run of coded shots mixes types.
  codedRunMax: 4,

  // 12.3 slideshow risk: the weighted mean of six dimensions, each 0 to 1. Equal weights are the initial value (the Bible names
  // the six dimensions and the 0.35 limit, not their weights). The mean divides by the sum of these weights.
  slideshowWeights: {
    repetition: 1,
    decorative_visuals: 1,
    weak_motion: 1,
    shot_intent: 1,
    typography_over_reliance: 1,
    unsupported_cinematic_claims: 1,
  },

  // Decorative visuals: a shot illustrates its words when its text shares a content word with its beat. A word shorter than this
  // does not count, and neither does a word in stopWords.
  contentWordMinLength: 4,
  stopWords: [
    "about", "after", "again", "against", "also", "because", "before", "being", "between", "could", "every", "from", "have", "here",
    "into", "just", "like", "more", "most", "much", "only", "other", "over", "should", "some", "such", "than", "that", "their", "them",
    "then", "there", "these", "they", "this", "those", "through", "very", "were", "what", "when", "where", "which", "while", "will",
    "with", "would", "your", "yours",
  ],

  // Typography over-reliance: a component whose picture is text. A kinetic_type shot is text-led by its type.
  textLedComponents: ["title.hook", "kinetic.punchline", "cta.card", "label.lower", "sticker.pop"],

  // Weak motion: an edit effect of one of these kinds inside a shot makes a still move.
  motionEffectKinds: ["punch_in", "shake", "flash", "speed_ramp"],

  // Weak motion: a generation model class that makes a still image, not a moving one.
  stillModelClasses: ["image.keyframe", "image.edit"],

  // Unsupported cinematic claims: the visual types that claim motion footage, and the model class prefix that makes it.
  cinematicClaimTypes: ["cinematic", "stock_footage"],
  motionModelClassPrefix: "video.",
} as const;
