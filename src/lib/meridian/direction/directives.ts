// Direction as prompt text (framework 16 and INTEGRATION.md, step 1). The codex's rules, compiled per role into short, ordered lines a
// model reads, within the cookbook limits the engine enforces (contract v13: at most 4,000 characters per role and 16,000 in all). The
// engine's write_script stage already sends a cookbook's `script` instruction to the scriptwriter (scriptwriter@3, rule 11), under its own
// rules, so direction reaches the engine's script without a contract change.
//
// Deterministic: the same options give the same text. Lines are in priority order, and a line that would not fit is dropped whole (a
// later, shorter line may still fit); a rule is never cut in the middle. Pure.

import { COOKBOOK_INSTRUCTIONS_MAX, COOKBOOK_INSTRUCTION_ROLES } from "../../../engine/contracts/request.ts";
import {
  AI_WEAK_SPOTS,
  DIRECTION_CODEX_VERSION,
  EMOTION_RULES,
  END_RULES,
  HOOK_RULES,
  RETENTION_RULES,
  RUBRIC,
  SCRIPT_RULES,
  SOUND_RULES,
  SPREAD_RULES,
  TRUST_RULES,
  VISUAL_RULES,
  formatArchetype,
  hookFamily,
  nicheProfile,
  type DirectionRule,
  type FormatId,
  type HookFamilyId,
  type NicheFamily,
} from "./codex.ts";

export type DirectionRole = (typeof COOKBOOK_INSTRUCTION_ROLES)[number];

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

export type DirectiveOptions = { format?: FormatId; hookFamily?: HookFamilyId; niche?: NicheFamily };

const SHORT_VERSION: readonly string[] = [
  "Stop the eye in the first half-second with motion, a face, or the result. Never an intro.",
  "Promise one specific thing by 3 seconds, and open one question. Do not answer it yet.",
  "Every beat raises the stakes or pays a small reward: but, therefore.",
  "Specific beats general. Every line has a picture. Never invent a fact.",
  "Pay more than you promised, at the peak, in the last third.",
  "End on a punch or a seam that restarts the video. No outro.",
  "Know who it gets sent to and why.",
  "One feeling, high arousal where it fits.",
  "No AI register, no stock jokes, no stock hooks, no bait.",
  "Diverge widely, judge pairwise, and let real viewers pick the winner.",
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
    context.push(`Format: ${format.name}. ${beats} It ends with: ${lowerFirst(format.endsWith)}`);
  }
  if (options.niche) {
    const profile = nicheProfile(options.niche);
    context.push(`For this niche, watch for: ${profile.pitfalls.join("; ")}.`);
  }

  switch (role) {
    case "script":
      return [
        ...ruleLines(TRUST_RULES),
        ...ruleLines(HOOK_RULES),
        ...context,
        ...ruleLines(RETENTION_RULES),
        ...ruleLines(END_RULES),
        ...ruleLines(SCRIPT_RULES),
        ...ruleLines(EMOTION_RULES),
        ...ruleLines(SPREAD_RULES),
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
        VISUAL_RULES.find((rule) => rule.id === "change_on_beat")?.text ?? "",
        ...ruleLines(END_RULES.filter((rule) => rule.id !== "end_first")),
        ...ruleLines(SOUND_RULES.filter((rule) => rule.id === "sound_marks_cut" || rule.id === "music_curve")),
      ].filter((line) => line.length > 0);
    case "critic":
      return [
        "Score each dimension 0 to 4, citing the beat or moment it is about; a score with no evidence counts as 0.",
        "Find failures; do not predict hits. Prefer comparing two versions to scoring one.",
        ...RUBRIC.map((dimension) => `${dimension.name}: 4 = ${lowerFirst(dimension.four)} 0 = ${lowerFirst(dimension.zero)}`),
      ];
    case "agent":
      return [...SHORT_VERSION, ...AI_WEAK_SPOTS.map((spot) => `${spot.name}: ${lowerFirst(spot.countermeasure)}`)];
  }
}

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
