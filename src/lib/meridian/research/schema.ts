export const RESEARCH_SCHEMA_VERSION = "jev.research-ad.v2" as const;

/**
 * Epistemic state. OBSERVED is transcript text and timestamps, verified against the supplied segments.
 * INFERRED is a model label drawn from those segments. Confidence on an INFERRED field is the model's
 * own self-report, so it is labelled as such and is not a calibrated score (see docs/INTELLIGENCE_ROADMAP.md).
 */
export const CONFIDENCE_SOURCE = "model_self_report" as const;

export const OPENING_MOVES = ["question", "problem", "bold_claim", "story", "demonstration", "product_first", "offer_first", "social_proof", "other", "unclear"] as const;
export const HOOK_MECHANISMS = ["curiosity", "pain_point", "contrast", "aspiration", "proof", "urgency", "humor", "authority", "demonstration", "offer", "other", "unclear"] as const;
export const STRUCTURES = ["problem_solution", "before_after", "story_payoff", "listicle", "demonstration", "testimonial", "offer_led", "other", "unclear"] as const;
export const EVIDENCE_TYPES = ["demonstration", "testimonial", "data", "expertise", "none", "unclear"] as const;
export const EMOTIONAL_APPEALS = ["relief", "aspiration", "belonging", "fear", "confidence", "amusement", "urgency", "other", "unclear"] as const;
export const ADVICE_SPECIFICITY = ["actionable", "general", "not_applicable", "unclear"] as const;
export const CTAS = ["shop_now", "learn_more", "sign_up", "download", "comment", "follow", "none", "other", "unclear"] as const;
export const SEGMENT_ROLES = ["hook", "setup", "problem", "example", "advice", "proof", "payoff", "cta", "other", "unclear"] as const;

export type ResearchField<T extends string = string> = {
  value: T;
  state: "INFERRED";
  confidence: number;
  confidenceSource: typeof CONFIDENCE_SOURCE;
  probability?: number;
  evidence: string[];
};

export type ResearchSegment = {
  id: string;
  text: string;
  startMs: number | null;
  endMs: number | null;
  role: (typeof SEGMENT_ROLES)[number];
  confidence: number;
  state: "OBSERVED";
};

export type ResearchClaim = {
  text: string;
  type: "product_benefit" | "performance" | "health" | "financial" | "comparative" | "other";
  evidence: string[];
  state: "INFERRED";
};

export type ResearchAnalysis = {
  schemaVersion: typeof RESEARCH_SCHEMA_VERSION;
  topic: ResearchField;
  openingMove: ResearchField<(typeof OPENING_MOVES)[number]>;
  hookMechanism: ResearchField<(typeof HOOK_MECHANISMS)[number]>;
  hook: ResearchField;
  structure: ResearchField<(typeof STRUCTURES)[number]>;
  evidenceOffered: ResearchField<(typeof EVIDENCE_TYPES)[number]>;
  emotionalAppeal: ResearchField<(typeof EMOTIONAL_APPEALS)[number]>;
  adviceSpecificity: ResearchField<(typeof ADVICE_SPECIFICITY)[number]>;
  cta: ResearchField<(typeof CTAS)[number]>;
  segments: ResearchSegment[];
  claims: ResearchClaim[];
  reviewRequired: boolean;
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function unit(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1.`);
  return value;
}

function evidenceRefs(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${name} evidence must be a list of segment ids.`);
  return [...new Set(value as string[])];
}

function field<T extends string>(value: unknown, name: string, allowed?: readonly T[]): ResearchField<T> {
  const input = record(value, name);
  if (typeof input.value !== "string" || !input.value.trim()) throw new Error(`${name} needs a value.`);
  const label = input.value.trim() as T;
  if (allowed && !allowed.includes(label)) throw new Error(`${name} has an unknown answer.`);
  return {
    value: label,
    state: "INFERRED",
    confidence: unit(input.confidence, `${name}.confidence`),
    confidenceSource: CONFIDENCE_SOURCE,
    ...(input.probability === undefined ? {} : { probability: unit(input.probability, `${name}.probability`) }),
    evidence: evidenceRefs(input.evidence, name),
  };
}

