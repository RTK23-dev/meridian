/**
 * The video path of the Produce stage (NORTH_STAR section 8, item 3). A video is one provider job, chosen by the production router with
 * the run's provider choice, and it is the same durable job Studio makes: a row, a budget reservation, one provider submission, and the
 * artifact stored and materialized by the shared materializer. A video that is still rendering keeps the run waiting, with its reason.
 * The poller that runs in the worker finishes it from the job row, and the run checks again. Nothing is marked produced until the
 * artifact is stored and its creative exists.
 *
 * The creative is judged once, by the same creative_qa check Studio runs on a video. A video the engine has not judged is review.
 */
import type { Sql } from "../learning/store.ts";
import { loadBrandContext } from "../context/load.ts";
import { semanticNearest } from "../embeddings/store.ts";
import { assessPublishing } from "../publishing/readiness.ts";
import {
  accountSnapshots,
  competitorCopy,
  factsFor,
  frameLike,
  videoVisualEvidence,
  visualFacts,
  writeJudgment,
} from "../studio/image-qc.server.ts";
import { resolveActiveEngine } from "../decisions/selection.ts";
import { perceptionReadiness, selectPerceptionProvider } from "../perception/run.ts";
import { combineLogoFrames, combinePaletteFrames } from "../vision/measure.ts";
import { finalizeProductionArtifact } from "../production/artifact-finalizer.ts";
import { productionRouter } from "../production/router.ts";
import { productionCostMode } from "../production/cost-mode.ts";
import { submitWithPreflight, type SubmitWithPreflightResult } from "../production/submit.ts";
import { openProductionReview, settleProductionReservation } from "../production/materialization.ts";
import type { CreativeSpec, ProductionJob } from "../production/types.ts";
import type { CreativePlan } from "../creative/plan.ts";
import { BudgetLedgerService, toMicros } from "../security/budget-ledger.ts";
import { recordDecisionSpend } from "./decision-spend.ts";
import { meteredSpendOf } from "./spend.ts";
import {
  IN_FLIGHT_STATUSES,
  NOT_A_SLIDE,
  UNKNOWN_OUTCOME_STATUSES,
  capStopOf,
  errorText,
  insertJobWithReservation,
  linkCreative,
  markJob,
  materialize,
  type ProduceInput,
  type Scope,
  type Step,
  type VariantRow,
} from "./produce-shared.ts";

/** The version of the video prompt this stage writes. It is recorded on the asset. */
export const VIDEO_PROMPT_VERSION = "factory-video-v1";

/** The statuses a provider job reaches when it has failed for good. Nothing is reserved for them after the release. */
const TERMINAL_FAILURE: ReadonlySet<string> = new Set(["FAILED", "CANCELLED", "PREFLIGHT_FAILED", "NOT_CONFIGURED", "POSTFLIGHT_FAILED"]);

export type VideoRequest = {
  variant: VariantRow;
  plan: CreativePlan;
  /** factory-<variant>-video. The job the run made for this variant's video. */
  jobId: string;
  label: string;
  copy: string;
  productName: string;
  hook: string;
  angle: string;
  planDeliverableId: string;
  durationSeconds: number;
  sequenceIndex: number;
};

/** The reason the run waits for a video that is still at the provider. It names the provider and the job's status. */
export function waitingReasonOf(label: string, providerId: string, status: string): string {
  return `The ${providerId} video for ${label} is still ${status.toLowerCase().replace(/_/g, " ")} at the provider. Nothing is marked produced until it completes, and the run checks again.`;
}

/**
 * Produces one variant's video. A job the run already made is resumed from its row: a stored creative is linked, a completed job is
 * materialized, a job still at the provider waits, and a job whose outcome is unknown stops the run with the reason. A new job is
 * chosen, reserved and submitted once.
 */
