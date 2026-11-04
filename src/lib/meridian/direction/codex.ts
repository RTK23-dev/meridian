// The direction codex: the machine-readable part of docs/direction/VIRAL_DIRECTION_FRAMEWORK.md. Every entry names the framework
// section it comes from and its evidence label (sourced, practice, hypothesis, contested), so an agent and a reader can tell a platform's
// own rule from a guess. The numbers here are initial values: the learning loop replaces them with measured ones (framework section 13).
//
// Data only, and pure. The checks that read it are attention.ts and slop.ts; the prompt text built from it is directives.ts.

import { z } from "zod";
import { BEAT_ROLES, type BeatRole } from "../../../engine/contracts/request.ts";

/**
 * The codex's version. A change to any rule, list or weight here is a new version, recorded on every direction record.
 *
 * Version 2 (2026-11-04) adds the short-form lessons of the creator Kallaway (274 posts, 147 lessons; docs/direction/LESSONS_CROSSWALK.md
 * maps each one): the triple hook, text-hook rules and power words, the lock-in zone, trust anchors, villains, the hourglass rehook,
 * zig-zag rhythm, the double aha, save and comment devices, video jobs, the format pyramid and its new formats, and the rubric's clarity
 * and proof dimensions. His numbers are one creator's own results, so every rule from them is labelled `practice`.
 */
export const DIRECTION_CODEX_VERSION = "direction-codex@2";

export const EVIDENCE_LABELS = ["sourced", "practice", "hypothesis", "contested"] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

export { BEAT_ROLES, type BeatRole };

/** A rule an agent follows and, where it can be measured, a check enforces. `section` is the framework section it comes from. */
export type DirectionRule = { id: string; text: string; evidence: EvidenceLabel; section: string };

// ---------------------------------------------------------------------------------------------------------------------------------
// Timing windows (framework 1.3, 5.3, 5.5). Initial values; callers may pass their own.

export type DirectionWindows = {
  /** The stop: the window in which the first frame and the first sound must stop the scroll. */
  stopMs: number;
  /** The promise is clear by this time. */
  promiseByMs: number;
  /** The hook beat ends by this time. */
  hookEndsByMs: number;
  /** The longest stretch without a story or visual change. */
  maxStretchMs: number;
  /** The payoff starts after this fraction of the duration. */
  payoffStartsAfterFraction: number;
  /** The most on-screen words in the hook. */
  maxHookTextWords: number;
  /** On-screen text, words per second at most. */
  maxTextWordsPerSecond: number;
  /** Spoken words per second at most in one beat (about 240 words per minute). */
  maxVoiceWordsPerSecond: number;
  /** The pace a script is estimated at when the voice's own pace is not given. */
  defaultWordsPerMinute: number;
  /** The first two spoken sentences carry at most this many words (overloading the hook). */
  maxOpeningWords: number;
  /** A video longer than `doubleHookAfterMs` opens a second loop or turn by this time (the double hook, the intensifier loop). */
  doubleHookByMs: number;
  doubleHookAfterMs: number;
  /** The longest gap between two peaks (a turn, an opened loop, a rehook, an aha, the payoff) before the payoff: the hourglass. */
  maxPeakGapMs: number;
  /** Sentence lengths vary at least this much (coefficient of variation) once a script has `rhythmMinSentences` sentences. */
  minRhythmVariation: number;
  rhythmMinSentences: number;
  /** The highest reading grade of the voice (Flesch-Kincaid, English). */
  maxReadingGrade: number;
  /** The lock-in zone and the trust anchor start by this time. */
  lockInByMs: number;
  /** The second aha starts by this fraction of the duration. */
  secondAhaByFraction: number;
};

export const DIRECTION_WINDOWS: DirectionWindows = {
  stopMs: 1500,
  promiseByMs: 3000,
  hookEndsByMs: 6000,
  maxStretchMs: 7000,
  payoffStartsAfterFraction: 0.5,
  maxHookTextWords: 7,
  maxTextWordsPerSecond: 10,
  maxVoiceWordsPerSecond: 4,
  defaultWordsPerMinute: 165,
  maxOpeningWords: 15,
  doubleHookByMs: 15_000,
  doubleHookAfterMs: 20_000,
  maxPeakGapMs: 25_000,
  minRhythmVariation: 0.35,
  rhythmMinSentences: 6,
  maxReadingGrade: 6,
  lockInByMs: 12_000,
  secondAhaByFraction: 0.7,
};

