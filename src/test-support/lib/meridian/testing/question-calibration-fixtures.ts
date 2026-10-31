/**
 * Fixtures for the calibration of grading questions: a graded ad, a Factory pick made from it, its control creative and its measured
 * rows. The graded ad is decided by the real gate with a stub engine, so the decision record and the answer rows are the ones the gate
 * writes. Every row names the tenant it belongs to.
 */
import type { Sql } from "../../../../lib/meridian/learning/store.ts";
import { runEngineGate, type GateEvidenceInput, type GateResult } from "../../../../lib/meridian/decisions/gate.ts";
import { abstainAll, type DecisionEngine, type DecisionEngineId, type DecisionRequest, type DecisionResult } from "../../../../lib/meridian/decisions/types.ts";
import type { GradeRecord } from "../../../../lib/meridian/factory/prediction.ts";
import type { JevAnswer, JevQuestionSpec } from "../../../../lib/meridian/jev/types.ts";

export type Tenant = { organizationId: string; brandId: string; userId: string };

/** The one grading question the fixtures grade with. Its threshold is uncalibrated, as the registry's grading questions are. */
export const GRADED_QUESTION: JevQuestionSpec = {
  id: "test.graded_question.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Does this concept leave an opening the brand has not used?",
  criteria: { true: "An opening.", false: "No opening." },
  evidenceRequirements: ["copy"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.9, reviewMinProbability: 0.6, thresholdCalibration: "uncalibrated" },
};

export const COPY_EVIDENCE: GateEvidenceInput = { kind: "text", name: "copy", source: "test", content: { copy: "A plain product description." } };

/**
 * A stub engine that answers every question with the given probability, or with nothing when it is null. It records nothing else.
 * The capabilities match the gate tests, so the gate accepts it as an engine.
 */
export function probabilityEngine(id: DecisionEngineId, probability: number | null): DecisionEngine {
  const engine: DecisionEngine = {
    id,
    adapterVersion: `${id}-stub.v1`,
    capabilities: () => ({
      engineId: id,
      questionKinds: ["predicate", "choice", "score"],
      inputModalities: ["text"],
      maxImages: 0,
      maxImageBytes: 20 * 1024 * 1024,
      imageMimeTypes: [],
      batchQuestions: true,
      reportsUsage: false,
      semantics: { predicate: "probability", choice: "categorical_with_confidence", score: "ordered_level_expectation" },
    }),
    health: async () => ({ status: "READY" }),
    decide: async (request: DecisionRequest): Promise<DecisionResult> => {
      const answers: Record<string, JevAnswer> = {};
      for (const [key, spec] of Object.entries(request.questions)) {
        if (probability === null) continue;
        answers[key] = {
          questionId: spec.id,
          questionVersion: spec.version,
          type: spec.type,
          model: "stub-model",
          provider: id,
          status: "answered",
          answer: probability >= 0.5,
          probability,
          noul: probability,
          semantics: "probability",
          calibrationStatus: "uncalibrated",
          evidenceRefs: [],
          evaluatedAt: new Date().toISOString(),
        } as JevAnswer;
      }
      if (probability === null) Object.assign(answers, abstainAll(request, { status: "abstain_insufficient_evidence", reason: "stub: no answer", model: "stub-model", provider: id }));
      return {
        runId: globalThis.crypto.randomUUID(),
        model: "stub-model",
        provider: id,
        inputHash: "stub-hash",
        cached: false,
        latencyMs: 2,
        answers,
        engineId: id,
        adapterVersion: engine.adapterVersion,
        requestedModel: "stub-model",
        returnedModel: "stub-model",
        inputModality: "text",
        imageCount: 0,
        imagesOmitted: 0,
      };
    },
  };
  return engine;
}

