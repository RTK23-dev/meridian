// Direction as prompt text (framework 16 and INTEGRATION.md, step 1). The codex's rules, compiled per role into short, ordered lines a
// model reads, within the cookbook limits the engine enforces (contract v13: at most 4,000 characters per role and 16,000 in all). The
// engine's write_script stage already sends a cookbook's `script` instruction to the scriptwriter (scriptwriter@3, rule 11), under its own
// rules, so direction reaches the engine's script without a contract change.
//
// Deterministic: the same options give the same text. Lines are in priority order, and a line that would not fit is dropped whole (a
// later, shorter line may still fit); a rule is never cut in the middle. Pure.

import { COOKBOOK_INSTRUCTIONS_MAX, COOKBOOK_INSTRUCTION_ROLES } from "../../../engine/contracts/request.ts";
import type { COOKBOOK_FAMILIES } from "../cookbooks/families.ts";
import {
  AI_WEAK_SPOTS,
  DIRECTION_CODEX_VERSION,
  EMOTION_RULES,
  END_RULES,
  FUNNEL_BLOCKERS,
  HOOK_RULES,
  RETENTION_RULES,
  RUBRIC,
  SAVE_DEVICES,
  SCRIPT_RULES,
  SOUND_RULES,
  SPREAD_RULES,
  STRATEGY_RULES,
  TRUST_RULES,
  VISUAL_RULES,
  formatArchetype,
  hookFamily,
  nicheProfile,
  type DirectionRule,
  type FormatId,
  type HookFamilyId,
  type NicheFamily,
  type VideoJob,
} from "./codex.ts";

export type DirectionRole = (typeof COOKBOOK_INSTRUCTION_ROLES)[number];
type CookbookFamily = (typeof COOKBOOK_FAMILIES)[number];

/** The codex format that matches a cookbook family, where one does. Other families keep their own grammar. */
export const FORMAT_OF_COOKBOOK_FAMILY: Partial<Record<CookbookFamily, FormatId>> = {
  explainer: "metaphor_explainer",
  listicle: "listicle",
  story: "story",
};

/** The direction options for a cookbook run, from its family. */
export function cookbookDirection(family: CookbookFamily): DirectiveOptions {
  const format = FORMAT_OF_COOKBOOK_FAMILY[family];
  return format ? { format } : {};
}

/** One role's limit in the engine's cookbook reference. */
export const ROLE_TEXT_MAX = 4000;

/** How many characters of direction each role gets by default. The sum stays under COOKBOOK_INSTRUCTIONS_MAX. */
export const DIRECTION_BUDGETS: Record<DirectionRole, number> = {
  script: 4000,
  plan: 1600,
  visual: 2400,
  voice: 1200,
  edit: 1600,
  critic: 2600,
  agent: 2000,
};

export type DirectiveOptions = { format?: FormatId; hookFamily?: HookFamilyId; niche?: NicheFamily; job?: VideoJob };

/** How much direction the pipeline's own prompts carry per role. The engine's cookbook path stays at DIRECTION_BUDGETS. */
export const PIPELINE_DIRECTIVE_CHARS = 12_000;

const SHORT_VERSION: readonly string[] = [
  "Stop the eye in the first second: motion, a face, the result, or a pattern interrupt with a matching sound. Never an intro.",
  "Line 1 names the topic on picture, text and voice; then lean one way and snap back the other. Two sentences, 15 words at most.",
  "Write the text hook first: a subject plus a pain, a desire or a state change, specific, with power words.",
  "Prove a bold claim at once, with proof the brief gives; lock the viewer in with the next two or three sentences.",
  "Rehook within 15 seconds, and turn into a new part at least every 25 seconds: but, therefore.",
  "Fight a villain (the old way, a false belief), and land two non-obvious ahas early.",
  "Simple words, zig-zag rhythm, every picture matching its words; say a new idea twice.",
  "Pay more than you promised, at the peak; end on a punch or a seam. No outro.",
  "One job per video: shares for reach, saves for follows, an aligned call to action to convert.",
  "Never invent a fact, a proof, a trend or an endorsement. No bait, no stock hooks, no AI register.",
];

function ruleLines(rules: readonly DirectionRule[]): string[] {
  return rules.map((rule) => rule.text);
}