export async function produceVideo(sql: Sql, input: ProduceInput, req: VideoRequest): Promise<Step> {
  const scope: Scope = { organizationId: input.organizationId, brandId: input.brandId };
  const existing = await sql<{ status: string; provider: string; materialized_creative_id: string | null }>`
    select status, provider, materialized_creative_id from production_jobs
    where id = ${req.jobId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
    limit 1
  `;
  if (existing[0]) return resumeVideo(sql, input, scope, req, existing[0]);
  return submitVideo(sql, input, scope, req);
}

async function resumeVideo(
  sql: Sql,
  input: ProduceInput,
  scope: Scope,
  req: VideoRequest,
  row: { status: string; provider: string; materialized_creative_id: string | null },
): Promise<Step> {
  const assetId = `video-asset-${req.jobId}`;
  const link = (creativeId: string) =>
    linkCreative(sql, scope, {
      runId: input.runId,
      variantId: req.variant.id,
      format: "video",
      slideIndex: NOT_A_SLIDE,
      creativeId,
      jobId: req.jobId,
      provider: row.provider,
    });
  if (row.materialized_creative_id) {
    await link(row.materialized_creative_id);
    await judgeFactoryVideo(sql, input, { creativeId: row.materialized_creative_id, assetId, jobId: req.jobId, productName: req.productName, angle: req.angle });
    return { kind: "linked" };
  }
  if (row.status === "COMPLETED") {
    const made = await materialize(sql, input, req.jobId);
    if ("reason" in made) return { kind: "stop", reason: made.reason };
    await link(made.creativeId);
    await judgeFactoryVideo(sql, input, { creativeId: made.creativeId, assetId, jobId: req.jobId, productName: req.productName, angle: req.angle });
    return { kind: "linked" };
  }
  if (IN_FLIGHT_STATUSES.has(row.status)) {
    return { kind: "waiting", reason: waitingReasonOf(req.label, row.provider, row.status) };
  }
  if (UNKNOWN_OUTCOME_STATUSES.has(row.status)) {
    return {
      kind: "stop",
      reason: `The video for ${req.label} has no confirmed provider outcome (${row.status}). Its budget is held until the provider confirms it holds no job for the submission, or an admin resolves it, and nothing was resubmitted.`,
    };
  }
  // A job that failed for good leaves no creative. The variant is reported, not produced, as an image is.
  return { kind: "skipped" };
}

