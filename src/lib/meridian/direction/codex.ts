// The direction codex: the machine-readable part of docs/direction/VIRAL_DIRECTION_FRAMEWORK.md. Every entry names the framework
// section it comes from and its evidence label (sourced, practice, hypothesis, contested), so an agent and a reader can tell a platform's
// own rule from a guess. The numbers here are initial values: the learning loop replaces them with measured ones (framework section 13).
//
// Data only, and pure. The checks that read it are attention.ts and slop.ts; the prompt text built from it is directives.ts.

import { z } from "zod";
import { BEAT_ROLES, type BeatRole } from "../../../engine/contracts/request.ts";

/** The codex's version. A change to any rule, list or weight here is a new version, recorded on every direction record. */
export const DIRECTION_CODEX_VERSION = "direction-codex@1";

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
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Formats (framework 5.6). Beat skeletons as fractions of the duration. A reference's measured grammar overrides a skeleton.

export const FORMAT_IDS = [
  "list_ranking",
  "story",
  "tutorial",
  "transformation",
  "myth_vs_fact",
  "test_experiment",
  "pov_skit",
  "metaphor_explainer",
  "reaction_commentary",
  "comparison",
  "behind_the_scenes",
  "satisfying_process",
] as const;
export const formatIdSchema = z.enum(FORMAT_IDS);
export type FormatId = z.infer<typeof formatIdSchema>;

export type SkeletonBeat = { role: BeatRole; from: number; to: number; job: string };
export type FormatArchetype = { id: FormatId; name: string; beats: readonly SkeletonBeat[]; endsWith: string; evidence: EvidenceLabel };

