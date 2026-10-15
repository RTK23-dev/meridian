// The work list of a generation variant (Video Engine Bible 6.13). The variants stage hands the orchestrator one item for each generation
// variant it funded: its attribute, its writer call (the words it changes), the beats the voice stage speaks again, and the generated
// shots that produce_shot makes again. The orchestrator queues one job per phase of the item (writer, voice, plan) and then one produce
// job per changed shot (jobs/variant-runs.ts). Pure: no call and no write.
//
// Voice is a full re-speak (Bible 6.13 deviation, variants/STATUS.md): a variant that changes any line speaks every beat of its own
// script, not only the changed beats, because an EDL holds one voice clip and there is no splice yet.

import { createHash } from "node:crypto";
import { z } from "zod";
import { EngineError, type ProductionRequest } from "../contracts/index.ts";
import type { PlannedVariant } from "./expand.ts";

/**
 * The phases of a generation variant. Its writer call, its voice and its plan run first, in that order (nextPhaseOf). Its assembly (the EDL
 * over its own takes and voice) runs after its produce and check jobs, once every shot it changes has a take that passed.
 */
export const VARIANT_PHASES = ["writer", "voice", "plan", "assemble"] as const;
export type VariantPhase = (typeof VARIANT_PHASES)[number];

const beatIdsSchema = z.array(z.string().min(1).max(64));

export const variantWorkItemSchema = z.object({
  /** Unique within the request: the attribute and the value, for example "hook:2" (variants/expand.ts). */
  key: z.string().min(1).max(120),
  attribute: z.enum(["hook", "product", "persona", "language"]),
  /** The job subject of the item's phases. It is a slug of the key: no ':' and no '.', so job keys and shot subjects stay unambiguous. */
  subject: z.string().regex(/^[A-Za-z0-9-]+$/).min(1).max(120),
  change: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("hook"), index: z.number().int().min(1) }),
    z.object({ kind: z.literal("product"), sku: z.string().min(1).max(120) }),
    z.object({ kind: z.literal("persona"), personaId: z.string().min(1).max(120) }),
    z.object({ kind: z.literal("language"), language: z.string().min(2).max(16) }),
  ]),
  /** The writer's call: the beats whose new line it writes, or the product shots whose new prompt it writes. Null when no words change. */
  writer: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("lines"), beatIds: beatIdsSchema.min(1) }),
      z.object({ kind: z.literal("product_prompts"), shotIds: beatIdsSchema.min(1) }),
    ])
    .nullable(),
  /** The beats the voice stage speaks again, in script order: every beat of the variant's script (a full re-speak). */
  voiceBeatIds: beatIdsSchema,
  /** The generated shots whose take is made again (produce_shot). */
  produceShotIds: beatIdsSchema,
});
export type VariantWorkItem = z.infer<typeof variantWorkItemSchema>;

/** The job subject of a variant's phases: a slug of its key with a short digest, so two keys never share one. */
export function variantSubjectOf(key: string): string {
  const slug = key
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 10);
  return `${slug.length > 0 ? slug : "variant"}-${digest}`;
}

/** The job subject of one produce job of a variant: the variant's subject and the plan shot, joined by '.' (never a ':'). */
export function variantShotSubjectOf(subject: string, shotId: string): string {
  return `${subject}.${shotId}`;
}

/**
 * The work list item of a generation variant, or null for a caption or music variant (it needs no generation). The request gives the
 * beats of the full re-speak. Pure.
 */
export function generationWorkOf(variant: PlannedVariant, request: ProductionRequest): VariantWorkItem | null {
  if (variant.build !== "generation") return null;
  const allBeats = request.script.beats.map((beat) => beat.beatId);
  const change = variant.change;
  switch (change.kind) {
    case "hook":
      return {
        key: variant.key,
        attribute: "hook",
        subject: variantSubjectOf(variant.key),
        change: { kind: "hook", index: change.index },
        writer: variant.work.writerBeatIds.length > 0 ? { kind: "lines", beatIds: [...variant.work.writerBeatIds] } : null,
        voiceBeatIds: allBeats,
        produceShotIds: [...variant.work.produceShotIds],
      };
    case "language":
      return {
        key: variant.key,
        attribute: "language",
        subject: variantSubjectOf(variant.key),
        change: { kind: "language", language: change.language },
        writer: { kind: "lines", beatIds: allBeats },
        voiceBeatIds: allBeats,
        produceShotIds: [...variant.work.produceShotIds],
      };
    case "persona":
      return {
        key: variant.key,
        attribute: "persona",
        subject: variantSubjectOf(variant.key),
        change: { kind: "persona", personaId: change.personaId },
        writer: null,
        voiceBeatIds: allBeats,
        produceShotIds: [...variant.work.produceShotIds],
      };
    case "product":
      return {
        key: variant.key,
        attribute: "product",
        subject: variantSubjectOf(variant.key),
        change: { kind: "product", sku: change.sku },
        writer: variant.work.produceShotIds.length > 0 ? { kind: "product_prompts", shotIds: [...variant.work.produceShotIds] } : null,
        voiceBeatIds: [],
        produceShotIds: [...variant.work.produceShotIds],
      };
    case "caption":
    case "music":
      return null;
  }
}

/** The phase a variant runs next, given the phases it has finished. Null when all three are done. A phase with no work is not run. */
export function nextPhaseOf(item: Pick<VariantWorkItem, "writer" | "voiceBeatIds">, done: readonly VariantPhase[]): VariantPhase | null {
  if (item.writer !== null && !done.includes("writer")) return "writer";
  if (item.voiceBeatIds.length > 0 && !done.includes("voice")) return "voice";
  if (!done.includes("plan")) return "plan";
  return null;
}

/**
 * The request the voice stage speaks for one variant: every beat of the master's script, in order, with the lines the writer wrote in
 * place of the beats it changed, and the variant's language. An emphasis word survives only when the new text still contains it. Pure.
 */
export function variantRequestFor(input: {
  request: ProductionRequest;
  language: string;
  lines: readonly { beatId: string; text: string }[];
}): ProductionRequest {
  const textOf = new Map<string, string>();
  for (const line of input.lines) {
    if (textOf.has(line.beatId)) {
      throw new EngineError("invalid_input", `beat ${line.beatId} has two lines in one variant`, { stage: "variants" });
    }
    textOf.set(line.beatId, line.text);
  }
  const known = new Set(input.request.script.beats.map((beat) => beat.beatId));
  for (const beatId of textOf.keys()) {
    if (!known.has(beatId)) throw new EngineError("invalid_input", `beat ${beatId} is not a beat of the request`, { stage: "variants" });
  }
  const beats = input.request.script.beats.map((beat) => {
    const text = textOf.get(beat.beatId) ?? beat.text;
    return { ...beat, text, emphasis: (beat.emphasis ?? []).filter((word) => text.includes(word)) };
  });
  return { ...input.request, script: { language: input.language, beats } };
}
