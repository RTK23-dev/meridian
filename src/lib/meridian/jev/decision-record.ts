import { createHash } from "node:crypto";
import type { AuditedDecision } from "./judgment.ts";
import type { DecisionOutput } from "./engine.ts";

/**
 * Decision record identity (P3b). A JEV decision is a record of what it saw and what it said.
 *
 * - The fingerprint identifies the question and its version, the provider, model, schema, policy, and calibration in
 *   force, the thresholds, the input it judged, and the evidence set it saw. The evidence is a set, so its order does not
 *   matter. Subject ids and decision times are not part of the fingerprint: the same evidence judged for another subject
 *   is the same record.
 * - The outcome digest covers what it said: the decision, the probabilities, the confidence, the reasons, the answer, and
 *   the evidence state.
 *
 * Re-running the same evidence under the same question version must reproduce the outcome. assertReproducible refuses a
 * rerun whose outcome differs under the same fingerprint, so a judge that is not deterministic cannot pass as one.
 */
export const DECISION_RECORD_VERSION = "jev-decision-record.v1" as const;

export type DecisionRecordFields = { decisionFingerprint: string; outcomeDigest: string };

export type RecordIdentity = {
  questionId: string;
  questionVersion: string;
  provider: string;
  model: string;
  schemaVersion: string;
  policyVersion: string;
  calibrationVersion: string | null;
  thresholds: unknown;
  /** What the decision judged: the features of a question-set judgment, or the gate input of a rule decision. */
  input: unknown;
  /** The evidence set it saw. Treated as a set. */
  evidence: unknown[];
};

export type RecordOutcome = {
  decision: string;
  probability: number;
  rawProbability: number;
  confidence: number;
  reasons: string[];
  answer: unknown;
  evidenceState: unknown;
};

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
  }
  return value;
}

/** JSON with object keys sorted at every depth. Equal values always serialize to the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function decisionFingerprint(identity: RecordIdentity): string {
  return sha256(canonicalJson({
    record: DECISION_RECORD_VERSION,
    questionId: identity.questionId,
    questionVersion: identity.questionVersion,
    provider: identity.provider,
    model: identity.model,
    schemaVersion: identity.schemaVersion,
    policyVersion: identity.policyVersion,
    calibrationVersion: identity.calibrationVersion,
    thresholds: identity.thresholds,
    input: identity.input,
    evidence: identity.evidence.map((item) => canonicalJson(item)).sort(),
  }));
}

export function outcomeDigest(outcome: RecordOutcome): string {
  return sha256(canonicalJson({
    decision: outcome.decision,
    probability: outcome.probability,
    rawProbability: outcome.rawProbability,
    confidence: outcome.confidence,
    reasons: outcome.reasons,
    answer: outcome.answer,
    evidenceState: outcome.evidenceState,
  }));
}

function fieldsOf(identity: RecordIdentity, outcome: RecordOutcome): DecisionRecordFields {
  return { decisionFingerprint: decisionFingerprint(identity), outcomeDigest: outcomeDigest(outcome) };
}

/** The identity and outcome of a question-set judgment (judgeBrief, judgeMedia). */
export function auditedRecord(decision: AuditedDecision): { identity: RecordIdentity; outcome: RecordOutcome } {
  return {
    identity: {
      questionId: decision.questionId,
      questionVersion: decision.questionVersion,
      provider: decision.provider,
      model: decision.modelVersion,
      schemaVersion: decision.schemaVersion,
      policyVersion: decision.policyVersion,
      calibrationVersion: decision.calibrationVersion,
      thresholds: decision.policy,
      input: decision.features,
      evidence: decision.evidence,
    },
    outcome: {
      decision: decision.decision,
      probability: decision.probability,
      rawProbability: decision.rawProbability,
      confidence: decision.confidence,
      reasons: decision.reasons,
      answer: decision.answer,
      evidenceState: decision.evidenceState,
    },
  };
}

/**
 * The identity and outcome of a rule decision (decide, decideForTenant). The rule engine does not keep the input it
 * judged, so the caller passes the input and evidence exactly as they are stored.
 */
export function ruleRecord(decision: DecisionOutput, stored: { input: unknown; evidence: unknown[] }): { identity: RecordIdentity; outcome: RecordOutcome } {
  return {
    identity: {
      questionId: decision.questionId,
      questionVersion: decision.questionVersion,
      provider: decision.provider,
      model: decision.model,
      schemaVersion: decision.schemaVersion,
      policyVersion: decision.policyVersion,
      calibrationVersion: decision.calibrationVersion,
      thresholds: decision.thresholds,
      input: stored.input,
      evidence: stored.evidence,
    },
    outcome: {
      decision: decision.decision,
      probability: decision.probability,
      rawProbability: decision.rawProbability,
      confidence: decision.confidence,
      reasons: decision.reasons,
      answer: decision.answer,
      evidenceState: decision.evidenceState,
    },
  };
}

export function decisionRecordFields(decision: AuditedDecision): DecisionRecordFields {
  const { identity, outcome } = auditedRecord(decision);
  return fieldsOf(identity, outcome);
}

export function ruleDecisionRecordFields(decision: DecisionOutput, stored: { input: unknown; evidence: unknown[] }): DecisionRecordFields {
  const { identity, outcome } = ruleRecord(decision, stored);
  return fieldsOf(identity, outcome);
}

/**
 * A rerun is reproducible when it has the same fingerprint and the same outcome. Different evidence is a new record,
 * not a rerun, so it is never refused here.
 */
export function assertReproducible(prior: DecisionRecordFields, rerun: DecisionRecordFields): void {
  if (prior.decisionFingerprint === rerun.decisionFingerprint && prior.outcomeDigest !== rerun.outcomeDigest) {
    throw new Error(
      `JEV decision is not reproducible: the same evidence and question version gave a different outcome (${prior.outcomeDigest.slice(0, 12)} vs ${rerun.outcomeDigest.slice(0, 12)}).`,
    );
  }
}