export const FORMAT_ARCHETYPES: readonly FormatArchetype[] = [
  {
    id: "list_ranking",
    name: "List or ranking",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "Name the list and its stakes; show the top item's result without naming it." },
      { role: "item", from: 0.1, to: 0.35, job: "The second-best item first, so the start is strong." },
      { role: "item", from: 0.35, to: 0.6, job: "The middle items, each with one surprise." },
      { role: "twist", from: 0.6, to: 0.72, job: "A re-hook: an entry the viewer did not expect." },
      { role: "payoff", from: 0.72, to: 1, job: "The top item, earned, and the reason it wins." },
    ],
    endsWith: "The top item, then a seam back to the opening claim.",
    evidence: "practice",
  },
  {
    id: "story",
    name: "Story",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "The most dramatic line or moment of the story." },
      { role: "setup", from: 0.1, to: 0.25, job: "Who wants what, in one breath." },
      { role: "twist", from: 0.25, to: 0.5, job: "But: the obstacle." },
      { role: "twist", from: 0.5, to: 0.75, job: "Therefore: a bigger obstacle, or the turn." },
      { role: "payoff", from: 0.75, to: 1, job: "The resolution that pays the opening line." },
    ],
    endsWith: "The resolution, ending on the opening line's meaning, now changed.",
    evidence: "practice",
  },
  {
    id: "tutorial",
    name: "Tutorial",
    beats: [
      { role: "hook", from: 0, to: 0.12, job: "The result first, or the mistake most people make." },
      { role: "setup", from: 0.12, to: 0.2, job: "What you need, as fast as possible." },
      { role: "item", from: 0.2, to: 0.45, job: "The steps, each shown." },
      { role: "item", from: 0.45, to: 0.7, job: "The step that surprises: the reason this method works." },
      { role: "proof", from: 0.7, to: 0.85, job: "Proof that it works, shown." },
      { role: "payoff", from: 0.85, to: 1, job: "The result again, better than the opening promised." },
    ],
    endsWith: "The finished result, matching the first frame.",
    evidence: "practice",
  },
  {
    id: "transformation",
    name: "Transformation",
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
    beats: [
      { role: "hook", from: 0, to: 0.12, job: "The myth, stated as the viewer believes it." },
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
    name: "Test or experiment",
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
    id: "pov_skit",
    name: "POV skit",
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
    id: "metaphor_explainer",
    name: "Explainer with a visual metaphor",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "An impossible image that is the metaphor." },
      { role: "setup", from: 0.1, to: 0.25, job: "The question the metaphor answers." },
      { role: "item", from: 0.25, to: 0.5, job: "The first part of the mechanism, shown through the metaphor." },
      { role: "item", from: 0.5, to: 0.72, job: "The second part." },
      { role: "twist", from: 0.72, to: 0.85, job: "What it means for the viewer." },
      { role: "payoff", from: 0.85, to: 1, job: "The insight, in one picture." },
    ],
    endsWith: "The metaphor, completed.",
    evidence: "practice",
  },
  {
    id: "reaction_commentary",
    name: "Reaction or commentary",
    beats: [
      { role: "hook", from: 0, to: 0.12, job: "The moment being reacted to, or the take, said first." },
      { role: "setup", from: 0.12, to: 0.3, job: "The context, fast." },
      { role: "item", from: 0.3, to: 0.6, job: "The take, with its reason." },
      { role: "twist", from: 0.6, to: 0.8, job: "What everyone missed." },
      { role: "payoff", from: 0.8, to: 1, job: "The conclusion." },
    ],
    endsWith: "The conclusion, and an honest open question.",
    evidence: "practice",
  },
  {
    id: "comparison",
    name: "Comparison",
    beats: [
      { role: "hook", from: 0, to: 0.1, job: "A versus B, and what is at stake in choosing." },
      { role: "item", from: 0.1, to: 0.35, job: "A, at its best." },
      { role: "item", from: 0.35, to: 0.6, job: "B, at its best." },
      { role: "twist", from: 0.6, to: 0.75, job: "The deciding factor nobody checks." },
      { role: "payoff", from: 0.75, to: 1, job: "The verdict, and who should choose which." },
    ],
    endsWith: "The verdict.",
    evidence: "practice",
  },
  {
    id: "behind_the_scenes",
    name: "Behind the scenes",
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
    id: "satisfying_process",
    name: "Satisfying process",
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
  { id: "stop_frame", group: "stop", name: "First-frame stopping power", four: "Frame 0 has motion, a face, contrast or an impossible image, and reads without sound.", zero: "A logo, a title card or a static establishing shot.", weight: 0.12 },
  { id: "promise", group: "stop", name: "Promise clarity by 3 s", four: "The viewer knows exactly what they will get and why it is for them.", zero: "No promise, or a vague one.", weight: 0.1 },
  { id: "gap", group: "stop", name: "A specific open question", four: "One concrete question the viewer now needs answered.", zero: "Nothing unresolved, or the answer is in the hook.", weight: 0.1 },
  { id: "escalation", group: "hold", name: "Each beat raises the stakes or pays a reward", four: "A but-and-therefore chain; the last item is the best.", zero: "A flat list; the best item first.", weight: 0.09 },
  { id: "density", group: "hold", name: "Value per second", four: "No dead air, no throat-clearing; every line works.", zero: "Preamble, repetition, filler.", weight: 0.08 },
  { id: "specificity", group: "hold", name: "Concrete over abstract", four: "Named situations, real numbers from the brief, sensory detail, a picture for every line.", zero: "Categories, generalities, adjectives doing the work.", weight: 0.07 },
  { id: "novelty", group: "hold", name: "A new element in a familiar container", four: "One surprising angle, subject or form inside a format the viewer reads at once.", zero: "Seen it before, or too strange to follow.", weight: 0.09 },
  { id: "emotion", group: "hold", name: "A felt peak", four: "A clear peak of awe, amusement, surprise or tension near the payoff.", zero: "Flat and informational.", weight: 0.07 },
  { id: "payoff", group: "payoff", name: "The payoff beats the promise", four: "It delivers more than promised, at the right moment.", zero: "Late, small, or a different thing from the promise.", weight: 0.1 },
  { id: "rewatch", group: "payoff", name: "A reason to watch again", four: "A loop seam, a twist that recontextualises, a detail to catch.", zero: "Ends on an outro; nothing to go back for.", weight: 0.06 },
  { id: "send", group: "spread", name: "A reason to send it", four: "Identity, relationship or utility: this is so you.", zero: "Nobody to send it to.", weight: 0.08 },
  { id: "save_comment", group: "spread", name: "A reason to save or to say something", four: "Lasting utility, or a genuine opinion split.", zero: "No utility, or a comment request that is bait.", weight: 0.04 },
];

/** The highest score of one rubric dimension. */
export const RUBRIC_MAX = 4;

// ---------------------------------------------------------------------------------------------------------------------------------
// Rules by area (framework 4 to 10). The directives builder turns these into prompt text per role.

