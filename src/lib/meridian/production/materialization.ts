/**
 * Shared, idempotent materialization of completed production artifacts, for every modality.
 *
 * The Studio path and the asynchronous poller both call `completeProductionJob`, which dispatches on the job's modality.
 * The creative, asset, review, and reservation rows for a completed artifact are written in exactly one place per modality.
 *
 * Every row id is derived from the production job id. Each insert is `on conflict do nothing`, so a crash between
 * inserts, a duplicate poll, or two pollers racing on one job cannot create a second creative, asset, or review. A job that
 * is already materialized is returned as it is: its judgment is never recomputed from data that may have changed since.
 *
 * Video creatives always enter review as `in_review`, and nothing here approves a video automatically. An image creative
 * takes the quality judgment's rollup, as the Studio path has always done: REJECT is rejected, AUTO_APPROVE is approved,
 * and anything else waits in review.
 *
 * Both modalities are made from the job's immutable input snapshot and its verified artifact. Neither reads the brief.
 */
import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { semanticNearest } from "../embeddings/store.ts";
import { defaultArtifactDrive, type ArtifactDrive } from "../storage/artifact-drive.ts";
import { transitionCreativePlan } from "../creative/state-transition.server.ts";
import { assessPublishing } from "../publishing/readiness.ts";
import { accountSnapshots, competitorCopy, factsFor, visualFacts, writeJudgment, type QcBrandContext } from "../studio/image-qc.server.ts";
import { BudgetLedgerService } from "../security/budget-ledger.ts";
import type { CreativeSpec, ProductionModality } from "./types.ts";

export const ESTIMATOR_VERSION = "creative-plan-estimate-v1";

/**
 * Settles a reservation whose job had no known price. The reserved ceiling is the most the job could have cost, and the
 * provider's actual charge is not known, so the ledger records the ceiling and says so in the estimator version.
 */
export const UNPRICED_CEILING_ESTIMATOR = "unpriced-ceiling-v1";

export interface ProductionJobRef {
  organizationId: string;
  brandId: string;
  productionJobId: string;
}

export interface MaterializedArtifact {
  modality: ProductionModality;
  creativeId: string;
  assetId: string;
  decisionId: string;
  creativePlanId: string | null;
  alreadyMaterialized: boolean;
  /** Whether the creative belongs in the human review queue. A video always does; an image does when its judgment says so. */
  reviewRequired: boolean;
  /** The label the review shows, such as "Video", "Image 2", or "Slide 3". */
  subjectLabel: string;
}

/** Kept for the video callers that predate the modality dispatch. */
export type MaterializedVideo = MaterializedArtifact;

interface ManifestLike {
  brand?: { product?: string; audience?: string };
  hook?: { type?: string; text?: string };
  concept?: { mechanism?: string };
}

const ASPECT_DIMENSIONS: Record<string, [number, number]> = {
  "9:16": [1080, 1920],
  "16:9": [1920, 1080],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
};

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface JobRow {
  id: string;
  status: string;
  artifact_id: string | null;
  input: unknown;
  output: unknown;
  materialized_at: unknown;
  materialized_creative_id: string | null;
  creative_plan_id: string | null;
  provider: string;
  modality: ProductionModality;
  cost_status: string | null;
}

async function loadCompletedJob(sql: Sql, ref: ProductionJobRef, expected: ProductionModality): Promise<JobRow> {
  const jobs = await sql<JobRow>`
    select id, status, artifact_id, input, output, materialized_at, materialized_creative_id, creative_plan_id,
           provider, modality, cost_status
    from production_jobs
    where id = ${ref.productionJobId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
    limit 1
  `;
  const job = jobs[0];
  if (!job) throw new Error("Production job was not found in this tenant.");
  if (job.modality !== expected) {
    throw new Error(`Production job '${job.id}' is a ${job.modality} job; the ${expected} materializer refuses it.`);
  }
  if (job.status !== "COMPLETED" || !job.artifact_id) {
    throw new Error(`Production job '${job.id}' has no completed artifact to materialize (status ${job.status}).`);
  }
  return job;
}

interface VerifiedArtifact {
  name: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  providerFileId: string;
}

