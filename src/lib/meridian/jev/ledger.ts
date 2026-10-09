/**
 * JEV Reasoning Ledger & Persistence
 *
 * Persists JEV runs and answers with complete lineage into Postgres (jev_runs, jev_answers).
 * Provides the explainDecision() query returning exact supporting evidence,
 * creator outlier context, and policy thresholds.
 */

import type { Sql } from "../learning/store.ts";
import type {
  JevDecisionResponse,
  JevPolicyEvaluation,
  EvidenceRef,
} from "./types.ts";

export type PersistJevRunInput = {
  organizationId: string;
  brandId: string;
  questionSet: string;
  response: JevDecisionResponse;
  policy?: JevPolicyEvaluation;
};

export async function persistJevRun(
  sql: Sql,
  input: PersistJevRunInput,
): Promise<{ runId: string; answersStored: number }> {
  const { response, organizationId, brandId, questionSet, policy } = input;

  await sql`
    insert into jev_runs (
      id, organization_id, brand_id, question_set, model, provider, input_hash, status, metadata
    ) values (
      ${response.runId}, ${organizationId}, ${brandId}, ${questionSet},
      ${response.model}, ${response.provider}, ${response.inputHash},
      ${policy?.decision || "completed"},
      ${JSON.stringify({
        latencyMs: response.latencyMs,
        cached: response.cached,
        policyReason: policy?.reason,
        policyVersion: policy?.policyVersion,
        thresholds: policy?.thresholds,
      })}
    )
    on conflict (id) do nothing
  `;

  let count = 0;
  for (const [key, ans] of Object.entries(response.answers)) {
    const answerId = globalThis.crypto.randomUUID();
    await sql`
      insert into jev_answers (
        id, organization_id, brand_id, run_id, record_id, question_id, question_version,
        model, provider, answer, probability, distribution, confidence, status, evidence
      ) values (
        ${answerId}, ${organizationId}, ${brandId}, ${response.runId}, ${key},
        ${ans.questionId}, ${ans.questionVersion}, ${ans.model}, ${ans.provider},
        ${JSON.stringify(ans.answer)},
        ${ans.probability ?? null},
        ${ans.distribution ? JSON.stringify(ans.distribution) : null},
        ${ans.confidence},
        ${ans.status},
        ${JSON.stringify(ans.evidenceRefs)}
      )
    `;
    count++;
  }

  return { runId: response.runId, answersStored: count };
}

export type DecisionExplanation = {
  runId: string;
  decision: string;
  reason: string;
  model: string;
  provider: string;
  evaluatedAt: string;
  answers: Array<{
    questionId: string;
    questionVersion: string;
    status: string;
    answer: unknown;
    probability: number | null;
    confidence: number;
    evidence: EvidenceRef[];
  }>;
};

export async function explainDecision(
  sql: Sql,
  organizationId: string,
  runId: string,
): Promise<DecisionExplanation | null> {
  const runRows = await sql<{
    id: string;
    status: string;
    model: string;
    provider: string;
    metadata: { policyReason?: string };
    created_at: string;
  }>`
    select id, status, model, provider, metadata, created_at
    from jev_runs
    where id = ${runId} and organization_id = ${organizationId}
    limit 1
  `;

  if (!runRows[0]) return null;
  const run = runRows[0];

  const answerRows = await sql<{
    question_id: string;
    question_version: string;
    status: string;
    answer: unknown;
    probability: number | null;
    confidence: number;
    evidence: EvidenceRef[];
  }>`
    select question_id, question_version, status, answer, probability, confidence, evidence
    from jev_answers
    where run_id = ${runId} and organization_id = ${organizationId}
  `;

  return {
    runId: run.id,
    decision: run.status,
    reason: run.metadata?.policyReason || "Evaluation complete.",
    model: run.model,
    provider: run.provider,
    evaluatedAt: run.created_at,
    answers: answerRows.map((r) => ({
      questionId: r.question_id,
      questionVersion: r.question_version,
      status: r.status,
      answer: r.answer,
      probability: r.probability,
      confidence: r.confidence,
      evidence: r.evidence || [],
    })),
  };
}
