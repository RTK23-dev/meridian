// Recorded fixtures for the direction tests: a script that follows the framework, and one that breaks it in the ways a first model draft
// usually does. Invented product, no real brand; the numbers are the brief's own in the fixture.

import type { DirectedScript } from "./script.ts";

/**
 * A script that follows the framework: hook first with its context and a sound, promise on screen, proof in the lock-in, a villain, two
 * early ahas, a rehook, payoff late, loops closed, ends on the payoff. It declares every codex 2 field.
 */
export const STRONG_SCRIPT: DirectedScript = {
  language: "en",
  hookFamily: "challenge_test",
  format: "test_experiment",
  feeling: "surprise",
  sendTrigger: "utility",
  rewatchDevice: "hidden_reveal",
  promise: { text: "Which of the 3 mugs keeps coffee hot for 2 hours", paidByBeatId: "b6" },
  loops: [
    { question: "Which mug wins", opensAt: "b1", closesAt: "b6" },
    { question: "Why did the steel mug fail", opensAt: "b4", closesAt: "b5" },
  ],
  topic: "Which mug keeps coffee hot",
  job: "reach",
  lockIn: { approach: "tease_proof", beatId: "b2" },
  trustAnchor: { type: "effort_maxing", beatId: "b2" },
  villain: { type: "false_belief", text: "The steel mug everyone buys keeps coffee hottest" },
  ahas: [
    { text: "The popular steel mug loses to glass", beatId: "b4" },
    { text: "A gap in the lid lets the heat out", beatId: "b5" },
  ],
  rehooks: ["b4"],
  cta: null,
  beats: [
    {
      beatId: "b1",
      role: "hook",
      voice: "Three mugs. Same coffee. Two hours.",
      onScreenText: "Only 1 stays hot",
      picture: "Three mugs filled at once, steam rising, a kitchen timer starts.",
      sound: "A kettle click, then the timer starts ticking",
    },
    {
      beatId: "b2",
      role: "setup",
      voice: "I poured them at ninety degrees and walked away.",
      picture: "Thermometer in each mug reading 90.",
      link: "therefore",
    },
    {
      beatId: "b3",
      role: "item",
      voice: "At one hour the glass mug was already lukewarm.",
      picture: "Close-up of the thermometer in the glass mug.",
      link: "but",
    },
    {
      beatId: "b4",
      role: "twist",
      voice: "But the steel one, the one everyone buys, dropped faster than glass.",
      onScreenText: "Wait, steel lost?",
      picture: "Steel mug thermometer falling, hand taps it in disbelief.",
      link: "but",
    },
    {
      beatId: "b5",
      role: "proof",
      voice: "Its lid has a gap. Look at the steam.",
      picture: "Macro shot of steam escaping the lid gap.",
      link: "therefore",
    },
    {
      beatId: "b6",
      role: "payoff",
      voice: "The winner was the one with the double wall, still at sixty one degrees.",
      onScreenText: "61° after 2 hours",
      picture: "The double-wall mug's thermometer at 61, then back to the three mugs.",
      link: "therefore",
    },
  ],
  rationale: "A test with an unknown winner, the obvious favourite failing in the middle, and the reason shown before the verdict.",
};

/**
 * A typical first draft: an intro, the answer in the hook, AI register, bait, an outro, a loop that never closes, a late lock-in, no proof,
 * no villain, no ahas, and a convert job with no call to action.
 */
export const WEAK_SCRIPT: DirectedScript = {
  language: "en",
  hookFamily: "question_gap",
  format: "tutorial",
  feeling: "inspiration",
  sendTrigger: "utility",
  rewatchDevice: "loop_seam",
  promise: { text: "The best mug for hot coffee", paidByBeatId: "b1" },
  loops: [{ question: "Why it works", opensAt: "b3", closesAt: "b2" }],
  topic: "Double wall mug",
  job: "convert",
  lockIn: { approach: "tease_proof", beatId: "b4" },
  trustAnchor: null,
  villain: null,
  ahas: [],
  rehooks: [],
  cta: null,
  beats: [
    {
      beatId: "b1",
      role: "hook",
      voice: "Hey guys, welcome back! In today's fast-paced world, the double wall mug is the best mug, and it's a total game-changer for your mornings.",
      onScreenText: "the double wall mug is the best mug",
    },
    {
      beatId: "b2",
      role: "setup",
      voice: "It's not just a mug, it's a ritual. Let's delve into why it will elevate your coffee.",
      link: "and",
    },
    {
      beatId: "b3",
      role: "item",
      voice: "It keeps heat in and it looks great and it is easy to clean and it comes in many colours.",
      link: "and",
    },
    {
      beatId: "b4",
      role: "item",
      voice: "Comment yes if you love coffee and tag a friend who needs this!",
      link: "and",
    },
    {
      beatId: "b5",
      role: "cta",
      voice: "Thanks for watching, and follow for more!",
      link: "and",
    },
  ],
  rationale: "A helpful overview of the product's benefits.",
};