/** Where each window comes from. */
export const DIRECTION_WINDOW_EVIDENCE: Record<keyof DirectionWindows, EvidenceLabel> = {
  stopMs: "sourced",
  promiseByMs: "sourced",
  hookEndsByMs: "sourced",
  maxStretchMs: "hypothesis",
  payoffStartsAfterFraction: "hypothesis",
  maxHookTextWords: "practice",
  maxTextWordsPerSecond: "sourced",
  maxVoiceWordsPerSecond: "practice",
  defaultWordsPerMinute: "practice",
  maxOpeningWords: "practice",
  doubleHookByMs: "practice",
  doubleHookAfterMs: "hypothesis",
  maxPeakGapMs: "practice",
  minRhythmVariation: "hypothesis",
  rhythmMinSentences: "hypothesis",
  maxReadingGrade: "practice",
  lockInByMs: "practice",
  secondAhaByFraction: "practice",
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Niche families (framework 14).

export const NICHE_FAMILIES = [
  "education",
  "entertainment",
  "ecommerce",
  "beauty",
  "fitness",
  "finance",
  "food",
  "tech",
  "b2b",
  "home",
  "parenting",
  "travel",
  "local",
] as const;
export const nicheFamilySchema = z.enum(NICHE_FAMILIES);
export type NicheFamily = z.infer<typeof nicheFamilySchema>;

// ---------------------------------------------------------------------------------------------------------------------------------
// Hook families (framework 4.3).

export const HOOK_FAMILY_IDS = [
  "result_first",
  "in_medias_res",
  "contrarian",
  "oddly_specific",
  "stakes_clock",
  "impossible_image",
  "identity_callout",
  "pov_relatable",
  "confession",
  "myth_bust",
  "mistake",
  "before_after",
  "question_gap",
  "ranking",
  "versus",
  "process_satisfaction",
  "unfinished_action",
  "mystery_object",
  "story_cliff",
  "genre_flip",
  "challenge_test",
  "insider_reveal",
  "fortune_teller",
  "proven_winner",
  "connector",
  "desire_outcome",
  "pattern_interrupt",
] as const;
export const hookFamilyIdSchema = z.enum(HOOK_FAMILY_IDS);
export type HookFamilyId = z.infer<typeof hookFamilyIdSchema>;

export type HookFamily = {
  id: HookFamilyId;
  name: string;
  /** Why it stops a viewer. */
  mechanism: string;
  /** What the video then owes the viewer: the payoff the hook promises. */
  owes: string;
  /** The channel that carries most of the hook. */
  leadChannel: "picture" | "text" | "voice";
  bestFor: readonly NicheFamily[] | "all";
  failureModes: readonly string[];
  /** The Angle Bible entry (src/lib/meridian/study/bible.ts) this family corresponds to, when there is one. */
  angleBibleSlug?: string;
  evidence: EvidenceLabel;
};

export const HOOK_FAMILIES: readonly HookFamily[] = [
  {
    id: "result_first",
    name: "Result first",
    mechanism: "The finished result removes doubt that the video is worth it; the viewer stays to learn how.",
    owes: "The method, with at least one step the viewer did not expect.",
    leadChannel: "picture",
    bestFor: ["beauty", "fitness", "food", "home", "tech", "b2b", "education"],
    failureModes: ["The result is ordinary", "The method is shown so early that nothing is left to learn"],
    angleBibleSlug: "result-first",
    evidence: "practice",
  },
  {
    id: "in_medias_res",
    name: "In the middle of it",
    mechanism: "Starting mid-action creates an information gap: the viewer needs the context and the ending.",
    owes: "The context, fast, and how it ends.",
    leadChannel: "picture",
    bestFor: "all",
    failureModes: ["The situation is unreadable without sound", "The backstory that follows is slow"],
    evidence: "practice",
  },
  {
    id: "contrarian",
    name: "Contrarian claim",
    mechanism: "A threat to something the viewer believes is hard to ignore; it opens a gap between their view and the claim.",
    owes: "A reason, shown, that changes their mind, inside the approved claims.",
    leadChannel: "voice",
    bestFor: ["finance", "fitness", "education", "b2b", "tech", "beauty"],
    failureModes: ["Contrarian for its own sake", "A claim the brief cannot support"],
    angleBibleSlug: "negative-inversion",
    evidence: "practice",
  },
  {
    id: "oddly_specific",
    name: "Oddly specific",
    mechanism: "A precise number or detail from the brief signals a real story and is more believable than a round claim.",
    owes: "The story behind the number.",
    leadChannel: "text",
    bestFor: "all",
    failureModes: ["The number is invented", "The number is precise but meaningless"],
    evidence: "practice",
  },
  {
    id: "stakes_clock",
    name: "Stakes and a clock",
    mechanism: "A goal with a deadline or a cost gives the viewer a reason to wait for the outcome.",
    owes: "The outcome, honestly, win or lose.",
    leadChannel: "voice",
    bestFor: ["entertainment", "fitness", "food", "home", "travel", "local"],
    failureModes: ["Fake urgency", "Stakes nobody cares about"],
    evidence: "practice",
  },
  {
    id: "impossible_image",
    name: "Impossible image",
    mechanism: "A picture that should not exist is surprising, and surprise pulls the gaze (Bayesian surprise).",
    owes: "The explanation, or the proof that it is real.",
    leadChannel: "picture",
    bestFor: ["entertainment", "tech", "food", "home", "education", "travel"],
    failureModes: ["The image reads as fake or generated", "No explanation follows"],
    evidence: "sourced",
  },
  {
    id: "identity_callout",
    name: "Identity call-out",
    mechanism: "Naming the viewer's group or situation makes relevance instant.",
    owes: "Something only that group gets, said in its words.",
    leadChannel: "text",
    bestFor: "all",
    failureModes: ["The group is too broad to feel named", "Stereotyping the group"],
    evidence: "practice",
  },
  {
    id: "pov_relatable",
    name: "Relatable POV",
    mechanism: "Putting the viewer inside a moment they know creates recognition and the urge to send it.",
    owes: "The beat that makes them laugh or feel seen.",
    leadChannel: "text",
    bestFor: ["entertainment", "parenting", "b2b", "fitness", "food", "local"],
    failureModes: ["Over-acted", "The perspective is unclear"],
    angleBibleSlug: "pov-relatable",
    evidence: "practice",
  },
  {
    id: "confession",
    name: "Confession",
    mechanism: "Admitting something opens a gap and builds trust through vulnerability.",
    owes: "The honest truth, with its cost.",
    leadChannel: "voice",
    bestFor: ["finance", "fitness", "beauty", "b2b", "parenting", "education"],
    failureModes: ["A fake confession", "The confession is a humblebrag"],
    evidence: "practice",
  },
  {
    id: "myth_bust",
    name: "Myth bust",
    mechanism: "Naming a common belief and promising to break it creates a gap between belief and evidence.",
    owes: "Evidence the viewer can check, within the approved claims.",
    leadChannel: "text",
    bestFor: ["beauty", "fitness", "finance", "food", "tech", "education"],
    failureModes: ["Debunking something trivial", "Academic and slow"],
    angleBibleSlug: "myth-vs-fact",
    evidence: "practice",
  },
  {
    id: "mistake",
    name: "The mistake you are making",
    mechanism: "The loss frame: the viewer may be doing something wrong and needs to know.",
    owes: "The fix, shown, simple to copy.",
    leadChannel: "voice",
    bestFor: ["fitness", "finance", "beauty", "food", "home", "tech", "b2b"],
    failureModes: ["Scolding the viewer", "The mistake is not common"],
    angleBibleSlug: "negative-inversion",
    evidence: "practice",
  },
  {
    id: "before_after",
    name: "Before and after",
    mechanism: "The visible gap between two states asks how it was crossed.",
    owes: "How the gap was crossed, honestly.",
    leadChannel: "picture",
    bestFor: ["beauty", "fitness", "home", "local", "ecommerce"],
    failureModes: ["A transformation too fast to believe", "Different light or angle between the states"],
    angleBibleSlug: "transformation-arc",
    evidence: "practice",
  },
  {
    id: "question_gap",
    name: "The viewer's question",
    mechanism: "Asking the exact question the viewer already has opens a gap they want closed.",
    owes: "The answer, and one thing they did not expect.",
    leadChannel: "voice",
    bestFor: "all",
    failureModes: ["A question nobody asks", "A yes-or-no question answered at once"],
    evidence: "sourced",
  },
  {
    id: "ranking",
    name: "Ranking",
    mechanism: "An order invites the viewer to wait for the top and to check where their favourite lands.",
    owes: "A top item that earns its place.",
    leadChannel: "text",
    bestFor: ["food", "tech", "travel", "entertainment", "ecommerce", "education"],
    failureModes: ["The best item first", "A top item the viewer disagrees with for no reason"],
    evidence: "practice",
  },
  {
    id: "versus",
    name: "Versus",
    mechanism: "Two options meet; the viewer picks a side and waits for the verdict.",
    owes: "A verdict, with the deciding reason.",
    leadChannel: "picture",
    bestFor: ["tech", "food", "finance", "fitness", "ecommerce", "b2b"],
    failureModes: ["No verdict", "A rigged comparison"],
    evidence: "practice",
  },
  {
    id: "process_satisfaction",
    name: "Satisfying process",
    mechanism: "A process already moving holds the eye to see it finish.",
    owes: "A clean, complete finish.",
    leadChannel: "picture",
    bestFor: ["food", "home", "beauty", "local", "ecommerce"],
    failureModes: ["The process stalls", "The finish is cut"],
    evidence: "practice",
  },
  {
    id: "unfinished_action",
    name: "Unfinished action",
    mechanism: "An action cut before it completes leaves an urge to see it finish (the resumption tendency).",
    owes: "The completion, later in the video.",
    leadChannel: "picture",
    bestFor: "all",
    failureModes: ["The completion never comes", "The cut reads as an error"],
    evidence: "sourced",
  },
  {
    id: "mystery_object",
    name: "Mystery object",
    mechanism: "An unexplained object asks what it is and why it matters.",
    owes: "What it is, and why it matters to the viewer.",
    leadChannel: "picture",
    bestFor: ["ecommerce", "tech", "home", "food", "beauty"],
    failureModes: ["The object is obvious", "The reveal is dull"],
    evidence: "practice",
  },
  {
    id: "story_cliff",
    name: "Story from the cliff",
    mechanism: "Opening on the most dramatic line of a story makes the viewer need the rest.",
    owes: "The story, told fast, with the line paid off.",
    leadChannel: "voice",
    bestFor: ["entertainment", "finance", "b2b", "travel", "parenting", "local"],
    failureModes: ["The line is exaggerated", "The story is slow to reach the line"],
    evidence: "practice",
  },
  {
    id: "genre_flip",
    name: "Genre flip",
    mechanism: "Beginning as one kind of video and turning into another breaks the viewer's prediction.",
    owes: "The turn, and why it was worth it.",
    leadChannel: "picture",
    bestFor: ["entertainment", "ecommerce", "food", "tech"],
    failureModes: ["The flip feels like a trick", "The first genre is too slow to set up"],
    evidence: "hypothesis",
  },
  {
    id: "challenge_test",
    name: "Test or challenge",
    mechanism: "A test with an unknown result gives a reason to wait for the verdict.",
    owes: "The result, including what surprised you.",
    leadChannel: "voice",
    bestFor: ["tech", "food", "fitness", "beauty", "home", "ecommerce"],
    failureModes: ["The result is known before it starts", "A rigged test"],
    angleBibleSlug: "skeptic-converted",
    evidence: "practice",
  },
  {
    id: "insider_reveal",
    name: "Insider reveal",
    mechanism: "How it works behind the curtain promises knowledge others do not have (social currency).",
    owes: "Something true the viewer could not see before.",
    leadChannel: "voice",
    bestFor: ["b2b", "finance", "food", "local", "education", "tech"],
    failureModes: ["The secret is common knowledge", "Claims of secrets the brief cannot support"],
    evidence: "practice",
  },
  {
    id: "fortune_teller",
    name: "Fortune teller",
    mechanism: "A prediction that something will change how the viewer works makes the future feel at stake now.",
    owes: "The change itself, specific enough to act on today.",
    leadChannel: "voice",
    bestFor: ["tech", "b2b", "education", "finance"],
    failureModes: ["A prediction the brief cannot support", "Hype with no specific change"],
    evidence: "practice",
  },
  {
    id: "proven_winner",
    name: "Proven winner",
    mechanism: "A result already achieved (this format got X) is proof in the first line, which the viewer can check against the video.",
    owes: "The exact thing that produced the result, shown.",
    leadChannel: "text",
    bestFor: ["b2b", "education", "ecommerce", "finance", "fitness"],
    failureModes: ["A result that is not the brand's or the brief's", "A result with no method behind it"],
    evidence: "practice",
  },
  {
    id: "connector",
    name: "Connector",
    mechanism: "Linking two things that seem unrelated (what does South Park have in common with your captions?) opens a gap only the link closes.",
    owes: "The link, and why it matters for the viewer.",
    leadChannel: "voice",
    bestFor: "all",
    failureModes: ["A forced link", "A link explained before the viewer wants it"],
    evidence: "practice",
  },
  {
    id: "desire_outcome",
    name: "Desire",
    mechanism: "An outcome the viewer secretly wants, tied to a relatable character, draws people who want the result rather than tips.",
    owes: "A non-obvious path to the outcome.",
    leadChannel: "text",
    bestFor: ["b2b", "fitness", "finance", "beauty", "education"],
    failureModes: ["An outcome the brief cannot support", "An info tease (3 hacks) instead of an outcome"],
    evidence: "practice",
  },
  {
    id: "pattern_interrupt",
    name: "Pattern interrupt",
    mechanism: "A picture that does not belong, with a sound that matches it (a snap, a crack, a loud first line), in one or two seconds, breaks the scroll before thought.",
    owes: "A fast turn from the interrupt into the topic.",
    leadChannel: "picture",
    bestFor: "all",
    failureModes: ["The interrupt has no matching sound", "It runs past two seconds", "The same interrupt every video"],
    evidence: "practice",
  },
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Formats (framework 5.6). Beat skeletons as fractions of the duration. A reference's measured grammar overrides a skeleton.

export const FORMAT_IDS = [
  "listicle",
  "s_tier_ranking",
  "three_levels",
  "story",
  "hero_journey",
  "epiphany",
  "tutorial",
  "transformation",
  "myth_vs_fact",
  "test_experiment",
  "scenario",
  "case_study",
  "live_breakdown",
  "pov_skit",
  "pov_through_my_eyes",
  "metaphor_explainer",
  "whiteboard_reveal",
  "reaction_commentary",
  "comparison",
  "behind_the_scenes",
  "extremes",
  "satisfying_process",
] as const;
export const formatIdSchema = z.enum(FORMAT_IDS);
export type FormatId = z.infer<typeof formatIdSchema>;

/**
 * The format pyramid (Kallaway): facts at the base (the largest audiences), then explanation, application and stories. As a niche
 * saturates, the lower levels stop outperforming first; application and one-of-one stories hold up longest. `practice`.
 */
export const FORMAT_LEVELS = ["facts", "explanation", "application", "story"] as const;
export type FormatLevel = (typeof FORMAT_LEVELS)[number];

export type SkeletonBeat = { role: BeatRole; from: number; to: number; job: string };
export type FormatArchetype = {
  id: FormatId;
  name: string;
  level: FormatLevel;
  beats: readonly SkeletonBeat[];
  endsWith: string;
  /** What makes the format work, from the lessons and practice. */
  notes?: string;
  evidence: EvidenceLabel;
};

/**
 * The core short-form template (Kallaway): hook, lock-in zone, body block, rehook, body block, rehook, an optional third block and close,
 * and a call to action aligned to the topic when the video's job is to convert. The skeletons below follow it: the lock-in is the beat
 * after the hook, and a rehook (a twist) sits near the middle, where a short video's attention runs out (the hourglass).
 */
export const CORE_TEMPLATE = ["hook", "lock_in", "body_1", "rehook_1", "body_2", "rehook_2", "body_3", "closing", "cta"] as const;

export const FORMAT_ARCHETYPES: readonly FormatArchetype[] = [
  {
    id: "listicle",
    name: "Listicle",
    level: "facts",
    beats: [
      { role: "hook", from: 0, to: 0.08, job: "Name the list's outcome for the viewer, with context in the first line." },
      { role: "setup", from: 0.08, to: 0.18, job: "Lock in: tease the proof or the transformation the points add up to." },
      { role: "item", from: 0.18, to: 0.38, job: "The best point first, in one or two sentences tied to the outcome." },
      { role: "item", from: 0.38, to: 0.55, job: "The second-best point." },
      { role: "twist", from: 0.55, to: 0.62, job: "Rehook: name what the viewer is thinking, then turn to the next thing." },
      { role: "item", from: 0.62, to: 0.88, job: "Points three and four (to six at most)." },
      { role: "payoff", from: 0.88, to: 1, job: "Close on the outcome the points add up to." },
    ],
    endsWith: "The outcome, said in one line.",
    notes: "Three to six points, the best two first so the viewer is paid before attention runs out. Each point is tied back to the objective.",
    evidence: "practice",
  },
  {
    id: "s_tier_ranking",
    name: "S-tier ranking",
    level: "facts",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "Open with a beloved item at a controversial low tier." },
      { role: "setup", from: 0.1, to: 0.18, job: "Lock in: what is being ranked and by what standard." },
      { role: "item", from: 0.18, to: 0.45, job: "The low tiers, the commentary doing the work." },
      { role: "twist", from: 0.45, to: 0.55, job: "Rehook: a surprising placement." },
      { role: "item", from: 0.55, to: 0.8, job: "The high tiers, the top held back." },
      { role: "payoff", from: 0.8, to: 1, job: "The S tier, revealed last, and why." },
    ],
    endsWith: "The S tier, then the full board.",
    notes: "A progressive reveal: hold the top tiers open. Pick a category nobody has ranked (outdoor stadiums, not team logos); the commentary is the draw.",
    evidence: "practice",
  },
  {
    id: "three_levels",
    name: "Three levels",
    level: "facts",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "Name the three levels of one thing (level 3 is what nobody does)." },
      { role: "setup", from: 0.1, to: 0.18, job: "Lock in: the through-line every level is judged on." },
      { role: "item", from: 0.18, to: 0.4, job: "Level 1: what most viewers already do (bury the lead)." },
      { role: "item", from: 0.4, to: 0.62, job: "Level 2." },
      { role: "twist", from: 0.62, to: 0.7, job: "Rehook: the gap between level 2 and level 3." },
      { role: "payoff", from: 0.7, to: 1, job: "Level 3." },
    ],
    endsWith: "Level 3, then the through-line once more.",
    notes: "Use a category people have opinions on (grandma's recipe), and keep one through-line commented on at every level.",
    evidence: "practice",
  },
  {
    id: "story",
    name: "Story",
    level: "story",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "Start at 70 out of 100: dropped into a story already in motion." },
      { role: "setup", from: 0.1, to: 0.25, job: "Who wants what, in one breath; spike to 90 with a contrast or a stat." },
      { role: "twist", from: 0.25, to: 0.5, job: "But: the obstacle." },
      { role: "twist", from: 0.5, to: 0.75, job: "Therefore: a bigger obstacle, or the turn. A new peak every 20 to 30 seconds." },
      { role: "payoff", from: 0.75, to: 1, job: "The resolution that pays the opening line." },
    ],
    endsWith: "The resolution, ending on the opening line's meaning, now changed.",
    notes: "The modern story arc: the classic slow rise loses viewers before it starts. Stakes, the big question, a headfake, then a rehook, cascaded.",
    evidence: "practice",
  },
  {
    id: "hero_journey",
    name: "Hero's journey",
    level: "story",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "The low point, or the result, first." },
      { role: "setup", from: 0.1, to: 0.22, job: "Who, and what they wanted." },
      { role: "twist", from: 0.22, to: 0.45, job: "The obstacle." },
      { role: "twist", from: 0.45, to: 0.7, job: "The turning point." },
      { role: "payoff", from: 0.7, to: 1, job: "The transformation, and the lesson the viewer can use." },
    ],
    endsWith: "The lesson, in one line.",
    evidence: "practice",
  },
  {
    id: "epiphany",
    name: "Personal epiphany",
    level: "story",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "The realisation, stated as a contrarian line." },
      { role: "setup", from: 0.1, to: 0.25, job: "What I believed before." },
      { role: "twist", from: 0.25, to: 0.5, job: "The moment it broke." },
      { role: "proof", from: 0.5, to: 0.75, job: "What changed, shown." },
      { role: "payoff", from: 0.75, to: 1, job: "The new rule." },
    ],
    endsWith: "The new rule.",
    evidence: "practice",
  },
  {
    id: "tutorial",
    name: "Tutorial",
    level: "explanation",
    beats: [
      { role: "hook", from: 0, to: 0.12, job: "The result first, or the mistake most people make." },
      { role: "setup", from: 0.12, to: 0.2, job: "Lock in: what you need, as fast as possible, and the proof it works." },
      { role: "item", from: 0.2, to: 0.45, job: "The steps, each shown." },
      { role: "item", from: 0.45, to: 0.7, job: "The step that surprises: the reason this method works." },
      { role: "proof", from: 0.7, to: 0.85, job: "Proof that it works, shown." },
      { role: "payoff", from: 0.85, to: 1, job: "The result again, better than the opening promised." },
    ],
    endsWith: "The finished result, matching the first frame.",
    notes: "Small effort, big reward: one setting, two small things. Show the specific inputs on screen so the video is worth saving.",
    evidence: "practice",
  },
  {
    id: "transformation",
    name: "Transformation",
    level: "application",
    beats: [
      { role: "hook", from: 0, to: 0.12, job: "The after, or the gap between before and after." },
      { role: "setup", from: 0.12, to: 0.25, job: "The before, honestly." },
      { role: "item", from: 0.25, to: 0.6, job: "The process, compressed." },
      { role: "twist", from: 0.6, to: 0.72, job: "The setback." },
      { role: "payoff", from: 0.72, to: 1, job: "The after, revealed fully." },
    ],
    endsWith: "The reveal, then a cut back to the before.",
    evidence: "practice",
  },
  {
    id: "myth_vs_fact",
    name: "Myth versus fact",
    level: "facts",
    beats: [
      { role: "hook", from: 0, to: 0.12, job: "The myth, stated as the viewer believes it: the villain." },
      { role: "proof", from: 0.12, to: 0.4, job: "Why people believe it, and the first crack." },
      { role: "twist", from: 0.4, to: 0.6, job: "What is actually true." },
      { role: "proof", from: 0.6, to: 0.82, job: "Evidence the viewer can check." },
      { role: "payoff", from: 0.82, to: 1, job: "What to do instead." },
    ],
    endsWith: "The new rule, said in one line.",
    evidence: "practice",
  },
  {
    id: "test_experiment",
    name: "Challenge or test",
    level: "application",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "The question and the stakes." },
      { role: "setup", from: 0.1, to: 0.2, job: "The setup, fast." },
      { role: "item", from: 0.2, to: 0.5, job: "The attempt." },
      { role: "twist", from: 0.5, to: 0.65, job: "Something unexpected happens." },
      { role: "proof", from: 0.65, to: 0.85, job: "The result, shown." },
      { role: "payoff", from: 0.85, to: 1, job: "The verdict." },
    ],
    endsWith: "The verdict, in one line.",
    evidence: "practice",
  },
  {
    id: "scenario",
    name: "Scenario or hypothetical",
    level: "application",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "The scenario and what is at stake: if you had X, here is what I would do." },
      { role: "setup", from: 0.1, to: 0.2, job: "The constraints, fast." },
      { role: "item", from: 0.2, to: 0.45, job: "The first move, and why." },
      { role: "twist", from: 0.45, to: 0.6, job: "The complication most people would not see." },
      { role: "item", from: 0.6, to: 0.8, job: "The expert move." },
      { role: "payoff", from: 0.8, to: 1, job: "The result, or the principle the viewer can reuse." },
    ],
    endsWith: "The principle.",
    notes: "Application content: skill proven on camera, which builds trust that lists of tips no longer do.",
    evidence: "practice",
  },
  {
    id: "case_study",
    name: "Case study",
    level: "application",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "The result first." },
      { role: "proof", from: 0.1, to: 0.2, job: "Lock in: the numbers, from the brief." },
      { role: "setup", from: 0.2, to: 0.35, job: "Where it started: the problem." },
      { role: "item", from: 0.35, to: 0.6, job: "What was done, step by step." },
      { role: "twist", from: 0.6, to: 0.72, job: "What nearly failed." },
      { role: "payoff", from: 0.72, to: 1, job: "The takeaway the viewer can use." },
    ],
    endsWith: "The takeaway.",
    evidence: "practice",
  },
  {
    id: "live_breakdown",
    name: "Live breakdown",
    level: "application",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "The thing being broken down, and a verdict teased." },
      { role: "setup", from: 0.1, to: 0.2, job: "What to look for." },
      { role: "item", from: 0.2, to: 0.45, job: "The first observation." },
      { role: "twist", from: 0.45, to: 0.6, job: "The non-obvious detail." },
      { role: "item", from: 0.6, to: 0.8, job: "The fix." },
      { role: "payoff", from: 0.8, to: 1, job: "The verdict." },
    ],
    endsWith: "The verdict.",
    evidence: "practice",
  },
  {
    id: "pov_skit",
    name: "POV skit",
    level: "story",
    beats: [
      { role: "hook", from: 0, to: 0.12, job: "The POV caption and the situation, already in motion." },
      { role: "setup", from: 0.12, to: 0.3, job: "The recognisable behaviour." },
      { role: "twist", from: 0.3, to: 0.55, job: "It gets worse." },
      { role: "twist", from: 0.55, to: 0.8, job: "It gets worse in an unexpected way." },
      { role: "payoff", from: 0.8, to: 1, job: "The punchline or the flip." },
    ],
    endsWith: "The punchline, then straight back into the first frame.",
    evidence: "practice",
  },
  {
    id: "pov_through_my_eyes",
    name: "Through my eyes",
    level: "story",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "First-person view, already mid-action, with motion." },
      { role: "item", from: 0.1, to: 0.4, job: "The craft, close." },
      { role: "item", from: 0.4, to: 0.65, job: "The craft, closer." },
      { role: "twist", from: 0.65, to: 0.78, job: "The hard part." },
      { role: "payoff", from: 0.78, to: 1, job: "The finish." },
    ],
    endsWith: "The finish, from the same eyes.",
    notes: "A change of perspective plus motion; open to any physical craft. Transposed from sports, where it won.",
    evidence: "practice",
  },
  {
    id: "metaphor_explainer",
    name: "Explainer with a visual metaphor",
    level: "explanation",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "An impossible image that is the metaphor." },
      { role: "setup", from: 0.1, to: 0.25, job: "The question the metaphor answers." },
      { role: "item", from: 0.25, to: 0.5, job: "The first part of the mechanism, shown through the metaphor." },
      { role: "item", from: 0.5, to: 0.72, job: "The second part." },
      { role: "twist", from: 0.72, to: 0.85, job: "What it means for the viewer." },
      { role: "payoff", from: 0.85, to: 1, job: "The insight, in one picture." },
    ],
    endsWith: "The metaphor, completed.",
    notes: "Anchor the new idea to something familiar, and say it twice: once precisely, once in plain words.",
    evidence: "practice",
  },
  {
    id: "whiteboard_reveal",
    name: "Whiteboard reveal",
    level: "explanation",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "A covered board and the question it answers." },
      { role: "setup", from: 0.1, to: 0.2, job: "Lock in: the title, and what is at stake." },
      { role: "item", from: 0.2, to: 0.45, job: "The first part revealed." },
      { role: "twist", from: 0.45, to: 0.55, job: "Rehook: the part most people get wrong." },
      { role: "item", from: 0.55, to: 0.8, job: "The second part revealed." },
      { role: "payoff", from: 0.8, to: 1, job: "The whole board." },
    ],
    endsWith: "The whole board, held long enough to save.",
    notes: "Start covered and reveal bit by bit: a natural curiosity loop. Pre-write the points so the voice gets to value fast.",
    evidence: "practice",
  },
  {
    id: "reaction_commentary",
    name: "Reaction or commentary",
    level: "explanation",
    beats: [
      { role: "hook", from: 0, to: 0.12, job: "The moment being reacted to, or the take, said first." },
      { role: "setup", from: 0.12, to: 0.3, job: "The context, fast." },
      { role: "item", from: 0.3, to: 0.6, job: "The take, with its reason." },
      { role: "twist", from: 0.6, to: 0.8, job: "What everyone missed." },
      { role: "payoff", from: 0.8, to: 1, job: "The conclusion." },
    ],
    endsWith: "The conclusion, and an honest open question.",
    notes: "Original footage only: the moment is described or recreated, never a clip of someone else's video (copy genes, never content).",
    evidence: "practice",
  },
  {
    id: "comparison",
    name: "A versus B",
    level: "facts",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "A very common habit on the bad side, against the better way." },
      { role: "item", from: 0.1, to: 0.35, job: "A, at its best or its most common." },
      { role: "item", from: 0.35, to: 0.6, job: "B." },
      { role: "twist", from: 0.6, to: 0.75, job: "The deciding factor nobody checks." },
      { role: "payoff", from: 0.75, to: 1, job: "The verdict, and why: the explained perspective." },
    ],
    endsWith: "The verdict.",
    notes: "Compare what matters most to the viewer; put a common habit first on the bad side (speed to shock); always explain why.",
    evidence: "practice",
  },
  {
    id: "behind_the_scenes",
    name: "Show the factory",
    level: "application",
    beats: [
      { role: "hook", from: 0, to: 0.12, job: "The finished thing, or the strangest part of the process." },
      { role: "setup", from: 0.12, to: 0.25, job: "Where we are and what is being made." },
      { role: "item", from: 0.25, to: 0.5, job: "The process." },
      { role: "item", from: 0.5, to: 0.75, job: "The detail only insiders know." },
      { role: "payoff", from: 0.75, to: 1, job: "The finished thing, now understood." },
    ],
    endsWith: "The finished thing.",
    evidence: "practice",
  },
  {
    id: "extremes",
    name: "Extremes",
    level: "application",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "The extreme: the dirtiest, biggest, oldest, worst." },
      { role: "setup", from: 0.1, to: 0.2, job: "How it got this way." },
      { role: "item", from: 0.2, to: 0.5, job: "The work." },
      { role: "twist", from: 0.5, to: 0.65, job: "What went wrong." },
      { role: "payoff", from: 0.65, to: 1, job: "The result." },
    ],
    endsWith: "The result, against the first frame.",
    evidence: "practice",
  },
  {
    id: "satisfying_process",
    name: "Satisfying process",
    level: "application",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "The process already moving." },
      { role: "item", from: 0.1, to: 0.4, job: "The process, with rhythm." },
      { role: "item", from: 0.4, to: 0.7, job: "The process, closer." },
      { role: "twist", from: 0.7, to: 0.8, job: "A near-fail." },
      { role: "payoff", from: 0.8, to: 1, job: "The finish, clean." },
    ],
    endsWith: "The finish, seamed into the start.",
    evidence: "practice",
  },
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Emotions, share triggers and rewatch devices (framework 1.4, 6, 7, 8).