async function submitVideo(sql: Sql, input: ProduceInput, scope: Scope, req: VideoRequest): Promise<Step> {
  // The metered spend is checked before any provider call, as it is for an image.
  const reached = await capStopOf(sql, input, scope);
  if (reached) return { kind: "stop", reason: reached };

  // The provider is the run's choice for video. A named provider that is not ready is refused here, before a job or a reservation exists.
  const requested = input.providers.video ?? "auto";
  const spec: CreativeSpec = {
    id: req.jobId,
    organizationId: scope.organizationId,
    brandId: scope.brandId,
    title: req.label,
    modality: "video",
    format: "video_ugc",
    aspectRatio: "9:16",
    durationTargetSeconds: req.durationSeconds,
    hookLine: req.hook,
    script: req.copy,
    scenes: [],
    idempotencyKey: req.jobId,
  };
  let selected: Awaited<ReturnType<typeof productionRouter.selectForSpec>>;
  try {
    selected = await productionRouter.selectForSpec(spec, await productionCostMode(sql, scope.organizationId), requested === "auto" ? undefined : requested);
  } catch (error) {
    return { kind: "stop", reason: errorText(error) };
  }
  const provider = selected.provider;
  const chosen = selected.selection.chosen;
  // A job's estimate is stored in cents, so an unknown cost cannot be recorded without inventing a zero. It is refused before any job exists.
  if (!chosen || !chosen.costKnown || chosen.estimateUsd === null) {
    return { kind: "stop", reason: `Video cost is not known for provider '${provider.id}'. No job was created, so nothing was spent.` };
  }
  const estimateUsd = chosen.estimateUsd;
  const estimateCents = Math.round(estimateUsd * 100);

  // A run with a cap is held to it for video too. A video's cost is a declared estimate, not a reported cost, so the estimates of the run's
  // own video jobs count toward the cap until they fail. A video that would pass the cap is not sent.
  const overCap = await videoCapStop(sql, input, scope, estimateCents);
  if (overCap) return { kind: "stop", reason: overCap };

  spec.providerId = provider.id;
  spec.modelId = chosen.modelId;
  const jobInput = {
    kind: "factory_video",
    runId: input.runId,
    factoryVariantId: req.variant.id,
    prompt: req.copy,
    copy: req.copy,
    productName: req.productName,
    format: "video_ugc",
    itemLabel: req.label,
    sequenceIndex: req.sequenceIndex,
    deliverableKind: "video",
    planDeliverableId: req.planDeliverableId,
    creativeSpec: spec,
    providerSelection: selected.selection,
    promptVersion: VIDEO_PROMPT_VERSION,
  };

  let reservationId: string;
  try {
    reservationId = await insertJobWithReservation(sql, {
      organizationId: scope.organizationId,
      brandId: scope.brandId,
      jobId: req.jobId,
      amountMicros: toMicros(estimateUsd),
      insertJob: async (tx) => {
        await tx`
          insert into production_jobs (
            id, organization_id, brand_id, provider, provider_job_id, request_id, status_url, cancel_url,
            status, cost_mode, estimated_cost_cents, input, created_at, submitted_at, updated_at, creative_plan_id, modality, cost_status
          ) values (
            ${req.jobId}, ${scope.organizationId}, ${scope.brandId}, ${provider.id}, null, null, null, null,
            'SUBMITTING', 'BALANCED', ${estimateCents}, ${JSON.stringify(jobInput)}, now(), null, now(), ${req.plan.id}, 'video',
            ${chosen.costStatus ?? null}
          )
        `;
      },
    });
  } catch (error) {
    return { kind: "stop", reason: `The brand's budget cannot cover the video, so no provider was called. ${errorText(error)}` };
  }

  // The provider is called once. A call that throws may have reached the provider, so its reservation is held for a person.
  const amount = `$${estimateUsd.toFixed(2)}`;
  let submission: SubmitWithPreflightResult;
  try {
    // Preflight runs inside submitWithPreflight, before the provider is called. A refusal calls no provider.
    submission = await submitWithPreflight(provider, spec);
  } catch (error) {
    const message = errorText(error);
    await markJob(sql, scope, req.jobId, "SUBMISSION_UNKNOWN", "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN", message);
    return {
      kind: "stop",
      reason: `The ${provider.id} submission did not return, so its outcome is unknown. The ${amount} reserved for it is held until the provider confirms it holds no job for the submission, or an admin resolves it. ${message}`,
    };
  }
  if (submission.refused) {
    // Refused before any provider call: nothing was sent, so the reservation is released. The job and the run both say why.
    const reason = `Preflight refused the video for ${req.label} before any provider call: ${submission.reasons.join(" ")}`;
    await markJob(sql, scope, req.jobId, "PREFLIGHT_FAILED", "PREFLIGHT_BLOCKED", reason);
    await BudgetLedgerService.release(sql, { reservationId, reason });
    return { kind: "stop", reason };
  }
  const submitted: ProductionJob = submission.job;
  if (submitted.status === "NOT_CONFIGURED") {
    // The provider accepted nothing, so the reservation is released and the run stops: the provider is not ready.
    const reason = submitted.error || `Provider '${provider.id}' is NOT_CONFIGURED.`;
    await markJob(sql, scope, req.jobId, "FAILED", "NOT_CONFIGURED", reason);
    await BudgetLedgerService.release(sql, { reservationId, reason });
    return { kind: "stop", reason };
  }
  if (submitted.status === "FAILED" || submitted.status === "PREFLIGHT_FAILED") {
    // A definitive rejection: nothing was accepted, so the reservation is released and the variant has no video.
    const reason = submitted.error || "The provider rejected the request.";
    await markJob(sql, scope, req.jobId, "FAILED", submitted.errorCode || submitted.status, reason);
    await BudgetLedgerService.release(sql, { reservationId, reason });
    return { kind: "failed" };
  }
  if (submitted.status === "SUBMISSION_UNKNOWN") {
    const reason = submitted.error || "The provider submission outcome is unknown; automatic retry is disabled.";
    await markJob(sql, scope, req.jobId, "SUBMISSION_UNKNOWN", "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN", reason);
    return {
      kind: "stop",
      reason: `The ${provider.id} submission outcome is unknown. The ${amount} reserved for it is held until the provider confirms it holds no job for the submission, or an admin resolves it. ${reason}`,
    };
  }

  await sql`
    update production_jobs set status = ${submitted.status},
      provider_job_id = ${submitted.providerJobId || submitted.jobId || null},
      request_id = ${submitted.requestId || null}, status_url = ${submitted.statusUrl || null},
      cancel_url = ${submitted.cancelUrl || null}, submitted_at = now(), error_code = null, error_message = null, updated_at = now()
    where id = ${req.jobId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
  `;

  if (submitted.status !== "COMPLETED" && submitted.status !== "RENDERED") {
    if (TERMINAL_FAILURE.has(submitted.status)) {
      const reason = submitted.error || `The provider reported ${submitted.status}.`;
      await markJob(sql, scope, req.jobId, "FAILED", submitted.errorCode || submitted.status, reason);
      await BudgetLedgerService.release(sql, { reservationId, reason });
      return { kind: "failed" };
    }
    // Still at the provider. The poller that runs in the worker reads this job row, and the run checks again.
    return { kind: "waiting", reason: waitingReasonOf(req.label, provider.id, submitted.status) };
  }

  // The provider returned the video: store it, then materialize it through the shared materializer, which settles the reservation.
  const finalized = await finalizeProductionArtifact(sql, {
    jobId: req.jobId,
    organizationId: scope.organizationId,
    brandId: scope.brandId,
    provider: provider.id,
    providerJobId: submitted.providerJobId || submitted.jobId,
    runId: input.runId,
    rawArtifact: {
      uri: submitted.outputArtifactId,
      base64: (submitted.metadata?.videoBytesBase64 as string) || undefined,
      mimeType: (submitted.metadata?.mimeType as string) || undefined,
    },
    options: {
      durationMs: req.durationSeconds * 1000,
      job: submitted,
      driveClient: input.driveClient,
    },
  });
  if (!finalized.success) {
    const reason = finalized.error ?? "The video could not be stored.";
    await sql`
      update production_jobs set status = ${finalized.status}, error_code = ${finalized.errorCode ?? null},
        error_message = ${reason.slice(0, 500)}, updated_at = now()
      where id = ${req.jobId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
    `;
    if (finalized.status === "WAITING_FOR_ARTIFACT" || finalized.status === "STORAGE_PERSISTENCE_FAILED") {
      // The poller stores it again. Nothing is reported as produced until it is.
      return { kind: "waiting", reason: `The video for ${req.label} was made and is being stored (${finalized.status}). The run waits for the store to finish.` };
    }
    // The provider made the video, so the spend happened. The reservation settles at its reserved amount.
    await settleProductionReservation(sql, { organizationId: scope.organizationId, brandId: scope.brandId, productionJobId: req.jobId });
    return { kind: "stop", reason: `The video for ${req.label} was generated, but it was not stored. ${reason}` };
  }

  const made = await materialize(sql, input, req.jobId);
  if ("reason" in made) return { kind: "stop", reason: made.reason };
  await linkCreative(sql, scope, {
    runId: input.runId,
    variantId: req.variant.id,
    format: "video",
    slideIndex: NOT_A_SLIDE,
    creativeId: made.creativeId,
    jobId: req.jobId,
    provider: provider.id,
  });
  await judgeFactoryVideo(sql, input, {
    creativeId: made.creativeId,
    assetId: `video-asset-${req.jobId}`,
    jobId: req.jobId,
    productName: req.productName,
    angle: req.angle,
  });
  return { kind: "linked" };
}