/** Seeds a research ad, with the collection run and job it needs, and returns its id. */
export async function seedResearchAd(sql: Sql, tenant: Tenant, suffix: string): Promise<string> {
  const jobId = `job-${suffix}`;
  const runId = `rcr-${suffix}`;
  const adId = `ra-${suffix}`;
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts)
    values (${jobId}, ${tenant.organizationId}, ${tenant.brandId}, 'research.collect', ${`idem-${suffix}`}, 'succeeded', '{}', 1)
  `;
  await sql`
    insert into research_collection_runs (id, organization_id, brand_id, job_id, search_terms, country, status, created_by)
    values (${runId}, ${tenant.organizationId}, ${tenant.brandId}, ${jobId}, 'sponge', 'US', 'succeeded', ${tenant.userId})
  `;
  await sql`
    insert into research_ads (id, organization_id, brand_id, collection_run_id, external_id, advertiser, original_url, captured_at, media_status, media_storage_key)
    values (${adId}, ${tenant.organizationId}, ${tenant.brandId}, ${runId}, ${`ext-${suffix}`}, 'Acme', 'https://example.test/ad', now(), 'pending', '')
  `;
  return adId;
}

/** Grades a research ad with the real gate, using a stub engine that answers with the given probability. */
export async function gradeResearchAd(
  sql: Sql,
  tenant: Tenant,
  input: { researchAdId: string; probability: number | null },
): Promise<{ gate: GateResult; grade: GradeRecord }> {
  const gate = await runEngineGate({
    sql,
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    gate: "factory_grade",
    subject: { type: "research_ad", id: input.researchAdId },
    description: "A stored ad, read as a creative concept.",
    questions: [{ key: "graded", spec: GRADED_QUESTION, needsImage: false, evidenceScope: ["copy"] }],
    evidence: [COPY_EVIDENCE],
    selection: { engineId: "jev", source: "workspace" },
    engines: { jev: probabilityEngine("jev", input.probability), "openai-decisions": probabilityEngine("openai-decisions", null), "openrouter-decisions": probabilityEngine("openrouter-decisions", null) },
  });
  const grade: GradeRecord = {
    jev_status: "engine",
    jev_action: gate.action,
    jev_reason: gate.reason,
    jev_engine_id: gate.engineId,
    jev_model: gate.model,
    jev_question_versions: JSON.stringify(gate.questionVersions),
    jev_policy_version: gate.policyVersion,
    jev_gate_record_id: gate.gateRecordId,
  };
  return { gate, grade };
}

/** The ad's grade, as the grade stage stores it on the ad timeline. */
export async function seedAdTimeline(sql: Sql, tenant: Tenant, researchAdId: string, grade: GradeRecord, suffix: string): Promise<void> {
  await sql`
    insert into ad_timelines (
      id, organization_id, brand_id, research_ad_id, first_seen, last_seen, jev_status, jev_action, jev_reason, jev_engine_id,
      jev_model, jev_question_versions, jev_policy_version, jev_gate_record_id
    ) values (
      ${`at-${suffix}`}, ${tenant.organizationId}, ${tenant.brandId}, ${researchAdId}, now(), now(), ${grade.jev_status},
      ${grade.jev_action}, ${grade.jev_reason}, ${grade.jev_engine_id}, ${grade.jev_model}, ${grade.jev_question_versions},
      ${grade.jev_policy_version}, ${grade.jev_gate_record_id}
    )
  `;
}

/**
 * A Factory pick of a graded ad, with its run, its template, its control variant and the creative the control made. The pick stores
 * the given fingerprint, so it is the prediction the ad carries now when the fingerprint matches.
 */
export async function seedPick(
  sql: Sql,
  tenant: Tenant,
  input: { runId: string; pickId: string; researchAdId: string; surface: string; fingerprint: string; creativeId: string; suffix: string },
): Promise<void> {
  await sql`
    insert into factory_runs (id, organization_id, brand_id, niche, level, status, current_stage, created_by, settings)
    values (${input.runId}, ${tenant.organizationId}, ${tenant.brandId}, 'skincare', 0, 'running', 'factory.pick', ${tenant.userId}, '{}')
  `;
  await sql`
    insert into factory_picks (id, organization_id, brand_id, run_id, concept, research_ad_id, score, method, surface, grade_fingerprint)
    values (${input.pickId}, ${tenant.organizationId}, ${tenant.brandId}, ${input.runId}, 'angle', ${input.researchAdId}, 0.5, 'thompson',
      ${input.surface}, ${input.fingerprint})
  `;
  const templateId = `tpl:${input.runId}:${input.researchAdId}`;
  await sql`
    insert into factory_templates (id, organization_id, brand_id, source_ad_id, storyboard)
    values (${templateId}, ${tenant.organizationId}, ${tenant.brandId}, ${input.researchAdId}, '{}')
  `;
  const variantId = `var-${input.suffix}`;
  await sql`
    insert into factory_variants (id, organization_id, brand_id, template_id, tests_attribute)
    values (${variantId}, ${tenant.organizationId}, ${tenant.brandId}, ${templateId}, 'control')
  `;
  await sql`
    insert into factory_creatives (organization_id, brand_id, run_id, variant_id, format, creative_id, production_job_id, provider)
    values (${tenant.organizationId}, ${tenant.brandId}, ${input.runId}, ${variantId}, 'image', ${input.creativeId}, ${`pj-${input.suffix}`}, 'test')
  `;
}

/** One measured row for a creative. A null metric is one the source did not report. */
export async function recordMeasuredRow(
  sql: Sql,
  tenant: Tenant,
  input: { id: string; creativeId: string; surface: "paid" | "organic"; clicks?: number | null; impressions?: number | null; completionRate?: number | null; metadata?: Record<string, unknown> },
): Promise<void> {
  await sql`
    insert into unified_performance_telemetry (id, organization_id, brand_id, platform, source_type, creative_id, clicks, impressions, completion_rate, recorded_at, metadata)
    values (${input.id}, ${tenant.organizationId}, ${tenant.brandId}, 'meta', ${input.surface}, ${input.creativeId},
      ${input.clicks ?? null}, ${input.impressions ?? null}, ${input.completionRate ?? null}, now(), ${JSON.stringify(input.metadata ?? {})})
  `;
}