export const EMOTION_IDS = ["awe", "amusement", "surprise", "tension", "righteous_anger", "inspiration", "relief", "belonging", "nostalgia", "sadness"] as const;
export const emotionIdSchema = z.enum(EMOTION_IDS);
export type EmotionId = z.infer<typeof emotionIdSchema>;

export type Emotion = { id: EmotionId; arousal: "high" | "medium" | "low"; spreads: boolean; caution?: string; evidence: EvidenceLabel };

export const EMOTIONS: readonly Emotion[] = [
  { id: "awe", arousal: "high", spreads: true, evidence: "sourced" },
  { id: "amusement", arousal: "high", spreads: true, evidence: "sourced" },
  { id: "surprise", arousal: "high", spreads: true, evidence: "sourced" },
  { id: "tension", arousal: "high", spreads: true, caution: "Resolve it; anxiety with no resolution reads as fear-mongering.", evidence: "sourced" },
  {
    id: "righteous_anger",
    arousal: "high",
    spreads: true,
    caution: "Only against a problem or a status quo, never a person or a group, and only where the brand's policy allows it.",
    evidence: "sourced",
  },
  { id: "inspiration", arousal: "medium", spreads: true, evidence: "hypothesis" },
  { id: "relief", arousal: "medium", spreads: true, evidence: "practice" },
  { id: "belonging", arousal: "medium", spreads: true, evidence: "practice" },
  { id: "nostalgia", arousal: "low", spreads: false, evidence: "hypothesis" },
  { id: "sadness", arousal: "low", spreads: false, caution: "Sadness on its own reduces sharing; turn it into resolve or relief.", evidence: "sourced" },
];