/** The artifact row is the authority for bytes. Refuses anything that is not a verified artifact of the expected family. */
async function loadVerifiedArtifact(sql: Sql, ref: ProductionJobRef, artifactId: string, family: "video/" | "image/"): Promise<VerifiedArtifact> {
  const artifacts = await sql<{ name: string; sha256: string; size_bytes: string | number | bigint; mime_type: string; provider_file_id: string }>`
    select name, sha256, size_bytes, mime_type, provider_file_id from storage_objects
    where id = ${artifactId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
    limit 1
  `;
  const artifact = artifacts[0];
  if (!artifact) throw new Error("Completed artifact has no storage record; refusing to materialize.");
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error("Stored artifact has no valid SHA-256; refusing to materialize.");
  if (BigInt(artifact.size_bytes) <= 0n) throw new Error("Stored artifact is empty; refusing to materialize.");
  if (!artifact.mime_type.startsWith(family)) {
    throw new Error(`Stored artifact is '${artifact.mime_type}', not ${family.slice(0, -1)}.`);
  }
  return {
    name: artifact.name,
    sha256: artifact.sha256,
    sizeBytes: Number(artifact.size_bytes),
    mimeType: artifact.mime_type,
    providerFileId: artifact.provider_file_id,
  };
}

interface PlanLineage {
  decisionId: string;
  briefId: string | null;
  approvedBy: string;
  planTitle: string;
  opportunityId: string | null;
}

/**
 * P3c: the materialized creative is made from the CreativePlan its job belongs to, never from the brief, which may have
 * been edited while production was in flight. The plan row supplies lineage and ownership; its snapshot supplies the
 * title and the opportunity link.
 */
async function loadPlanLineage(sql: Sql, ref: ProductionJobRef, planId: string | null): Promise<PlanLineage> {
  if (!planId) throw new Error("Production job belongs to no CreativePlan; refusing to materialize it.");
  const plans = await sql<{ plan_payload: unknown; decision_id: string | null; brief_id: string | null; approved_by: string | null }>`
    select plan_payload, decision_id, brief_id, approved_by from creative_plans
    where id = ${planId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
    limit 1
  `;
  const planRow = plans[0];
  if (!planRow) throw new Error("CreativePlan for this production job was not found in this tenant.");
  // A review is only meaningful with the JEV decision that authorized the plan.
  if (!planRow.decision_id) throw new Error("CreativePlan has no JEV decision; refusing to create a review without lineage.");
  if (!planRow.approved_by) throw new Error("CreativePlan has no approver; refusing to attribute a creative to nobody.");
  const planContext = (parseJson(planRow.plan_payload).productionContext ?? null) as { title?: unknown; opportunityId?: unknown } | null;
  if (!planContext) throw new Error("CreativePlan has no production context; refusing to materialize it.");
  return {
    decisionId: planRow.decision_id,
    briefId: planRow.brief_id,
    approvedBy: planRow.approved_by,
    planTitle: text(planContext.title),
    opportunityId: text(planContext.opportunityId) || null,
  };
}

/**
 * Creates the creative, asset, and materialization marker for a COMPLETED video job. Requires the job's artifact to be
 * verified in storage. Safe to call again at any time.
 */
