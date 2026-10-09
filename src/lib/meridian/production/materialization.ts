/**
 * Shared, idempotent materialization of completed production artifacts.
 *
 * Both the synchronous Studio path and the asynchronous poller call these functions, so the
 * creative, asset, review, and reservation rows for a video are written in exactly one place.
 *
 * Every row id is derived from the production job id. Each insert is `on conflict do nothing`,
 * so a crash between inserts, a duplicate poll, or two pollers racing on one job cannot create a
 * second creative, asset, or review. Creatives always enter review as `in_review`: nothing here
 * approves an artifact automatically.
 */
import type { Sql } from "../learning/store.ts";
import { transitionCreativePlan } from "../creative/state-transition.server.ts";
import { BudgetLedgerService } from "../security/budget-ledger.ts";
import type { CreativeSpec } from "./types.ts";

export const ESTIMATOR_VERSION = "creative-plan-estimate-v1";

export interface ProductionJobRef {
  organizationId: string;
  brandId: string;
  productionJobId: string;
}

export interface MaterializedVideo {
  creativeId: string;
  assetId: string;
  decisionId: string;
  creativePlanId: string | null;
  alreadyMaterialized: boolean;
}

interface ManifestLike {
  brand?: { product?: string };
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

/**
 * Creates the creative, asset, and materialization marker for a COMPLETED production job.
 * Requires the job's artifact to be verified in storage. Safe to call again at any time.
 */
export async function materializeVideoArtifact(sql: Sql, ref: ProductionJobRef): Promise<MaterializedVideo> {
  const jobs = await sql<{
    id: string;
    status: string;
    artifact_id: string | null;
    input: unknown;
    materialized_at: unknown;
    creative_plan_id: string | null;
    provider: string;
  }>`
    select id, status, artifact_id, input, materialized_at, creative_plan_id, provider
    from production_jobs
    where id = ${ref.productionJobId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
    limit 1
  `;
  const job = jobs[0];
  if (!job) throw new Error("Production job was not found in this tenant.");
  if (job.status !== "COMPLETED" || !job.artifact_id) {
    throw new Error(`Production job '${job.id}' has no completed artifact to materialize (status ${job.status}).`);
  }

  const input = parseJson(job.input);
  const runId = text(input.runId);
  const briefId = text(input.briefId);
  const deliverableId = text(input.planDeliverableId);
  const spec = (input.creativeSpec ?? null) as CreativeSpec | null;
  const manifest = (input.manifest ?? {}) as ManifestLike;
  if (!runId || !briefId || !spec) throw new Error("Production job input is incomplete; the artifact cannot be materialized.");

  // The artifact row is the authority for bytes: refuse anything that is not a verified video.
  const artifacts = await sql<{ name: string; sha256: string; size_bytes: string | number | bigint; mime_type: string }>`
    select name, sha256, size_bytes, mime_type from storage_objects
    where id = ${job.artifact_id} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
    limit 1
  `;
  const artifact = artifacts[0];
  if (!artifact) throw new Error("Completed artifact has no storage record; refusing to materialize.");
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error("Stored artifact has no valid SHA-256; refusing to materialize.");
  if (BigInt(artifact.size_bytes) <= 0n) throw new Error("Stored artifact is empty; refusing to materialize.");
  if (!artifact.mime_type.startsWith("video/")) throw new Error(`Stored artifact is '${artifact.mime_type}', not video.`);

  const briefs = await sql<{ id: string; title: string; opportunity_id: string | null; decision_id: string | null; created_by: string }>`
    select id, title, opportunity_id, decision_id, created_by from briefs
    where id = ${briefId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
    limit 1
  `;
  const brief = briefs[0];
  if (!brief) throw new Error("Brief for this production job was not found in this tenant.");
  // A review is only meaningful with the JEV decision that authorized the brief.
  if (!brief.decision_id) throw new Error("Brief has no JEV decision; refusing to create a review without lineage.");

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
      ${creativeId}, ${ref.organizationId}, ${ref.brandId}, 'generated', ${`${brief.title} video`},
      ${`${product}. ${text(spec.script)}`}, ${product}, ${text(spec.hookLine) || text(manifest.hook?.text)},
      ${text(manifest.hook?.type)}, ${text(manifest.concept?.mechanism)},
      ${text(spec.script)}, '', ${text(spec.format)}, '', ${brief.opportunity_id}, ${brief.id}, 'in_review', ${brief.created_by},
      ${JSON.stringify({
        generationRunId: runId,
        provider: job.provider,
        productionJobId: job.id,
        jevDecisionId: brief.decision_id,
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
      ${artifact.mime_type}, ${job.provider}, 'stored', 'qa_required', ${artifact.sha256}, ${width}, ${height},
      ${Number(artifact.size_bytes)}, ${durationMs}, ${job.provider}, ${text(spec.modelId)}, 'studio_video_v1', ${runId},
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
    creativeId,
    assetId,
    decisionId: brief.decision_id,
    creativePlanId: job.creative_plan_id,
    alreadyMaterialized: job.materialized_at != null,
  };
}

/** Puts the review for a materialized creative in the human queue. Idempotent. */
export async function openVideoReview(
  sql: Sql,
  ref: { organizationId: string; brandId: string; creativeId: string; decisionId: string },
): Promise<void> {
  await sql`
    insert into reviews (id, organization_id, brand_id, decision_id, creative_id, subject_label)
    values (${`review-${ref.creativeId}`}, ${ref.organizationId}, ${ref.brandId}, ${ref.decisionId}, ${ref.creativeId}, 'Video')
    on conflict (id) do nothing
  `;
}

/**
 * Settles the budget reservation held for one production job against its estimate. Runs only
 * after the artifact is materialized. Reservations for failed or ambiguous jobs are never settled here.
 */
export async function settleVideoReservation(sql: Sql, ref: ProductionJobRef): Promise<boolean> {
  const rows = await sql<{ id: string; amount_micros: string | number | bigint }>`
    select id, amount_micros from budget_reservations
    where production_job_id = ${ref.productionJobId}
      and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
      and status = 'RESERVED'
    limit 1
  `;
  const reservation = rows[0];
  if (!reservation) return false;
  await BudgetLedgerService.reconcile(sql, {
    reservationId: reservation.id,
    cost: { basis: "ESTIMATED", amountMicros: BigInt(reservation.amount_micros), estimatorVersion: ESTIMATOR_VERSION },
  });
  return true;
}

/** Materializes a completed job and settles its reservation. Used by both completion paths. */
export async function completeVideoJob(sql: Sql, ref: ProductionJobRef): Promise<MaterializedVideo> {
  const materialized = await materializeVideoArtifact(sql, ref);
  await settleVideoReservation(sql, ref);
  return materialized;
}

export type PlanSettlement = "pending" | "completed" | "partially_completed" | "failed" | "unchanged";

const SUCCESS_TERMINAL = "COMPLETED";
const FAILURE_TERMINAL = new Set(["FAILED", "POSTFLIGHT_FAILED", "PREFLIGHT_FAILED", "NOT_CONFIGURED", "CANCELLED"]);

/**
 * Completes a CreativePlan only when every production job it created has a deterministic
 * terminal outcome. A job is successful only when its artifact is materialized. Ambiguous or
 * retryable states (queued, submission unknown, storage retry, unmaterialized) keep the plan
 * executing. Transitions go through the authoritative state service.
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