export const SHARE_TRIGGER_IDS = ["identity", "relationship", "utility", "status", "emotion", "conversation"] as const;
export const shareTriggerIdSchema = z.enum(SHARE_TRIGGER_IDS);
export type ShareTriggerId = z.infer<typeof shareTriggerIdSchema>;

export const SHARE_TRIGGERS: readonly { id: ShareTriggerId; test: string; evidence: EvidenceLabel }[] = [
  { id: "identity", test: "Sending it says something about the sender: this is me.", evidence: "sourced" },
  { id: "relationship", test: "It names a shared experience: this is us.", evidence: "practice" },
  { id: "utility", test: "The receiver will use it: you need this.", evidence: "sourced" },
  { id: "status", test: "The sender looks informed for finding it first.", evidence: "sourced" },
  { id: "emotion", test: "The feeling is too strong to keep: you have to see this.", evidence: "sourced" },
  { id: "conversation", test: "It starts an argument worth having: what do you think?", evidence: "practice" },
];

export const REWATCH_DEVICE_IDS = ["loop_seam", "recontextualising_twist", "detail_hunt", "pace_over_one_view", "satisfying_form", "hidden_reveal"] as const;
export const rewatchDeviceIdSchema = z.enum(REWATCH_DEVICE_IDS);
export type RewatchDeviceId = z.infer<typeof rewatchDeviceIdSchema>;