/**
 * Whether one more video estimate would pass the run's cap. The metered spend and the estimates of the run's own video jobs that have not
 * failed are the spend the cap is held against. Returns the reason, or null.
 */
async function videoCapStop(sql: Sql, input: ProduceInput, scope: Scope, estimateCents: number): Promise<string | null> {
  const metered = await meteredSpendOf(sql, scope.organizationId, scope.brandId, input.runId);
  const committed = await sql<{ total: number; daily: number }>`
    select coalesce(sum(estimated_cost_cents), 0)::int as total,
      coalesce(sum(estimated_cost_cents) filter (where created_at >= now() - interval '1 day'), 0)::int as daily
    from production_jobs
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and modality = 'video'
      and input->>'runId' = ${input.runId} and status not in ('FAILED', 'CANCELLED', 'PREFLIGHT_FAILED', 'NOT_CONFIGURED', 'POSTFLIGHT_FAILED')
  `;
  const held = Number(committed[0]?.total ?? 0);
  const heldToday = Number(committed[0]?.daily ?? 0);
  if (input.caps.totalCents !== null && metered.totalCents + held + estimateCents > input.caps.totalCents) {
    return `The video's estimated cost of $${(estimateCents / 100).toFixed(2)} would pass the total spend cap with the spend this run already holds, so no provider was called.`;
  }
  if (input.caps.dailyCents !== null && metered.dailyCents + heldToday + estimateCents > input.caps.dailyCents) {
    return `The video's estimated cost of $${(estimateCents / 100).toFixed(2)} would pass the daily spend cap with the spend this run already holds, so no provider was called.`;
  }
  return null;
}

