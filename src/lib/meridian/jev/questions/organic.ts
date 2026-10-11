/**
 * JEV Question Registry: Organic Questions
 *
 * Covers 11-dimension Angle Bible and psychological mechanisms:
 * hook, format, emotion, retention, visual craft, audio, persona,
 * share trigger, conversion, trend, product integration, novelty,
 * authenticity, and transferability.
 */

import type { JevQuestionSpec } from "../types.ts";

export const ORGANIC_QUESTIONS: Record<string, JevQuestionSpec> = {
  "organic.hook_mechanism.v1": {
    id: "organic.hook_mechanism.v1",
    version: "1.0.0",
    type: "choice",
    instructions: "Identify the dominant psychological hook mechanism deployed in the opening 3 seconds.",
    criteria: {
      result_first: "Shows end result or dramatic outcome immediately in first 1.5 seconds.",
      negative_inversion: "Frames a common mistake, warning, or counterintuitive anti-advice.",
      pov_relatable: "First-person situational perspective establishing relatable dilemma.",
      curiosity_gap: "Withholds resolution or asks an intriguing question creating open loop.",
      pattern_interrupt: "Unexpected physical movement, sound, or visual discordance.",
      unclear: "No discernible hook mechanism in the opening seconds.",
    },
    evidenceRequirements: ["scene_frames", "transcript"],
    policyMapping: {
      reviewMinProbability: 0.60,
    },
  },

  "organic.format_structure.v1": {
    id: "organic.format_structure.v1",
    version: "1.0.0",
    type: "choice",
    instructions: "Classify the overall format structure of the creative.",
    criteria: {
      pov_skit: "Multi-character or monologue situational skit.",
      transformation_arc: "Step-by-step progress from problem state to resolved state.",
      myth_vs_fact: "Structured contrast debunking misconception with demonstration.",
      seamless_loop: "End transition flows naturally into the opening scene.",
      listicle: "Ordered series of tips, products, or steps.",
      talking_head_demo: "Presenter on camera speaking while interacting with product.",
      other: "Uncategorized format.",
    },
    evidenceRequirements: ["transcript", "scene_cuts"],
    policyMapping: {
      reviewMinProbability: 0.55,
    },
  },

  "organic.retention_architecture.v1": {
    id: "organic.retention_architecture.v1",
    version: "1.0.0",
    type: "choice",
    instructions: "Evaluate the primary retention mechanism that prevents drop-off.",
    criteria: {
      continuous_open_loop: "Introduces unanswered questions resolved only at the end.",
      micro_escalation: "Each cut escalates intensity, stakes, or visual payoff.",
      text_rhythm_sync: "Typography appears synchronized to spoken speech accents.",
      ambient_payoff: "Subtle build-up towards an anticipated visual conclusion.",
      unclear: "No active retention architecture observed.",
    },
    evidenceRequirements: ["scene_cuts", "transcript"],
  },

  "organic.visual_craft.v1": {
    id: "organic.visual_craft.v1",
    version: "1.0.0",
    type: "choice",
    instructions: "Classify the primary visual craft style.",
    criteria: {
      organic_handheld_macro: "Close-up handheld camera with genuine amateur aesthetic.",
      cinematic_lighting: "Studio three-point lighting with shallow depth of field.",
      screen_record_ui: "Direct device capture with finger taps or cursor moves.",
      lo_fi_selfie: "Front-facing mobile camera with natural room acoustics.",
      polished_commercial: "High-budget studio commercial style.",
    },
    evidenceRequirements: ["scene_frames"],
  },

  "organic.share_trigger.v1": {
    id: "organic.share_trigger.v1",
    version: "1.0.0",
    type: "choice",
    instructions: "Identify the psychological driver prompting peer-to-peer sharing.",
    criteria: {
      relational_tag_bait: "Direct call to tag partner, friend, or coworker.",
      high_utility_save: "Dense actionable information that viewer wants to save for reference.",
      identity_validation: "Affirms viewer's specific worldview, lifestyle, or niche humor.",
      cathartic_relief: "Venting common frustration with humor and satisfaction.",
      none: "No explicit share trigger detected.",
    },
    evidenceRequirements: ["transcript", "comments"],
  },

  "organic.transferability.v1": {
    id: "organic.transferability.v1",
    version: "1.0.0",
    type: "score",
    instructions: "Rate how easily this creative mechanism transfers to adjacent categories without creator dependency (1 to 5).",
    criteria: [
      "1: Solely dependent on this specific creator's celebrity or unique physique.",
      "2: Heavily reliant on niche creator voice; hard to replicate.",
      "3: Moderate transferability; mechanism works with similar persona.",
      "4: High transferability; mechanism is structural and platform-wide.",
      "5: Universal transferability; pure psychology that applies across verticals.",
    ],
    evidenceRequirements: ["transcript", "scene_cuts"],
    policyMapping: {
      approveMinProbability: 0.70,
      reviewMinProbability: 0.40,
    },
  },

  "organic.authenticity.v1": {
    id: "organic.authenticity.v1",
    version: "1.0.0",
    type: "noul",
    instructions: "Does this asset feel authentically native to organic feeds rather than looking like an overt advertisement?",
    criteria: {
      true: "Natural speech, unpolished lighting, organic text stickers, relatable tone.",
      false: "Polished studio ad aesthetics, corporate logos, salesy infomercial pacing.",
    },
    evidenceRequirements: ["scene_frames", "transcript"],
    policyMapping: {
      approveMinProbability: 0.75,
      reviewMinProbability: 0.45,
    },
  },
};

/**
 * The evidence each research organic question may receive (GateQuestion.evidenceScope). Scope names are the research bundle's
 * evidence names (evidence/bundle.ts): transcript, scene_cuts, scene_frames, ocr, comments, creator_baseline,
 * performance_snapshot, comparison_context. Each scope is the question's requirements, plus bundle_source: the bundle's identity,
 * source, and platform, which the question is judged within. Organic questions are analysis: they are answered and recorded, and
 * they do not decide the action.
 */
export const ORGANIC_EVIDENCE_SCOPES: Record<string, readonly string[]> = {
  "organic.hook_mechanism.v1": ["bundle_source", "scene_frames", "transcript"],
  "organic.format_structure.v1": ["bundle_source", "transcript", "scene_cuts"],
  "organic.retention_architecture.v1": ["bundle_source", "scene_cuts", "transcript"],
  "organic.visual_craft.v1": ["bundle_source", "scene_frames"],
  "organic.share_trigger.v1": ["bundle_source", "transcript", "comments"],
  "organic.transferability.v1": ["bundle_source", "scene_cuts", "transcript"],
  "organic.authenticity.v1": ["bundle_source", "scene_frames", "transcript"],
};