export const REWATCH_DEVICES: readonly { id: RewatchDeviceId; how: string; evidence: EvidenceLabel }[] = [
  { id: "loop_seam", how: "The last line or frame runs into the first, so the video restarts before the viewer decides to leave.", evidence: "practice" },
  { id: "recontextualising_twist", how: "The payoff changes what the opening meant, so the opening is worth seeing again.", evidence: "hypothesis" },
  { id: "detail_hunt", how: "More detail on screen than one viewing takes in, and a reason to look for it.", evidence: "hypothesis" },
  { id: "pace_over_one_view", how: "Slightly faster than one viewing can follow, and rewarding enough to repeat.", evidence: "hypothesis" },
  { id: "satisfying_form", how: "A perfect cut, a process, a sound on the beat: pleasure in the form itself.", evidence: "practice" },
  { id: "hidden_reveal", how: "Something was visible from the start and is only pointed out at the end.", evidence: "hypothesis" },
];

// ---------------------------------------------------------------------------------------------------------------------------------
// The Lean-In Score (framework 3).

export const RUBRIC_IDS = [
  "stop_frame",
  "promise",
  "gap",
  "clarity",
  "proof",
  "escalation",
  "density",
  "specificity",
  "novelty",
  "emotion",
  "payoff",
  "rewatch",
  "send",
  "save_comment",
] as const;
export const rubricIdSchema = z.enum(RUBRIC_IDS);
export type RubricId = z.infer<typeof rubricIdSchema>;

export type RubricDimension = {
  id: RubricId;
  group: "stop" | "hold" | "payoff" | "spread";
  name: string;
  four: string;
  zero: string;
  /** A prior weight (hypothesis). The weights sum to 1. The learning loop fits them to outcomes. */
  weight: number;
};

export const RUBRIC: readonly RubricDimension[] = [
  { id: "stop_frame", group: "stop", name: "First-frame stopping power", four: "Frame 0 stuns: motion, a face, contrast, a pattern interrupt with matching sound, or the result; it reads without sound.", zero: "A logo, a title card or a static establishing shot.", weight: 0.1 },
  { id: "promise", group: "stop", name: "Context and promise in the first line", four: "Line 1 names the topic on all three channels, and the viewer knows what they will get and why it is for them.", zero: "Context arrives late, or the promise is vague.", weight: 0.09 },
  { id: "gap", group: "stop", name: "A lean and a snapback", four: "The hook leans one way (a stat, a pain, a benefit) and snaps back the other: one concrete question the viewer now needs answered.", zero: "Nothing unresolved, or the answer is in the hook.", weight: 0.09 },
  { id: "clarity", group: "stop", name: "Simple, short, easy to follow", four: "Simple words, short sentences, one thread from the hook; a new idea is said twice (precisely, then plainly) and every picture matches its words.", zero: "Jargon, long sentences, a drifting thread, pictures that do not match.", weight: 0.07 },
  { id: "proof", group: "stop", name: "Proof early", four: "A claim is followed at once by proof the brief gives: a direct result, the effort spent, or a credible source.", zero: "A bold claim with no proof, or proof that is invented.", weight: 0.06 },
  { id: "escalation", group: "hold", name: "Each beat raises the stakes or pays a reward", four: "A but-and-therefore chain with a new peak every 20 to 30 seconds; each reveal beats the viewer's expectation.", zero: "A flat list, and-then, beats the viewer saw coming.", weight: 0.08 },
  { id: "density", group: "hold", name: "Value per second", four: "No dead air, no throat-clearing; two non-obvious ahas early; every line works.", zero: "Preamble, repetition, filler, nothing the viewer did not know.", weight: 0.07 },
  { id: "specificity", group: "hold", name: "Concrete over abstract", four: "Exact figures and time frames from the brief, named concepts, sensory detail, a picture for every line.", zero: "Categories, generalities, adjectives doing the work.", weight: 0.06 },
  { id: "novelty", group: "hold", name: "A non-obvious angle in a familiar container", four: "A contrarian core argument, against a named villain, in a format the viewer reads at once.", zero: "The obvious angle, seen before, or too strange to follow.", weight: 0.09 },
  { id: "emotion", group: "hold", name: "A felt peak", four: "Stakes the viewer cares about and a clear peak of awe, amusement, surprise or tension near the payoff.", zero: "Flat and informational.", weight: 0.06 },
  { id: "payoff", group: "payoff", name: "The payoff beats the promise", four: "It delivers more than promised, small effort for a big reward, at the right moment.", zero: "Late, small, or a different thing from the promise.", weight: 0.09 },
  { id: "rewatch", group: "payoff", name: "A reason to watch again", four: "A loop seam, a twist that recontextualises, more on screen than one viewing takes in.", zero: "Ends on an outro; nothing to go back for.", weight: 0.05 },
  { id: "send", group: "spread", name: "A reason to send it", four: "Surprising, contrarian or emotional enough for a group chat: this is so you.", zero: "Nobody to send it to; only agreeable enough to like.", weight: 0.06 },
  { id: "save_comment", group: "spread", name: "A reason to save, say something, or act", four: "Tactical detail worth keeping, a side worth arguing, or a native call to action aligned to the topic.", zero: "No utility, a comment request that is bait, or a CTA unrelated to the video.", weight: 0.03 },
];

/** The highest score of one rubric dimension. */
export const RUBRIC_MAX = 4;

// ---------------------------------------------------------------------------------------------------------------------------------
// Hook anatomy (framework 4; Kallaway lessons 1 to 18). All `practice` unless marked.

/** The triple hook: context first (on picture, text and voice), a lean one way, a snapback the other. */
export const TRIPLE_HOOK = [
  { step: "context", job: "Line 1 names the topic on all three channels, so the viewer knows at once whether the video is for them." },
  { step: "lean", job: "Pull the viewer one way: proof or a stat, a pain or a benefit, or something shocking." },
  { step: "snapback", job: "Yank them the other way with a contrarian turn: the question they now need answered." },
] as const;

export const LEAN_TYPES = ["proof", "pain", "benefit", "shock"] as const;

/** Hook alignment: the three channels say one thing. Readers decide from the text first, then the voice, then the picture (Kallaway). */
export const HOOK_CHANNEL_PRIORITY = ["text", "voice", "picture"] as const;

/** The power words of a hook: who, what they did, the state change, and the contrast between the start and the outcome (the strongest). */
export const POWER_WORD_ROLES = [
  { id: "subject", job: "Subject clarity: I, you, we." },
  { id: "action", job: "The action: had to grow, rebuilt, tested." },
  { id: "state_change", job: "The objective or state change: 0 to 100K subscribers." },
  { id: "contrast", job: "The contrast between the base state and the outcome, the most important." },
] as const;

/** The four S's that break the first view ceiling. */
export const FOUR_S = [
  { id: "subject", job: "It is clear what the video is about." },
  { id: "stakes", job: "There is a reason to keep watching." },
  { id: "simple", job: "Third-grade words." },
  { id: "short", job: "Punchy sentences." },
] as const;

/** The five ways to make a visual hook (the visual stun gun). */
export const VISUAL_HOOK_TYPES = ["overlay", "pattern_interrupt", "subject_motion", "visual_effect", "unique_visual"] as const;

/** Trust anchors in the hook's second line, strongest first. Each must come from the brief: an anchor is never invented. */
export const TRUST_ANCHOR_TYPES = ["direct_results", "effort_maxing", "credibility", "association"] as const;
export const trustAnchorTypeSchema = z.enum(TRUST_ANCHOR_TYPES);
export type TrustAnchorType = z.infer<typeof trustAnchorTypeSchema>;

/** The trust ladder: kinds of proof, strongest first. Demonstrated beats owned, and owned beats borrowed. */
export const TRUST_LADDER = [
  "proof_of_audience",
  "live_demonstration",
  "warm_group_testimonials",
  "personal_results",
  "borrowed_proof",
  "cold_testimonial",
  "third_party_verification",
] as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// Story structure (framework 5; lessons 19 to 49).

/** What the two or three sentences after the hook can do (the lock-in zone). */
export const LOCK_IN_APPROACHES = ["tease_proof", "tease_transformation", "clarifying_contrast", "magic_box", "handle_objection", "double_down"] as const;
export const lockInApproachSchema = z.enum(LOCK_IN_APPROACHES);
export type LockInApproach = z.infer<typeof lockInApproachSchema>;

/** The villain of an educational video: the old way, a false or outdated belief, or the shared negative feeling they cause. */
export const VILLAIN_TYPES = ["old_way", "false_belief", "shared_frustration"] as const;
export const villainTypeSchema = z.enum(VILLAIN_TYPES);
export type VillainType = z.infer<typeof villainTypeSchema>;

/** The dopamine loop, cascaded: stakes, the big question, a headfake, a rehook. */
export const DOPAMINE_LOOP = ["stakes", "big_question", "headfake", "rehook"] as const;

/** The dopamine ladder: what a viewer gets, in order. The top two come only from hitting the first four, video after video. */
export const DOPAMINE_LADDER = ["stimulation", "captivation", "anticipation", "validation", "affection", "revelation"] as const;

/** The story ladder: what each level adds. A direction agent writes at the architect level or above. */
export const STORY_LADDER = [
  { id: "reporter", adds: "Facts in a predictable order." },
  { id: "illusionist", adds: "Hooks and headfakes." },
  { id: "champion", adds: "Stakes: use cases, problems, characters." },
  { id: "architect", adds: "Arcs of tension and release, mini loops inside the story." },
  { id: "translator", adds: "Comprehension: reframes, matching pictures." },
  { id: "maestro", adds: "A signature, one-of-one style." },
] as const;

