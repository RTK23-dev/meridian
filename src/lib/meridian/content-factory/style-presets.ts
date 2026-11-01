// The video style preset library. A preset is a plain-language brief for one kind of short video: what it is for, how it is paced and what it
// shows. Choosing one adds a style instruction to each draft, so the planner is told the style in words. It does not set a render option and it
// does not change the engine's style kits. The wording is original to Meridian; the categories (promo, explainer, shorts, motion graphics, stories)
// are common kinds of video, and a list of video skills was only a reminder of which kinds people ask for.
//
// Three ways to pick: one preset; Auto, where Meridian picks from the structure that repeats in the brand's research (a fixed rule table,
// not a model call) and falls back to the mix; or the Super preset, which gives each video in a batch a different preset from the library.

export type StylePreset = {
  id: string;
  label: string;
  /** What it is good for, in one short line. */
  bestFor: string;
  /** How it is paced and what it shows, in plain words. */
  look: string;
  /** The instruction added to the brief. */
  instruction: string;
};

export const STYLE_PRESETS: readonly StylePreset[] = [
  {
    id: "product_promo",
    label: "Product promo",
    bestFor: "Showing what a product does and why it is worth having.",
    look: "Quick, benefit-first, the product on screen doing its job, a clear closing offer.",
    instruction: "Make a short promo: open on the product in use, state the main benefit in the first seconds, show it working, and close on one clear next step. Keep it tight and benefit-led.",
  },
  {
    id: "explainer",
    label: "Explainer",
    bestFor: "Teaching one idea or answering one question.",
    look: "Calm pace, one idea at a time, simple visuals that match the narration.",
    instruction: "Make a short explainer: state the question, explain one idea in plain steps, and use simple visuals that match each step. End by restating the answer in one sentence.",
  },
  {
    id: "talking_head",
    label: "Talking head",
    bestFor: "A direct message from one speaker to the viewer.",
    look: "One speaker facing the camera, steady framing, bold captions, little cutting.",
    instruction: "Make a talking-head video: a single presenter speaks directly to the viewer with steady framing and large captions. Keep the script conversational and under one minute.",
  },
  {
    id: "ugc_style",
    label: "UGC style",
    bestFor: "A casual, first-person feel.",
    look: "Handheld and informal, a reaction or a quick demo, plain language.",
    instruction: "Make a casual, first-person style video: informal framing, a quick reaction or demo, and plain spoken language. Do not invent a customer, a review or a result.",
  },
  {
    id: "fast_cut_short",
    label: "Fast-cut short",
    bestFor: "Short vertical videos that must hold attention.",
    look: "A hook in the first second, quick cuts on the beat, punchy captions.",
    instruction: "Make a fast-cut short for vertical viewing: a strong hook in the first second, quick cuts, punchy captions, and one idea. Keep it under 30 seconds.",
  },
  {
    id: "cinematic_story",
    label: "Cinematic story",
    bestFor: "A mood-led short story that ends on the brand.",
    look: "Slower pace, atmospheric visuals, a small story with a turn.",
    instruction: "Make a short cinematic story: set a mood, build a small story with one clear turn, use atmospheric visuals and slower pacing, and end on the brand with a single line.",
  },
  {
    id: "motion_graphics",
    label: "Motion graphics",
    bestFor: "Ideas best shown with animated text and shapes.",
    look: "Animated type and simple shapes, little or no footage, clean timing.",
    instruction: "Make a motion-graphics video: animated text and simple shapes carry the message with little or no live footage. Keep the timing clean and each screen to one point.",
  },
  {
    id: "tips_list",
    label: "Tips list",
    bestFor: "A numbered set of quick, useful points.",
    look: "A numbered list, one tip per beat, each easy to remember.",
    instruction: "Make a numbered tips video: open by saying how many tips there are, give one short tip per beat, and end on the most useful one. Every tip must be something the evidence supports.",
  },
] as const;

/** Added to every style instruction. A preset steers the brief; it never licenses an invented claim or a real person's likeness. */
export const STYLE_RULES =
  "This style steers the brief only; the engine decides how to produce it. Use no real person's likeness, and add no testimonial, result or claim that the attached evidence does not support.";

export type StyleMode = "auto" | "super" | "none" | string;

export const STYLE_AUTO = "auto";
export const STYLE_SUPER = "super";
/** The workspace's decision engine chooses: one model call, made when the batch is created, ranked over the library. */
export const STYLE_ORCHESTRATOR = "orchestrator";

export function presetById(id: string): StylePreset | null {
  return STYLE_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** Whether the value is a way to choose: Auto, the Super preset, or the id of one preset in the library. */
export function isStyleChoice(value: string): boolean {
  return value === STYLE_AUTO || value === STYLE_SUPER || value === STYLE_ORCHESTRATOR || presetById(value) !== null;
}

/** The preset Auto picks for a research structure. A fixed table: the same research always gives the same preset. */
const AUTO_BY_STRUCTURE: Record<string, string> = {
  problem_solution: "explainer",
  before_after: "product_promo",
  story_payoff: "cinematic_story",
  listicle: "tips_list",
  demonstration: "product_promo",
  testimonial: "ugc_style",
  offer_led: "product_promo",
};

/**
 * The preset for each video of a batch of `count`, in order. One preset repeats for every video; Auto repeats the preset its table gives for
 * the most common research structure, or the Super mix when there is no research format; Super walks the whole library, so a batch of
 * eight tries eight styles. Returns null for an unknown choice, which the caller refuses.
 */
export function presetsForBatch(choice: string, count: number, topStructure: string | null): StylePreset[] | null {
  const mix = () => Array.from({ length: count }, (_, index) => STYLE_PRESETS[index % STYLE_PRESETS.length] as StylePreset);
  if (choice === STYLE_SUPER) return mix();
  if (choice === STYLE_AUTO) {
    const picked = topStructure !== null ? presetById(AUTO_BY_STRUCTURE[topStructure] ?? "") : null;
    return picked ? Array.from({ length: count }, () => picked) : mix();
  }
  const one = presetById(choice);
  return one ? Array.from({ length: count }, () => one) : null;
}

/**
 * The preset for each video from a ranked list of preset ids (best first), as the decision engine ranked them. The first `count` take one
 * each in rank order, and a batch longer than the list starts over. An id that is not in the library is dropped; with none left, null.
 */
export function presetsFromRanking(ranked: readonly string[], count: number): StylePreset[] | null {
  const known = ranked.map((id) => presetById(id)).filter((preset): preset is StylePreset => preset !== null);
  if (known.length === 0) return null;
  return Array.from({ length: count }, (_, index) => known[index % known.length] as StylePreset);
}

/** The sentence Auto's choice is explained with, so the person can see why. */
export function autoReason(topStructure: string | null): string {
  const picked = topStructure !== null ? presetById(AUTO_BY_STRUCTURE[topStructure] ?? "") : null;
  return picked
    ? `Auto picked ${picked.label} because "${topStructure!.replaceAll("_", " ")}" is the structure that repeats most in your research.`
    : "Auto found no repeating structure in your research, so it mixes every style across the batch.";
}

export function styleInstruction(preset: StylePreset): string {
  return `Style preset: ${preset.label}. ${preset.instruction} ${STYLE_RULES}`;
}
