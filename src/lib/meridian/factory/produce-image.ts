/**
 * The image path of the Produce stage (NORTH_STAR section 8, item 6). One image is one durable job: its row and its budget reservation
 * exist before the provider is called, the provider is called once, and the bytes are stored, judged and recorded by the materializer
 * Studio uses. A carousel slide is an image job too, with the carousel's parent job and its slide position. Its creative is linked
 * under the carousel format with its slide index.
 *
 * The job id and the reservation rules are the ones the image path always had, so an image made before this module existed is found,
 * linked and left as it is.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { finalizeProductionArtifact } from "../production/artifact-finalizer.ts";
import { productionRouter } from "../production/router.ts";
import type { ImageGenerationOutcome, ProductionImageProvider } from "../production/image-providers.ts";
import type { CreativeSpec } from "../production/types.ts";
import { BudgetLedgerService, toMicros } from "../security/budget-ledger.ts";
import type { CreativePlan } from "../creative/plan.ts";
import { qcBrandOf } from "../studio/image-qc.server.ts";
import {
  capStopOf,
  errorText,
  insertJobWithReservation,
  linkCreative,
  markJob,
  materialize,
  reportedCents,
  type ProduceInput,
  type Scope,
  type Step,
  type VariantRow,
} from "./produce-shared.ts";
import { settleProductionReservation } from "../production/materialization.ts";

/**
 * The guard reserved against one image before its provider call, in USD. It is a ceiling, not a price: no image price is declared for
 * the providers, and a provider that reports no cost settles at this ceiling (unpriced-ceiling-v1). It is the same guard the Studio
 * attach uses. It is an operator value to confirm.
 */
export const FACTORY_IMAGE_CEILING_USD = 1;

/** The version of the image prompt this stage writes. It is recorded on each asset. */
export const PROMPT_VERSION = "factory-image-v1";

export type ImageRequest = {
  variant: VariantRow;
  plan: CreativePlan;
  /** The production job id. An image's is factory-<variant>-image, so an image made before this module keeps its id. */
  jobId: string;
  /** The format the creative is linked under: "image" for a single image, "carousel" for a slide. */
  format: "image" | "carousel";
  /** -1 for a single image. A slide's position in its carousel, from 0. */
  slideIndex: number;
  /** The creative's sequence: the variant's position for an image, the slide's position for a slide. */
  sequenceIndex: number;
  copy: string;
  label: string;
  productName: string;
  hook: string;
  angle: string;
  /** The carousel's parent job, for a slide. Null for a single image. */
  parentJobId: string | null;
  deliverableKind: "image" | "carousel_slide";
  planDeliverableId: string;
  qcBrand: ReturnType<typeof qcBrandOf>;
};

/**
 * Produces one image or one carousel slide. A job that already exists is finished from what is stored, or left for a person to see
 * when it failed. A new job is chosen, reserved, called once, stored and recorded.
 */