export const HOOK_RULES: readonly DirectionRule[] = [
  { id: "hook_first", text: "The hook is the first beat. No intro, greeting, logo or channel name before it.", evidence: "sourced", section: "4.3" },
  { id: "promise_by_3s", text: "The promise is clear by 3 seconds, and the hook beat ends by 6 seconds.", evidence: "sourced", section: "4.3" },
  { id: "hook_withholds", text: "The hook does not answer its own question; the answer comes in the last third.", evidence: "hypothesis", section: "4.3" },
  { id: "hook_specific", text: "The hook is specific: a number from the brief, a named situation or a visible object. Never 'this changed everything'.", evidence: "practice", section: "4.3" },
  { id: "hook_true", text: "Every promise in the hook is kept by a later beat. Name the beat that pays it.", evidence: "hypothesis", section: "4.2" },
  { id: "hook_three_channels", text: "Write the hook on three channels: frame 0 (motion, a face, contrast or the result), at most 7 on-screen words that frame the question, and a first spoken line that raises the stakes.", evidence: "practice", section: "4.1" },
  { id: "hook_new", text: "A new hook every video: never a near-repeat of the brand's recent hooks.", evidence: "hypothesis", section: "4.3" },
];

export const RETENTION_RULES: readonly DirectionRule[] = [
  { id: "but_therefore", text: "Join beats with but or therefore, not and then. Two plain additions in a row are a warning.", evidence: "practice", section: "5.1" },
  { id: "escalate", text: "Order the material so the stakes rise: the best last, the second best first.", evidence: "practice", section: "5.2" },
  { id: "rehook", text: "No stretch longer than 7 seconds without a story or visual change; re-hook by the midpoint.", evidence: "hypothesis", section: "5.3" },
  { id: "loops_close", text: "Open one question early and close it late; every loop that opens closes.", evidence: "hypothesis", section: "5.4" },
  { id: "density", text: "Cut the first sentence of every draft. No dead air, no repetition. As long as the payoff needs and no longer.", evidence: "practice", section: "5.5" },
];

export const END_RULES: readonly DirectionRule[] = [
  { id: "end_first", text: "Write the last line and the last frame before the middle.", evidence: "practice", section: "6" },
  { id: "loop_seam", text: "Where it fits, let the last line run into the first, or the last frame match the first.", evidence: "practice", section: "6" },
  { id: "no_outro", text: "No outro: no thanks for watching, no follow for more, no end card in an organic video.", evidence: "practice", section: "6" },
  { id: "peak_end", text: "End on or just after the emotional peak, never on a decline.", evidence: "sourced", section: "6" },
];

export const SPREAD_RULES: readonly DirectionRule[] = [
  { id: "send_reason", text: "Name who the video gets sent to and what sending it says. No answer, no send.", evidence: "sourced", section: "7" },
  { id: "save_reason", text: "Give lasting utility a viewer would come back to, when the format allows.", evidence: "practice", section: "7" },
  { id: "no_bait", text: "No engagement bait: no comment-YES, tag-a-friend, like-if or share-if requests.", evidence: "sourced", section: "7" },
];

export const EMOTION_RULES: readonly DirectionRule[] = [
  { id: "one_feeling", text: "Choose one dominant feeling before writing.", evidence: "practice", section: "8" },
  { id: "high_arousal", text: "Prefer awe, amusement, surprise or tension; sadness alone does not spread. Anger only at a problem, never a person or group.", evidence: "sourced", section: "8" },
  { id: "benign_violation", text: "Humour comes from a specific truth the audience recognises, a norm broken safely. Never a stock joke.", evidence: "sourced", section: "8" },
  { id: "story_over_list", text: "A person, a want and an obstacle persuade more than a list of benefits.", evidence: "sourced", section: "8" },
];

export const SCRIPT_RULES: readonly DirectionRule[] = [
  { id: "ear", text: "Write for the ear: short sentences, one idea each, words people say aloud.", evidence: "practice", section: "9" },
  { id: "timeline", text: "Write the timeline, not a paragraph: each beat has a role, a duration, a voice line, on-screen text and a picture.", evidence: "hypothesis", section: "9" },
  { id: "start_late", text: "Start at the first interesting moment; end on the payoff.", evidence: "practice", section: "9" },
  { id: "specific", text: "Specific beats general. Use names, numbers and details from the brief only; when the brief gives none, use a concrete picture, never an invented fact.", evidence: "practice", section: "9" },
  { id: "one_reader", text: "Talk to one person, in their own words, taken from the brief's sources.", evidence: "practice", section: "9" },
  { id: "picture_per_line", text: "Every line has a picture. A line that cannot be shown is too abstract: rewrite it.", evidence: "practice", section: "9" },
  { id: "no_ai_register", text: "No AI register: no delve, unlock, elevate, game-changer, in today's fast-paced world, it's not X it's Y, or stacked dashes.", evidence: "sourced", section: "11" },
  { id: "contrast", text: "Use contrast: before and after, expected and actual.", evidence: "practice", section: "9" },
];