export async function materializeVideoArtifact(sql: Sql, ref: ProductionJobRef): Promise<MaterializedArtifact> {
  const job = await loadCompletedJob(sql, ref, "video");
  const input = parseJson(job.input);
  const runId = text(input.runId);
  const deliverableId = text(input.planDeliverableId);
  const spec = (input.creativeSpec ?? null) as CreativeSpec | null;
  const manifest = (input.manifest ?? {}) as ManifestLike;
  if (!runId || !spec) throw new Error("Production job input is incomplete; the artifact cannot be materialized.");

  const artifact = await loadVerifiedArtifact(sql, ref, job.artifact_id!, "video/");
  const lineage = await loadPlanLineage(sql, ref, job.creative_plan_id);

  const creativeId = `video-creative-${job.id}`;
  const assetId = `video-asset-${job.id}`;
  const [width, height] = ASPECT_DIMENSIONS[spec.aspectRatio ?? "9:16"] ?? [1080, 1920];
  const durationMs = Math.round((spec.durationTargetSeconds ?? 8) * 1000);
  const product = manifest.brand?.product || "";

  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
      message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
    ) values (
      ${creativeId}, ${ref.organizationId}, ${ref.brandId}, 'generated', ${lineage.planTitle ? `${lineage.planTitle} video` : "Video"},
      ${`${product}. ${text(spec.script)}`}, ${product}, ${text(spec.hookLine) || text(manifest.hook?.text)},
      ${text(manifest.hook?.type)}, ${text(manifest.concept?.mechanism)},
      ${text(spec.script)}, '', ${text(spec.format)}, '', ${lineage.opportunityId}, ${lineage.briefId}, 'in_review', ${lineage.approvedBy},
      ${JSON.stringify({
        generationRunId: runId,
        provider: job.provider,
        productionJobId: job.id,
        jevDecisionId: lineage.decisionId,
        kind: "video",
        planDeliverableId: deliverableId,
      })}
    )
    on conflict (id) do nothing
  `;

  await sql`
    insert into assets (
      id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
      lifecycle, checksum, width, height, byte_size, duration_ms, provider, model, prompt_version, generation_run_id,
      kind, qa_decision, review_status, media_status, variant_index, provenance
    ) values (
      ${assetId}, ${ref.organizationId}, ${ref.brandId}, ${creativeId}, 1, ${artifact.name}, ${artifact.sha256},
      ${artifact.mimeType}, ${job.provider}, 'stored', 'qa_required', ${artifact.sha256}, ${width}, ${height},
      ${artifact.sizeBytes}, ${durationMs}, ${job.provider}, ${text(spec.modelId)}, 'studio_video_v1', ${runId},
      'video', '', 'in_review', 'completed', 0, 'generated'
    )
    on conflict (id) do nothing
  `;

  await sql`
    update production_jobs
    set materialized_creative_id = ${creativeId},
        materialized_at = coalesce(materialized_at, now()),
        updated_at = now()
    where id = ${job.id} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
  `;

  return {
    modality: "video",
    creativeId,
    assetId,
    decisionId: lineage.decisionId,
    creativePlanId: job.creative_plan_id,
    alreadyMaterialized: job.materialized_at != null,
    reviewRequired: true,
    subjectLabel: "Video",
  };
}

/**
 * Creates the creative, asset, judgment, and materialization marker for a COMPLETED image job. The bytes are read back
 * from Drive and checked against the recorded SHA-256 before anything is judged or stored. Safe to call again at any time:
 * a job that is already materialized returns its creative without judging it again.
 */
export async function materializeImageArtifact(
  sql: Sql,
  ref: ProductionJobRef,
  options: { driveClient?: ArtifactDrive } = {},
): Promise<MaterializedArtifact> {
  const job = await loadCompletedJob(sql, ref, "image");
  const input = parseJson(job.input);
  const runId = text(input.runId);
  const prompt = text(input.prompt);
  const copy = text(input.copy);
  const productName = text(input.productName);
  const format = text(input.format);
  const itemLabel = text(input.itemLabel);
  const sequenceIndex = typeof input.sequenceIndex === "number" ? input.sequenceIndex : NaN;
  const manifest = (input.manifest ?? {}) as ManifestLike;
  const spec = (input.creativeSpec ?? null) as CreativeSpec | null;
  if (!runId || !prompt || !copy || !itemLabel || !Number.isInteger(sequenceIndex) || !spec) {
    throw new Error("Production job input is incomplete; the image cannot be materialized.");
  }
  const creativeId = `image-creative-${job.id}`;
  const assetId = `image-asset-${job.id}`;
  const lineage = await loadPlanLineage(sql, ref, job.creative_plan_id);

  if (job.materialized_at != null && job.materialized_creative_id) {
    const existing = await sql<{ workflow: unknown; status: string }>`
      select workflow, status from creative_records
      where id = ${job.materialized_creative_id} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
      limit 1
    `;
    const workflow = parseJson(existing[0]?.workflow);
    return {
      modality: "image",
      creativeId: job.materialized_creative_id,
      assetId,
      decisionId: text(workflow.jevDecisionId) || lineage.decisionId,
      creativePlanId: job.creative_plan_id,
      alreadyMaterialized: true,
      reviewRequired: existing[0]?.status === "in_review",
      subjectLabel: itemLabel,
    };
  }

  const artifact = await loadVerifiedArtifact(sql, ref, job.artifact_id!, "image/");
  const drive = options.driveClient ?? defaultArtifactDrive();
  const stored = await drive.get(artifact.providerFileId);
  if (!stored?.bytes || stored.bytes.byteLength === 0) {
    throw new Error("The stored image bytes are missing; refusing to judge or materialize it.");
  }
  const storedSha = createHash("sha256").update(stored.bytes).digest("hex");
  if (storedSha !== artifact.sha256 || stored.bytes.byteLength !== artifact.sizeBytes) {
    throw new Error("The stored image bytes do not match the verified artifact; refusing to judge or materialize it.");
  }

  const output = parseJson(job.output);
  const width = typeof output.width === "number" ? output.width : NaN;
  const height = typeof output.height === "number" ? output.height : NaN;
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error("Image dimensions were not recorded; refusing to materialize it.");

  // Quality judgment, made from the stored bytes and the brand's data as it is now. Judgments are written with deterministic
  // ids, so a retry after a crash does not duplicate them.
  const product = productName || manifest.brand?.product || "";
  const copyWithProduct = `${product}. ${prompt}`;
  // The brand data the judgment compares against was captured when the image was submitted. It is never reloaded here.
  const qcBrand = input.qcBrand as QcBrandContext | undefined;
  if (!qcBrand || !qcBrand.brain || !Array.isArray(qcBrand.creatives)) {
    throw new Error("Production job has no brand snapshot for its judgment; refusing to judge it against live brand data.");
  }
  const loaded = qcBrand;
  const visual = await visualFacts(sql, ref.organizationId, ref.brandId, stored.bytes);
  const ownSemantic = await semanticNearest(
    copyWithProduct,
    loaded.creatives.filter((item) => item.origin !== "competitor").map((item) => item.text),
  ).catch(() => null);
  const accounts = await accountSnapshots(sql, ref.organizationId);
  const publishing = assessPublishing({
    accounts,
    provider: "test:publisher",
    kind: "image",
    mime: artifact.mimeType,
    width,
    height,
    byteSize: artifact.sizeBytes,
    destinationUrl: "",
  });
  const facts = factsFor(loaded, {
    kind: "image",
    productName: product,
    angle: text(manifest.concept?.mechanism),
    copy: copyWithProduct,
    prompt,
    mime: artifact.mimeType,
    byteSize: artifact.sizeBytes,
    width,
    height,
    checksum: artifact.sha256,
    durationMs: null,
    transcript: "",
    sceneCount: 0,
    logoSimilarity: visual.measuredLogo.similarity,
    logoOutcome: visual.measuredLogo.outcome,
    logoEvidence: visual.measuredLogo.evidence,
    paletteDistance: visual.measuredPalette.distance,
    paletteOutcome: visual.measuredPalette.outcome,
    paletteEvidence: visual.measuredPalette.evidence,
    semanticSimilarity: await semanticNearest(copyWithProduct, competitorCopy(loaded)).catch(() => null),
    ownSemanticSimilarity: ownSemantic,
    publishing,
  });
  const judged = await writeJudgment(sql, { organizationId: ref.organizationId, brandId: ref.brandId, creativeId, facts });
  const status = judged.rollup === "REJECT" ? "rejected" : judged.rollup === "AUTO_APPROVE" ? "approved" : "in_review";

  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
      message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
    ) values (
      ${creativeId}, ${ref.organizationId}, ${ref.brandId}, 'generated', ${lineage.planTitle ? `${lineage.planTitle} ${itemLabel}` : itemLabel},
      ${copy}, ${productName}, ${text(manifest.hook?.text)}, ${text(manifest.hook?.type)}, ${text(manifest.concept?.mechanism)},
      ${copy}, ${""}, ${format}, ${""},
      ${lineage.opportunityId}, ${lineage.briefId}, ${status}, ${lineage.approvedBy},
      ${JSON.stringify({
        generationRunId: runId,
        provider: job.provider,
        productionJobId: job.id,
        jevDecisionId: judged.decisionId || lineage.decisionId,
        kind: text(input.deliverableKind) || "image",
        variant: sequenceIndex + 1,
        planDeliverableId: text(input.planDeliverableId),
      })}
    )
    on conflict (id) do nothing
  `;
  await sql`
    insert into assets (
      id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
      lifecycle, checksum, width, height, byte_size, provider, model, prompt_version, generation_run_id, kind,
      qa_decision, review_status, media_status, variant_index, provenance
    ) values (
      ${assetId}, ${ref.organizationId}, ${ref.brandId}, ${creativeId}, 1, ${artifact.name}, ${artifact.sha256},
      ${artifact.mimeType}, ${job.provider}, 'stored', 'qa_required', ${artifact.sha256}, ${width}, ${height},
      ${artifact.sizeBytes}, ${job.provider}, ${text(spec.modelId)}, ${text(output.promptVersion)}, ${runId}, 'image',
      ${judged.rollup}, ${status}, 'completed', ${sequenceIndex}, 'generated'
    )
    on conflict (id) do nothing
  `;
  await sql`
    update production_jobs
    set materialized_creative_id = ${creativeId},
        materialized_at = coalesce(materialized_at, now()),
        updated_at = now()
    where id = ${job.id} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
  `;

  return {
    modality: "image",
    creativeId,
    assetId,
    decisionId: judged.decisionId || lineage.decisionId,
    creativePlanId: job.creative_plan_id,
    alreadyMaterialized: false,
    reviewRequired: status === "in_review",
    subjectLabel: itemLabel,
  };
}