export async function produceImage(sql: Sql, input: ProduceInput, req: ImageRequest): Promise<Step> {
  const scope: Scope = { organizationId: input.organizationId, brandId: input.brandId };
  const { variant, plan, jobId } = req;
  const link = (creativeId: string, provider: string) =>
    linkCreative(sql, scope, {
      runId: input.runId,
      variantId: variant.id,
      format: req.format,
      slideIndex: req.slideIndex,
      creativeId,
      jobId,
      provider,
    });

  const existing = await sql<{ status: string; provider: string; materialized_creative_id: string | null }>`
    select status, provider, materialized_creative_id from production_jobs
    where id = ${jobId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
    limit 1
  `;
  if (existing[0]) {
    // The job exists from an earlier run of this stage. A job whose creative is recorded is linked. A job that completed and was not
    // recorded is finished. Any other job is held or failed, and is left for a person to see on the Factory screen.
    if (existing[0].materialized_creative_id) {
      await link(existing[0].materialized_creative_id, existing[0].provider);
      return { kind: "linked" };
    }
    if (existing[0].status === "COMPLETED") {
      const made = await materialize(sql, input, jobId);
      if ("reason" in made) return { kind: "stop", reason: made.reason };
      await link(made.creativeId, existing[0].provider);
      return { kind: "linked" };
    }
    return { kind: "skipped" };
  }

  // The caps are checked before a provider call, against the metered spend recorded so far.
  const reached = await capStopOf(sql, input, scope);
  if (reached) return { kind: "stop", reason: reached };

  const { productName, copy } = req;
  const baseSpec: CreativeSpec = {
    id: jobId,
    organizationId: scope.organizationId,
    brandId: scope.brandId,
    title: req.label,
    modality: "image",
    format: "single_image",
    aspectRatio: "1:1",
    durationTargetSeconds: 0,
    hookLine: req.hook,
    script: copy,
    scenes: [],
    idempotencyKey: jobId,
  };
  // A named provider is checked first. A provider that is not configured, or not connected, is refused with its reason, and no
  // reservation or call follows. A provider whose cost is unknown is never used: its spend cannot be counted against a cap, so a capped
  // run could overrun it, and an uncapped run has no bound at all. The run stops with the reason until the provider has a price.
  const requested = input.providers[req.format] ?? "auto";
  let selected: Awaited<ReturnType<typeof productionRouter.selectImageForSpec>>;
  try {
    selected = await productionRouter.selectImageForSpec(baseSpec, { requestedProvider: requested, allowUnknownCost: false });
  } catch (error) {
    return { kind: "stop", reason: errorText(error) };
  }
  const chosen: ProductionImageProvider = selected.provider;
  const modelId = selected.selection.chosen?.modelId ?? "";
  const creativeSpec: CreativeSpec = { ...baseSpec, providerId: chosen.id, modelId };
  const prompt = [productName, req.angle ? `Angle: ${req.angle}.` : "", copy].filter(Boolean).join(" ");
  const jobInput = {
    kind: "factory_image",
    runId: input.runId,
    factoryVariantId: variant.id,
    prompt,
    copy,
    productName,
    format: "single_image",
    itemLabel: req.label,
    sequenceIndex: req.sequenceIndex,
    manifest: { brand: { product: productName }, hook: { type: variant.hook }, concept: { mechanism: plan.selectedConceptId ?? "" } },
    creativeSpec,
    qcBrand: req.qcBrand,
    deliverableKind: req.deliverableKind,
    planDeliverableId: req.planDeliverableId,
    promptVersion: PROMPT_VERSION,
  };

  // The job row and its reservation are written together. A budget that cannot cover the reservation refuses it, the job row rolls back
  // with it, and no provider is called.
  let reservationId: string;
  try {
    reservationId = await insertJobWithReservation(sql, {
      organizationId: scope.organizationId,
      brandId: scope.brandId,
      jobId,
      amountMicros: toMicros(FACTORY_IMAGE_CEILING_USD),
      insertJob: async (tx) => {
        await tx`
          insert into production_jobs (
            id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
            status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, next_poll_at, modality, cost_status,
            creative_plan_id, sequence_index, parent_job_id
          ) values (
            ${jobId}, ${scope.organizationId}, ${scope.brandId}, ${chosen.id}, null, null, null, null,
            'SUBMITTING', 'BALANCED', null, ${JSON.stringify(jobInput)}, now(), null, now(), now() + interval '5 minutes', 'image', 'unknown',
            ${plan.id}, ${req.parentJobId ? req.sequenceIndex : null}, ${req.parentJobId}
          )
        `;
      },
    });
  } catch (error) {
    return { kind: "stop", reason: `The brand's budget cannot cover the next image, so no provider was called. ${errorText(error)}` };
  }

  // The provider is called once. A thrown call may have reached the provider, so its reservation is held for a person.
  const amount = `$${FACTORY_IMAGE_CEILING_USD.toFixed(2)}`;
  let outcome: ImageGenerationOutcome;
  try {
    outcome = await chosen.generate({
      prompt,
      seed: jobId,
      promptVersion: PROMPT_VERSION,
      model: modelId,
      aspectRatio: "1:1",
      organizationId: scope.organizationId,
    });
  } catch (error) {
    const message = errorText(error);
    await markJob(sql, scope, jobId, "SUBMISSION_UNKNOWN", "PROVIDER_CALL_AMBIGUOUS", message);
    return {
      kind: "stop",
      reason: `The ${chosen.id} call did not return, so its outcome is unknown. The ${amount} reserved for it is held until the provider confirms it holds no job for the submission, or an admin resolves it. ${message}`,
    };
  }
  if (outcome.status === "NOT_CONNECTED") {
    // The provider made no request, so nothing was billed and the reservation is released. The run stops: the provider is not ready.
    await markJob(sql, scope, jobId, "FAILED", "NOT_CONNECTED", outcome.error);
    await BudgetLedgerService.release(sql, { reservationId, reason: outcome.error });
    return { kind: "stop", reason: outcome.error };
  }
  if (outcome.status === "failed") {
    // The call returned a failure, so it is over, and its reservation is released.
    await markJob(sql, scope, jobId, "FAILED", "PROVIDER_CALL_FAILED", outcome.error);
    await BudgetLedgerService.release(sql, { reservationId, reason: outcome.error });
    return { kind: "failed" };
  }

  // The provider returned an image. If it reported a cost, the reservation settles at that cost and the cost is written as a metered
  // row. If it reported none, nothing is written, and the reservation settles at its ceiling when the creative is recorded.
  const reported = reportedCents(outcome.costCents);
  if (reported !== null) {
    await BudgetLedgerService.reconcile(sql, {
      reservationId,
      cost: { basis: "PROVIDER_ACTUAL", amountMicros: BigInt(Math.round(reported * 10_000)) },
    });
    await sql`
      insert into factory_costs (id, organization_id, brand_id, run_id, stage, cents, seconds, provider, production_job_id, basis, created_at)
      values (${randomUUID()}, ${scope.organizationId}, ${scope.brandId}, ${input.runId}, 'factory.produce', ${Math.round(reported)}, 0,
        ${chosen.id}, ${jobId}, 'provider_reported', now())
    `;
  }
  await sql`
    update production_jobs
    set output = ${JSON.stringify({
      width: outcome.width,
      height: outcome.height,
      mediaType: outcome.mediaType,
      promptVersion: outcome.promptVersion,
      model: outcome.model,
      provider: outcome.provider,
    })}, updated_at = now()
    where id = ${jobId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
  `;
  const stored = await finalizeProductionArtifact(sql, {
    jobId,
    organizationId: scope.organizationId,
    brandId: scope.brandId,
    provider: outcome.provider,
    rawArtifact: { bytes: outcome.bytes, mimeType: outcome.mediaType },
    options: input.driveClient ? { driveClient: input.driveClient } : undefined,
  });
  if (!stored.success || !stored.artifactId || !stored.storageKey || !stored.sha256 || stored.byteSize === undefined) {
    // The provider made the image, so the spend happened. The reservation settles, and the job says why it was not stored.
    const reason = stored.error ?? "The image could not be stored.";
    await markJob(sql, scope, jobId, "FAILED", stored.errorCode ?? "STORAGE_PERSISTENCE_FAILED", reason);
    await settleProductionReservation(sql, { organizationId: scope.organizationId, brandId: scope.brandId, productionJobId: jobId });
    return { kind: "stop", reason: `The image was generated, but it was not stored. ${reason}` };
  }

  const made = await materialize(sql, input, jobId);
  if ("reason" in made) return { kind: "stop", reason: made.reason };
  await link(made.creativeId, chosen.id);
  return { kind: "linked" };
}