export const VISUAL_RULES: readonly DirectionRule[] = [
  { id: "frame_zero", text: "Choose frame 0 on purpose: motion, a face, contrast or the result. It is the video's thumbnail in the feed.", evidence: "practice", section: "10.1" },
  { id: "change_on_beat", text: "Cut, punch in or change angle at each turn of the script.", evidence: "practice", section: "10.1" },
  { id: "illustrate", text: "Every shot illustrates its words, literally or laterally. No decorative shots.", evidence: "practice", section: "10.1" },
  { id: "texture", text: "Ask for real light, real wear and texture; avoid the glossy, symmetrical, over-saturated generated look. Real product imagery always.", evidence: "practice", section: "10.1" },
  { id: "no_generated_text", text: "No text, label, price or logo in a generation prompt: code draws text.", evidence: "sourced", section: "10.1" },
  { id: "safe_zone", text: "Keep key content out of the lower fifth and the right twelfth of the frame.", evidence: "practice", section: "10.1" },
];

export const SOUND_RULES: readonly DirectionRule[] = [
  { id: "voice_performs", text: "Vary the pace, pause before the reveal, stress the one word that matters.", evidence: "practice", section: "10.3" },
  { id: "music_curve", text: "Music rises into the peak and drops under the key line.", evidence: "practice", section: "10.3" },
  { id: "sound_marks_cut", text: "Mark a turn of the story with a sound or a half-second of silence.", evidence: "practice", section: "10.3" },
  { id: "sound_off", text: "On-screen text carries the story for a viewer with the sound off.", evidence: "sourced", section: "10.3" },
];

export const TRUST_RULES: readonly DirectionRule[] = [
  { id: "no_invented_claims", text: "Never invent a claim, number, result, testimonial, person or trend.", evidence: "sourced", section: "0" },
  { id: "promise_kept", text: "No bait-and-switch: the payoff is the thing the hook promised.", evidence: "hypothesis", section: "3.1" },
  { id: "no_fake_urgency", text: "No fake urgency, fake scarcity or fake confession.", evidence: "hypothesis", section: "3.1" },
  { id: "original", text: "Copy genes, never content: no words, footage, voice or music of a reference.", evidence: "sourced", section: "3.1" },
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
  { id: "W3", name: "Abstraction", symptom: "Categories instead of moments.", countermeasure: "Specificity rules; every line needs a picture.", checks: ["specificity", "picture_missing"], evidence: "practice" },
  { id: "W4", name: "AI register", symptom: "Words and patterns readers recognise as machine-written.", countermeasure: "The slop lexicon refuses or warns, with the line.", checks: ["slop_lexicon", "not_x_but_y", "dash_density"], evidence: "sourced" },
  { id: "W5", name: "Helpfulness", symptom: "Explains too much and resolves tension at once.", countermeasure: "The hook withholds; the payoff sits in the last part.", checks: ["hook_answers_itself", "payoff_position"], evidence: "practice" },
  { id: "W6", name: "No sense of time", symptom: "Paragraphs instead of beats; no feel for a second and a half.", countermeasure: "Timeline-first writing, word budgets, the Swipe Test.", checks: ["voice_rate", "max_stretch", "hook_length", "promise_by"], evidence: "hypothesis" },
  { id: "W7", name: "Weak self-judgement", symptom: "Prefers its own text, sways with order and length, near chance at picking winners from text.", countermeasure: "Pairwise, order-swapped, cross-family judging calibrated on outcomes.", checks: [], evidence: "sourced" },
  { id: "W8", name: "Accepts a weak brief", symptom: "Writes the brief as given even when the angle is dull.", countermeasure: "A brief challenge step proposes a sharper angle inside the claims.", checks: [], evidence: "hypothesis" },
  { id: "W9", name: "Safe blandness", symptom: "Avoids edge, humour and opinion.", countermeasure: "Benign violations and honest opinions the brand holds, inside the trust floor.", checks: [], evidence: "sourced" },
  { id: "W10", name: "No live culture", symptom: "Knows nothing after its cutoff; invents trends.", countermeasure: "Trends only from dated discovery data and the brief's sources.", checks: [], evidence: "sourced" },
  { id: "W11", name: "Frames, not motion", symptom: "A vision model sent stills misses pace, motion and sound.", countermeasure: "A native video-and-audio model watches the render.", checks: [], evidence: "sourced" },
  { id: "W12", name: "Invented facts", symptom: "Numbers, results and testimonials that the brief does not give.", countermeasure: "The claims gate; specificity from the brief or the picture only; every number in the script is checked against the brief.", checks: ["unsourced_number", "forbidden_term"], evidence: "sourced" },
  { id: "W13", name: "Memorised viral lines", symptom: "Stock hooks and lines reappear word for word.", countermeasure: "The reference copy check, hook history and the stock-hook list.", checks: ["stock_hook", "hook_repeat"], evidence: "practice" },
  { id: "W14", name: "The generated look", symptom: "Plastic skin, warping, morphing, one shared glossy aesthetic.", countermeasure: "The take critic's slop rubric; art direction toward texture; real footage where it matters.", checks: [], evidence: "practice" },
  { id: "W15", name: "No stakes", symptom: "Information without a want, an obstacle or a cost.", countermeasure: "The direction brief requires stakes.", checks: ["and_chain"], evidence: "practice" },
];

