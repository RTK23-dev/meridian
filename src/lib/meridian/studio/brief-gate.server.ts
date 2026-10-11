/**
 * The brief gate: whether a brief directs a creative the brand can stand behind.
 *
 * Mechanical checks decide first and can reject with no engine call: the mandatory brief fields (audience, hook, message,
 * angle) must be present, and no stored prohibited claim may appear in the brief text. Semantic checks belong to the active
 * decision engine, asked through the engine gate: brand fit, opportunity fit, and claim compliance. Each sees only its own
 * scope, so the engine is called once per scope, all to the active engine. The outcome is
 * written as the brief's decision, which is the row `loadGatedJevDecision` reads before any production starts.
 */
import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { runEngineGate, type GateEvidenceInput, type GateQuestion, type GateResult } from "../decisions/gate.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";
import type { EngineSelection } from "../decisions/selection.ts";
import { BRIEF_EVIDENCE_SCOPES, BRIEF_QUESTIONS } from "../jev/questions/brief.ts";
import { BRIEF_GATE_QUESTION_ID, BRIEF_GATE_SCHEMA_VERSION } from "../decisions/brief-contract.ts";

export type BriefForGate = {
  audience: string;
  hook: string;
  message: string;
  format: string;
  cta: string;
  angle: string;
  offer?: string;
};

export type BriefBrain = {
  positioning: string;
  valueProposition: string;
  tone: string;
  prohibitedClaims: string;
  wordsToAvoid: string;
};

const MANDATORY_FIELDS = ["audience", "hook", "message", "angle"] as const;

/** Checks that need no judgment. Any one of them rejects the brief before the engine is called. */
export function briefDeterministicRejections(brief: BriefForGate, brain: BriefBrain): Array<{ rule: string; reason: string }> {
  const rejections: Array<{ rule: string; reason: string }> = [];
  const missing = MANDATORY_FIELDS.filter((field) => !brief[field].trim());
  if (missing.length > 0) {
    rejections.push({ rule: "mandatory_brief_fields", reason: `Missing ${missing.join(", ")}. A brief cannot be judged without them.` });
  }
  const text = [brief.audience, brief.hook, brief.message, brief.format, brief.cta, brief.angle, brief.offer ?? ""].join("\n").toLowerCase();
  const banned = brain.prohibitedClaims
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
  const hit = banned.find((part) => text.includes(part.toLowerCase()));
  if (hit) {
    rejections.push({ rule: "prohibited_claim", reason: `The brief contains the stored prohibited claim “${hit}”.` });
  }
  return rejections;
}

/**
 * The evidence the brief questions can be scoped to, with its content. A brand fact that is blank is not evidence: a question
 * that needs it abstains, and the brief goes to review. No image and no perception observation is ever part of a brief.
 */
function briefEvidence(brief: BriefForGate, brain: BriefBrain): GateEvidenceInput[] {
  const items: GateEvidenceInput[] = [
    {
      kind: "text",
      name: "brief_fields",
      source: "briefs",
      content: {
        audience: brief.audience,
        hook: brief.hook,
        message: brief.message,
        format: brief.format,
        cta: brief.cta,
        angle: brief.angle,
        offer: brief.offer ?? "",
      },
    },
  ];
  if (brain.positioning.trim() || brain.valueProposition.trim()) {
    items.push({
      kind: "text",
      name: "brand_positioning",
      source: "brand_brain",
      content: { positioning: brain.positioning, valueProposition: brain.valueProposition, tone: brain.tone },
    });
  }
  if (brain.prohibitedClaims.trim()) {
    items.push({ kind: "text", name: "brand_prohibited_claims", source: "brand_brain", content: { prohibitedClaims: brain.prohibitedClaims } });
  }
  if (brief.angle.trim()) {
    items.push({ kind: "text", name: "opportunity_angle", source: "opportunity", content: { angle: brief.angle } });
  }
  return items;
}

