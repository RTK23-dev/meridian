// Executing an approved creative plan, with its budget reservations and the helpers it uses. Moved out of
// studio/session.server.ts unchanged (coding loop, T4). studio/session.server.ts re-exports the public names.

import { resolveImageSupport } from "../decisions/capabilities.ts";
import type { Role } from "../access.ts";
import { loadBrandContext } from "../context/load.ts";
import { assertSameTenant } from "../domain.ts";
import type { Sql } from "../learning/store.ts";
import { generationAllowed } from "../security/budget.ts";
import { evaluateJevGate } from "../jev/reviewer-decision.ts";
import { STUDIO_PROMPT_VERSION, variantPrompt } from "./media-work.ts";
import { productionRouter, type ImageProviderSelection } from "../production/router.ts";
import { productionCostMode } from "../production/cost-mode.ts";
import { semanticNearest } from "../embeddings/store.ts";
import { assessPublishing } from "../publishing/readiness.ts";
import type { CreativePlan } from "../creative/plan.ts";
import { finalizeProductionArtifact } from "../production/artifact-finalizer.ts";
import { BudgetLedgerService, InvalidBudgetCapError, toMicros } from "../security/budget-ledger.ts";
import { modelCapabilityRegistry } from "../production/registry.ts";
import { completeProductionJob, ESTIMATOR_VERSION, openProductionReview, settleCreativePlanIfComplete, settleCarouselParent, settleProductionReservation } from "../production/materialization.ts";
import type { ImageGenerationOutcome } from "../production/image-providers.ts";
import type { CreativeSpec } from "../production/types.ts";
import { creativeSpecFromManifest } from "../production/spec-from-manifest.ts";
import { resolveProductionTarget } from "../production/target.ts";
import { submitWithPreflight, type SubmitWithPreflightResult } from "../production/submit.ts";
import { transitionCreativePlan } from "../creative/state-transition.server.ts";
import { accountSnapshots, competitorCopy, factsFor, measureVideoFrames, qcBrandOf, sampleVideoForJudgment, videoVisualEvidence, writeJudgment } from "./image-qc.server.ts";
import { resolveActiveEngine } from "../decisions/selection.ts";
import { perceptionReadiness, selectPerceptionProvider } from "../perception/run.ts";
import { asJson, asNumber, asText, loadSession } from "./session-load.server.ts";
import { loadGatedJevDecision } from "./session-jev.server.ts";

/**
 * Budget reservation shares for an approved plan, keyed by deliverable id. Fails closed.
 *
 * Priced deliverables reserve their known estimate, and those estimates must add up to the plan's known total (to within
 * one cent of rounding). An unpriced deliverable (no declared price, such as an image) has no estimate to reserve, so it
 * reserves an equal share of the plan's explicit spend cap, the most it can cost, and is settled at that ceiling because
 * its actual provider cost is not known. A plan with an unpriced deliverable and no cap is refused. A plan with no
 * priced and no unpriced cost reserves nothing only when every deliverable's model is registered as free of charge.
 */
function planReservationShares(plan: CreativePlan): Map<string, bigint> | null {
  const isFree = (d: CreativePlan["deliverables"][number]) => modelCapabilityRegistry.isEstablishedFree(d.provider, d.model);
  const allFree = plan.deliverables.every(isFree);
  const unpriced = new Set(plan.estimatedCost?.unpricedDeliverableIds ?? []);
  const total = plan.estimatedCost?.totalEstimatedUsd;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    if (allFree) return null;
    throw new InvalidBudgetCapError(
      `Cost estimate is missing or invalid (${String(total)}) for a billable plan. Budget reservation refused; no provider was called.`
    );
  }
  if (total === 0 && unpriced.size === 0) {
    if (allFree) return null;
    throw new InvalidBudgetCapError(
      "Zero cost estimate for a billable provider. Budget reservation refused; no provider was called."
    );
  }
  const perDeliverable = plan.estimatedCost?.perDeliverableUsd ?? {};
  const shares = new Map<string, bigint>();
  let knownSum = 0n;
  for (const deliverable of plan.deliverables) {
    if (unpriced.has(deliverable.id)) continue;
    const raw = perDeliverable[deliverable.id];
    if (raw === undefined && isFree(deliverable)) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      throw new InvalidBudgetCapError(
        `Deliverable '${deliverable.id}' has no valid cost estimate. Budget reservation refused; no provider was called.`
      );
    }
    const micros = toMicros(raw);
    knownSum += micros;
    if (micros > 0n) shares.set(deliverable.id, micros);
  }
  const knownTotalMicros = toMicros(total);
  const drift = knownSum > knownTotalMicros ? knownSum - knownTotalMicros : knownTotalMicros - knownSum;
  if (drift > 10_000n) {
    throw new InvalidBudgetCapError(
      "Per-deliverable estimates do not add up to the plan estimate. Budget reservation refused; no provider was called."
    );
  }
  if (unpriced.size > 0) {
    const cap = plan.estimatedCost?.maxSpendUsd;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
      throw new InvalidBudgetCapError(
        `Deliverables with no known price (${[...unpriced].join(", ")}) need an explicit plan spend cap. Budget reservation refused; no provider was called.`
      );
    }
    const remaining = toMicros(cap) - knownTotalMicros;
    const each = remaining / BigInt(unpriced.size);
    if (each <= 0n) {
      throw new InvalidBudgetCapError(
        "The plan spend cap leaves nothing for deliverables with no known price. Budget reservation refused; no provider was called."
      );
    }
    for (const deliverable of plan.deliverables) {
      if (unpriced.has(deliverable.id)) shares.set(deliverable.id, each);
    }
  }
  return shares;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Marks an image job whose provider outcome is unknown. Its reservation stays held for reconciliation, and it is never resubmitted. */

