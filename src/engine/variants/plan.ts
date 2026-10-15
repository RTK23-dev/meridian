// The scene plan of a variant (Video Engine Bible 6.13). A variant is the master plan with one change: a product swap gives the product
// shots the product kit's hero image as their reference, and a persona change gives the presenter shots the persona's portrait. Every
// other shot is the master's own object, unchanged, so produce_shot re-produces only the shots the change touches, and the unchanged
// shots keep the master's accepted takes. The shot ids and the timing stay the master's. The prompts are not rewritten here: a product
// swap whose prompt names the master's product needs the planner (see variants/STATUS.md).

import { EngineError, scenePlanSchema, type Decision, type Persona, type ProductKit, type ScenePlan, type ShotSpec } from "../contracts/index.ts";

const STAGE = "variants";

/** The reference a product swap uses: the kit's front hero image, else its first hero image. Null when the kit has no hero image. */
export function productReferenceOf(kit: ProductKit): string | null {
  const front = kit.heroImages.find((image) => image.angle === "front");
  return (front ?? kit.heroImages[0])?.uri ?? null;
}

/** The reference a persona change uses: the persona's first portrait. Portraits are required, so this is null only for a broken kit. */
export function personaReferenceOf(persona: Persona): string | null {
  return persona.portraits[0] ?? null;
}

export type VariantPlanInput = {
  /** The variant key (attribute and value), for example "product:SKU-2". It names the plan and the decision. */
  key: string;
  attribute: "hook" | "product" | "persona" | "language";
  /** The new reference of each generated shot the change touches, or null when the change keeps the shots' references. */
  reference: string | null;
  /** The shots the change touches (the variant's produceShotIds). Each must be a generated shot of the master plan. */
  shotIds: readonly string[];
  /** The variant's voice track when its voice was regenerated. The master's voice track otherwise. */
  voiceTrackId?: string;
  /** What the variant chose, in plain words, for the decision record. */
  chose: string;
};

export type VariantPlan = {
  plan: ScenePlan;
  /** The shots whose take is made again, sorted. The master's other shots are unchanged. */
  changedShotIds: string[];
};

function slugOf(key: string): string {
  return key.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The master plan with one change. Pure. Throws invalid_input when a touched shot is not in the master plan or is not generated (only a
 * generated shot has a take to make again), and when the result does not parse against the scene plan contract.
 */
export function variantScenePlan(master: ScenePlan, input: VariantPlanInput): VariantPlan {
  const touched = new Set(input.shotIds);
  const found = new Set<string>();
  const shots: ShotSpec[] = master.shots.map((shot) => {
    if (!touched.has(shot.shotId)) return shot;
    found.add(shot.shotId);
    if (shot.source.kind !== "generate") {
      throw new EngineError("invalid_input", `shot ${shot.shotId} is not generated, so the ${input.attribute} variant cannot re-produce it`, { stage: STAGE });
    }
    if (input.reference === null) return shot;
    return { ...shot, source: { ...shot.source, refs: [input.reference] } };
  });
  for (const shotId of touched) {
    if (!found.has(shotId)) throw new EngineError("invalid_input", `shot ${shotId} is not in the master plan`, { stage: STAGE });
  }
  const decision: Decision = {
    at: `variant:${input.key}`,
    chose: input.chose,
    alternatives: [],
    reason: `the ${input.attribute} variant changes ${touched.size} generated shot${touched.size === 1 ? "" : "s"} of the master`,
    by: "human",
  };
  const parsed = scenePlanSchema.safeParse({
    ...master,
    planId: `${master.planId}.${slugOf(input.key)}`,
    voiceTrackId: input.voiceTrackId ?? master.voiceTrackId,
    shots,
    decisions: [...master.decisions, decision],
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EngineError("invalid_input", `the variant plan does not match its contract: ${issue ? issue.path.join(".") || "(root)" : "unknown"}`, {
      stage: STAGE,
    });
  }
  return { plan: parsed.data, changedShotIds: [...touched].sort() };
}