export type BriefGateInput = {
  sql: Sql;
  organizationId: string;
  brandId: string;
  briefId: string;
  brief: BriefForGate;
  brain: BriefBrain;
  selection?: EngineSelection;
  engines?: DecisionEngineRegistry;
};

export type BriefGateResult = GateResult & { deterministicRejections: Array<{ rule: string; reason: string }> };

export async function judgeBriefFit(input: BriefGateInput): Promise<BriefGateResult> {
  const deterministicRejections = briefDeterministicRejections(input.brief, input.brain);
  const questions: GateQuestion[] = Object.values(BRIEF_QUESTIONS).map((spec) => ({
    key: spec.id,
    spec,
    needsImage: false,
    evidenceScope: BRIEF_EVIDENCE_SCOPES[spec.id],
  }));
  const gate = await runEngineGate({
    sql: input.sql,
    organizationId: input.organizationId,
    brandId: input.brandId,
    gate: "brief",
    subject: { type: "brief", id: input.briefId },
    description: "Creative brief for an approved direction. Judge only the brief and the brand facts provided.",
    questions,
    evidence: briefEvidence(input.brief, input.brain),
    deterministicRejections,
    selection: input.selection,
    engines: input.engines,
  });
  return { ...gate, deterministicRejections };
}

/** The lowest predicate probability the engine returned for this brief, or null when it returned none. Null is unknown, not 0. */
function lowestProbability(gate: GateResult): number | null {
  const probabilities = Object.values(gate.answers)
    .filter((answer) => answer.status === "answered" && typeof answer.probability === "number")
    .map((answer) => answer.probability as number);
  return probabilities.length > 0 ? Math.min(...probabilities) : null;
}

/**
 * Writes the brief's decision row from the gate outcome. `probability` and `confidence` hold the lowest predicate probability
 * among the engine's brief answers (null when none), and the full gate record is linked through `evidence`.
 */
export async function writeBriefDecision(
  sql: Sql,
  input: { organizationId: string; brandId: string; briefId: string; decisionId: string; result: BriefGateResult },
): Promise<void> {
  const { result } = input;
  const digestOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const probability = lowestProbability(result);
  // Creating a brief never records a review. A HUMAN_REVIEW brief waits for an explicit review action
  // (studio/brief-review.server.ts), and an AUTO_APPROVE brief needs none.
  await sql`
    insert into jev_decisions (
      id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
      input, evidence, probability, confidence, thresholds, decision, reasons, provider, model,
      answer, schema_version, policy_version, calibration_version, reviewer_id, reviewer_decision, reviewed_at,
      decision_fingerprint, outcome_digest
    ) values (
      ${input.decisionId}, ${input.organizationId}, ${input.brandId}, ${input.briefId}, ${BRIEF_GATE_QUESTION_ID}, ${result.questionVersions.join(",") || "none"},
      'brief', ${input.briefId},
      ${JSON.stringify({ questionVersions: result.questionVersions, deterministicRejections: result.deterministicRejections })},
      ${JSON.stringify({
        gateRecordId: result.gateRecordId,
        evidenceIds: [...(result.gateRecordId ? [`gate_record:${result.gateRecordId}`] : []), ...result.evidence.map((item) => item.name)],
        evidence: result.evidence,
      })},
      ${probability}, ${probability}, ${JSON.stringify({ policyVersion: result.policyVersion })},
      ${result.action}, ${JSON.stringify([result.reason])}, ${result.engineId ?? "deterministic"}, ${result.returnedModel ?? "none"},
      ${JSON.stringify(result.answers)}, ${BRIEF_GATE_SCHEMA_VERSION}, ${result.policyVersion}, '',
      null, null, null,
      ${digestOf({ engine: result.engineId, requested: result.requestedModel, returned: result.returnedModel, questionVersions: result.questionVersions, policyVersion: result.policyVersion })},
      ${digestOf({ action: result.action, votes: result.votes, unresolved: result.unresolved })}
    )
    on conflict (id) do nothing
  `;
}