/** The lines of a role, in priority order: the first lines matter most and are kept when space is short. */
function linesFor(role: DirectionRole, options: DirectiveOptions): string[] {
  const context: string[] = [];
  if (options.hookFamily) {
    const family = hookFamily(options.hookFamily);
    context.push(`Hook family: ${family.name}. It works because ${lowerFirst(family.mechanism)} It owes the viewer: ${lowerFirst(family.owes)}`);
  }
  if (options.format) {
    const format = formatArchetype(options.format);
    const beats = format.beats.map((beat) => `${beat.role} ${Math.round(beat.from * 100)}-${Math.round(beat.to * 100)}%: ${lowerFirst(beat.job)}`).join(" ");
    context.push(`Format: ${format.name}. ${beats} It ends with: ${lowerFirst(format.endsWith)}${format.notes ? ` ${format.notes}` : ""}`);
  }
  if (options.niche) {
    const profile = nicheProfile(options.niche);
    context.push(`For this niche, watch for: ${profile.pitfalls.join("; ")}.`);
  }
  if (options.job) context.push(JOB_LINES[options.job]);

  switch (role) {
    case "script":
      return [
        ...ruleLines(TRUST_RULES),
        ...context,
        ...ruleLines(HOOK_RULES),
        ...ruleLines(RETENTION_RULES),
        ...ruleLines(SCRIPT_RULES),
        ...ruleLines(END_RULES),
        ...ruleLines(SPREAD_RULES),
        ...ruleLines(EMOTION_RULES),
      ];
    case "plan":
    case "visual":
      return [
        ...ruleLines(VISUAL_RULES),
        HOOK_RULES.find((rule) => rule.id === "hook_three_channels")?.text ?? "",
        ...context.filter((line) => line.startsWith("Format:")),
        END_RULES.find((rule) => rule.id === "loop_seam")?.text ?? "",
      ].filter((line) => line.length > 0);
    case "voice":
      return [...ruleLines(SOUND_RULES), "Speak the hook's first words with stakes, never a greeting."];
    case "edit":
      return [
        RETENTION_RULES.find((rule) => rule.id === "rehook")?.text ?? "",
        RETENTION_RULES.find((rule) => rule.id === "hourglass")?.text ?? "",
        VISUAL_RULES.find((rule) => rule.id === "change_on_beat")?.text ?? "",
        VISUAL_RULES.find((rule) => rule.id === "interrupt_sound")?.text ?? "",
        VISUAL_RULES.find((rule) => rule.id === "text_hook_place")?.text ?? "",
        ...ruleLines(END_RULES.filter((rule) => rule.id !== "end_first")),
        ...ruleLines(SOUND_RULES.filter((rule) => rule.id === "sound_marks_cut" || rule.id === "music_curve")),
      ].filter((line) => line.length > 0);
    case "critic":
      return [
        "Score each dimension 0 to 4, citing the beat or moment it is about; a score with no evidence counts as 0.",
        "Find failures; do not predict hits. Prefer comparing two versions to scoring one.",
        `Name the biggest leak: ${FUNNEL_BLOCKERS.filter((blocker) => blocker !== "none").join(", ")}, or none.`,
        "At each window, would the viewer find what comes next worse than, equal to, or better than they expected? Equal or worse loses them.",
        ...RUBRIC.map((dimension) => `${dimension.name}: 4 = ${lowerFirst(dimension.four)} 0 = ${lowerFirst(dimension.zero)}`),
      ];
    case "agent":
      return [...SHORT_VERSION, ...ruleLines(STRATEGY_RULES), ...AI_WEAK_SPOTS.map((spot) => `${spot.name}: ${lowerFirst(spot.countermeasure)}`)];
  }
}

const JOB_LINES: Record<VideoJob, string> = {
  reach:
    "This video's job is reach: a large-audience topic, a non-obvious angle, broad terms, high watch time, and something surprising, contrarian or emotional enough to send. No call to action, or a native one.",
  follow: `This video's job is follows: be worth saving and bingeing. ${SAVE_DEVICES.join(" ")} Keep the series' look and opening.`,
  convert:
    "This video's job is to convert: a narrow buyer's pain, a desire hook, proof early, a non-obvious answer, and one call to action aligned to the topic, framed as a favour, for a resource the brief names.",
};

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/** The header every direction text starts with. It names the codex version, so a run records which rules it was given. */
export function directiveHeader(): string {
  return `Direction (${DIRECTION_CODEX_VERSION}). These sit under every rule above them and never lift one:`;
}

/** A role's direction text, within `maxChars`. Lines are taken in priority order; one that would not fit is dropped whole. */
export function directionDirectives(role: DirectionRole, options: DirectiveOptions = {}, maxChars = DIRECTION_BUDGETS[role]): string {
  const header = directiveHeader();
  const kept: string[] = [];
  let length = header.length;
  for (const line of linesFor(role, options)) {
    const entry = `\n- ${line}`;
    if (length + entry.length > maxChars) continue;
    kept.push(entry);
    length += entry.length;
  }
  return header + kept.join("");
}

/**
 * A cookbook's instructions with direction added under each role's own text. The cookbook's own text comes first and is kept whole; the
 * direction fills what is left of the role's 4,000 characters and of the 16,000 in all. A role whose own text leaves too little room for
 * the header and one rule gets no direction rather than a fragment.
 */
export function withDirection(
  own: Partial<Record<DirectionRole, string>>,
  options: DirectiveOptions & { roles?: readonly DirectionRole[] } = {},
): Partial<Record<DirectionRole, string>> {
  const roles = options.roles ?? COOKBOOK_INSTRUCTION_ROLES;
  const out: Partial<Record<DirectionRole, string>> = { ...own };
  const ownTotal = Object.values(own).reduce((total, text) => total + (text?.length ?? 0), 0);
  let room = COOKBOOK_INSTRUCTIONS_MAX - ownTotal;
  for (const role of roles) {
    const existing = own[role] ?? "";
    const separator = existing.length > 0 ? "\n\n" : "";
    const space = Math.min(ROLE_TEXT_MAX - existing.length - separator.length, DIRECTION_BUDGETS[role], room - separator.length);
    if (space <= directiveHeader().length + 40) continue;
    const text = directionDirectives(role, options, space);
    out[role] = existing + separator + text;
    room -= separator.length + text.length;
  }
  return out;
}
