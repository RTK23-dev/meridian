// Motion registers (motion-kit LIBRARY section 1): what a piece's motion should feel like, and the curves it starts from. A register is
// chosen per piece; two pieces should not come out moving the same. Until a request carries its register (a contract change for the
// owner, proposed with direction in contract v15), it can be read from the piece's dominant feeling: the direction codex's emotion ids.

import type { CurveName } from "./kit.ts";

export const MOTION_REGISTERS = ["technical", "editorial", "premium", "expressive", "playful", "calm"] as const;
export type MotionRegister = (typeof MOTION_REGISTERS)[number];

export type RegisterProfile = {
  feel: string;
  /** Entrances from off-frame and arrivals. */
  arrive: CurveName;
  /** Big objects and camera moves. */
  weighty: CurveName;
  /** State changes and transitions. */
  snap: CurveName;
  /** Spring damping for physical landings: 1 no overshoot, 0.8 felt not seen, 0.65 a visible settle. */
  damping: number;
  /** Multiplies durations from dur(): longer for premium and calm, shorter for technical. */
  pace: number;
};

export const REGISTER_PROFILES: Record<MotionRegister, RegisterProfile> = {
  technical: { feel: "Precise, efficient, confident", arrive: "carbon.productive.entrance", weighty: "m3.standard", snap: "kit.whip", damping: 1, pace: 0.85 },
  editorial: { feel: "Clear cause and effect, a guided eye", arrive: "kit.land", weighty: "kit.heavy", snap: "kit.whip", damping: 0.85, pace: 1 },
  premium: { feel: "Weight, long settles, restraint", arrive: "easings.outExpo", weighty: "kit.heavy", snap: "easings.inOutQuint", damping: 1, pace: 1.25 },
  expressive: { feel: "Moments meant to be noticed", arrive: "carbon.expressive.entrance", weighty: "kit.heavy", snap: "kit.whip", damping: 0.75, pace: 0.9 },
  playful: { feel: "Elastic, physical, characterful", arrive: "kit.land", weighty: "kit.heavy", snap: "kit.whip", damping: 0.62, pace: 0.85 },
  calm: { feel: "Breathing, continuous", arrive: "easings.inOutSine", weighty: "kit.drift", snap: "kit.drift", damping: 1, pace: 1.35 },
};

/** The register a piece's dominant feeling suggests (the direction codex's emotion ids). Unknown feelings read as editorial. */
export const REGISTER_FOR_FEELING: Record<string, MotionRegister> = {
  awe: "premium",
  surprise: "editorial",
  amusement: "playful",
  tension: "expressive",
  inspiration: "expressive",
  relief: "calm",
  belonging: "calm",
  sadness: "calm",
  righteous_anger: "expressive",
  nostalgia: "premium",
};

export function registerForFeeling(feeling: string | null | undefined): MotionRegister {
  return (feeling && REGISTER_FOR_FEELING[feeling]) || "editorial";
}
