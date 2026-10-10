import type { ModelCapabilityRecord, ModelCapabilityRegistry } from "./registry.ts";
import { estimateCost, type CostEstimate, type PriceQuote, type PriceStatus, type PriceUnit } from "./pricing.ts";

/**
 * Capability and cost matrix (P4a, P4b). A provider is chosen for a deliverable only when one of its registered models
 * meets every requirement the deliverable has: the generation task, the duration (video), and the aspect ratio. Among
 * the models that meet them, LOWEST_COST takes the cheapest known estimate and PREFERENCE takes the first in the mode's
 * order. Every refusal is recorded with its reasons, so a choice can be audited and a refusal is never silent.
 *
 * P4b: a candidate with an unknown or stale price is refused unless the caller allows unknown costs. Under LOWEST_COST
 * an allowed unknown-cost candidate sorts after every known one, because it cannot be compared. A requirement's task
 * fixes the modality it produces, so a video task cannot satisfy an image requirement, and the reverse.
 *
 * The task is the output check: a text-to-video or image-to-video model produces video. The registry's
 * supported_modalities lists inputs, so it is not used to decide what a model outputs.
 */

export type SelectionModality = "video" | "image";

export type SelectionTask = "text-to-video" | "image-to-video" | "text-to-image";

/** The modality each generation task produces. */
const TASK_MODALITY: Record<SelectionTask, SelectionModality> = {
  "text-to-video": "video",
  "image-to-video": "video",
  "text-to-image": "image",
};

/** What is billed for one unit of each modality: seconds of video, or images. */
const BILLED_UNIT: Record<SelectionModality, PriceUnit> = {
  video: "per_second",
  image: "per_image",
};

export interface SelectionRequirement {
  modality: SelectionModality;
  task: SelectionTask;
  /** Video only: the duration the model must offer. Null for an image, which has no duration. */
  durationSeconds: number | null;
  aspectRatio: string;
  /** What is billed: seconds for video, images for an image. For video it equals durationSeconds. */
  units: number;
}

/** A provider's cost as Meridian holds it: its price, and whether it is a zero-spend manual workflow. */
export interface ProviderCost {
  id: string;
  zeroSpend: boolean;
  price: PriceQuote;
}

export interface SelectionCandidate {
  provider: ProviderCost;
  record: ModelCapabilityRecord;
}

export interface SelectionRejection {
  providerId: string;
  modelId: string;
  reasons: string[];
}

export interface SelectionRecord {
  requirement: SelectionRequirement;
  mode: "LOWEST_COST" | "PREFERENCE";
  chosen: {
    providerId: string;
    modelId: string;
    costKnown: boolean;
    costStatus: PriceStatus;
    /** Null when the cost is not known. A missing price is never recorded as zero. */
    estimateUsd: number | null;
  } | null;
  rejected: SelectionRejection[];
}

/** A requirement is a caller's statement of what to make. An inconsistent one is an error, not a refusal. */
function validateRequirement(requirement: SelectionRequirement): void {
  if (TASK_MODALITY[requirement.task] !== requirement.modality) {
    throw new Error(`requirement task ${requirement.task} produces ${TASK_MODALITY[requirement.task]}, not ${requirement.modality}`);
  }
  if (requirement.modality === "video") {
    if (requirement.durationSeconds === null || !(requirement.durationSeconds > 0)) {
      throw new Error("a video requirement needs a positive duration");
    }
    if (requirement.units !== requirement.durationSeconds) {
      throw new Error("a video requirement bills its duration: units must equal durationSeconds");
    }
    return;
  }
  if (requirement.durationSeconds !== null) throw new Error("an image requirement has no duration");
  if (!Number.isInteger(requirement.units) || requirement.units < 1) {
    throw new Error("an image requirement bills a whole number of images, at least one");
  }
}