/** Puts a materialized creative in the human review queue. Idempotent. */
export async function openProductionReview(
  sql: Sql,
  ref: { organizationId: string; brandId: string; creativeId: string; decisionId: string; subjectLabel: string },
): Promise<void> {
  await sql`
    insert into reviews (id, organization_id, brand_id, decision_id, creative_id, subject_label)
    values (${`review-${ref.creativeId}`}, ${ref.organizationId}, ${ref.brandId}, ${ref.decisionId}, ${ref.creativeId}, ${ref.subjectLabel})
    on conflict (id) do nothing
  `;
}

/**
 * Settles the budget reservation held for one production job. Runs only after the artifact is materialized. A job with a
 * known price settles at its reserved estimate. A job without one settles at the reserved ceiling, which is the most it
 * could have cost. Reservations for failed or ambiguous jobs are never settled here.
 */
export async function settleProductionReservation(sql: Sql, ref: ProductionJobRef): Promise<boolean> {
  const rows = await sql<{ id: string; amount_micros: string | number | bigint; cost_status: string | null }>`
    select r.id, r.amount_micros, j.cost_status
    from budget_reservations r
    join production_jobs j on j.id = r.production_job_id
    where r.production_job_id = ${ref.productionJobId}
      and r.organization_id = ${ref.organizationId} and r.brand_id = ${ref.brandId}
      and r.status = 'RESERVED'
    limit 1
  `;
  const reservation = rows[0];
  if (!reservation) return false;
  const unpriced = reservation.cost_status === "unknown" || reservation.cost_status === "stale";
  await BudgetLedgerService.reconcile(sql, {
    reservationId: reservation.id,
    cost: {
      basis: "ESTIMATED",
      amountMicros: BigInt(reservation.amount_micros),
      estimatorVersion: unpriced ? UNPRICED_CEILING_ESTIMATOR : ESTIMATOR_VERSION,
    },
  });
  return true;
}

