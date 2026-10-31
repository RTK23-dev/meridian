// Style presets: a reusable "make videos in this style" package, built from one reference and kept as data. A preset holds the parts
// the engine already has contracts for (the style kit, a look, the gene choice) and the parts that are only guidance for the planner
// today (the beat structure, the shot wants, the measured grammar). It adds no contract: the kit is validated by styleKitSchema, the
// look by the look enum, the genes by the gene enum. See README.md in this folder.
//
// How a preset is reused: installStylePreset writes its style kit into the workspace's kit store (engine_kits), so a theme page can
// name the kit id; the reference's format id is the one the Content Factory gives the same reference file, so the Video DNA the first
// analysis stores is reused by every later run of that format.

import {
  EngineError,
  styleKitSchema,
  visualTreatmentSchema,
  type BeatRole,
  type GeneId,
  type LookPreset,
  type StyleKit,
  type VisualType,
} from "../contracts/index.ts";
import { writeKit, type StoredKit } from "../jobs/kit-store.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { threeDDataExplainer } from "./three-d-data-explainer.ts";

export type StylePreset = {
  presetId: string;
  version: number;
  label: string;
  summary: string;
  /** The reference the preset was built from. formatId follows the Content Factory rule: `ref_` and the first 24 hex of the SHA-256. */
  reference: { formatId: string; sha256: string; durationMs: number; width: number; height: number; fps: number; analysedOn: string };
  styleKit: StyleKit;
  look: { preset: LookPreset; strength: number; source: "chosen" | "read" };
  grammar: {
    /** Numbers from the media functions and the engine's analysis code. */
    measured: Record<string, unknown>;
    /** Observations from the reference's frames, made outside the engine's roles. */
    read: Record<string, unknown>;
    /** What was not measured, and why. Never filled with a guess. */
    unknown: string[];
  };
  structure: Array<{ role: BeatRole; fromMs: number; toMs: number; intent: string; visual: string }>;
  genes: { keep: GeneId[]; change: string[]; notTransferable: string[] };
  shots: Array<{ id: string; visualType: VisualType; want: string }>;
  /** What the preset cannot express or draw today, and what each needs. */
  gaps: Array<{ what: string; why: string; needs: string }>;
};

export const STYLE_PRESETS: readonly StylePreset[] = [threeDDataExplainer];

/** The preset with this id. An unknown id is refused, never defaulted (CLAUDE.md rule 1). */
export function stylePreset(presetId: string): StylePreset {
  const preset = STYLE_PRESETS.find((candidate) => candidate.presetId === presetId);
  if (preset === undefined) {
    throw new EngineError("invalid_input", `there is no style preset "${presetId}"`, { stage: "presets" });
  }
  return preset;
}

/** Checks a preset against the contracts it uses. Returns the problems; an empty list means the preset is usable. */
export function presetProblems(preset: StylePreset): string[] {
  const problems: string[] = [];
  const kit = styleKitSchema.safeParse(preset.styleKit);
  if (!kit.success) problems.push(`style kit: ${kit.error.message}`);
  const look = visualTreatmentSchema.safeParse({ version: 1, look: { preset: preset.look.preset, strength: preset.look.strength } });
  if (!look.success) problems.push(`look: ${look.error.message}`);
  if (!/^ref_[0-9a-f]{24}$/.test(preset.reference.formatId) || preset.reference.formatId !== `ref_${preset.reference.sha256.slice(0, 24)}`) {
    problems.push("reference: formatId must be ref_ and the first 24 hex characters of the SHA-256");
  }
  let previousEnd = 0;
  for (const beat of preset.structure) {
    if (beat.fromMs !== previousEnd) problems.push(`structure: the ${beat.role} beat starts at ${beat.fromMs} ms, not at ${previousEnd} ms`);
    if (beat.toMs <= beat.fromMs) problems.push(`structure: the ${beat.role} beat ends before it starts`);
    previousEnd = beat.toMs;
  }
  if (preset.structure.length > 0 && previousEnd !== preset.reference.durationMs) {
    problems.push(`structure: the beats end at ${previousEnd} ms, not at the reference's ${preset.reference.durationMs} ms`);
  }
  for (const shot of preset.shots) {
    if (preset.styleKit.bannedTypes.includes(shot.visualType)) problems.push(`shots: ${shot.id} uses the banned type ${shot.visualType}`);
  }
  return problems;
}

/**
 * Writes the preset's style kit into one workspace's kit store, so a theme page can name it. The same kit twice is one row. A preset
 * with problems is refused before anything is written.
 */
export async function installStylePreset(
  sql: Sql,
  input: { organizationId: string; presetId: string },
): Promise<StoredKit<unknown>> {
  const preset = stylePreset(input.presetId);
  const problems = presetProblems(preset);
  if (problems.length > 0) {
    throw new EngineError("invalid_input", `the style preset "${preset.presetId}" is not usable: ${problems.join("; ")}`, {
      stage: "presets",
    });
  }
  return writeKit(sql, { organizationId: input.organizationId, kind: "style", body: preset.styleKit });
}
