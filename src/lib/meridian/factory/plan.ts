/**
 * The Plan stage (NORTH_STAR section 5, plan). A pick becomes one CreativePlan (creative/plan.ts) for the brand's product, and its
 * variants. Each variant changes exactly one attribute against the control, which is the plan as the graded concept gives it.
 *
 * The attributes are hook, angle, format, proof and CTA. The control reads them from the concept's creative DNA, which holds the
 * framework of the winning ad (its hook type, angle and format), never its words. A variant takes its value from the brand's brain,
 * one entry at a time, used as the brand wrote it. A brain field with no entry gives no variant. Nothing here invents a hook or a CTA.
 *
 * A plan needs a persisted engine decision behind it (creative/lineage.ts). A pick with none gets no plan, and no variant.
 */

import type { BrainKey } from "../brain.ts";
import { requireCitedDeliverables, validatePlanLineage, type PlanLineage } from "../creative/lineage.ts";
import type {
  CampaignObjective,
  CreationScope,
  CreativeDeliverable,
  CreativePlan,
  DecisionRationale,
  PlanProductionContext,
} from "../creative/plan.ts";
import { FORMATS, type AdFormat, type CreativeDna } from "./creative-dna.ts";
import { linesOf } from "./brain-facts.ts";
import type { Concept } from "./pick.ts";
import { studioAutonomyOfAutomation } from "./run-settings.ts";

export const PLAN_ATTRIBUTES = ["hook", "angle", "format", "proof", "cta"] as const;
export type PlanAttribute = (typeof PLAN_ATTRIBUTES)[number];

/** What a plan's control says about the creative. Presenter and length are carried, and no variant changes them. */
export type PlanAttributes = {
  hook: string;
  angle: string;
  format: string;
  proof: string;
  cta: string;
  presenter: string;
  lengthMs: number;
};

export const PLAN_SCHEMA = "meridian.factory-plan.v1" as const;

/** The stored plan of one pick: its control's attributes and the CreativePlan built for them. */
export type StoredPlan = { schema: typeof PLAN_SCHEMA; attributes: PlanAttributes; creativePlan: CreativePlan };