async function markImageJobUnknown(sql: Sql, jobId: string, organizationId: string, brandId: string, code: string, message: string) {
  await sql`
    update production_jobs set status = 'SUBMISSION_UNKNOWN', error_code = ${code}, error_message = ${message}, updated_at = now()
    where id = ${jobId} and organization_id = ${organizationId} and brand_id = ${brandId}
  `;
}

/** Inserts the durable row for one image job. The first snapshot for an id stands: a conflicting insert is ignored. */

async function insertImageJobRow(sql: Sql, row: {
  id: string;
  organizationId: string;
  brandId: string;
  providerId: string;
  status: "SUBMITTING" | "FAILED";
  creativePlanId: string;
  sequenceIndex: number;
  /** The carousel this slide belongs to, or null for a single image. */
  parentJobId: string | null;
  costStatus: string | null;
  /** Null when the cost is unknown. A zero here would be an invented price. */
  estimateCents: number | null;
  input: string;
  errorCode?: string;
  errorMessage?: string;
}) {
  await sql`
    insert into production_jobs (
      id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
      status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id,
      modality, sequence_index, parent_job_id, cost_status, error_code, error_message
    ) values (
      ${row.id}, ${row.organizationId}, ${row.brandId}, ${row.providerId}, null, null, null, null,
      ${row.status}, 'BALANCED', ${row.estimateCents}, ${row.input}, now(), null, now(), ${row.creativePlanId},
      'image', ${row.sequenceIndex}, ${row.parentJobId}, ${row.costStatus}, ${row.errorCode ?? null}, ${row.errorMessage ?? null}
    )
    on conflict (id) do nothing
  `;
}

/** Releases every reservation that no provider submission can be holding. Held ones stay for reconciliation. */

async function releaseUnheldReservations(
  sql: Sql,
  reservations: Map<string, { id: string; held: boolean }>,
  reason: string,
) {
  for (const reservation of reservations.values()) {
    if (reservation.held) continue;
    await BudgetLedgerService.release(sql, { reservationId: reservation.id, reason }).catch(() => {});
  }
}