/** Where a story leaks viewers. The swipe test names the biggest one. */
export const FUNNEL_BLOCKERS = ["idea", "hook", "comprehension", "boredom", "takeaway", "none"] as const;
export const funnelBlockerSchema = z.enum(FUNNEL_BLOCKERS);
export type FunnelBlocker = z.infer<typeof funnelBlockerSchema>;

// ---------------------------------------------------------------------------------------------------------------------------------
// Spread (framework 7; lessons 79 to 81, 121 to 126).

/** Ways to be worth saving: saving is the same psychology as following. */
export const SAVE_DEVICES = [
  "Signal the outcome clearly.",
  "Show a lot of tactical detail on screen.",
  "Give more than a viewer can remember in one pass.",
  "Show the specific inputs: the prompt, the setup, the exact phrase.",
  "Remind the viewer of the outcome as you go.",
] as const;

/** Ways to earn comments without bait. */
export const COMMENT_DEVICES = [
  "Take the contrarian side instead of hedging.",
  "An extreme emotional ratchet, as plain opinion, inside the brand's policy.",
  "A prop that should not be there (it pulls the talk off-topic, so use it sparingly).",
] as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// What each video is for (framework 18; lessons 64 to 107).

/**
 * Every video has one job. Reach: shares to new viewers (broad audience, non-obvious angle). Follow: saves and binges (series,
 * tactical density). Convert: a narrow buyer pain, a desire hook, proof, and a call to action aligned to the topic.
 */
export const VIDEO_JOBS = ["reach", "follow", "convert"] as const;
export const videoJobSchema = z.enum(VIDEO_JOBS);
export type VideoJob = z.infer<typeof videoJobSchema>;

/** The five content games. Each wants a different strategy; pick the game before the plan. */
export const CONTENT_GAMES = ["entertainment_media", "education_media", "commodity_product", "explanatory_product", "authority_services"] as const;
export type ContentGame = (typeof CONTENT_GAMES)[number];

/** The virality stack: topic commonness x angle obviousness x audience breadth. The non-obvious angle is in every winner. */
export const VIRALITY_STACK = {
  reach: { angle: "non_obvious", audience: "broad" },
  follow: { angle: "non_obvious", audience: "broad" },
  convert: { angle: "non_obvious", audience: "narrow" },
} as const satisfies Record<VideoJob, { angle: "non_obvious"; audience: "broad" | "narrow" }>;

/** The four things everyone wants. Promise one degree away from them, or the claim trips the viewer's doubt. */
export const ONE_DEGREE_DESIRES = ["money", "time", "health", "access"] as const;

/** What to fix at each view ceiling (median views per video), lowest first. */
export const VIEW_CEILINGS = [
  { below: 1_000, fix: "Hook clarity and alignment: the four S's." },
  { below: 10_000, fix: "Topic selection: tie it to a pain or desire early, and align the pictures." },
  { below: 100_000, fix: "The angle: non-obvious but broadly relatable." },
  { below: 1_000_000, fix: "Controversy: a huge topic, or a narrow one with a strongly contrarian take." },
] as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// Rules by area (framework 4 to 10). The directives builder turns these into prompt text per role.

export const HOOK_RULES: readonly DirectionRule[] = [
  { id: "hook_first", text: "The hook is the first beat. No intro, greeting, logo or channel name before it.", evidence: "sourced", section: "4.3" },
  { id: "context_first", text: "Line 1 names the topic on picture, text and voice. Context that arrives even at the end of the first sentence raises the skip rate.", evidence: "practice", section: "4.4" },
  { id: "triple_hook", text: "Triple hook: context, then a lean (a stat or proof, a pain, a benefit, or a shock), then a contrarian snapback the other way.", evidence: "practice", section: "4.4" },
  { id: "opening_words", text: "Keep the first two sentences to 15 words at most.", evidence: "practice", section: "4.4" },
  { id: "promise_by_3s", text: "The promise is clear by 3 seconds, and the hook beat ends by 6 seconds.", evidence: "sourced", section: "4.3" },
  { id: "hook_aligned", text: "Text, voice and picture say the same thing. The text is read first, then the voice, then the picture: write the text hook first.", evidence: "practice", section: "4.1" },
  { id: "text_hook", text: "The text hook is a subject plus a pain, a dream outcome or a state change: specific (22 days, a figure from the brief), with power words, no filler or transition words, no punctuation but parentheses and quotes, at most two lines.", evidence: "practice", section: "4.1" },
  { id: "proof_loop", text: "A bold claim gets its proof at once, in line 2 or the lock-in: a direct result, the effort spent, or a credible source, from the brief only.", evidence: "practice", section: "4.2" },
  { id: "declarative", text: "Say it as a fact: 'Do Y to get X', never 'If you want X, you should do Y'.", evidence: "practice", section: "9" },
  { id: "hook_withholds", text: "The hook does not answer its own question; the answer comes in the last part.", evidence: "hypothesis", section: "4.3" },
  { id: "hook_true", text: "Every promise in the hook is kept by a later beat. Name the beat that pays it.", evidence: "hypothesis", section: "4.2" },
  { id: "hook_three_channels", text: "Write the hook on three channels: frame 0 (motion, a face, contrast or the result), at most 7 on-screen words that frame the question, and a first spoken line that raises the stakes.", evidence: "practice", section: "4.1" },
  { id: "desire_not_tips", text: "Lead with an outcome the viewer wants, one degree from money, time, health or access, not an info tease like 3 hacks.", evidence: "practice", section: "4.3" },
  { id: "hook_new", text: "A new hook every video: never a near-repeat of the brand's recent hooks.", evidence: "hypothesis", section: "4.3" },
];

export const RETENTION_RULES: readonly DirectionRule[] = [
  { id: "lock_in", text: "The two or three sentences after the hook are the lock-in: tease the proof or the transformation, add a clarifying contrast, name a method (a magic box), answer the top objection, or double down and twist the pain.", evidence: "practice", section: "5.1" },
  { id: "double_hook", text: "Rehook with extra contrast within the first 15 seconds: a second loop or a headfake.", evidence: "practice", section: "5.3" },
  { id: "hourglass", text: "Attention runs about 25 seconds. Build the first part on the core insight (what it is), then flip to a second part (how to do it) with a turn that opens a new loop. A new peak every 20 to 30 seconds.", evidence: "practice", section: "5.3" },
  { id: "but_therefore", text: "Join beats with but or therefore, not and then. Two plain additions in a row are a warning.", evidence: "practice", section: "5.1" },
  { id: "anticipation", text: "Open a question, load the tension with examples and proof before the answer, then open the next one. Two or three loops a video.", evidence: "practice", section: "5.4" },
  { id: "beat_expectations", text: "Each beat beats the viewer's expectation. Of 100 viewers, how many would be surprised by this next line? Pick the most surprising true line.", evidence: "practice", section: "5.2" },
  { id: "villain", text: "An educational video has a villain: the old way, a false belief, or the shared frustration they cause. Attack it throughout.", evidence: "practice", section: "5.2" },
  { id: "double_aha", text: "Front-load two non-obvious lightbulb moments, in the hook, the lock-in or the first two body blocks.", evidence: "practice", section: "5.2" },
  { id: "escalate", text: "Order the material so the stakes rise; in a list, put the best two points first; in a ranking, hold the top back.", evidence: "practice", section: "5.2" },
  { id: "storyflow", text: "Every sentence builds on the last and stays tied to the hook's subject. A drift snaps the thread.", evidence: "practice", section: "5.1" },
  { id: "rehook", text: "No stretch longer than 7 seconds without a story or visual change.", evidence: "hypothesis", section: "5.3" },
  { id: "loops_close", text: "Every loop that opens closes.", evidence: "hypothesis", section: "5.4" },
  { id: "density", text: "Cut the first sentence of every draft. No dead air, no repetition. As long as the payoff needs and no longer.", evidence: "practice", section: "5.5" },
];

export const END_RULES: readonly DirectionRule[] = [
  { id: "end_first", text: "Write the last line and the last frame before the middle.", evidence: "practice", section: "6" },
  { id: "loop_seam", text: "Where it fits, let the last line run into the first, or the last frame match the first.", evidence: "practice", section: "6" },
  { id: "no_outro", text: "No outro: no thanks for watching, no follow for more, no end card in an organic video.", evidence: "practice", section: "6" },
  { id: "peak_end", text: "End on or just after the emotional peak, never on a decline.", evidence: "sourced", section: "6" },
];

export const SPREAD_RULES: readonly DirectionRule[] = [
  { id: "send_reason", text: "Shares reach new viewers and come from the surprising, the contrarian and the emotional; likes come from agreement. Name who the video gets sent to and why.", evidence: "sourced", section: "7" },
  { id: "save_reason", text: "Saves turn into follows: signal the outcome, show tactical detail and the exact inputs on screen, give more than one pass can hold, and remind the viewer of the outcome.", evidence: "practice", section: "7" },
  { id: "comment_reason", text: "Earn comments by taking the contrarian side, not by asking for them.", evidence: "practice", section: "7" },
  { id: "native_cta", text: "A video whose job is to convert ends with one call to action aligned to its topic, framed as a favour: a keyword for a resource the brief names. Never a generic follow request.", evidence: "practice", section: "7" },
  { id: "no_bait", text: "No engagement bait: no comment-YES, tag-a-friend, like-if or share-if requests.", evidence: "sourced", section: "7" },
];

export const EMOTION_RULES: readonly DirectionRule[] = [
  { id: "one_feeling", text: "Choose one dominant feeling before writing.", evidence: "practice", section: "8" },
  { id: "stakes", text: "Give the viewer stakes: a character to root for, something at risk, a reason it matters now.", evidence: "practice", section: "8" },
  { id: "high_arousal", text: "Prefer awe, amusement, surprise or tension; sadness alone does not spread. Anger only at a problem, never a person or group.", evidence: "sourced", section: "8" },
  { id: "benign_violation", text: "Humour comes from a specific truth the audience recognises, a norm broken safely. Never a stock joke.", evidence: "sourced", section: "8" },
  { id: "story_over_list", text: "A person, a want and an obstacle persuade more than a list of benefits.", evidence: "sourced", section: "8" },
];

