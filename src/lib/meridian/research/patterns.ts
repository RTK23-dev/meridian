import { CONFIDENCE_SOURCE, type ResearchAnalysis, type ResearchField } from "./schema.ts";

/** The transcript segments behind one example ad's label. Segment ids are the model's citations, checked by the validator. */
export type PatternEvidence = {
  adId: string;
  analysisId?: string;
  segmentIds: string[];
};

export const PATTERN_EXAMPLE_LIMIT = 5;

export type ResearchPattern = {
  scope?: "brand" | "organization";
  dimension: "topic" | "openingMove" | "hookMechanism" | "hook" | "structure" | "evidenceOffered" | "emotionalAppeal" | "adviceSpecificity" | "cta" | "creative_pattern";
  value: string;
  /** A pattern counts the model's labels. A label is an inference from the transcript, never an observation. */
  state: "INFERRED";
  sampleCount: number;
  corpusSize: number;
  prevalence: number;
  /** The model's self-reported confidence, averaged. It is not a calibrated probability (docs/INTELLIGENCE_ROADMAP.md). */
  confidence: number;
  confidenceSource: typeof CONFIDENCE_SOURCE;
  exampleAdIds: string[];
  exampleAnalysisIds?: string[];
  /** One entry per example ad, so every pattern can be traced to the transcript segments that support it. */
  evidence: PatternEvidence[];
  summary: string;
};

const DIMENSIONS = ["topic", "openingMove", "hookMechanism", "hook", "structure", "evidenceOffered", "emotionalAppeal", "adviceSpecificity", "cta"] as const;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

type Group = {
  dimension: ResearchPattern["dimension"];
  value: string;
  confidences: number[];
  ids: string[];
  analysisIds: string[];
  evidence: Map<string, { adId: string; analysisId?: string; segmentIds: Set<string> }>;
};

function groupFor(groups: Map<string, Group>, key: string, dimension: Group["dimension"], value: string): Group {
  const existing = groups.get(key);
  if (existing) return existing;
  const created: Group = { dimension, value, confidences: [], ids: [], analysisIds: [], evidence: new Map() };
  groups.set(key, created);
  return created;
}

/** Records one ad as a sample of the group, citing the segments that support it. Call once per ad per group. */
function citeExample(group: Group, item: { adId: string; analysisId?: string }, segmentIds: string[]): void {
  group.ids.push(item.adId);
  if (item.analysisId) group.analysisIds.push(item.analysisId);
  const key = `${item.adId}\0${item.analysisId ?? ""}`;
  const entry = group.evidence.get(key) ?? { adId: item.adId, ...(item.analysisId ? { analysisId: item.analysisId } : {}), segmentIds: new Set<string>() };
  for (const id of segmentIds) entry.segmentIds.add(id);
  group.evidence.set(key, entry);
}

/**
 * Counts how often each model label appears across analyzed ads. Labels with no transcript citation are not
 * counted. Confidence is the model's self-report. No engagement or causal outcome is inferred.
 */
export function aggregateResearchPatterns(
  items: { adId: string; analysisId?: string; analysis: ResearchAnalysis; capturedAt?: string }[],
): ResearchPattern[] {
  const corpus = items.filter((item) => item.adId.trim());
  const groups = new Map<string, Group>();
  for (const item of corpus) {
    for (const dimension of DIMENSIONS) {
      const answer = item.analysis[dimension] as ResearchField;
      const value = normalize(answer.value);
      if (!value || value === "unclear" || !answer.evidence.length) continue;
      const group = groupFor(groups, `${dimension}\0${value}`, dimension, value);
      group.confidences.push(answer.confidence);
      citeExample(group, item, answer.evidence);
    }
    const fields = [item.analysis.topic, item.analysis.hookMechanism, item.analysis.structure, item.analysis.cta];
    if (fields.every((answer) => answer.value && answer.value !== "unclear" && answer.evidence.length > 0)) {
      const value = JSON.stringify({ topic: fields[0]!.value, hook: fields[1]!.value, structure: fields[2]!.value, cta: fields[3]!.value });
      const group = groupFor(groups, `creative_pattern\0${value}`, "creative_pattern", value);
      group.confidences.push(...fields.map((answer) => answer.confidence));
      citeExample(group, item, fields.flatMap((answer) => answer.evidence));
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
        state: "INFERRED",
        sampleCount,
        corpusSize: corpus.length,
        prevalence,
        confidence: Math.round(average * 1000) / 1000,
        confidenceSource: CONFIDENCE_SOURCE,
        exampleAdIds: [...new Set(group.ids)].slice(0, PATTERN_EXAMPLE_LIMIT),
        exampleAnalysisIds: [...new Set(group.analysisIds)].slice(0, PATTERN_EXAMPLE_LIMIT),
        evidence: [...group.evidence.values()].slice(0, PATTERN_EXAMPLE_LIMIT).map((entry) => ({
          adId: entry.adId,
          ...(entry.analysisId ? { analysisId: entry.analysisId } : {}),
          segmentIds: [...entry.segmentIds],
        })),
        summary: `Model-labelled in ${sampleCount} of ${corpus.length} analyzed ads (${Math.round(prevalence * 100)}%). Labels are model inferences from the transcript. Frequency only; this is not evidence of advertising effectiveness or causation.`,
      };
    })
    .sort((left, right) => right.sampleCount - left.sampleCount || left.dimension.localeCompare(right.dimension) || left.value.localeCompare(right.value));
}

/** Reads stored evidence refs. Malformed entries are dropped, so one bad row cannot break the read. */
export function parsePatternEvidence(raw: string): PatternEvidence[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const parsed = value.flatMap((entry): PatternEvidence[] => {
    if (!entry || typeof entry !== "object") return [];
    const { adId, analysisId, segmentIds } = entry as Record<string, unknown>;
    if (typeof adId !== "string" || !adId || !Array.isArray(segmentIds)) return [];
    const ids = segmentIds.filter((id): id is string => typeof id === "string" && id.length > 0);
    if (!ids.length) return [];
    return [{ adId, ...(typeof analysisId === "string" && analysisId ? { analysisId } : {}), segmentIds: ids }];
  });
  return parsed.slice(0, PATTERN_EXAMPLE_LIMIT);
}