export async function executeApprovedCreativePlan(
  sql: Sql,
  access: { organizationId: string; role: Role },
  userId: string,
  creativePlan: CreativePlan,
) {
  // P3c: production runs on the plan row and its snapshot. The brief row is never read here, so an edit to it cannot
  // change what the plan produces. The brief id is kept only as a reference, and its status is updated by id.
  const persistedPlan = await sql<{ status: string; brand_id: string; decision_id: string | null; brief_id: string | null }>`
    select status, brand_id, decision_id, brief_id from creative_plans
    where id = ${creativePlan.id} and organization_id = ${access.organizationId}
    limit 1
  `;
  const planRow = persistedPlan[0];
  if (planRow?.status !== "executing") {
    throw new Error("CreativePlan must be durably approved and executing before provider calls.");
  }
  const brandId = planRow.brand_id;
  const briefId = planRow.brief_id ?? "";
  const decisionId = planRow.decision_id ?? "";
  const context = creativePlan.productionContext;
  // M2 and P3c: the gate runs on the decision the plan recorded, before any reservation or provider call. A refusal
  // closes the plan as failed.
  try {
    if (!context) throw new Error("CreativePlan has no production context; refusing to execute it. Re-plan from the brief.");
    await loadGatedJevDecision(sql, access.organizationId, brandId, decisionId, "plan");
  } catch (gateErr) {
    await transitionCreativePlan(sql, {
      organizationId: access.organizationId,
      brandId,
      planId: creativePlan.id,
      actorId: userId,
      target: "failed",
      reason: "JEV gate refused production before provider submission.",
    }).catch(() => {});
    throw gateErr;
  }

  const loaded = await loadBrandContext(sql, access.organizationId, brandId);
  assertSameTenant(loaded.creatives, access.organizationId, brandId);
  const productName = context.productName;

  // Derive concrete creation mode and beats from creativePlan.deliverables
  const hasVideo = creativePlan.deliverables.some((d) => d.kind === "video");
  const hasCarousel = creativePlan.deliverables.some((d) => d.kind === "carousel_slide");
  const hasImage = creativePlan.deliverables.some((d) => d.kind === "image");

  let mode: import("../factory/creative-manifest.ts").CreationMode;
  if (creativePlan.deliverables.length === 0 || creativePlan.scope === "research_only") {
    mode = "research_only";
  } else if ((hasVideo && (hasImage || hasCarousel)) || (hasCarousel && hasImage)) {
    mode = "mixed_format";
  } else if (hasVideo) {
    mode = "video";
  } else if (hasCarousel) {
    mode = "carousel";
  } else {
    mode = "image_ad";
  }

  const { validateCreationPlan, buildCreativeManifest, manifestFromCreativePlan } = await import("../factory/creative-manifest.ts");

  const deliverableManifests = creativePlan.deliverables.map((d) =>
    manifestFromCreativePlan(creativePlan, d, {
      organizationId: access.organizationId,
      brandId,
      productName,
      audience: context.audience,
    })
  );

  let beats: import("../factory/creative-manifest.ts").CreativeManifestBeat[] = [];
  let targetDurationSeconds: number | undefined;
  const slideCount = creativePlan.deliverables.filter((d) => d.kind === "carousel_slide").length || undefined;

  if (mode === "research_only") {
    targetDurationSeconds = undefined;
    beats = [];
  } else if (deliverableManifests.length > 0) {
    beats = deliverableManifests.flatMap((m) => m.beats);
    targetDurationSeconds = creativePlan.deliverables.find((d) => d.targetDurationSeconds)?.targetDurationSeconds || (hasVideo ? 8 : undefined);
  } else {
    targetDurationSeconds = undefined;
    beats = [];
  }

  const plan = validateCreationPlan({
    mode,
    startingMaterial: "new_brief",
    productionStrategy: "automated_provider",
    slideCount,
    beats,
  });

  if (!plan.valid) {
    throw new Error(`Creative plan invalid: ${plan.reason}`);
  }

  const rawRatio = creativePlan.deliverables[0]?.aspectRatio || "9:16";
  const aspectRatio: "9:16" | "16:9" | "1:1" | "4:5" = (rawRatio === "16:9" || rawRatio === "1:1" || rawRatio === "4:5") ? rawRatio : "9:16";
  const manifest = buildCreativeManifest({
    creativeId: crypto.randomUUID(),
    conceptId: context.opportunityId || creativePlan.id,
    mode,
    startingMaterial: "new_brief",
    productionStrategy: "automated_provider",
    brand: {
      organizationId: access.organizationId,
      brandId,
      product: productName,
      audience: context.audience,
      objective: context.angle,
    },
    format: {
      channel: "multi_channel",
      aspectRatio,
      targetDurationSeconds,
      slideCount,
    },
    beats,
  });

  if (!plan.willCreateProductionJob || mode === "research_only" || creativePlan.scope === "research_only" || creativePlan.deliverables.length === 0) {
    await sql`
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (
        ${crypto.randomUUID()}, ${access.organizationId}, ${brandId}, ${userId},
        'studio.research_manifest_created', 'brief', ${briefId},
        ${JSON.stringify({ manifestId: manifest.creativeId, mode: manifest.mode, beats: manifest.beats.length, planId: creativePlan.id })}
      )
    `;
    await sql`update briefs set status = 'used' where id = ${briefId} and organization_id = ${access.organizationId} and brand_id = ${brandId}`;
    await transitionCreativePlan(sql, {
      organizationId: access.organizationId, brandId, planId: creativePlan.id, actorId: userId,
      target: "executing", reason: "Approved research manifest is being finalized.",
    });
    await transitionCreativePlan(sql, {
      organizationId: access.organizationId, brandId, planId: creativePlan.id, actorId: userId,
      target: "completed", reason: "Research-only manifest completed without production jobs.",
    });
    return loadSession(sql, access.organizationId, brandId, access.role);
  }

  const usage = await sql<{ runs_today: number; running: number; brand_runs_today: number; brand_running: number }>`
    select
      count(*) filter (where created_at > now() - interval '1 day' and status in ('running', 'completed'))::int as runs_today,
      count(*) filter (where status = 'running')::int as running,
      count(*) filter (where brand_id = ${brandId} and created_at > now() - interval '1 day' and status in ('running', 'completed'))::int as brand_runs_today,
      count(*) filter (where brand_id = ${brandId} and status = 'running')::int as brand_running
    from generation_runs
    where organization_id = ${access.organizationId}
  `;
  const orgGate = generationAllowed({
    runsToday: asNumber(usage[0]?.runs_today),
    running: asNumber(usage[0]?.running),
  });
  const brandGate = generationAllowed({
    runsToday: asNumber(usage[0]?.brand_runs_today),
    running: asNumber(usage[0]?.brand_running),
  });
  const blocked = !orgGate.allowed ? orgGate : !brandGate.allowed ? brandGate : null;
  if (blocked) {
    await sql`
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (
        ${crypto.randomUUID()}, ${access.organizationId}, ${brandId}, ${userId},
        'generation.blocked', 'brand', ${brandId},
        ${JSON.stringify({ reason: blocked.reason, estimatedCostCents: blocked.estimatedCostCents })}
      )
    `;
    throw new Error(blocked.reason);
  }

  // One reservation per deliverable that carries spend. Each video reservation is linked to its
  // production job id before any provider call, so its budget line is settled or held per job.
  const reservations = new Map<string, { id: string; amountMicros: bigint; held: boolean }>();
  const productionJobIds = new Map<string, string>();
  // An image job is judged on its own copy. A plan with an image that has no copy is refused before any job or reservation exists.
  if (creativePlan.deliverables.some((d) => (d.kind === "image" || d.kind === "carousel_slide") && !d.copy?.trim())) {
    throw new Error("An image in this plan has no copy to check, so nothing was sent.");
  }
  for (const deliverable of creativePlan.deliverables) {
    if (deliverable.kind === "video" || deliverable.kind === "image" || deliverable.kind === "carousel_slide") {
      productionJobIds.set(deliverable.id, crypto.randomUUID());
    }
  }
  let providerSubmissionUnknown = false;
  try {
    const shares = planReservationShares(creativePlan);
    for (const [deliverableId, amountMicros] of shares ?? []) {
      const reservation = await BudgetLedgerService.reserve(sql, {
        organizationId: access.organizationId,
        brandId,
        amountMicros,
        creativePlanId: creativePlan.id,
        productionJobId: productionJobIds.get(deliverableId),
      });
      reservations.set(deliverableId, { id: reservation.id, amountMicros, held: false });
    }
  } catch (budgetErr) {
    await releaseUnheldReservations(sql, reservations, "Budget reservation failed before provider submission.");
    await transitionCreativePlan(sql, {
      organizationId: access.organizationId,
      brandId,
      planId: creativePlan.id,
      actorId: userId,
      target: "failed",
      reason: "Budget reservation failed before provider submission.",
    }).catch(() => {});
    throw budgetErr;
  }

  const runId = crypto.randomUUID();
  // A carousel is one parent job whose slides are its children. The parent holds no reservation: each slide reserves its own.
  const carouselJobId = creativePlan.deliverables.some((d) => d.kind === "carousel_slide") ? `carousel-job-${creativePlan.id}` : null;
  const firstImgDeliv = creativePlan.deliverables.find((d) => d.kind === "image" || d.kind === "carousel_slide");
  const firstVidDeliv = creativePlan.deliverables.find((d) => d.kind === "video");
  const effectiveImageProvider = firstImgDeliv?.provider || "none";
  const effectiveVideoProvider = firstVidDeliv?.provider || "none";

  await sql`
    insert into generation_runs (
      id, organization_id, brand_id, opportunity_id, brief_id, prompt_version, image_provider, video_provider, status, created_by
    ) values (
      ${runId}, ${access.organizationId}, ${brandId}, ${context.opportunityId}, ${briefId},
      ${STUDIO_PROMPT_VERSION}, ${effectiveImageProvider}, ${effectiveVideoProvider}, 'running', ${userId}
    )
  `;

  try {

    if (carouselJobId) {
      const slideCount = creativePlan.deliverables.filter((d) => d.kind === "carousel_slide").length;
      await sql`
        insert into production_jobs (
          id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
          status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id,
          modality, sequence_index, parent_job_id, cost_status
        ) values (
          ${carouselJobId}, ${access.organizationId}, ${brandId}, 'carousel', null, null, null, null,
          'AWAITING_CHILDREN', 'BALANCED', null, ${JSON.stringify({ kind: "carousel", slideCount, runId, briefId, planDeliverableIds: creativePlan.deliverables.filter((d) => d.kind === "carousel_slide").map((d) => d.id) })},
          now(), null, now(), ${creativePlan.id}, 'carousel', null, null, null
        )
        on conflict (id) do nothing
      `;
    }

    for (const deliv of creativePlan.deliverables) {
      if (deliv.kind === "image" || deliv.kind === "carousel_slide") {
        // Every image is a durable production job with the same lifecycle as video. Its job row and its budget reservation
        // exist before the provider is called, and its bytes are stored and verified before anything is materialized.
        const index = deliv.sequenceIndex ?? 0;
        const delivManifest = deliverableManifests.find((m) => m.deliverableId === deliv.id);
        if (!delivManifest) throw new Error(`CreativePlan deliverable ${deliv.id} has no executable manifest.`);
        const prodJobId = productionJobIds.get(deliv.id);
        if (!prodJobId) throw new Error(`CreativePlan deliverable ${deliv.id} has no production job id.`);
        const promptVersion = `${STUDIO_PROMPT_VERSION}#${deliv.kind}-${index + 1}`;
        const prompt = variantPrompt({
          productName,
          angle: delivManifest.concept?.mechanism || "",
          hook: delivManifest.hook?.text || "",
          audience: delivManifest.brand.audience,
          constraints: creativePlan.constraintsApplied.map((constraint) => `${constraint.constraintName}: ${String(constraint.constraintValue)}`).join("; "),
          index,
          kind: "image",
        });
        const copy = deliv.copy.trim();
        const itemLabel = deliv.kind === "carousel_slide" ? `carousel slide ${index + 1}` : `image ${index + 1}`;
        const imageTarget = resolveProductionTarget({
          provider: delivManifest.production!.provider,
          model: delivManifest.production!.model,
          capability: "IMAGE_GENERATION",
          aspectRatio: delivManifest.format.aspectRatio,
        });
        const reservation = reservations.get(deliv.id);
        // An unpriced image is allowed only because its reservation is bounded by the plan's spend cap (planReservationShares).
        const unpriced = creativePlan.estimatedCost?.unpricedDeliverableIds?.includes(deliv.id) === true;
        const spec: CreativeSpec = {
          id: deliv.id,
          organizationId: access.organizationId,
          brandId,
          title: context.title,
          modality: "image",
          format: deliv.format,
          aspectRatio: delivManifest.format.aspectRatio as CreativeSpec["aspectRatio"],
          // An image has no duration. The matrix reads no duration for an image.
          durationTargetSeconds: 0,
          hookLine: delivManifest.hook?.text || "",
          script: copy,
          scenes: [],
          assetIds: [],
          idempotencyKey: prodJobId,
        };

        let selected: ImageProviderSelection;
        try {
          selected = await productionRouter.selectImageForSpec(spec, { requestedProvider: imageTarget.provider, allowUnknownCost: unpriced });
        } catch (refusal) {
          // Refused before any provider call. The refusal is recorded on the job, and its reservation is released.
          await insertImageJobRow(sql, {
            id: prodJobId, organizationId: access.organizationId, brandId, providerId: imageTarget.provider, status: "FAILED",
            creativePlanId: creativePlan.id, sequenceIndex: index, parentJobId: deliv.kind === "carousel_slide" ? carouselJobId : null, costStatus: null, estimateCents: null,
            input: JSON.stringify({ kind: "image", creativeSpec: spec, runId, briefId, planDeliverableId: deliv.id }),
            errorCode: "SELECTION_REFUSED", errorMessage: errorText(refusal),
          });
          if (reservation && !reservation.held) {
            await BudgetLedgerService.release(sql, { reservationId: reservation.id, reason: "Image was refused before any provider call." }).catch(() => {});
          }
          // An approved provider that cannot produce this deliverable stops the run, as an approved video provider does.
          throw refusal;
        }
        const chosen = selected.selection.chosen!;
        spec.providerId = selected.provider.id;
        spec.modelId = chosen.modelId;
        // The job's snapshot is written once, before the provider call. Materialization reads only this snapshot.
        await insertImageJobRow(sql, {
          id: prodJobId, organizationId: access.organizationId, brandId, providerId: selected.provider.id, status: "SUBMITTING",
          creativePlanId: creativePlan.id, sequenceIndex: index, parentJobId: deliv.kind === "carousel_slide" ? carouselJobId : null, costStatus: chosen.costStatus,
          estimateCents: chosen.estimateUsd === null ? null : Math.round(chosen.estimateUsd * 100),
          input: JSON.stringify({
            kind: "image", creativeSpec: spec, runId, briefId, manifest: delivManifest, planDeliverableId: deliv.id,
            deliverableKind: deliv.kind, sequenceIndex: index, itemLabel, format: deliv.format, prompt, copy, productName,
            promptVersion, providerSelection: selected.selection, qcBrand: qcBrandOf(loaded),
          }),
        });

        // The reservation is held before the call. From here a failure is ambiguous, so the reservation is never released.
        if (reservation) reservation.held = true;
        let outcome: ImageGenerationOutcome;
        try {
          outcome = await selected.provider.generate({
            organizationId: access.organizationId,
            prompt,
            seed: `${runId}:${deliv.kind}:${index}`,
            promptVersion,
            model: chosen.modelId,
            aspectRatio: spec.aspectRatio,
          });
        } catch (callError) {
          providerSubmissionUnknown = true;
          await markImageJobUnknown(sql, prodJobId, access.organizationId, brandId, "PROVIDER_CALL_AMBIGUOUS", errorText(callError));
          throw callError;
        }
        if (outcome.status === "NOT_CONNECTED") {
          // No credentials, so the provider was never called: nothing was submitted and the reservation is released.
          await sql`
            update production_jobs set status = 'FAILED', error_code = 'NOT_CONNECTED', error_message = ${outcome.error}, updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
          if (reservation) {
            reservation.held = false;
            await BudgetLedgerService.release(sql, { reservationId: reservation.id, reason: outcome.error }).catch(() => {});
          }
          continue;
        }
        if (outcome.status === "failed") {
          // The call returned a failure after it may have reached the provider, so no charge can be ruled out. The
          // reservation stays held for reconciliation, and the plan is not completed on this run.
          providerSubmissionUnknown = true;
          await markImageJobUnknown(sql, prodJobId, access.organizationId, brandId, "PROVIDER_CALL_FAILED", outcome.error);
          throw new Error(`Image provider '${outcome.provider}' failed; its reservation is held for reconciliation. ${outcome.error}`);
        }

        const finalized = await finalizeProductionArtifact(sql, {
          jobId: prodJobId,
          organizationId: access.organizationId,
          brandId,
          provider: outcome.provider,
          rawArtifact: { bytes: outcome.bytes, mimeType: outcome.mediaType },
        });
        if (!finalized.success) {
          // The image was generated, so the spend happened. The reservation settles at its reserved amount, and the job
          // records why its artifact was not stored.
          await sql`
            update production_jobs set status = 'FAILED', error_code = ${finalized.errorCode ?? "STORAGE_PERSISTENCE_FAILED"},
              error_message = ${finalized.error ?? "The artifact could not be stored."}, updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
          await settleProductionReservation(sql, { organizationId: access.organizationId, brandId, productionJobId: prodJobId });
          continue;
        }
        await sql`
          update production_jobs set output = ${JSON.stringify({
            width: outcome.width, height: outcome.height, mediaType: outcome.mediaType,
            promptVersion: outcome.promptVersion, model: outcome.model, provider: outcome.provider,
          })}, updated_at = now()
          where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
        `;
        try {
          await completeProductionJob(sql, { organizationId: access.organizationId, brandId, productionJobId: prodJobId }, { openReview: true });
        } catch (materializeError) {
          // The artifact is verified and the job is COMPLETED, so nothing is lost. The poller finishes it from this state.
          await sql`
            update production_jobs set error_message = ${errorText(materializeError)}, next_poll_at = now() + interval '30 seconds', updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
        }
      } else if (deliv.kind === "video") {
        const decisionRows = await sql<{
          id: string;
          organization_id: string;
          brand_id: string;
          question_id: string;
          policy_version: string;
          decision: string;
          reviewer_decision: string | null;
          reasons: string;
          evidence: string;
        }>`
          select id, organization_id, brand_id, question_id, policy_version, decision, reviewer_decision, reasons, evidence
          from jev_decisions
          where id = ${decisionId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          limit 1
        `;
        const decisionRow = decisionRows[0];
        if (!decisionRow) throw new Error("JEV has not approved this creative. No video job was created.");
        const gate = evaluateJevGate({
          decision: decisionRow.decision,
          reviewerDecision: decisionRow.reviewer_decision,
        });
        if (gate.status === "BLOCK") {
          throw new Error(`Brief is rejected by Brand Guardian policy (${gate.reason}). Creative generation blocked.`);
        }
        if (gate.status === "REQUIRE_HUMAN") {
          throw new Error("Brief requires human review approval before video generation.");
        }

        const delivManifest = deliverableManifests.find((m) => m.deliverableId === deliv.id);
        if (!delivManifest) throw new Error(`CreativePlan deliverable ${deliv.id} has no executable manifest.`);
        const creativeSpec = creativeSpecFromManifest(delivManifest, {
          organizationId: access.organizationId,
          brandId,
          title: context.title,
        });

        const targetVidProvider = delivManifest.production!.provider;
        const productionTarget = resolveProductionTarget({
          provider: targetVidProvider,
          model: creativeSpec.modelId!,
          capability: "VIDEO_GENERATION",
          aspectRatio: creativeSpec.aspectRatio,
          durationSeconds: creativeSpec.durationTargetSeconds,
        });
        creativeSpec.providerId = productionTarget.provider;
        creativeSpec.modelId = productionTarget.model;
        // P4a: the provider and model are chosen by the capability matrix, and the choice is recorded on the job.
        const { provider, selection } = await productionRouter.selectForSpec(
          creativeSpec,
          await productionCostMode(sql, creativeSpec.organizationId),
          targetVidProvider === "auto" ? undefined : targetVidProvider,
        );
        creativeSpec.providerId = provider.id;
        creativeSpec.modelId = selection.chosen?.modelId ?? creativeSpec.modelId;
        // The job's estimate is stored in cents with a default of zero, so an unknown cost cannot be recorded without
        // inventing a zero. Refuse it before any job row or provider call exists.
        if (!selection.chosen?.costKnown || selection.chosen.estimateUsd === null) {
          throw new Error(`Video cost is not known for provider '${provider.id}'. No job was created.`);
        }
        const prodJobId = productionJobIds.get(deliv.id) ?? crypto.randomUUID();
        creativeSpec.idempotencyKey = prodJobId;
        const durableInput = JSON.stringify({
          creativeSpec, runId, briefId: briefId, manifestId: delivManifest.creativeId,
          manifest: delivManifest, planDeliverableId: deliv.id, providerSelection: selection,
        });
        await sql`
          insert into production_jobs (
            id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
            status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id
          ) values (
            ${prodJobId}, ${access.organizationId}, ${brandId}, ${provider.id}, null, null, null, null,
            'SUBMITTING', 'BALANCED', ${Math.round(selection.chosen.estimateUsd * 100)},
            ${durableInput}, now(), null, now(), ${creativePlan.id}
          )
          on conflict (id) do nothing
        `;
        let submission: SubmitWithPreflightResult;
        const videoReservation = reservations.get(deliv.id);
        if (videoReservation) videoReservation.held = true;
        try {
          // Preflight runs inside submitWithPreflight, before the provider is called. A refusal calls no provider.
          submission = await submitWithPreflight(provider, creativeSpec);
        } catch (submitError) {
          providerSubmissionUnknown = true;
          await sql`
            update production_jobs
            set status = 'SUBMISSION_UNKNOWN', error_code = 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
              error_message = ${submitError instanceof Error ? submitError.message : String(submitError)}, updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
          throw new Error("Provider submission outcome is unknown. The durable job and budget reservation are held for reconciliation; it was not resubmitted.");
        }
        if (submission.refused) {
          // Refused by preflight before any provider call: nothing was sent, so nothing was spent. The job records the reasons,
          // and the reservation is released, as for a definitive provider rejection.
          if (videoReservation) videoReservation.held = false;
          const refusalReasons = submission.reasons.join(" ");
          await sql`
            update production_jobs set status = 'PREFLIGHT_FAILED', error_code = 'PREFLIGHT_BLOCKED',
              error_message = ${refusalReasons}, updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
          throw new Error(`Video production refused by preflight before any provider call: ${refusalReasons}`);
        }
        const submittedJob = submission.job;
        if (submittedJob.status === "SUBMISSION_UNKNOWN") {
          providerSubmissionUnknown = true;
          await sql`
            update production_jobs
            set status = 'SUBMISSION_UNKNOWN', error_code = 'PROVIDER_SUBMISSION_OUTCOME_UNKNOWN',
              error_message = ${submittedJob.error || "Provider submission outcome is unknown; automatic retry is disabled."},
              updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
          throw new Error("Provider submission outcome is unknown. The durable job and budget reservation are held for reconciliation; it was not resubmitted.");
        }
        if (submittedJob.status === "FAILED" || submittedJob.status === "PREFLIGHT_FAILED" || submittedJob.status === "NOT_CONFIGURED") {
          // Definitive provider rejection: nothing was accepted, so the reservation may be released.
          if (videoReservation) videoReservation.held = false;
          await sql`
            update production_jobs set status = 'FAILED', error_code = ${submittedJob.errorCode || submittedJob.status},
              error_message = ${submittedJob.error || "Provider rejected the request."}, updated_at = now()
            where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
          `;
          throw new Error(`Video production failed (${submittedJob.status}): ${submittedJob.error || "Provider rejected job."}`);
        }

        await sql`
          update production_jobs set status = ${submittedJob.status},
            provider_job_id = ${submittedJob.providerJobId || submittedJob.jobId || null},
            request_id = ${submittedJob.requestId || null}, status_url = ${submittedJob.statusUrl || null},
            cancel_url = ${submittedJob.cancelUrl || null}, submitted_at = now(), error_code = null,
            error_message = null, updated_at = now()
          where id = ${prodJobId} and organization_id = ${access.organizationId} and brand_id = ${brandId}
        `;

        let finalResult: import("../production/artifact-finalizer.ts").ArtifactFinalizeResult | null = null;
        if (submittedJob.status === "COMPLETED" || submittedJob.status === "RENDERED") {
          finalResult = await finalizeProductionArtifact(sql, {
            jobId: prodJobId,
            organizationId: access.organizationId,
            brandId,
            provider: provider.id,
            providerJobId: submittedJob.providerJobId || submittedJob.jobId,
            runId,
            rawArtifact: {
              uri: submittedJob.outputArtifactId,
              base64: (submittedJob.metadata?.videoBytesBase64 as string) || undefined,
              mimeType: (submittedJob.metadata?.mimeType as string) || undefined,
            },
            options: {
              durationMs: (creativeSpec.durationTargetSeconds ?? 8) * 1000,
              job: submittedJob,
            },
          });
        }

        if (finalResult && !finalResult.success) {
          await sql`
            update production_jobs
            set status = ${finalResult.status}, error_message = ${finalResult.error || "Storage persistence failed"}, updated_at = now()
            where id = ${prodJobId}
          `;
        } else if (finalResult?.success) {
          // Shared with the poller: creates the creative, asset, and settles this job's reservation.
          await completeProductionJob(sql, { organizationId: access.organizationId, brandId, productionJobId: prodJobId }, { openReview: false });
        }
      }
    }

    if (carouselJobId) {
      await settleCarouselParent(sql, { organizationId: access.organizationId, brandId, productionJobId: carouselJobId });
    }

    const videos = await sql<Record<string, unknown>>`
      select a.id, a.creative_id, a.storage_key, a.media_status, a.byte_size, a.width, a.height, a.duration_ms, a.transcript,
             a.scenes, a.checksum, a.mime_type, a.prompt_version, c.raw_text, c.angle
      from assets a
      join creative_records c on c.id = a.creative_id
      where a.generation_run_id = ${runId} and a.kind = 'video' and a.organization_id = ${access.organizationId}
    `;
    for (const video of videos) {
      const scenes = asJson<{ summary: string }[]>(video.scenes, []);
      const copy = asText(video.raw_text);
      const ownSemantic = await semanticNearest(copy, loaded.creatives.filter((item) => item.origin !== "competitor").map((item) => item.text)).catch(() => null);
      const publishing = assessPublishing({
        accounts: await accountSnapshots(sql, access.organizationId),
        provider: "test:publisher",
        kind: "video",
        mime: asText(video.mime_type),
        width: video.width == null ? null : asNumber(video.width),
        height: video.height == null ? null : asNumber(video.height),
        byteSize: asNumber(video.byte_size),
        destinationUrl: "",
      });
      const videoDurationMs = video.duration_ms == null ? null : asNumber(video.duration_ms);
      // One sample and one selection per video: the logo and palette measurements and the visual questions read the same frames.
      const videoFrames = await sampleVideoForJudgment(sql, access.organizationId, brandId, asText(video.storage_key), videoDurationMs);
      const visual = await measureVideoFrames(sql, access.organizationId, brandId, videoFrames);
      const selection = await resolveActiveEngine(sql, access.organizationId);
      // Whether the engine this video is judged by can see frames, resolved once for this video.
      const engineSeesFrames = (await resolveImageSupport({ selection, sql, organizationId: access.organizationId })).takesImages;
      // Perception is used only when the engine cannot see frames. It is checked here, before any frame is sampled for it.
      const perceptionCandidate = selectPerceptionProvider().provider;
      const perceptionForJudgment = !engineSeesFrames &&
        (await perceptionReadiness(sql, access.organizationId, perceptionCandidate)).ready ? perceptionCandidate : null;
      const facts = factsFor(loaded, {
        kind: "video",
        productName,
        angle: asText(video.angle),
        copy,
        prompt: copy,
        mime: asText(video.mime_type),
        byteSize: asNumber(video.byte_size),
        width: video.width == null ? null : asNumber(video.width),
        height: video.height == null ? null : asNumber(video.height),
        checksum: asText(video.checksum),
        durationMs: video.duration_ms == null ? null : asNumber(video.duration_ms),
        transcript: asText(video.transcript),
        sceneCount: scenes.length,
        logoSimilarity: visual.measuredLogo.similarity,
        logoOutcome: visual.measuredLogo.outcome,
        logoEvidence: visual.measuredLogo.evidence,
        paletteDistance: visual.measuredPalette.distance,
        paletteOutcome: visual.measuredPalette.outcome,
        paletteEvidence: visual.measuredPalette.evidence,
        semanticSimilarity: await semanticNearest(copy, competitorCopy(loaded)).catch(() => null),
        ownSemanticSimilarity: ownSemantic,
        publishing,
      });
      const judged = await writeJudgment(sql, {
        organizationId: access.organizationId,
        brandId,
        creativeId: asText(video.creative_id),
        facts,
        selection,
        perception: perceptionForJudgment,
        visual: await videoVisualEvidence(sql, access.organizationId, brandId, asText(video.storage_key), videoDurationMs, {
          sample: engineSeesFrames || perceptionForJudgment !== null,
          sampled: videoFrames,
        }),
      });
      const status = judged.rollup === "REJECT" ? "rejected" : "in_review";
      await sql`update creative_records set status = ${status}, updated_at = now() where id = ${asText(video.creative_id)}`;
      await sql`
        update assets set qa_decision = ${judged.rollup}, review_status = ${status}, lifecycle = 'qa_required'
        where id = ${asText(video.id)}
      `;
      if (status === "in_review") {
        await openProductionReview(sql, {
          organizationId: access.organizationId,
          brandId,
          creativeId: asText(video.creative_id),
          decisionId: decisionId,
          subjectLabel: "Video",
        });
      }
    }

    // Image spend settles now. Video spend settles per job when its artifact is materialized.
    for (const [deliverableId, reservation] of reservations) {
      if (productionJobIds.has(deliverableId)) continue;
      await BudgetLedgerService.reconcile(sql, {
        reservationId: reservation.id,
        cost: { basis: "ESTIMATED", amountMicros: reservation.amountMicros, estimatorVersion: ESTIMATOR_VERSION },
      });
    }

    await sql`update briefs set status = 'used' where id = ${briefId} and organization_id = ${access.organizationId}`;
    await sql`update generation_runs set status = 'completed' where id = ${runId}`;
    await settleCreativePlanIfComplete(sql, {
      organizationId: access.organizationId,
      brandId,
      planId: creativePlan.id,
      actorId: userId,
    });
    return loadSession(sql, access.organizationId, brandId, access.role);
  } catch (error) {
    if (carouselJobId) {
      await settleCarouselParent(sql, { organizationId: access.organizationId, brandId, productionJobId: carouselJobId }, { interrupted: true })
        .catch(() => undefined);
    }
    await releaseUnheldReservations(sql, reservations, error instanceof Error ? error.message : String(error));
    await sql`
      update generation_runs set status = 'failed'
      where id = ${runId} and organization_id = ${access.organizationId} and status = 'running'
    `;
    const acceptedJobInFlight = !providerSubmissionUnknown && [...reservations.values()].some((r) => r.held);
    if (!acceptedJobInFlight) {
      await transitionCreativePlan(sql, {
        organizationId: access.organizationId, brandId, planId: creativePlan.id, actorId: userId,
        target: "failed", reason: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    }
    throw error;
  }
}
