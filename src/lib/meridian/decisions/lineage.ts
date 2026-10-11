/**
 * Decision lineage: one structured record per decision run and one row per answer, in the existing JEV ledger tables.
 *
 * jev_runs and jev_answers keep their names for compatibility, and every engine writes to them. Engine, adapter, model,
 * input modality, image count, usage, latency, and failure are columns, not JSON, so they can be queried. Provider
 * detail that does not need querying stays in `metadata`.
 *
 * Images are recorded by count and by a hash of their data, never by content.
 */
import type { Sql } from "../learning/store.ts";
import type { DecisionRequest, DecisionResult } from "./types.ts";

function answerValue(answer: DecisionResult["answers"][string]): unknown {
  if (answer.status !== "answered") return null;
  return answer.answer !== undefined ? answer.answer : null;
}

/**
 * Writes the run and its answers. A storage failure is reported as `false` and does not change the decision, which the
 * caller still returns. The caller decides whether an unrecorded decision is acceptable.
 */
export async function persistDecisionLineage(
  sql: Sql,
  request: DecisionRequest,
  result: DecisionResult,
  recordId?: string,
): Promise<boolean> {
  const failed = Boolean(result.failure);
  const metadata = {
    latencyMs: result.latencyMs,
    questionCount: Object.keys(result.answers).length,
    imagesOmitted: result.imagesOmitted,
    returnedModel: result.returnedModel,
    failureMessage: result.failure?.message ?? null,
    comparison: result.comparison
      ? { comparedWith: result.comparison.comparedWith, agreementRate: result.comparison.agreementRate }
      : undefined,
    fallbackFrom: result.fallbackFrom ?? null,
    fallbackReason: result.fallbackReason ?? null,
  };
  try {
    await sql`
      insert into jev_runs (
        id, organization_id, brand_id, question_set, model, provider, input_hash, status, metadata,
        engine_id, adapter_version, requested_model, input_modality, image_count, usage, latency_ms, failure_kind
      ) values (
        ${result.runId}, ${request.organizationId}, ${request.brandId}, 'semantic_decision',
        ${result.model}, ${result.provider}, ${result.inputHash}, ${failed ? "failed" : "completed"},
        ${JSON.stringify(metadata)},
        ${result.engineId}, ${result.adapterVersion}, ${result.requestedModel}, ${result.inputModality},
        ${result.imageCount}, ${result.usage ? JSON.stringify(result.usage) : null}, ${result.latencyMs},
        ${result.failure?.kind ?? null}
      )
      on conflict (id) do nothing
    `;

    for (const [key, answer] of Object.entries(result.answers)) {
      const isAnswered = answer.status === "answered";
      const probability = isAnswered ? (answer.probability ?? answer.noul ?? null) : null;
      const distribution = isAnswered ? (answer.probabilities ?? answer.distribution ?? null) : null;
      await sql`
        insert into jev_answers (
          id, organization_id, brand_id, run_id, record_id, question_id, question_version,
          model, provider, answer, probability, distribution, confidence, status, evidence,
          engine_id, calibration_status
        ) values (
          ${crypto.randomUUID()}, ${request.organizationId}, ${request.brandId}, ${result.runId},
          ${recordId || (request.state as { bundleId?: string })?.bundleId || result.runId},
          ${answer.questionId || key}, ${answer.questionVersion || "v1"},
          ${answer.model}, ${answer.provider},
          ${answerValue(answer) === null ? null : JSON.stringify(answerValue(answer))},
          ${probability},
          ${distribution === null ? null : JSON.stringify(distribution)},
          ${isAnswered ? (answer.confidence ?? null) : null},
          ${answer.status},
          ${JSON.stringify(answer.evidenceRefs || [])},
          ${result.engineId}, ${answer.calibrationStatus ?? (isAnswered ? "uncalibrated" : null)}
        )
      `;
    }
    return true;
  } catch (error) {
    console.warn("[decisions] Failed to persist decision lineage:", error instanceof Error ? error.message : error);
    return false;
  }
}
