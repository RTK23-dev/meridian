import type { ModelCapabilityRecord, ModelCapabilityRegistry } from "./registry.ts";

/**
 * Capability and cost matrix (P4a). A provider is chosen for a deliverable only when one of its registered models meets
 * every requirement the deliverable has: the generation task, the duration, and the aspect ratio. Among the models that
 * meet them, LOWEST_COST takes the cheapest estimate and PREFERENCE takes the first in the mode's order. Every refusal is
 * recorded with its reasons, so a choice can be audited and a refusal is never silent.
 *
 * The task is the output check: a text-to-video or image-to-video model produces video. The registry's
 * supported_modalities lists inputs, so it is not used to decide what a model outputs.
 */

export type SelectionTask = "text-to-video" | "image-to-video";

export interface SelectionRequirement {
  task: SelectionTask;
  durationSeconds: number;
  aspectRatio: string;
}

/** The cost fields a provider declares. A zero-spend provider is a manual workflow, not a generator. */
export interface ProviderCost {
  id: string;
  costPerSecondEstimateUsd: number;
  zeroSpend: boolean;
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
  chosen: { providerId: string; modelId: string; estimateUsd: number } | null;
  rejected: SelectionRejection[];
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
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
}): string[] {
  const { candidate, requirement, registry, allowDeprecated = false, allowZeroSpend = false } = input;
  const { provider, record } = candidate;
  const reasons: string[] = [];
  if (provider.zeroSpend && !allowZeroSpend) reasons.push("zero-spend workflows are not selected for automatic generation");
  const lifecycle = registry.checkModelLifecycle(record.model_id);
  if (!lifecycle.usable) reasons.push(`model is ${lifecycle.state}`);
  else if (lifecycle.state === "DEPRECATED" && !allowDeprecated) reasons.push("model is DEPRECATED and is not selected automatically");
  if (!record.supported_tasks.includes(requirement.task)) reasons.push(`does not support ${requirement.task}`);
  if (record.durations.length === 0) reasons.push("declares no durations");
  else if (!record.durations.includes(requirement.durationSeconds)) reasons.push(`does not offer ${requirement.durationSeconds}s`);
  if (!record.aspect_ratios.includes(requirement.aspectRatio)) reasons.push(`does not offer ${requirement.aspectRatio}`);
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
}): SelectionRecord {
  const { candidates, requirement, registry, mode, preference = [], allowDeprecated, allowZeroSpend } = input;
  const rejected: SelectionRejection[] = [];
  const eligible: { candidate: SelectionCandidate; estimateUsd: number }[] = [];
  for (const candidate of candidates) {
    const reasons = refusalReasons({ candidate, requirement, registry, allowDeprecated, allowZeroSpend });
    if (reasons.length > 0) {
      rejected.push({ providerId: candidate.provider.id, modelId: candidate.record.model_id, reasons });
    } else {
      eligible.push({ candidate, estimateUsd: roundUsd(requirement.durationSeconds * candidate.provider.costPerSecondEstimateUsd) });
    }
  }
  const rank = (providerId: string) => {
    const index = preference.indexOf(providerId);
    return index === -1 ? preference.length : index;
  };
  const byName = (a: { candidate: SelectionCandidate }, b: { candidate: SelectionCandidate }) =>
    a.candidate.provider.id.localeCompare(b.candidate.provider.id) || a.candidate.record.model_id.localeCompare(b.candidate.record.model_id);
  eligible.sort((a, b) => {
    if (mode === "LOWEST_COST") return a.estimateUsd - b.estimateUsd || byName(a, b);
    return rank(a.candidate.provider.id) - rank(b.candidate.provider.id) || a.estimateUsd - b.estimateUsd || byName(a, b);
  });
  const first = eligible[0];
  return {
    requirement,
    mode,
    chosen: first
      ? { providerId: first.candidate.provider.id, modelId: first.candidate.record.model_id, estimateUsd: first.estimateUsd }
      : null,
    rejected,
  };
}
