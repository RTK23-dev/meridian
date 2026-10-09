/**
 * JEV Decision Service
 *
 * Central application-level service for model-backed semantic judgments.
 * Injects the shared JevProviderRouter and records authoritative decision ledgers
 * into jev_runs and jev_answers with strict provenance, tenant boundaries, and auditability.
 *
 * Distinguishes remote semantic decisions from deterministic ruleEngine gates.
 */

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { EvidenceBundle } from "../evidence/types.ts";
import { compressEvidenceForJev } from "../evidence/bundle.ts";
import { jevRouter } from "./router.ts";
import { jevRegistry } from "./registry.ts";
import type {
  JevDecisionRequest,
  JevDecisionResponse,
  JevProviderRouter,
  JevRoutingPolicy,
  JevQuestionSpec,
  JevAnswer,
} from "./types.ts";

export interface SemanticDecisionResult extends JevDecisionResponse {
  engineType: "remoteJev";
  persisted: boolean;
}

function resolveQuestionSpec(id: string): JevQuestionSpec | undefined {
  const direct = jevRegistry.get(id);
  if (direct) return direct;
  const aliasMap: Record<string, string> = {
    org_hook_intent: "organic.hook_mechanism.v1",
    org_retention_risk: "organic.retention_architecture.v1",
    org_format_structure: "organic.format_structure.v1",
    safe_substantiation_present: "safety.claim_compliance.v1",
  };
  const resolvedId = aliasMap[id];
  return resolvedId ? jevRegistry.get(resolvedId) : undefined;
}

export class JevDecisionService {
  private router: JevProviderRouter;

  constructor(router: JevProviderRouter = jevRouter) {
    this.router = router;
  }

  /**
   * Dispatches a semantic decision request through the configured JEV provider router
   * and persists the decision ledger to Postgres if an SQL client is supplied.
   */
  async decideSemantic(
    request: JevDecisionRequest,
    options?: {
      policy?: JevRoutingPolicy;
      sql?: Sql;
      recordId?: string;
    }
  ): Promise<SemanticDecisionResult> {
    const response = await this.router.decide(request, options?.policy);

    let persisted = false;
    if (options?.sql) {
      try {
        const metadata = {
          latencyMs: response.latencyMs,
          questionCount: Object.keys(response.answers).length,
          cached: response.cached,
          fallbackFrom: response.fallbackFrom,
          fallbackReason: response.fallbackReason,
          comparison: response.comparison
            ? {
                comparedWith: response.comparison.comparedWith,
                agreementRate: response.comparison.agreementRate,
              }
            : undefined,
        };

        await options.sql`
          insert into jev_runs (
            id, organization_id, brand_id, question_set, model, provider, input_hash, status, metadata
          ) values (
            ${response.runId}, ${request.organizationId}, ${request.brandId}, 'semantic_decision',
            ${response.model}, ${response.provider}, ${response.inputHash}, 'completed',
            ${JSON.stringify(metadata)}
          )
          on conflict (id) do nothing
        `;

        for (const [key, ans] of Object.entries(response.answers)) {
          const recordId = options.recordId || (request.state as any)?.bundleId || response.runId;
          const isAnswered = ans.status === "answered";

          await options.sql`
            insert into jev_answers (
              id, organization_id, brand_id, run_id, record_id, question_id, question_version,
              model, provider, answer, probability, distribution, confidence, status, evidence
            ) values (
              ${randomUUID()}, ${request.organizationId}, ${request.brandId}, ${response.runId},
              ${recordId}, ${ans.questionId || key}, ${ans.questionVersion || "v1"},
              ${ans.model}, ${ans.provider},
              ${isAnswered && ans.answer !== undefined ? JSON.stringify(ans.answer) : null},
              ${isAnswered ? (ans.probability ?? ans.noul ?? null) : null},
              ${isAnswered && (ans.probabilities || ans.distribution) ? JSON.stringify(ans.probabilities || ans.distribution) : null},
              ${isAnswered ? (ans.confidence ?? null) : null},
              ${ans.status},
              ${JSON.stringify(ans.evidenceRefs || [])}
            )
          `;
        }
        persisted = true;
      } catch (err) {
        // Logging/storage failure is non-fatal to decision delivery
        console.warn("[JevDecisionService] Failed to persist decision ledger:", err);
      }
    }

    return {
      ...response,
      engineType: "remoteJev",
      persisted,
    };
  }