/**
 * Materializes a completed job of any modality, opens its review, and settles its reservation. This is the one completion
 * path: the Studio and the poller both call it, so a job is treated the same wherever it completes.
 */
export async function completeProductionJob(
  sql: Sql,
  ref: ProductionJobRef,
  options: {
    driveClient?: ArtifactDrive;
    /** False when the caller judges the creative itself and opens its review with that judgment. */
    openReview?: boolean;
  } = {},
): Promise<MaterializedArtifact> {
  const shape = await jobShapeOf(sql, ref);
  const modality = shape.modality;
  const materialized =
    modality === "video"
      ? await materializeVideoArtifact(sql, ref)
      : modality === "image"
        ? await materializeImageArtifact(sql, ref, options)
        : null;
  if (!materialized) throw new Error(`Production job modality '${modality}' has no materializer yet.`);
  if (materialized.reviewRequired && options.openReview !== false) {
    await openProductionReview(sql, {
      organizationId: ref.organizationId,
      brandId: ref.brandId,
      creativeId: materialized.creativeId,
      decisionId: materialized.decisionId,
      subjectLabel: materialized.subjectLabel,
    });
  }
  await settleProductionReservation(sql, ref);
  if (shape.parentJobId) {
    await settleCarouselParent(sql, {
      organizationId: ref.organizationId,
      brandId: ref.brandId,
      productionJobId: shape.parentJobId,
    });
  }
  return materialized;
}