/** Why a candidate cannot produce the requirement. An empty list means it can. */
export function refusalReasons(input: {
  candidate: SelectionCandidate;
  requirement: SelectionRequirement;
  registry: ModelCapabilityRegistry;
  /** An explicitly requested model may be deprecated but still usable until its shutdown. Automatic selection never is. */
  allowDeprecated?: boolean;
  /** An explicitly requested manual workflow is a deliberate choice. Automatic selection never picks one. */
  allowZeroSpend?: boolean;
  /** An explicitly requested provider may have no known price. Automatic selection needs an explicit policy for that. */
  allowUnknownCost?: boolean;
}): string[] {
  const { candidate, requirement, registry, allowDeprecated = false, allowZeroSpend = false, allowUnknownCost = false } = input;
  const { provider, record } = candidate;
  const reasons: string[] = [];
  if (provider.zeroSpend && !allowZeroSpend) reasons.push("zero-spend workflows are not selected for automatic generation");
  const lifecycle = registry.checkModelLifecycle(record.model_id);
  if (!lifecycle.usable) reasons.push(`model is ${lifecycle.state}`);
  else if (lifecycle.state === "DEPRECATED" && !allowDeprecated) reasons.push("model is DEPRECATED and is not selected automatically");
  if (!record.supported_tasks.includes(requirement.task)) reasons.push(`does not support ${requirement.task}`);
  if (requirement.modality === "video" && requirement.durationSeconds !== null) {
    if (record.durations.length === 0) reasons.push("declares no durations");
    else if (!record.durations.includes(requirement.durationSeconds)) reasons.push(`does not offer ${requirement.durationSeconds}s`);
  }
  if (!record.aspect_ratios.includes(requirement.aspectRatio)) reasons.push(`does not offer ${requirement.aspectRatio}`);
  const cost = estimateCost(provider.price, requirement.units, BILLED_UNIT[requirement.modality]);
  if (!cost.costKnown && !allowUnknownCost) {
    reasons.push(`cost ${cost.costStatus}: needs a known price, or allowUnknownCost to select it`);
  }
  return reasons;
}

export function selectOffer(input: {
  candidates: SelectionCandidate[];
  requirement: SelectionRequirement;
  registry: ModelCapabilityRegistry;
  mode: "LOWEST_COST" | "PREFERENCE";
  preference?: string[];
  allowDeprecated?: boolean;
  allowZeroSpend?: boolean;
  allowUnknownCost?: boolean;
}): SelectionRecord {
  const { candidates, requirement, registry, mode, preference = [], allowDeprecated, allowZeroSpend, allowUnknownCost } = input;
  validateRequirement(requirement);
  const rejected: SelectionRejection[] = [];
  const eligible: { candidate: SelectionCandidate; cost: CostEstimate }[] = [];
  for (const candidate of candidates) {
    const reasons = refusalReasons({ candidate, requirement, registry, allowDeprecated, allowZeroSpend, allowUnknownCost });
    if (reasons.length > 0) {
      rejected.push({ providerId: candidate.provider.id, modelId: candidate.record.model_id, reasons });
    } else {
      const cost = estimateCost(candidate.provider.price, requirement.units, BILLED_UNIT[requirement.modality]);
      eligible.push({ candidate, cost });
    }
  }
  const rank = (providerId: string) => {
    const index = preference.indexOf(providerId);
    return index === -1 ? preference.length : index;
  };
  // A known cost sorts before an unknown one, because an unknown cost cannot be compared.
  const byCost = (a: { cost: CostEstimate }, b: { cost: CostEstimate }) => {
    if (a.cost.costKnown !== b.cost.costKnown) return a.cost.costKnown ? -1 : 1;
    return (a.cost.estimateUsd ?? 0) - (b.cost.estimateUsd ?? 0);
  };
  const byName = (a: { candidate: SelectionCandidate }, b: { candidate: SelectionCandidate }) =>
    a.candidate.provider.id.localeCompare(b.candidate.provider.id) || a.candidate.record.model_id.localeCompare(b.candidate.record.model_id);
  eligible.sort((a, b) => {
    if (mode === "LOWEST_COST") return byCost(a, b) || byName(a, b);
    return rank(a.candidate.provider.id) - rank(b.candidate.provider.id) || byCost(a, b) || byName(a, b);
  });
  const first = eligible[0];
  return {
    requirement,
    mode,
    chosen: first
      ? {
          providerId: first.candidate.provider.id,
          modelId: first.candidate.record.model_id,
          costKnown: first.cost.costKnown,
          costStatus: first.cost.costStatus,
          estimateUsd: first.cost.estimateUsd,
        }
      : null,
    rejected,
  };
}