  /**
   * Evaluates an EvidenceBundle against a set of versioned JEV questions.
   */
  async evaluateEvidence(input: {
    organizationId: string;
    brandId: string;
    bundle: EvidenceBundle;
    questionIds?: string[];
    policy?: JevRoutingPolicy;
    sql?: Sql;
  }): Promise<{
    bundleId: string;
    runId: string;
    model: string;
    provider: string;
    answers: JevAnswer[];
    comparison?: any;
    fallbackFrom?: string;
    persisted: boolean;
  }> {
    const questionIds = input.questionIds || [
      "organic.hook_mechanism.v1",
      "organic.format_structure.v1",
      "organic.retention_architecture.v1",
      "safety.claim_compliance.v1",
    ];

    const questionsRecord: Record<string, JevQuestionSpec> = {};
    for (const qid of questionIds) {
      const q = resolveQuestionSpec(qid);
      if (q) questionsRecord[q.id] = q;
    }

    if (Object.keys(questionsRecord).length === 0) {
      return {
        bundleId: input.bundle.id,
        runId: randomUUID(),
        model: "none",
        provider: "none",
        answers: [],
        persisted: false,
      };
    }

    const firstQ = Object.values(questionsRecord)[0];
    const compressed = compressEvidenceForJev(input.bundle, firstQ);

    const request: JevDecisionRequest = {
      organizationId: input.organizationId,
      brandId: input.brandId,
      state: {
        description: compressed.description,
        bundleId: input.bundle.id,
        availableEvidence: input.bundle.availableEvidence || compressed.availableEvidence,
        evidenceRefs: compressed.evidenceRefs,
        source: input.bundle.source || compressed.source,
        platform: input.bundle.source?.platform,
        contentType: input.bundle.content?.type,
        metrics: compressed.metrics,
        transcriptSummary: compressed.transcriptSummary,
        sceneSummary: compressed.sceneSummary,
        scenes: compressed.scenes,
        ocr: compressed.ocr,
        comments: compressed.comments,
        performance: input.bundle.performance,
      },
      questions: questionsRecord,
    };

    const result = await this.decideSemantic(request, {
      policy: input.policy,
      sql: input.sql,
      recordId: input.bundle.id,
    });

    return {
      bundleId: input.bundle.id,
      runId: result.runId,
      model: result.model,
      provider: result.provider,
      answers: Object.values(result.answers),
      comparison: result.comparison,
      fallbackFrom: result.fallbackFrom,
      persisted: result.persisted,
    };
  }

  /**
   * Retrieves full audit ledger answers for a specific ad, creative, or run record.
   */
  async getAuditTrail(recordId: string, sql: Sql): Promise<{
    answers: Array<{
      id: string;
      runId: string;
      questionId: string;
      model: string;
      provider: string;
      status: string;
      answer: unknown;
      probability: number | null;
      evidence: unknown;
      createdAt: string;
    }>;
  }> {
    const rows = await sql<{
      id: string;
      run_id: string;
      question_id: string;
      model: string;
      provider: string;
      status: string;
      answer: unknown;
      probability: number | null;
      evidence: unknown;
      created_at: string;
    }>`
      select id, run_id, question_id, model, provider, status, answer, probability, evidence, created_at
      from jev_answers
      where record_id = ${recordId} or run_id = ${recordId}
      order by created_at desc
    `;

    return {
      answers: rows.map((r) => ({
        id: r.id,
        runId: r.run_id,
        questionId: r.question_id,
        model: r.model,
        provider: r.provider,
        status: r.status,
        answer: r.answer,
        probability: r.probability,
        evidence: r.evidence,
        createdAt: r.created_at,
      })),
    };
  }
}

export const jevDecisionService = new JevDecisionService();