interface JobShape {
  modality: ProductionModality;
  parentJobId: string | null;
}

async function jobShapeOf(sql: Sql, ref: ProductionJobRef): Promise<JobShape> {
  const rows = await sql<{ modality: ProductionModality; parent_job_id: string | null }>`
    select modality, parent_job_id from production_jobs
    where id = ${ref.productionJobId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
    limit 1
  `;
  if (!rows[0]) throw new Error("Production job was not found in this tenant.");
  return { modality: rows[0].modality, parentJobId: rows[0].parent_job_id };
}

export type PlanSettlement = "pending" | "completed" | "partially_completed" | "failed" | "unchanged";

const SUCCESS_TERMINAL = "COMPLETED";
const FAILURE_TERMINAL = new Set(["FAILED", "POSTFLIGHT_FAILED", "PREFLIGHT_FAILED", "NOT_CONFIGURED", "CANCELLED"]);

/**
 * Completes a CreativePlan only when every production job it created has a deterministic terminal outcome. A job is
 * successful only when its artifact is materialized. Ambiguous or retryable states (queued, submission unknown, storage
 * retry, unmaterialized) keep the plan executing. Transitions go through the authoritative state service.
 */
export async function settleCreativePlanIfComplete(
  sql: Sql,
  ref: { organizationId: string; brandId: string; planId: string; actorId: string },
): Promise<PlanSettlement> {
  const plans = await sql<{ status: string }>`
    select status from creative_plans
    where id = ${ref.planId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
    limit 1
  `;
  const plan = plans[0];
  if (!plan) throw new Error("Creative plan not found for this organization and brand.");
  if (plan.status !== "executing") return "unchanged";

  const jobs = await sql<{ status: string; materialized_at: unknown }>`
    select status, materialized_at from production_jobs
    where creative_plan_id = ${ref.planId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
  `;
  let successes = 0;
  let failures = 0;
  for (const job of jobs) {
    if (job.status === SUCCESS_TERMINAL && job.materialized_at != null) successes += 1;
    else if (FAILURE_TERMINAL.has(job.status)) failures += 1;
    else return "pending";
  }

  const target: "completed" | "partially_completed" | "failed" =
    failures === 0 ? "completed" : successes > 0 ? "partially_completed" : "failed";
  await transitionCreativePlan(sql, {
    organizationId: ref.organizationId,
    brandId: ref.brandId,
    planId: ref.planId,
    actorId: ref.actorId,
    target,
    reason: "Plan settled from durable production job outcomes.",
  });
  return target;
}

export type CarouselSettlement = "pending" | "completed" | "incomplete" | "unchanged";

/**
 * Settles a carousel parent from its slides (P4b-3). The slides are the carousel: each is an image job with this parent and
 * its position in `sequence_index`. The parent completes only when every expected slide is materialized, and it becomes
 * incomplete when a slide fails or the run is interrupted before every slide exists. An incomplete carousel creates no
 * carousel creative, and the slides that did complete keep their own creatives and assets. Slides are always read in
 * `sequence_index` order, never in completion or creation order. Idempotent: a settled parent is returned unchanged.
 */
