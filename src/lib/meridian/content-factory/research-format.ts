// A format found in a brand's own research: how often each structure, opening move, hook mechanism and call to action appears in the ads
// the brand has analyzed. It is a count of model labels, so every finding is INFERRED and says how many of how many ads carry it. It is not
// a measure of what works. The angles built from it name only the schema's fixed label words, never any text from an ad, and the
// variations that use them still write new wording and visuals (see variations.ts).

import { CTAS, HOOK_MECHANISMS, OPENING_MOVES, STRUCTURES } from "../research/schema.ts";
import type { VariationAngle } from "./variations.ts";

/** The analyzed ads a brand needs before its patterns say anything, and the ads a pattern needs to count as repeated. */
export const MIN_RESEARCH_CORPUS = 3;
export const MIN_PATTERN_SAMPLES = 2;

export type StoredPattern = { dimension: string; value: string; sampleCount: number; corpusSize: number; prevalence: number; confidence: number };

export type Finding = { value: string; label: string; sampleCount: number; prevalence: number; confidence: number };

export type ResearchFormat = {
  corpusSize: number;
  structures: Finding[];
  openings: Finding[];
  hooks: Finding[];
  ctas: Finding[];
};

const USABLE: Record<"structures" | "openings" | "hooks" | "ctas", { dimension: string; allowed: readonly string[] }> = {
  structures: { dimension: "structure", allowed: STRUCTURES.filter((value) => value !== "other" && value !== "unclear") },
  openings: { dimension: "openingMove", allowed: OPENING_MOVES.filter((value) => value !== "other" && value !== "unclear") },
  hooks: { dimension: "hookMechanism", allowed: HOOK_MECHANISMS.filter((value) => value !== "other" && value !== "unclear") },
  ctas: { dimension: "cta", allowed: CTAS.filter((value) => value !== "other" && value !== "unclear" && value !== "none") },
};

/** A schema label as plain words: problem_solution → "problem solution". */
export function plainLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function findingsFor(patterns: readonly StoredPattern[], key: keyof typeof USABLE): Finding[] {
  const { dimension, allowed } = USABLE[key];
  return patterns
    .filter((pattern) => pattern.dimension === dimension && allowed.includes(pattern.value) && pattern.sampleCount >= MIN_PATTERN_SAMPLES)
    .sort((left, right) => right.sampleCount - left.sampleCount || left.value.localeCompare(right.value))
    .map((pattern) => ({ value: pattern.value, label: plainLabel(pattern.value), sampleCount: pattern.sampleCount, prevalence: pattern.prevalence, confidence: pattern.confidence }));
}

export type FormatOutcome = { ok: true; format: ResearchFormat } | { ok: false; reason: string };

/**
 * The format in a brand's stored patterns, or why there is none. It needs at least MIN_RESEARCH_CORPUS analyzed ads and a structure that
 * at least MIN_PATTERN_SAMPLES of them share. Nothing is filled in when it is missing.
 */
export function formatFromPatterns(patterns: readonly StoredPattern[]): FormatOutcome {
  const corpusSize = patterns.reduce((largest, pattern) => Math.max(largest, pattern.corpusSize), 0);
  if (corpusSize < MIN_RESEARCH_CORPUS) {
    return { ok: false, reason: `Your research has ${corpusSize} analyzed ${corpusSize === 1 ? "ad" : "ads"}. Pattern-finding needs at least ${MIN_RESEARCH_CORPUS}. Collect and analyze more examples on Market first.` };
  }
  const format: ResearchFormat = {
    corpusSize,
    structures: findingsFor(patterns, "structures"),
    openings: findingsFor(patterns, "openings"),
    hooks: findingsFor(patterns, "hooks"),
    ctas: findingsFor(patterns, "ctas"),
  };
  if (format.structures.length === 0) {
    return { ok: false, reason: `No structure repeats across your ${corpusSize} analyzed ads (a pattern needs at least ${MIN_PATTERN_SAMPLES}). Add more examples of one kind on Market.` };
  }
  return { ok: true, format };
}

/** One sentence per dimension, for the person to read before choosing to use the format. */
export function describeFormat(format: ResearchFormat): string[] {
  const top = (findings: Finding[]) => findings.slice(0, 2).map((finding) => `${finding.label} (${finding.sampleCount} of ${format.corpusSize})`).join(", ");
  const lines = [`Structure: ${top(format.structures)}`];
  if (format.openings.length > 0) lines.push(`Opening: ${top(format.openings)}`);
  if (format.hooks.length > 0) lines.push(`Hook: ${top(format.hooks)}`);
  if (format.ctas.length > 0) lines.push(`Call to action: ${top(format.ctas)}`);
  return lines;
}

/** FNV-1a over the text, 32 bits as 8 hex digits. Pure TypeScript, so the module also loads in the browser, which has no node:crypto. */
function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** A stable short id for an angle: the same labels always give the same id. */
function angleId(parts: readonly string[]): string {
  const text = parts.join("|");
  return `res_${fnv1a(text, 0x811c9dc5)}${fnv1a(text, 0x9e3779b1)}`.slice(0, 14);
}

/**
 * Up to `count` angles from the format: each common structure, paired with each common opening move (or alone when none repeats), most
 * common first. The angle names only the schema's label words and the counts. Fewer are returned when the research has fewer distinct
 * combinations; the caller adds fixed angles for the rest and says so.
 */
export function researchAngles(format: ResearchFormat, count: number): VariationAngle[] {
  const openings: Array<Finding | null> = format.openings.length > 0 ? format.openings : [null];
  const combos = format.structures.flatMap((structure) =>
    openings.map((opening) => ({ structure, opening, weight: structure.sampleCount * (opening?.sampleCount ?? 1) })),
  );
  combos.sort((left, right) => right.weight - left.weight || left.structure.value.localeCompare(right.structure.value) || (left.opening?.value ?? "").localeCompare(right.opening?.value ?? ""));
  const hook = format.hooks[0] ?? null;
  const cta = format.ctas[0] ?? null;
  return combos.slice(0, count).map(({ structure, opening }): VariationAngle => {
    const label = capitalized(opening ? `${structure.label}, ${opening.label} opening` : structure.label);
    const shared = (finding: Finding) => `${finding.sampleCount} of ${format.corpusSize}`;
    const parts = [
      `Build the video as a ${structure.label} structure (found in ${shared(structure)} analyzed ads)`,
      opening ? `with a ${opening.label} opening (${shared(opening)})` : "",
      hook ? `and a ${hook.label} hook (${shared(hook)})` : "",
      cta ? `ending on a ${cta.label} call to action (${shared(cta)})` : "",
    ].filter(Boolean);
    return {
      id: angleId([structure.value, opening?.value ?? "", hook?.value ?? "", cta?.value ?? ""]),
      label,
      focus: `${parts.join(", ")}. These are model-labelled counts from the brand's research, not proof of what works.`,
    };
  });
}
