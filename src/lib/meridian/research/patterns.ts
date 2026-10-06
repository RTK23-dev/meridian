import type { ResearchAnalysis, ResearchField } from "./schema.ts";

export type ResearchPattern = {
  scope?: "brand" | "organization";
  dimension: "topic" | "openingMove" | "hookMechanism" | "hook" | "structure" | "evidenceOffered" | "emotionalAppeal" | "adviceSpecificity" | "cta" | "creative_pattern";
  value: string;
  state: "OBSERVED" | "INFERRED" | "VALIDATED";
  sampleCount: number;
  corpusSize: number;
  prevalence: number;
  confidence: number;
  exampleAdIds: string[];
  exampleAnalysisIds?: string[];
  summary: string;
};

const DIMENSIONS = ["topic", "openingMove", "hookMechanism", "hook", "structure", "evidenceOffered", "emotionalAppeal", "adviceSpecificity", "cta"] as const;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Aggregate source observations only. No engagement or causal outcome is inferred. */
export function aggregateResearchPatterns(
  items: { adId: string; analysisId?: string; analysis: ResearchAnalysis; capturedAt?: string }[],
): ResearchPattern[] {
  const corpus = items.filter((item) => item.adId.trim());
  const groups = new Map<string, { dimension: ResearchPattern["dimension"]; value: string; confidences: number[]; ids: string[]; analysisIds: string[] }>();
  for (const item of corpus) {
    for (const dimension of DIMENSIONS) {
      const answer = item.analysis[dimension] as ResearchField;
      const value = normalize(answer.value);
      if (!value || value === "unclear" || !answer.evidence.length) continue;
      const key = `${dimension}\0${value}`;
      const group = groups.get(key) ?? { dimension, value, confidences: [], ids: [], analysisIds: [] };
      group.confidences.push(answer.confidence);
      group.ids.push(item.adId);
      if (item.analysisId) group.analysisIds.push(item.analysisId);
      groups.set(key, group);
    }
    const fields = [item.analysis.topic, item.analysis.hookMechanism, item.analysis.structure, item.analysis.cta];
    if (fields.every((answer) => answer.value && answer.value !== "unclear" && answer.evidence.length > 0)) {
      const value = JSON.stringify({ topic: fields[0]!.value, hook: fields[1]!.value, structure: fields[2]!.value, cta: fields[3]!.value });
      const key = `creative_pattern\0${value}`;
      const group = groups.get(key) ?? { dimension: "creative_pattern" as const, value, confidences: [], ids: [], analysisIds: [] };
      group.confidences.push(...fields.map((answer) => answer.confidence));
      group.ids.push(item.adId);
      if (item.analysisId) group.analysisIds.push(item.analysisId);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map((group): ResearchPattern => {
      const sampleCount = group.ids.length;
      const average = group.confidences.reduce((total, value) => total + value, 0) / group.confidences.length;
      const prevalence = corpus.length ? sampleCount / corpus.length : 0;
      return {
        dimension: group.dimension,
        value: group.value,
        state: "OBSERVED",
        sampleCount,
        corpusSize: corpus.length,
        prevalence,
        confidence: Math.round(average * 1000) / 1000,
        exampleAdIds: [...new Set(group.ids)].slice(0, 5),
        exampleAnalysisIds: [...new Set(group.analysisIds)].slice(0, 5),
        summary: `Observed in ${sampleCount} of ${corpus.length} analyzed ads (${Math.round(prevalence * 100)}%). Frequency only; this is not evidence of advertising effectiveness or causation.`,
      };
    })
    .sort((left, right) => right.sampleCount - left.sampleCount || left.dimension.localeCompare(right.dimension) || left.value.localeCompare(right.value));
}
