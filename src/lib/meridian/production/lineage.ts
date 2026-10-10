/**
 * Lineage reconstruction for a stored creative (P4b-4).
 *
 * Given a creative, this follows its recorded links back to the production job that made it, the carousel it belongs to,
 * the CreativePlan that authorized the job, and the JEV decision the plan cites. Every link is read by tenant and id. A
 * link that is missing is listed in `missing`, and a lineage with any missing link is not complete. Nothing is inferred
 * to fill a gap, so a legacy creative with no recorded job reports itself as incomplete.
 */
import type { Sql } from "../learning/store.ts";
import { carouselQcVerdict, qcVerdictForStatus, type QcVerdict, type SlideQc } from "./qc.ts";

export type LineageModality = "image" | "video" | "carousel" | "unknown";

export interface SlideLineage {
  index: number;
  jobId: string;
  creativeId: string;
  qc: QcVerdict;
}

export interface CreativeLineage {
  creativeId: string;
  modality: LineageModality;
  qc: QcVerdict;
  productionJobId: string | null;
  /** The carousel this creative is a slide of, when it is a slide. */
  parentJobId: string | null;
  /** The slides of a carousel, in position order. Empty for any other creative. */
  slides: SlideLineage[];
  planId: string | null;
  briefId: string | null;
  decisionId: string | null;
  evidenceCount: number;
  /** Every link that should exist and does not. Empty means the lineage is complete. */
  missing: string[];
  complete: boolean;
}

export interface CreativeLineageRef {
  organizationId: string;
  brandId: string;
  creativeId: string;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function modalityOfKind(kind: unknown): LineageModality {
  if (kind === "carousel") return "carousel";
  if (kind === "video") return "video";
  if (kind === "image" || kind === "carousel_slide") return "image";
  return "unknown";
}

/** The slide references a carousel records in its creative, in position order. */
function slideReferences(workflow: Record<string, unknown>): Array<{ index: number; jobId: string; creativeId: string }> {
  return parseJsonArray(workflow.slides)
    .map((item) => parseJsonObject(item))
    .flatMap((item) =>
      typeof item.index === "number" && typeof item.jobId === "string" && typeof item.creativeId === "string"
        ? [{ index: item.index, jobId: item.jobId, creativeId: item.creativeId }]
        : [],
    )
    .sort((left, right) => left.index - right.index);
}

/** Returns the lineage of one creative in this tenant, or null when the creative is not in this tenant. */
export async function reconstructCreativeLineage(sql: Sql, ref: CreativeLineageRef): Promise<CreativeLineage | null> {
  const creatives = await sql<{ id: string; status: string; workflow: unknown }>`
    select id, status, workflow from creative_records
    where id = ${ref.creativeId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
    limit 1
  `;
  const creative = creatives[0];
  if (!creative) return null;

  const workflow = parseJsonObject(creative.workflow);
  const missing: string[] = [];
  let modality = modalityOfKind(workflow.kind);
  const productionJobId = typeof workflow.productionJobId === "string" ? workflow.productionJobId : null;
  let parentJobId: string | null = null;
  let planId: string | null = null;
  let decisionId: string | null = null;
  let briefId: string | null = null;
  let evidenceCount = 0;
  const slides: SlideLineage[] = [];

  if (!productionJobId) {
    missing.push("production job");
  } else {
    const jobs = await sql<{ id: string; modality: string; parent_job_id: string | null; creative_plan_id: string | null }>`
      select id, modality, parent_job_id, creative_plan_id from production_jobs
      where id = ${productionJobId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
      limit 1
    `;
    const job = jobs[0];
    if (!job) {
      missing.push("production job");
    } else {
      if (job.modality === "image" && modality === "image") parentJobId = job.parent_job_id;
      if (job.modality === "carousel") modality = "carousel";
      if (job.modality === "image" && job.parent_job_id) {
        const parents = await sql<{ id: string }>`
          select id from production_jobs
          where id = ${job.parent_job_id} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
          limit 1
        `;
        if (!parents[0]) missing.push("carousel parent job");
      }

      if (!job.creative_plan_id) {
        missing.push("creative plan");
      } else {
        planId = job.creative_plan_id;
        const plans = await sql<{ decision_id: string | null; brief_id: string | null }>`
          select decision_id, brief_id from creative_plans
          where id = ${job.creative_plan_id} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
          limit 1
        `;
        const plan = plans[0];
        if (!plan) {
          missing.push("creative plan");
        } else {
          briefId = plan.brief_id;
          if (!plan.decision_id) {
            missing.push("decision");
          } else {
            decisionId = plan.decision_id;
            const decisions = await sql<{ evidence: unknown }>`
              select evidence from jev_decisions
              where id = ${plan.decision_id} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
              limit 1
            `;
            if (!decisions[0]) missing.push("decision");
            else evidenceCount = parseJsonArray(decisions[0].evidence).length;
          }
        }
      }
    }
  }

  // A carousel's quality is the quality of its slides, so each slide is read from its own creative.
  const slideQc: SlideQc[] = [];
  if (modality === "carousel") {
    const references = slideReferences(workflow);
    if (references.length === 0) missing.push("carousel slides");
    for (const reference of references) {
      const rows = await sql<{ status: string }>`
        select status from creative_records
        where id = ${reference.creativeId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
        limit 1
      `;
      if (!rows[0]) {
        missing.push(`carousel slide ${reference.index + 1} creative`);
        slideQc.push({ index: reference.index, verdict: "PENDING" });
        continue;
      }
      const verdict = qcVerdictForStatus(rows[0].status);
      slides.push({ index: reference.index, jobId: reference.jobId, creativeId: reference.creativeId, qc: verdict });
      slideQc.push({ index: reference.index, verdict });
    }
  }

  const qc = modality === "carousel" ? carouselQcVerdict(slideQc, creative.status) : qcVerdictForStatus(creative.status);

  return {
    creativeId: creative.id,
    modality,
    qc,
    productionJobId,
    parentJobId,
    slides,
    planId,
    briefId,
    decisionId,
    evidenceCount,
    missing,
    complete: missing.length === 0,
  };
}