/** The measured frames of a stored video, as the Studio judgment reads them. Nothing is measured when no frame was stored. */
async function measuredVideoFrames(sql: Sql, organizationId: string, brandId: string, storageKey: string) {
  const missingLogo = {
    similarity: null,
    confidence: null,
    outcome: "ABSENT" as const,
    evidence: storageKey && !storageKey.startsWith("pending/")
      ? "The stored container had no extractable frame. Vision was not run and nothing was treated as a match."
      : "Video bytes are not stored yet. Vision was not run.",
  };
  const missingPalette = {
    distance: null,
    confidence: null,
    outcome: "ABSENT" as const,
    extracted: [] as string[],
    evidence: missingLogo.evidence,
  };
  if (!storageKey || storageKey.startsWith("pending/")) {
    return { measuredLogo: missingLogo, measuredPalette: missingPalette };
  }
  const rows = await sql<{ body: string }>`
    select body from asset_blobs
    where organization_id = ${organizationId} and brand_id = ${brandId}
      and storage_key like ${frameLike(storageKey)} escape '\\'
    order by storage_key asc
  `;
  const logos = [];
  const palettes = [];
  for (const row of rows) {
    const visual = await visualFacts(sql, organizationId, brandId, new Uint8Array(Buffer.from(row.body, "base64")));
    logos.push(visual.measuredLogo);
    palettes.push(visual.measuredPalette);
  }
  if (logos.length === 0) return { measuredLogo: missingLogo, measuredPalette: missingPalette };
  return { measuredLogo: combineLogoFrames(logos), measuredPalette: combinePaletteFrames(palettes) };
}

/**
 * The creative_qa check of one stored video, once. The judgment reads the stored video's copy, its container facts and its frames, and
 * the engine answers through the same gate an image uses. A creative already judged is not judged again, so the engine is asked once.
 */
