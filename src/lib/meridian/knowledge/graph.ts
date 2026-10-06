import type { LearnedPattern, RejectionFact } from "../domain.ts";

export type GraphEdge = {
  relation:
    | "HAS_PRODUCT"
    | "TARGETS"
    | "COMPETES_WITH"
    | "USES_HOOK"
    | "USES_ANGLE"
    | "USES_FORMAT"
    | "PROMOTES"
    | "DERIVED_FROM"
    | "GENERATED_FROM"
    | "IMPLEMENTS"
    | "SUPPORTED_BY"
    | "TESTED_IN"
    | "PRODUCES"
    | "RESEMBLES"
    | "CONTRIBUTES_TO"
    | "INFLUENCES"
    | "UPDATES";
  from: string;
  to: string;
  evidence: string;
};

export function influenceNotes(input: {
  angle: string;
  hookType: string;
  patterns: LearnedPattern[];
  rejections: RejectionFact[];
}): string[] {
  const notes: string[] = [];
  for (const edge of influenceEdges(input)) notes.push(`${edge.from} ${edge.relation} ${edge.to}. ${edge.evidence}`);
  return notes;
}

export function influenceEdges(input: {
  angle: string;
  hookType: string;
  patterns: LearnedPattern[];
  rejections: RejectionFact[];
}): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const angle = input.angle.trim().toLowerCase();
  const hook = input.hookType.trim().toLowerCase();
  for (const pattern of input.patterns) {
    const value = pattern.value.trim().toLowerCase();
    const matches =
      (pattern.attribute === "angle" && value === angle) ||
      (pattern.attribute === "hookType" && value === hook) ||
      (pattern.attribute.includes("angle") && value.includes(angle) && angle.length > 0);
    if (!matches) continue;
    edges.push({
      relation: "INFLUENCES",
      from: `LearnedPattern ${pattern.attribute}=${pattern.value}`,
      to: `Opportunity ${angle || "unspecified"}`,
      evidence: pattern.summary,
    });
  }
  for (const fact of input.rejections) {
    if (fact.count <= 0 || !fact.reasonCode.trim()) continue;
    edges.push({
      relation: "UPDATES",
      from: `Rejection ${fact.reasonCode}`,
      to: `Opportunity ${angle || "unspecified"}`,
      evidence: `Rejected ${fact.count} time${fact.count === 1 ? "" : "s"}.`,
    });
  }
  return edges;
}

export function creativeLineage(input: {
  creativeId: string;
  briefId: string;
  opportunityId: string;
  patternAttribute: string;
  patternValue: string;
}): GraphEdge[] {
  return [
    {
      relation: "GENERATED_FROM",
      from: input.creativeId,
      to: input.briefId,
      evidence: "The creative was generated from this brief.",
    },
    {
      relation: "IMPLEMENTS",
      from: input.briefId,
      to: input.opportunityId,
      evidence: "The brief implements this opportunity.",
    },
    {
      relation: "CONTRIBUTES_TO",
      from: input.creativeId,
      to: `${input.patternAttribute}=${input.patternValue}`,
      evidence: "The brief carried this learned pattern into the creative.",
    },
    {
      relation: "INFLUENCES",
      from: `${input.patternAttribute}=${input.patternValue}`,
      to: input.opportunityId,
      evidence: "The learned pattern changed the opportunity that produced the brief.",
    },
  ];
}

/** Neighbors of one node. Used by retrieval instead of a decorative graph. */
export function neighbors(edges: GraphEdge[], node: string, relation?: GraphEdge["relation"]): GraphEdge[] {
  return edges.filter((edge) => (edge.from === node || edge.to === node) && (!relation || edge.relation === relation));
}