export const SCRIPT_RULES: readonly DirectionRule[] = [
  { id: "four_s", text: "Subject, stakes, simple, short: third-grade words and punchy sentences.", evidence: "practice", section: "9" },
  { id: "zig_zag", text: "Zig-zag the rhythm: mix short, medium and long sentences, with short punchy resets. A run of same-length sentences is a flat line.", evidence: "practice", section: "9" },
  { id: "double_tap", text: "Say a new or complex idea twice: once precisely, then again in plain words or a metaphor.", evidence: "practice", section: "9" },
  { id: "anchor_terms", text: "Explain a new concept by linking it to something familiar.", evidence: "practice", section: "9" },
  { id: "specific", text: "Specific beats general: exact figures and a time frame from the brief, and named concepts. When the brief gives no figure, use a concrete picture, never an invented fact.", evidence: "practice", section: "9" },
  { id: "small_effort", text: "Frame the solution as small (one setting, two small things) and the reward as big.", evidence: "practice", section: "9" },
  { id: "timeline", text: "Write the timeline, not a paragraph: each beat has a role, a duration, a voice line, on-screen text and a picture.", evidence: "hypothesis", section: "9" },
  { id: "picture_per_line", text: "Every line has a picture, and the picture matches the words.", evidence: "practice", section: "9" },
  { id: "start_late", text: "Start at the first interesting moment; end on the payoff.", evidence: "practice", section: "9" },
  { id: "ear", text: "Write for the ear: one idea a sentence, words people say aloud.", evidence: "practice", section: "9" },
  { id: "one_reader", text: "Talk to one person, in their own words, taken from the brief's sources.", evidence: "practice", section: "9" },
  { id: "term_branding", text: "Name your best idea, so two words replace a sentence and the credit comes back to the brand.", evidence: "practice", section: "9" },
  { id: "no_ai_register", text: "No AI register: no delve, unlock, elevate, game-changer, in today's fast-paced world, it's not X it's Y, or stacked dashes.", evidence: "sourced", section: "11" },
  { id: "contrast", text: "Use contrast: before and after, expected and actual, the villain and the better way.", evidence: "practice", section: "9" },
];

export const VISUAL_RULES: readonly DirectionRule[] = [
  { id: "frame_zero", text: "Choose frame 0 on purpose: motion, a face, contrast or the result. It is the video's thumbnail in the feed.", evidence: "practice", section: "10.1" },
  { id: "stun_gun", text: "Make the first one or two seconds stun: an overlay, a pattern interrupt, subject motion, a visual effect, or a picture nobody else would choose.", evidence: "practice", section: "10.1" },
  { id: "interrupt_sound", text: "A pattern interrupt has a matching sound (a snap, a crack, a loud first line) and lasts one or two seconds. Rotate two or three interrupts so they stay fresh.", evidence: "practice", section: "10.1" },
  { id: "text_hook_place", text: "Put the text hook about a third down from the top, in a plain readable font, at most two lines broken at natural phrases, never over eyes or mouth.", evidence: "practice", section: "10.1" },
  { id: "match_words", text: "Match the picture to the words, word for word where it can; start broad and high, then narrow in.", evidence: "practice", section: "10.1" },
  { id: "intentional_motion", text: "Move with intention: a talking head changes position or setting between beats, never one static shot.", evidence: "practice", section: "10.1" },
  { id: "change_on_beat", text: "Cut, punch in or change angle at each turn of the script.", evidence: "practice", section: "10.1" },
  { id: "illustrate", text: "Every shot illustrates its words, literally or laterally. No decorative shots.", evidence: "practice", section: "10.1" },
  { id: "texture", text: "Ask for real light, real wear and texture; avoid the glossy, symmetrical, over-saturated generated look. Real product imagery always.", evidence: "practice", section: "10.1" },
  { id: "series_look", text: "A series keeps one look (set, light, framing) so viewers recognise it among thousands of videos.", evidence: "practice", section: "10.1" },
  { id: "no_generated_text", text: "No text, label, price or logo in a generation prompt: code draws text.", evidence: "sourced", section: "10.1" },
  { id: "safe_zone", text: "Keep key content out of the lower fifth and the right twelfth of the frame.", evidence: "practice", section: "10.1" },
];

export const SOUND_RULES: readonly DirectionRule[] = [
  { id: "voice_power", text: "Speak about 20% more powerfully than feels natural: recordings sound thinner than the voice in your head.", evidence: "practice", section: "10.3" },
  { id: "voice_performs", text: "Vary the pace, pause before the reveal, stress the one word that matters.", evidence: "practice", section: "10.3" },
  { id: "interrupt_audio", text: "Give the first frame a sound that matches it.", evidence: "practice", section: "10.3" },
  { id: "music_curve", text: "Music rises into the peak and drops under the key line.", evidence: "practice", section: "10.3" },
  { id: "sound_marks_cut", text: "Mark a turn of the story with a sound or a half-second of silence.", evidence: "practice", section: "10.3" },
  { id: "sound_off", text: "On-screen text carries the story for a viewer with the sound off.", evidence: "sourced", section: "10.3" },
];

export const TRUST_RULES: readonly DirectionRule[] = [
  { id: "no_invented_claims", text: "Never invent a claim, number, result, testimonial, person, endorsement or trend. Every proof and every trust anchor comes from the brief.", evidence: "sourced", section: "0" },
  { id: "promise_kept", text: "No bait-and-switch: the payoff is the thing the hook promised.", evidence: "hypothesis", section: "3.1" },
  { id: "no_fake_urgency", text: "No fake urgency, fake scarcity or fake confession.", evidence: "hypothesis", section: "3.1" },
  { id: "original", text: "Copy genes, never content: no words, footage, voice or music of a reference or another creator's video.", evidence: "sourced", section: "3.1" },
];