async function judgeFactoryVideo(
  sql: Sql,
  input: ProduceInput,
  args: { creativeId: string; assetId: string; jobId: string; productName: string; angle: string },
): Promise<void> {
  const { organizationId, brandId } = input;
  const judged = await sql<{ n: number }>`
    select count(*)::int as n from decision_gate_records
    where organization_id = ${organizationId} and subject_type = 'creative' and subject_id = ${args.creativeId} and gate = 'creative_qa'
  `;
  if ((judged[0]?.n ?? 0) > 0) return;

  const rows = await sql<{
    raw_text: string;
    mime_type: string;
    width: number | null;
    height: number | null;
    byte_size: string | number;
    duration_ms: number | null;
    transcript: string;
    scenes: string;
    checksum: string;
    storage_key: string;
  }>`
    select c.raw_text, a.mime_type, a.width, a.height, a.byte_size, a.duration_ms, a.transcript, a.scenes, a.checksum, a.storage_key
    from creative_records c
    join assets a on a.creative_id = c.id and a.organization_id = c.organization_id
    where a.id = ${args.assetId} and c.id = ${args.creativeId} and c.organization_id = ${organizationId} and c.brand_id = ${brandId}
    limit 1
  `;
  const video = rows[0];
  if (!video) return;
  const loaded = await loadBrandContext(sql, organizationId, brandId);
  const copy = video.raw_text;
  const durationMs = video.duration_ms == null ? null : Number(video.duration_ms);
  const byteSize = Number(video.byte_size);
  const width = video.width == null ? null : Number(video.width);
  const height = video.height == null ? null : Number(video.height);
  const sceneCount = sceneCountOf(video.scenes);
  const ownSemantic = await semanticNearest(copy, loaded.creatives.filter((item) => item.origin !== "competitor").map((item) => item.text)).catch(() => null);
  const publishing = assessPublishing({
    accounts: await accountSnapshots(sql, organizationId),
    provider: "test:publisher",
    kind: "video",
    mime: video.mime_type,
    width,
    height,
    byteSize,
    destinationUrl: "",
  });
  const visual = await measuredVideoFrames(sql, organizationId, brandId, video.storage_key);
  const selection = await resolveActiveEngine(sql, organizationId);
  // Perception is used only when the engine cannot see frames. It is checked here, before any frame is sampled for it.
  const perceptionCandidate = selectPerceptionProvider().provider;
  const perceptionForJudgment =
    selection.engineId !== "openai-decisions" && (await perceptionReadiness(sql, organizationId, perceptionCandidate)).ready ? perceptionCandidate : null;
  const facts = factsFor(loaded, {
    kind: "video",
    productName: args.productName,
    angle: args.angle,
    copy,
    prompt: copy,
    mime: video.mime_type,
    byteSize,
    width,
    height,
    checksum: video.checksum,
    durationMs,
    transcript: video.transcript,
    sceneCount,
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
  const judgment = await writeJudgment(sql, {
    organizationId,
    brandId,
    creativeId: args.creativeId,
    facts,
    selection,
    perception: perceptionForJudgment,
    visual: await videoVisualEvidence(sql, organizationId, brandId, video.storage_key, durationMs, {
      sample: selection.engineId === "openai-decisions" || perceptionForJudgment !== null,
    }),
    engines: input.engines,
  });
  await recordDecisionSpend(sql, {
    organizationId,
    brandId,
    runId: input.runId,
    stage: "factory.produce",
    productionJobId: args.jobId,
    gateRecordId: judgment.gateRecordId,
    engineCalled: judgment.gateEngineCalled,
    engineId: judgment.gateEngineId,
    requestedModel: judgment.gateRequestedModel,
    returnedModel: judgment.gateReturnedModel,
    usage: judgment.gateUsage ?? undefined,
  });
  // A rejected video is rejected. Any other video stays in review: a video is never approved by the judgment alone.
  const status = judgment.rollup === "REJECT" ? "rejected" : "in_review";
  await sql`
    update creative_records set status = ${status}, updated_at = now()
    where id = ${args.creativeId} and organization_id = ${organizationId} and brand_id = ${brandId}
  `;
  await sql`
    update assets set qa_decision = ${judgment.rollup}, review_status = ${status}, lifecycle = 'qa_required'
    where id = ${args.assetId} and organization_id = ${organizationId} and brand_id = ${brandId}
  `;
  // The review cites the decision row this judgment wrote. It never cites the plan's gate record, which is not a jev_decisions row
  // (reviews.decision_id references jev_decisions). A rejected video has no review.
  if (status === "in_review" && judgment.decisionId) {
    await openProductionReview(sql, {
      organizationId,
      brandId,
      creativeId: args.creativeId,
      decisionId: judgment.decisionId,
      subjectLabel: "Video",
    });
  }
}

function sceneCountOf(value: string): number {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
