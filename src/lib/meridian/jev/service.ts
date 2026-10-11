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
import { createDecisionEngines, decideWithActiveEngine } from "../decisions/dispatcher.ts";
import { runEngineGate, type GateEvidenceInput } from "../decisions/gate.ts";
import type { DecisionRequest } from "../decisions/types.ts";
import { jevRegistry } from "./registry.ts";
import { ORGANIC_EVIDENCE_SCOPES } from "./questions/organic.ts";
import { SAFETY_EVIDENCE_SCOPES } from "./questions/safety.ts";
import type {
  JevDecisionRequest,
  JevDecisionResponse,
  JevProviderRouter,
  JevQuestionSpec,
  JevAnswer,
} from "./types.ts";

export interface SemanticDecisionResult extends JevDecisionResponse {
  engineType: "remoteJev";
  persisted: boolean;
}

/** The evidence each research question may receive, declared with the question (jev/questions/organic.ts, safety.ts). */
const RESEARCH_EVIDENCE_SCOPES: Record<string, readonly string[]> = { ...ORGANIC_EVIDENCE_SCOPES, ...SAFETY_EVIDENCE_SCOPES };

/**
 * The research evidence the gate may place in a question's scope, each with the content it carries. The bundle's identity and
 * source travel as `bundle_source`, which every research scope names. A structural name is listed only when the bundle supplies
 * its structure. A name with no content is not evidence, so a question that requires it abstains. The research bundle does not
 * supply script or brand-allowed claims, so claim questions have no evidence and go to review.
 */
function researchEvidence(
  bundle: EvidenceBundle,
  compressed: ReturnType<typeof compressEvidenceForJev>,
  availableEvidence: string[],
): GateEvidenceInput[] {
  const content: Record<string, unknown> = {
    transcript: { transcriptSummary: compressed.transcriptSummary },
    scene_cuts: { scenes: compressed.scenes },
    scene_frames: { scenes: compressed.scenes },
    ocr: { ocr: compressed.ocr },
    comments: { comments: compressed.comments },
    creator_baseline: { creatorBaseline: compressed.creatorBaseline },
    performance_snapshot: { performance: bundle.performance, metrics: compressed.metrics },
    comparison_context: { comparisonContext: compressed.comparisonContext },
  };
  const structural = availableEvidence.flatMap((name): GateEvidenceInput[] => {
    const value = content[name];
    if (value === undefined) return [];
    const fields = Object.values(value as Record<string, unknown>);
    if (fields.every((field) => field === undefined)) return [];
    return [{ kind: "text", name, source: "evidence_bundle", content: value }];
  });
  const provenance: GateEvidenceInput = {
    kind: "text",
    name: "bundle_source",
    source: "evidence_bundle",
    content: {
      bundleId: bundle.id,
      source: bundle.source,
      platform: bundle.source?.platform,
      contentType: bundle.content?.type,
      evidenceRefs: compressed.evidenceRefs,
    },
  };
  return [provenance, ...structural];
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
      sql?: Sql;
      recordId?: string;
    }
  ): Promise<SemanticDecisionResult> {
    // The active decision engine handles the call. JEV is this service's transport, so the JEV engine wraps this
    // service's router. Lineage is recorded by the dispatcher, in the same tables.
    const dispatched = await decideWithActiveEngine({
      sql: options?.sql,
      request: { ...request } as DecisionRequest,
      engines: createDecisionEngines({ jevRouter: this.router }),
      recordId: options?.recordId,
    });
    const { selection: _selection, persisted, ...response } = dispatched;
    void _selection;

    return {
      ...response,
      engineType: "remoteJev",
      persisted,
    } as SemanticDecisionResult;
  }

  /**
   * Evaluates an EvidenceBundle against a set of versioned JEV questions.
   */
  async evaluateEvidence(input: {
    organizationId: string;
    brandId: string;
    bundle: EvidenceBundle;
    questionIds?: string[];
    sql?: Sql;
  }): Promise<{
    bundleId: string;
    runId: string;
    model: string;
    provider: string;
    answers: JevAnswer[];
    /** The gate's outcome over the gating questions. Analysis answers do not appear here. Absent when nothing was asked. */
    gate?: {
      action: "AUTO_APPROVE" | "HUMAN_REVIEW" | "REJECT";
      reason: string;
      gateRecordId: string | null;
      votes: Array<{ questionId: string; outcome: string; reason: string }>;
      unresolved: Array<{ questionId: string; status: string; reason: string }>;
    };
    persisted: boolean;
  }> {
    const questionIds = input.questionIds || [
      "organic.hook_mechanism.v1",
      "organic.format_structure.v1",
      "organic.retention_architecture.v1",
      "safety.claim_compliance.v1",
    ];

    const questions: Array<{ key: string; spec: JevQuestionSpec; needsImage: false; gating: boolean; evidenceScope?: readonly string[] }> = [];
    for (const qid of questionIds) {
      const q = resolveQuestionSpec(qid);
      // Claim and rights questions gate the evidence. The organic questions are analysis: answered and recorded only.
      if (q) questions.push({ key: q.id, spec: q, needsImage: false, gating: q.id.startsWith("safety."), evidenceScope: RESEARCH_EVIDENCE_SCOPES[q.id] });
    }

    if (questions.length === 0) {
      return {
        bundleId: input.bundle.id,
        runId: randomUUID(),
        model: "none",
        provider: "none",
        answers: [],
        gate: undefined,
        persisted: false,
      };
    }

    const compressed = compressEvidenceForJev(input.bundle, questions.map((entry) => entry.spec));
    const availableEvidence = input.bundle.availableEvidence || compressed.availableEvidence;

    // One active engine. The gate sends one call per evidence scope and computes the outcome of the gating questions under
    // their policies. Nothing downstream approves or rejects research on the answers alone.
    const gate = await runEngineGate({
      sql: input.sql,
      organizationId: input.organizationId,
      brandId: input.brandId,
      gate: "research_evidence",
      subject: { type: "evidence_bundle", id: input.bundle.id },
      description: compressed.description,
      questions,
      evidence: researchEvidence(input.bundle, compressed, availableEvidence),
      engines: createDecisionEngines({ jevRouter: this.router }),
    });

    return {
      bundleId: input.bundle.id,
      runId: gate.runId ?? randomUUID(),
      model: gate.model ?? "none",
      provider: gate.provider ?? "none",
      answers: Object.values(gate.answers),
      gate: {
        action: gate.action,
        reason: gate.reason,
        gateRecordId: gate.gateRecordId,
        votes: gate.votes,
        unresolved: gate.unresolved,
      },
      persisted: gate.lineagePersisted,
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