/** What a video is for and how it fits the account (framework 18). The agent and the planner read these. */
export const STRATEGY_RULES: readonly DirectionRule[] = [
  { id: "one_job", text: "Give every video one job: reach new viewers (shares), earn follows (saves, a binge), or convert (a lead).", evidence: "practice", section: "18" },
  { id: "idea_first", text: "The idea is the cake: a relevant, painful topic with a large audience, and a non-obvious, contrarian angle you can act on. Hook, edit and style are icing.", evidence: "practice", section: "18" },
  { id: "dct", text: "Data picks the topic, creativity picks the angle, and formats are transposed from other niches where they already won.", evidence: "practice", section: "18" },
  { id: "virality_stack", text: "For reach: a non-obvious angle for a broad audience. To convert: a non-obvious angle for a narrow one. Never the obvious angle.", evidence: "practice", section: "18" },
  { id: "broad_to_narrow", text: "A broad hook, a moderate explanation, a narrow takeaway: people outside the buyer drop off late, which is fine.", evidence: "practice", section: "18" },
  { id: "lawyer", text: "State the core argument (what the brand believes that most people do not), then bring the best evidence the brief gives.", evidence: "practice", section: "18" },
  { id: "relevant_novel_interesting", text: "Relevant to the viewer's pain or desire, novel (new, or an old idea in a new frame), and interesting (stakes, or close to the pain).", evidence: "practice", section: "18" },
  { id: "format_pyramid", text: "As a niche saturates, facts and lists stop working first; prefer application (scenarios, case studies, challenges) and one-of-one stories.", evidence: "practice", section: "18" },
  { id: "high_effort", text: "Easy formats need more polish, insight and detail than before: the low-effort versions are oversupplied.", evidence: "practice", section: "18" },
  { id: "winners_first", text: "Remix the brand's own winners first: change one brick (topic, angle, format, hook or visuals) at a time.", evidence: "practice", section: "18" },
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Where AI fails (framework 11).

export const CHECK_IDS = [
  "beat_ids",
  "slop_lexicon",
  "stock_hook",
  "preamble",
  "outro",
  "engagement_bait",
  "not_x_but_y",
  "dash_density",
  "hook_first",
  "promise_by",
  "hook_length",
  "hook_answers_itself",
  "promise_paid",
  "loops_close",
  "payoff_position",
  "max_stretch",
  "and_chain",
  "ends_after_payoff",
  "voice_rate",
  "hook_text_length",
  "text_rate",
  "text_echoes_voice",
  "picture_missing",
  "specificity",
  "max_duration",
  "forbidden_term",
  "unsourced_number",
  "context_first",
  "opening_overload",
  "if_then_hook",
  "double_hook",
  "peak_gap",
  "rhythm",
  "reading_level",
  "text_hook_style",
  "lock_in",
  "trust_anchor",
  "villain",
  "double_aha",
  "hook_sound",
  "cta_alignment",
  "hook_repeat",
  "concept_similarity",
  "obvious_idea",
] as const;
export const checkIdSchema = z.enum(CHECK_IDS);
export type CheckId = z.infer<typeof checkIdSchema>;

export type AiWeakSpot = { id: string; name: string; symptom: string; countermeasure: string; checks: readonly CheckId[]; evidence: EvidenceLabel };

export const AI_WEAK_SPOTS: readonly AiWeakSpot[] = [
  { id: "W1", name: "Homogeneity", symptom: "One model repeats itself and different models converge on the same ideas.", countermeasure: "Diverge first: many seeds, two model families, verbalized sampling, forced combinations, similarity checks.", checks: ["concept_similarity", "hook_repeat"], evidence: "sourced" },
  { id: "W2", name: "Typicality bias", symptom: "The first answer is the safe, familiar one.", countermeasure: "List the obvious ideas first and ban them; ask for low-probability candidates.", checks: ["obvious_idea"], evidence: "sourced" },
  { id: "W3", name: "Abstraction", symptom: "Categories instead of moments.", countermeasure: "Specificity rules; every line needs a picture.", checks: ["specificity", "picture_missing", "reading_level"], evidence: "practice" },
  { id: "W4", name: "AI register", symptom: "Words and patterns readers recognise as machine-written.", countermeasure: "The slop lexicon refuses or warns, with the line.", checks: ["slop_lexicon", "not_x_but_y", "dash_density"], evidence: "sourced" },
  { id: "W5", name: "Helpfulness", symptom: "Explains too much and resolves tension at once.", countermeasure: "The hook withholds; the payoff sits in the last part; a villain and a lean give the viewer something to resist.", checks: ["hook_answers_itself", "payoff_position", "villain"], evidence: "practice" },
  { id: "W6", name: "No sense of time", symptom: "Paragraphs instead of beats; no feel for a second and a half.", countermeasure: "Timeline-first writing, word budgets, the Swipe Test.", checks: ["voice_rate", "max_stretch", "hook_length", "promise_by", "context_first", "opening_overload", "double_hook", "peak_gap"], evidence: "hypothesis" },
  { id: "W7", name: "Weak self-judgement", symptom: "Prefers its own text, sways with order and length, near chance at picking winners from text.", countermeasure: "Pairwise, order-swapped, cross-family judging calibrated on outcomes.", checks: [], evidence: "sourced" },
  { id: "W8", name: "Accepts a weak brief", symptom: "Writes the brief as given even when the angle is dull.", countermeasure: "A brief challenge step proposes a sharper angle inside the claims.", checks: [], evidence: "hypothesis" },
  { id: "W9", name: "Safe blandness", symptom: "Avoids edge, humour and opinion.", countermeasure: "Benign violations and honest opinions the brand holds, inside the trust floor.", checks: [], evidence: "sourced" },
  { id: "W10", name: "No live culture", symptom: "Knows nothing after its cutoff; invents trends.", countermeasure: "Trends only from dated discovery data and the brief's sources.", checks: [], evidence: "sourced" },
  { id: "W11", name: "Frames, not motion", symptom: "A vision model sent stills misses pace, motion and sound.", countermeasure: "A native video-and-audio model watches the render.", checks: [], evidence: "sourced" },
  { id: "W12", name: "Invented facts", symptom: "Numbers, results and testimonials that the brief does not give.", countermeasure: "The claims gate; specificity from the brief or the picture only; every number in the script is checked against the brief.", checks: ["unsourced_number", "forbidden_term"], evidence: "sourced" },
  { id: "W13", name: "Memorised viral lines", symptom: "Stock hooks and lines reappear word for word.", countermeasure: "The reference copy check, hook history and the stock-hook list.", checks: ["stock_hook", "hook_repeat"], evidence: "practice" },
  { id: "W14", name: "The generated look", symptom: "Plastic skin, warping, morphing, one shared glossy aesthetic.", countermeasure: "The take critic's slop rubric; art direction toward texture; real footage where it matters.", checks: [], evidence: "practice" },
  { id: "W15", name: "No stakes", symptom: "Information without a want, an obstacle or a cost.", countermeasure: "The direction brief requires stakes.", checks: ["and_chain"], evidence: "practice" },
  { id: "W16", name: "Flat rhythm", symptom: "Sentences of one length, one after another: a flat line the ear tunes out. Models do not check rhythm by themselves.", countermeasure: "The zig-zag rule in every script prompt, and a check on the spread of sentence lengths.", checks: ["rhythm"], evidence: "practice" },
  { id: "W17", name: "Hedged and generic hooks", symptom: "If-then openings, info teases (3 hacks) and claims with no proof, which read as selling.", countermeasure: "Declarative hooks, desire outcomes, a trust anchor from the brief, and the text-hook rules.", checks: ["if_then_hook", "text_hook_style", "trust_anchor", "lock_in"], evidence: "practice" },
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Niche defaults (framework 14.2). Priors only: the learning loop replaces them with the brand's own results.

export const PROOF_DEVICES = ["demonstration", "before_after", "test_result", "brief_numbers", "customer_words", "side_by_side", "process_shown", "time_lapse", "credential"] as const;
export type ProofDevice = (typeof PROOF_DEVICES)[number];

export type NicheProfile = { id: NicheFamily; emotions: readonly EmotionId[]; hookFamilies: readonly HookFamilyId[]; proofDevices: readonly ProofDevice[]; pitfalls: readonly string[] };

export const NICHE_PROFILES: readonly NicheProfile[] = [
  { id: "education", emotions: ["surprise", "awe", "inspiration"], hookFamilies: ["question_gap", "myth_bust", "connector", "impossible_image", "oddly_specific"], proofDevices: ["demonstration", "side_by_side"], pitfalls: ["Lecturing", "Answering the question in the hook"] },
  { id: "entertainment", emotions: ["amusement", "surprise", "tension"], hookFamilies: ["in_medias_res", "pattern_interrupt", "pov_relatable", "genre_flip", "story_cliff"], proofDevices: ["demonstration"], pitfalls: ["Stock jokes", "A slow setup"] },
  { id: "ecommerce", emotions: ["surprise", "relief", "amusement"], hookFamilies: ["mystery_object", "versus", "challenge_test", "genre_flip"], proofDevices: ["demonstration", "test_result", "customer_words", "side_by_side"], pitfalls: ["Reading the product page aloud", "A product that never moves"] },
  { id: "beauty", emotions: ["surprise", "relief", "belonging"], hookFamilies: ["before_after", "result_first", "myth_bust", "mistake"], proofDevices: ["before_after", "process_shown", "customer_words"], pitfalls: ["Unbelievable results", "Lighting that changes between states"] },
  { id: "fitness", emotions: ["inspiration", "tension", "surprise"], hookFamilies: ["mistake", "contrarian", "stakes_clock", "before_after"], proofDevices: ["demonstration", "before_after", "time_lapse"], pitfalls: ["Promised results the brief cannot support", "Shaming the viewer"] },
  { id: "finance", emotions: ["tension", "relief", "surprise"], hookFamilies: ["desire_outcome", "oddly_specific", "confession", "contrarian", "mistake"], proofDevices: ["brief_numbers", "side_by_side"], pitfalls: ["Implied guaranteed returns", "Jargon"] },
  { id: "food", emotions: ["awe", "amusement", "relief"], hookFamilies: ["process_satisfaction", "result_first", "ranking", "challenge_test"], proofDevices: ["process_shown", "demonstration"], pitfalls: ["A dish that does not look good in the first frame", "Long ingredient lists"] },
  { id: "tech", emotions: ["surprise", "awe", "amusement"], hookFamilies: ["impossible_image", "fortune_teller", "versus", "challenge_test", "mystery_object"], proofDevices: ["demonstration", "test_result", "side_by_side"], pitfalls: ["Spec lists", "No human reaction"] },
  { id: "b2b", emotions: ["relief", "belonging", "amusement"], hookFamilies: ["proven_winner", "desire_outcome", "pov_relatable", "mistake", "insider_reveal"], proofDevices: ["brief_numbers", "customer_words", "demonstration"], pitfalls: ["Corporate register", "Feature lists instead of a workday moment"] },
  { id: "home", emotions: ["relief", "awe", "surprise"], hookFamilies: ["before_after", "process_satisfaction", "result_first", "mistake"], proofDevices: ["before_after", "time_lapse", "process_shown"], pitfalls: ["Clutter in the first frame", "A reveal from a different angle"] },
  { id: "parenting", emotions: ["amusement", "belonging", "relief"], hookFamilies: ["pov_relatable", "confession", "identity_callout", "story_cliff"], proofDevices: ["demonstration", "customer_words"], pitfalls: ["Judging other parents", "Fear-led hooks"] },
  { id: "travel", emotions: ["awe", "surprise", "inspiration"], hookFamilies: ["impossible_image", "ranking", "stakes_clock", "insider_reveal"], proofDevices: ["demonstration", "brief_numbers"], pitfalls: ["Generic drone shots", "Postcard narration"] },
  { id: "local", emotions: ["belonging", "amusement", "awe"], hookFamilies: ["insider_reveal", "process_satisfaction", "story_cliff", "identity_callout"], proofDevices: ["process_shown", "customer_words", "demonstration"], pitfalls: ["An advert voice", "No faces"] },
];

/** The profile of a niche family. */
export function nicheProfile(id: NicheFamily): NicheProfile {
  const profile = NICHE_PROFILES.find((entry) => entry.id === id);
  if (!profile) throw new Error(`No niche profile for ${id}.`);
  return profile;
}

/** The hook family of an id. */
export function hookFamily(id: HookFamilyId): HookFamily {
  const family = HOOK_FAMILIES.find((entry) => entry.id === id);
  if (!family) throw new Error(`No hook family ${id}.`);
  return family;
}

/** The format archetype of an id. */
export function formatArchetype(id: FormatId): FormatArchetype {
  const format = FORMAT_ARCHETYPES.find((entry) => entry.id === id);
  if (!format) throw new Error(`No format ${id}.`);
  return format;
}

/** The weighted Lean-In Score of a set of dimension scores (0 to RUBRIC_MAX each), from 0 to 100. A missing dimension counts as 0. */
export function leanInScore(scores: Partial<Record<RubricId, number>>): number {
  let total = 0;
  for (const dimension of RUBRIC) {
    const raw = scores[dimension.id];
    const value = typeof raw === "number" && Number.isFinite(raw) ? Math.min(Math.max(raw, 0), RUBRIC_MAX) : 0;
    total += dimension.weight * (value / RUBRIC_MAX);
  }
  return Math.round(total * 1000) / 10;
}