/** Validate the model response; malformed/unsupported labels never enter stored research. */
export function validateResearchAnalysis(value: unknown): ResearchAnalysis {
  const input = record(value, "Research analysis");
  const rawSegments = input.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length > 40) throw new Error("Research segments must contain at most 40 rows.");
  const segments = rawSegments.map((raw, index): ResearchSegment => {
    const segment = record(raw, `segments[${index}]`);
    if (typeof segment.id !== "string" || !segment.id.trim() || typeof segment.text !== "string" || !segment.text.trim()) throw new Error("Every segment needs an id and transcript text.");
    if (typeof segment.role !== "string" || !SEGMENT_ROLES.includes(segment.role as ResearchSegment["role"])) throw new Error("A segment has an unknown role.");
    const startMs = segment.startMs === null ? null : Number(segment.startMs);
    const endMs = segment.endMs === null ? null : Number(segment.endMs);
    if ((startMs !== null && (!Number.isFinite(startMs) || startMs < 0)) || (endMs !== null && (!Number.isFinite(endMs) || endMs < 0)) || (startMs !== null && endMs !== null && endMs < startMs)) throw new Error("Segment timestamps are invalid.");
    return { id: segment.id, text: segment.text, startMs, endMs, role: segment.role as ResearchSegment["role"], confidence: unit(segment.confidence, `segments[${index}].confidence`), state: "OBSERVED" };
  });
  const segmentIds = new Set(segments.map((segment) => segment.id));
  if (segmentIds.size !== segments.length) throw new Error("Segment ids must be unique.");
  const topic = field(input.topic, "topic");
  const hook = field(input.hook, "hook");
  const fields = {
    topic,
    openingMove: field(input.openingMove, "openingMove", OPENING_MOVES),
    hookMechanism: field(input.hookMechanism, "hookMechanism", HOOK_MECHANISMS),
    hook,
    structure: field(input.structure, "structure", STRUCTURES),
    evidenceOffered: field(input.evidenceOffered, "evidenceOffered", EVIDENCE_TYPES),
    emotionalAppeal: field(input.emotionalAppeal, "emotionalAppeal", EMOTIONAL_APPEALS),
    adviceSpecificity: field(input.adviceSpecificity, "adviceSpecificity", ADVICE_SPECIFICITY),
    cta: field(input.cta, "cta", CTAS),
  };
  for (const [name, result] of Object.entries(fields)) {
    if (result.evidence.some((id) => !segmentIds.has(id))) throw new Error(`${name} cites an unknown transcript segment.`);
  }
  if (!Array.isArray(input.claims)) throw new Error("Claims must be a list.");
  const claims = input.claims.map((raw, index): ResearchClaim => {
    const claim = record(raw, `claims[${index}]`);
    const types = ["product_benefit", "performance", "health", "financial", "comparative", "other"] as const;
    if (typeof claim.text !== "string" || !claim.text.trim() || typeof claim.type !== "string" || !types.includes(claim.type as (typeof types)[number])) throw new Error("A claim has invalid text or type.");
    const refs = evidenceRefs(claim.evidence, `claims[${index}]`);
    if (refs.some((id) => !segmentIds.has(id))) throw new Error("A claim cites an unknown transcript segment.");
    return { text: claim.text.trim(), type: claim.type as ResearchClaim["type"], evidence: refs, state: "INFERRED" };
  });
  const reviewRequired = Object.values(fields).some((answer) => answer.confidence < 0.65 || answer.value === "unclear") || segments.some((segment) => segment.confidence < 0.65);
  return { schemaVersion: RESEARCH_SCHEMA_VERSION, ...fields, segments, claims, reviewRequired };
}
