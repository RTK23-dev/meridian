/**
 * Deep Study JEV Service & Concept Library Integration
 *
 * Connects deep study contrast analysis with native JEV question evaluations
 * and versioned ConceptGenome models mapped to the 11D Angle Bible.
 */

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { jevDecisionService, JevDecisionService } from "../jev/service.ts";
import type { EvidenceBundle } from "../evidence/types.ts";
import {
  calculateDecomposedOpportunityRating,
  buildConceptGenome,
  createCreativeConcept,
  type CreativeConcept,
  type DecomposedOpportunityRating,
} from "../factory/concept-genome.ts";
import { DeepStudyContrastEngine, type ContrastSubject, type ContrastDivergenceReport } from "./contrast-engine.ts";
import type { EvidenceRef } from "../jev/types.ts";

export interface DeepStudyInput {
  organizationId: string;
  brandId: string;
  subject: ContrastSubject;
  bundle: EvidenceBundle;
  sql?: Sql;
}

export interface DeepStudyResult {
  studyId: string;
  concept: CreativeConcept;
  divergenceReport: ContrastDivergenceReport;
  opportunityRating: DecomposedOpportunityRating;
  jevAnswers: Record<string, unknown>;
  analyzedAt: string;
}

export class DeepStudyService {
  private jevService: JevDecisionService;

  constructor(jevService: JevDecisionService = jevDecisionService) {
    this.jevService = jevService;
  }

  /**
   * Conducts a deep study using contrast analysis, native JEV questions, and Concept Genome construction.
   */
  async conductDeepStudy(input: DeepStudyInput): Promise<DeepStudyResult> {
    const studyId = `study_${randomUUID()}`;
    const startedAt = new Date().toISOString();

    // 1. Contrast Engine Divergence Analysis
    const divergence = DeepStudyContrastEngine.analyzeContrast(input.subject);

    // 2. Model-backed Native JEV Questions
    const deepQuestions = [
      "organic.hook_mechanism.v1",
      "organic.format_structure.v1",
      "organic.retention_architecture.v1",
      "organic.visual_craft.v1",
      "organic.share_trigger.v1",
      "organic.transferability.v1",
      "safety.claim_compliance.v1",
      "safety.rights_and_originality.v1",
    ];

    const jevRes = await this.jevService.evaluateEvidence({
      organizationId: input.organizationId,
      brandId: input.brandId,
      bundle: input.bundle,
      questionIds: deepQuestions,
      sql: input.sql,
    });

    const jevAnswersMap: Record<string, unknown> = {};
    for (const ans of jevRes.answers) {
      jevAnswersMap[ans.questionId] = {
        choice: ans.choice,
        score: ans.score,
        status: ans.status,
        confidence: ans.confidence,
        evidenceRefs: ans.evidenceRefs,
      };
    }

    // 3. Assemble Concept Genes from JEV and Contrast Divergence
    const conceptGenes: string[] = [];
    if (divergence.hookDivergence.outlierMechanism) {
      conceptGenes.push(divergence.hookDivergence.outlierMechanism);
    }
    const hookAns = jevRes.answers.find((a) => a.questionId === "organic.hook_mechanism.v1");
    if (hookAns?.choice) conceptGenes.push(String(hookAns.choice));

    const formatAns = jevRes.answers.find((a) => a.questionId === "organic.format_structure.v1");
    if (formatAns?.choice) conceptGenes.push(String(formatAns.choice));

    // 4. Calculate Decomposed Opportunity Rating
    const outlier = input.subject.outlierReel;
    const opportunityRating = calculateDecomposedOpportunityRating({
      observed: {
        views: outlier.metrics?.views ?? (outlier as any).views,
        creatorMedianViews: input.bundle.metrics?.creatorMedianViews as number | undefined,
        likes: outlier.metrics?.likes ?? (outlier as any).likes,
        comments: outlier.metrics?.comments ?? (outlier as any).comments,
        shares: outlier.metrics?.shares ?? (outlier as any).shares,
        controlSetSize: input.subject.baselineReels.length,
      },
      conceptGenes,
      transferContext: {
        brandFit: divergence.transferabilityAnalysis.score,
        productFit: divergence.transferabilityAnalysis.score * 0.9,
      },
      evidenceRefs: input.bundle.evidenceRefs as EvidenceRef[],
    });

    // 5. Construct Concept Genome & Creative Concept
    const genome = buildConceptGenome({
      genomeId: `genome_${randomUUID()}`,
      slugs: conceptGenes,
      pacingSecondsPerShot: divergence.pacingDivergence.outlierAverageShotSec,
      evidenceRefs: input.bundle.evidenceRefs as EvidenceRef[],
    });

    const concept = createCreativeConcept({
      conceptId: `concept-${studyId}`,
      name: `${input.bundle.source?.sourceAdapter || "source"} — ${divergence.hookDivergence.outlierMechanism} Concept`,
      mechanismDescription: divergence.hookDivergence.whyItPopped,
      genome,
      sourceCreativeIds: [outlier.id],
      artifactRefs: input.bundle.evidenceRefs as EvidenceRef[],
      positiveExamples: [outlier.id],
      negativeControls: input.subject.baselineReels.map((r) => r.id),
      productTransferConditions: divergence.transferabilityAnalysis.transferableFactors,
      scores: opportunityRating,
    });

    // Persist to DB if SQL client is passed
    if (input.sql) {
      try {
        await input.sql`
          insert into creative_patterns (
            id, organization_id, brand_id, dimension, value, state, sample_count, confidence, summary
          ) values (
            ${studyId}, ${input.organizationId}, ${input.brandId},
            'concept_genome', ${concept.name}, 'active',
            ${input.subject.baselineReels.length + 1}, ${opportunityRating.ratingOutOfTen / 10},
            ${JSON.stringify({ genome: concept.genome, opportunityRating, divergence })}
          )
          on conflict (id) do nothing
        `;
      } catch (err) {
        console.warn("[DeepStudyService] Failed to persist pattern:", err);
      }
    }

    return {
      studyId,
      concept,
      divergenceReport: divergence,
      opportunityRating,
      jevAnswers: jevAnswersMap,
      analyzedAt: startedAt,
    };
  }
}

export const deepStudyService = new DeepStudyService();