/** The most frequent presenter in the DNA's scenes. Empty when no scene names one, so an unknown presenter stays unknown. */
function presenterOf(dna: CreativeDna): string {
  const counts = new Map<string, number>();
  for (const scene of dna.scenes) {
    const value = scene.presenter?.value?.trim() ?? "";
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The control's attributes, from the concept's creative DNA. The DNA classifies the winning ad's hook, angle and format. It does not
 * classify a proof point or a call to action, so those are empty in the control, and the brain supplies them to variants.
 */
export function controlAttributesOf(dna: CreativeDna): PlanAttributes {
  return {
    hook: dna.hook.type.value.trim(),
    angle: dna.angle.value.trim(),
    format: dna.format.value.trim(),
    proof: "",
    cta: "",
    presenter: presenterOf(dna),
    lengthMs: dna.durationMs,
  };
}

/** The values the brain supplies for each attribute that varies. Each is one entry the brand wrote. */
export function brainEntriesOf(brain: Record<BrainKey, string>): Record<PlanAttribute, string[]> {
  const formats = new Set<string>(FORMATS);
  return {
    hook: linesOf(brain.problems),
    angle: linesOf(brain.differentiators),
    format: [...new Set(linesOf(brain.preferredFormats).flatMap((entry) => entry.split(/[\s,]+/)).map((word) => word.toLowerCase()))].filter(
      (word): word is AdFormat => formats.has(word),
    ),
    proof: linesOf(brain.proofPoints),
    cta: linesOf(brain.offers),
  };
}

export type AttributeVariant = { attribute: PlanAttribute; value: string; attributes: PlanAttributes };

/**
 * The variants of a control, up to `cap`. For each attribute the brain supplies, one variant per entry that differs from the control's
 * value. Each variant is the control with only that attribute changed. The entries are taken round by round across the attributes, so
 * a cap does not leave the later attributes with none.
 */
export function variantsOf(control: PlanAttributes, entries: Record<PlanAttribute, string[]>, cap: number): AttributeVariant[] {
  const variants: AttributeVariant[] = [];
  const longest = Math.max(0, ...PLAN_ATTRIBUTES.map((attribute) => entries[attribute].length));
  for (let round = 0; round < longest; round += 1) {
    for (const attribute of PLAN_ATTRIBUTES) {
      if (round >= entries[attribute].length) continue;
      const value = entries[attribute][round] ?? "";
      if (!value || value === control[attribute]) continue;
      if (variants.length >= Math.max(0, cap)) return variants;
      variants.push({ attribute, value, attributes: { ...control, [attribute]: value } });
    }
  }
  return variants;
}

/** The formats the plan can make. The run's formats are checked against this set, so an unknown name is never a deliverable. */
const SUPPORTED_FORMATS: ReadonlySet<string> = new Set(["image", "video", "carousel"]);

export type PlanRun = {
  formats: string[];
  automation: "manual" | "semi" | "full";
  intent: "organic" | "ad" | "both";
  capTotalCents: number;
};

export type PlanInput = {
  templateId: string;
  concept: Concept;
  attributes: PlanAttributes;
  /** The persisted engine decision that backs the item: the grade's gate record. Without one the plan is refused. */
  decisionId: string;
  researchAdId: string;
  winnerScore: number;
  /** The brand's product the plan is for. Empty is refused, because the plan has no product to name. */
  productName: string;
  audience: string;
  run: PlanRun;
  now: string;
  /** A saved Factory Line video shape. Absent means the plan keeps the DNA length and 9:16. */
  video?: { aspectRatio: "9:16" | "1:1" | "16:9" | "4:5"; durationSeconds: number } | null;
  /** Saved brief instructions. Absent means the plan carries no extra direction. Spoken copy is still written at production. */
  briefPrompt?: string | null;
};

const SCOPE_BY_FORMAT: Record<string, CreationScope> = { image: "image_only", video: "video_only", carousel: "carousel_only" };

/** A deliverable per run format. Its copy is empty: the words are written at production, never copied from the winning ad. */
function deliverablesOf(
  templateId: string,
  concept: Concept,
  attributes: PlanAttributes,
  formats: string[],
  video: PlanInput["video"],
  briefPrompt: string | null | undefined,
): CreativeDeliverable[] {
  const direction = briefPrompt?.trim() ?? "";
  return formats.map((format, index): CreativeDeliverable => {
    const base = {
      id: `deliv-${templateId}-${format}`,
      sequenceIndex: index,
      title: concept.label,
      copy: "",
      provider: "auto",
      model: "",
      ...(direction ? { visualDirection: direction } : {}),
    };
    if (format === "video") {
      return {
        ...base,
        kind: "video",
        format: "video_ugc",
        aspectRatio: video?.aspectRatio ?? "9:16",
        targetDurationSeconds: video?.durationSeconds ?? Math.max(1, Math.round(attributes.lengthMs / 1000)),
        hook: { type: attributes.hook },
        concept: { mechanism: concept.label, theme: attributes.angle },
      };
    }
    if (format === "carousel") {
      return { ...base, kind: "carousel_slide", format: "carousel", aspectRatio: "4:5", hook: { type: attributes.hook }, concept: { mechanism: concept.label, theme: attributes.angle } };
    }
    return { ...base, kind: "image", format: "single_image", aspectRatio: "1:1", hook: { type: attributes.hook }, concept: { mechanism: concept.label, theme: attributes.angle } };
  });
}

/**
 * The CreativePlan for one pick. A manual or semi plan stays a draft and waits for a person. A full plan is approved on its own only when a spend cap is set and the estimate is within it. With no cap, a full plan stays a draft: an unpriced estimate of zero is not a cap. It spends nothing: no
 * production step is written here, and the estimate lists every deliverable as unpriced, since no provider has been chosen.
 * Throws when the plan has no lineage, no product, or no formats, so the caller records the refusal and writes no variant.
 */
export function creativePlanFor(input: PlanInput): CreativePlan {
  const lineage: PlanLineage = validatePlanLineage({
    decisionId: input.decisionId,
    evidenceRefs: [`research_ad:${input.researchAdId}`, `creative_dna:dna:${input.researchAdId}`],
  });
  if (!input.productName.trim()) {
    throw new Error("Creative plan refused: the brand records no product, so the plan has no product to name.");
  }
  const formats = [...new Set(input.run.formats)].filter((format) => SUPPORTED_FORMATS.has(format));
  if (formats.length === 0) {
    throw new Error("Creative plan refused: the run names no format the plan can make.");
  }
  const deliverables = deliverablesOf(input.templateId, input.concept, input.attributes, formats, input.video, input.briefPrompt);
  requireCitedDeliverables(lineage, deliverables.length);
  const scope: CreationScope = formats.length === 1 ? SCOPE_BY_FORMAT[formats[0] ?? ""] ?? "mixed_campaign" : "mixed_campaign";
  const autonomy = studioAutonomyOfAutomation(input.run.automation);
  const estimateUsd = 0;
  const hasCap = input.run.capTotalCents > 0;
  const withinCap = hasCap && estimateUsd <= input.run.capTotalCents / 100;
  const autoApproved = autonomy === "fully_automatic" && withinCap;
  const objective: CampaignObjective = input.run.intent === "organic" ? "engagement" : "conversion";
  const rationale: DecisionRationale[] = [
    {
      topic: "observed_signal",
      claim: `The concept's observed winner score is ${input.winnerScore}.`,
      groundedIn: "evidence_metric",
      sourceId: input.researchAdId,
      detail: "The observed signal the grade stage stored for the ad: its survival from real sightings.",
    },
    {
      topic: "engine_grade",
      claim: "The engine grade for this item is the decision this plan was made under.",
      groundedIn: "jev_answer",
      sourceId: lineage.decisionId,
      detail: "The gate record that holds the engine's answers for the five grading questions.",
    },
  ];
  const whyOtherFormatsRejected: Record<string, string> = {};
  for (const format of ["image", "video", "carousel"]) {
    if (!formats.includes(format)) whyOtherFormatsRejected[format] = "Not a format this run makes.";
  }
  const productionContext: PlanProductionContext = {
    title: input.concept.label,
    audience: input.audience,
    angle: input.attributes.angle,
    productName: input.productName.trim(),
    opportunityId: null,
  };
  return {
    id: `plan-${input.templateId}`,
    version: "factory.v2.plan.1",
    status: autoApproved ? "approved" : "draft",
    scope,
    autonomy,
    objective,
    selectedConceptId: input.concept.label,
    rationale,
    deliverables,
    assetPlan: [],
    productionPlan: [],
    estimatedCost: {
      totalEstimatedUsd: estimateUsd,
      perDeliverableUsd: {},
      unpricedDeliverableIds: deliverables.map((deliverable) => deliverable.id),
      isHardCapped: hasCap,
      maxSpendUsd: hasCap ? input.run.capTotalCents / 100 : undefined,
      currency: "USD",
      label: "PRE_GENERATION_ESTIMATE",
    },
    approvalRequirements: [
      {
        id: `approval-production-${input.templateId}`,
        level: autoApproved ? "spend_threshold" : "human_creative_director",
        status: autoApproved ? "auto_approved" : "pending",
        reason: autoApproved
          ? "Full automation is within the spend cap, so this plan is approved without a person."
          : autonomy === "fully_automatic"
            ? "Full automation has no spend cap, so this plan is not approved on its own."
            : "Production spends money. A manual or semi run waits for a person before it.",
        requiredBeforeAction: "production_execution",
      },
    ],
    fallbackPlan: [],
    constraintsApplied: [
      { constraintName: "creationScope", constraintValue: scope, source: "user_intent" },
      { constraintName: "autonomyMode", constraintValue: autonomy, source: "user_intent" },
      ...(input.run.capTotalCents > 0 ? [{ constraintName: "maxSpendUsd", constraintValue: input.run.capTotalCents / 100, source: "spend_cap" as const }] : []),
    ],
    whyFormatChosen: `The run's formats are ${formats.join(", ")}.`,
    whyOtherFormatsRejected,
    createdAt: input.now,
    lineage,
    productionContext,
  };
}

export function storedPlanOf(attributes: PlanAttributes, plan: CreativePlan): string {
  const stored: StoredPlan = { schema: PLAN_SCHEMA, attributes, creativePlan: plan };
  return JSON.stringify(stored);
}

/** The stored plan of a template, or null when the template has none (its plan was refused, or it predates the plan). */
export function parseStoredPlan(value: string): StoredPlan | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredPlan>;
    if (parsed.schema !== PLAN_SCHEMA || !parsed.attributes || !parsed.creativePlan) return null;
    return parsed as StoredPlan;
  } catch {
    return null;
  }
}