export async function settleCarouselParent(
  sql: Sql,
  ref: ProductionJobRef,
  options: { interrupted?: boolean } = {},
): Promise<CarouselSettlement> {
  const parents = await sql<{ id: string; status: string; input: unknown; creative_plan_id: string | null; modality: string }>`
    select id, status, input, creative_plan_id, modality from production_jobs
    where id = ${ref.productionJobId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
    limit 1
  `;
  const parent = parents[0];
  if (!parent) throw new Error("Carousel job was not found in this tenant.");
  if (parent.modality !== "carousel") throw new Error(`Production job '${parent.id}' is a ${parent.modality} job, not a carousel.`);
  if (parent.status !== "SUBMITTING") return "unchanged";

  const expected = Number(parseJson(parent.input).slideCount);
  if (!Number.isInteger(expected) || expected < 1) throw new Error("Carousel job has no slide count; refusing to settle it.");

  const children = await sql<{
    id: string;
    status: string;
    sequence_index: number | null;
    materialized_at: unknown;
    materialized_creative_id: string | null;
  }>`
    select id, status, sequence_index, materialized_at, materialized_creative_id from production_jobs
    where parent_job_id = ${parent.id} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
    order by sequence_index asc, id asc
  `;
  const done = (child: (typeof children)[number]) => child.status === SUCCESS_TERMINAL && child.materialized_at != null;
  const failed = (child: (typeof children)[number]) => FAILURE_TERMINAL.has(child.status);

  // A slide that is still running, ambiguous, or completed but not yet materialized keeps the carousel pending.
  if (children.some((child) => !done(child) && !failed(child))) return "pending";

  const failedSlides = children.filter(failed).map((child) => child.sequence_index);
  const missing = children.length < expected;
  // While the run is still creating slides, a failed slide does not decide the carousel: later slides may yet complete.
  if (missing && !options.interrupted) return "pending";
  if (failedSlides.length > 0 || missing) {
    const reason = failedSlides.length > 0
      ? `Slides ${failedSlides.map((index) => (index ?? 0) + 1).join(", ")} did not complete.`
      : "The run stopped before every slide was created.";
    await sql`
      update production_jobs
      set status = 'FAILED', error_code = 'CAROUSEL_INCOMPLETE', error_message = ${reason},
          output = ${JSON.stringify({ completedSlides: children.filter(done).map((child) => child.sequence_index) })},
          updated_at = now()
      where id = ${parent.id} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId} and status = 'SUBMITTING'
    `;
    return "incomplete";
  }
  // Every slide is materialized. The carousel references them in order and is judged by its slides, not separately.
  if (!parent.creative_plan_id) throw new Error("Carousel job belongs to no CreativePlan; refusing to materialize it.");
  const lineage = await loadPlanLineage(sql, ref, parent.creative_plan_id);
  const slideRows: Array<{ index: number; jobId: string; creativeId: string; assetId: string; status: string; rawText: string }> = [];
  for (const child of children) {
    const creativeId = child.materialized_creative_id;
    if (!creativeId) throw new Error(`Carousel slide '${child.id}' has no creative; refusing to materialize the carousel.`);
    const rows = await sql<{ status: string; raw_text: string }>`
      select status, raw_text from creative_records
      where id = ${creativeId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
      limit 1
    `;
    if (!rows[0]) throw new Error(`Carousel slide creative '${creativeId}' was not found in this tenant.`);
    slideRows.push({
      index: child.sequence_index ?? slideRows.length,
      jobId: child.id,
      creativeId,
      assetId: `image-asset-${child.id}`,
      status: rows[0].status,
      rawText: rows[0].raw_text,
    });
  }

  const carouselCreativeId = `carousel-creative-${parent.id}`;
  const status = slideRows.some((slide) => slide.status === "rejected") ? "rejected" : "in_review";
  const slides = slideRows.map((slide) => ({ index: slide.index, jobId: slide.jobId, creativeId: slide.creativeId, assetId: slide.assetId }));
  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
      message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
    ) values (
      ${carouselCreativeId}, ${ref.organizationId}, ${ref.brandId}, 'generated',
      ${lineage.planTitle ? `${lineage.planTitle} carousel` : "Carousel"}, ${slideRows.map((slide) => slide.rawText).join("\n\n")},
      '', '', '', '', '', '', 'carousel', '', ${lineage.opportunityId}, ${lineage.briefId}, ${status}, ${lineage.approvedBy},
      ${JSON.stringify({
        kind: "carousel",
        productionJobId: parent.id,
        jevDecisionId: lineage.decisionId,
        planId: parent.creative_plan_id,
        slides,
      })}
    )
    on conflict (id) do nothing
  `;
  if (status === "in_review") {
    await openProductionReview(sql, {
      organizationId: ref.organizationId,
      brandId: ref.brandId,
      creativeId: carouselCreativeId,
      decisionId: lineage.decisionId,
      subjectLabel: "Carousel",
    });
  }
  await sql`
    update production_jobs
    set status = 'COMPLETED', materialized_creative_id = ${carouselCreativeId},
        materialized_at = coalesce(materialized_at, now()), output = ${JSON.stringify({ slides })},
        error_code = null, error_message = null, updated_at = now()
    where id = ${parent.id} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId} and status = 'SUBMITTING'
  `;
  return "completed";
}