// ---------------------------------------------------------------------------------------------------------------------------------
// Niche defaults (framework 14.2). Priors only: the learning loop replaces them with the brand's own results.

export const PROOF_DEVICES = ["demonstration", "before_after", "test_result", "brief_numbers", "customer_words", "side_by_side", "process_shown", "time_lapse", "credential"] as const;
export type ProofDevice = (typeof PROOF_DEVICES)[number];

export type NicheProfile = { id: NicheFamily; emotions: readonly EmotionId[]; hookFamilies: readonly HookFamilyId[]; proofDevices: readonly ProofDevice[]; pitfalls: readonly string[] };

export const NICHE_PROFILES: readonly NicheProfile[] = [
  { id: "education", emotions: ["surprise", "awe", "inspiration"], hookFamilies: ["question_gap", "myth_bust", "impossible_image", "oddly_specific"], proofDevices: ["demonstration", "side_by_side"], pitfalls: ["Lecturing", "Answering the question in the hook"] },
  { id: "entertainment", emotions: ["amusement", "surprise", "tension"], hookFamilies: ["in_medias_res", "pov_relatable", "genre_flip", "story_cliff"], proofDevices: ["demonstration"], pitfalls: ["Stock jokes", "A slow setup"] },
  { id: "ecommerce", emotions: ["surprise", "relief", "amusement"], hookFamilies: ["mystery_object", "versus", "challenge_test", "genre_flip"], proofDevices: ["demonstration", "test_result", "customer_words", "side_by_side"], pitfalls: ["Reading the product page aloud", "A product that never moves"] },
  { id: "beauty", emotions: ["surprise", "relief", "belonging"], hookFamilies: ["before_after", "result_first", "myth_bust", "mistake"], proofDevices: ["before_after", "process_shown", "customer_words"], pitfalls: ["Unbelievable results", "Lighting that changes between states"] },
  { id: "fitness", emotions: ["inspiration", "tension", "surprise"], hookFamilies: ["mistake", "contrarian", "stakes_clock", "before_after"], proofDevices: ["demonstration", "before_after", "time_lapse"], pitfalls: ["Promised results the brief cannot support", "Shaming the viewer"] },
  { id: "finance", emotions: ["tension", "relief", "surprise"], hookFamilies: ["oddly_specific", "confession", "contrarian", "mistake"], proofDevices: ["brief_numbers", "side_by_side"], pitfalls: ["Implied guaranteed returns", "Jargon"] },
  { id: "food", emotions: ["awe", "amusement", "relief"], hookFamilies: ["process_satisfaction", "result_first", "ranking", "challenge_test"], proofDevices: ["process_shown", "demonstration"], pitfalls: ["A dish that does not look good in the first frame", "Long ingredient lists"] },
  { id: "tech", emotions: ["surprise", "awe", "amusement"], hookFamilies: ["impossible_image", "versus", "challenge_test", "mystery_object"], proofDevices: ["demonstration", "test_result", "side_by_side"], pitfalls: ["Spec lists", "No human reaction"] },
  { id: "b2b", emotions: ["relief", "belonging", "amusement"], hookFamilies: ["pov_relatable", "mistake", "insider_reveal", "oddly_specific"], proofDevices: ["brief_numbers", "customer_words", "demonstration"], pitfalls: ["Corporate register", "Feature lists instead of a workday moment"] },
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
