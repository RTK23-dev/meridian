/**
 * The Factory's video made by the Meridian video engine (NORTH_STAR section 8, item 6; lead tasks I1 to I3). A run that names the engine
 * for video calls no provider. The variant's plan is mapped to the engine's production request (engine-request.ts), the request is started
 * through the engine's API (src/engine/api), and the run waits while the engine works. When the engine delivers the master, its MP4 and its
 * manifest become the Factory creative: a creative_records row and an assets row, linked to the variant in factory_creatives, as Studio's
 * creatives are. Nothing is marked produced before then.
 *
 * Nothing is invented. A request the engine cannot run is refused with the engine's own reasons (not connected, no budget, a field the plan
 * does not carry), and a request that stops is reported with its reason. The budget of a request is held against the run's caps until the
 * engine records what it spent (spend.ts). A cap that is reached stops the run and pauses the run's live engine reservations.
 *
 * The creative is not judged here. The Factory gate stage runs its rule gates and its JEV check on it, and a check with no evidence is
 * review, never pass (gates.ts, worker.ts).
 */
import type { Sql } from "../learning/store.ts";
import {
  engineDeliveredMaster,
  engineReadiness,
  engineRequestStatus,
  productionReadinessPorts,
  startEngineRequest,
  type DeliveredMaster,
  type EngineRequestStatus,
} from "../../../engine/api/index.ts";
import { engineRequestIdFor, mapVideoToEngineRequest, type EngineMapping } from "./engine-request.ts";
import { ENGINE_VIDEO_PROVIDER_ID } from "./run-settings.ts";
import { approverOf, capStopOf, errorText, linkCreative, NOT_A_SLIDE, type ProduceInput, type Scope, type Step } from "./produce-shared.ts";
import { engineHeldOf, meteredSpendOf, pauseRunEngineSpend } from "./spend.ts";
import type { VideoRequest } from "./produce-video.ts";

/** The provider an engine video is recorded under. */
const ENGINE_PROVIDER = ENGINE_VIDEO_PROVIDER_ID;
/** The container the engine renders. A RenderedVideo carries no mime type, and the engine renders MP4 only. */
const ENGINE_MIME = "video/mp4";

/**
 * Produces one variant's video through the engine. A variant whose request the run already started is followed from its row: its status
 * is read from the engine, and a delivered master is made into the creative. A variant with no request starts one, if the engine can run it.
 */
export async function produceEngineVideo(sql: Sql, input: ProduceInput, scope: Scope, req: VideoRequest): Promise<Step> {
  const linked = await sql<{ request_id: string }>`
    select request_id from factory_engine_requests
    where variant_id = ${req.variant.id} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
    limit 1
  `;
  const requestId = linked[0]?.request_id;
  if (requestId) return resumeEngineVideo(sql, input, scope, req, requestId);
  return startEngineVideo(sql, input, scope, req);
}

async function resumeEngineVideo(sql: Sql, input: ProduceInput, scope: Scope, req: VideoRequest, requestId: string): Promise<Step> {
  const status = await engineRequestStatus(sql, scope.organizationId, requestId);
  if (status === null) {
    return {
      kind: "stop",
      reason: `The video engine has no request ${requestId} for ${req.label} in this workspace, so nothing was made. Nothing was sent again.`,
    };
  }
  return stepOfStatus(sql, input, scope, req, requestId, status);
}

/** What one engine status means for the run. A status the Factory does not know stops the run: it is never read as a success. */
async function stepOfStatus(
  sql: Sql,
  input: ProduceInput,
  scope: Scope,
  req: VideoRequest,
  requestId: string,
  status: EngineRequestStatus,
): Promise<Step> {
  switch (status.status) {
    case "queued":
      return waiting(`The video engine has accepted the request for ${req.label} (${requestId}) and has not started it yet. The run checks again.`);
    case "running":
      return waiting(
        `The video engine is making the video for ${req.label} (request ${requestId}${status.stage ? `, at ${status.stage}` : ""}). ` +
          "Nothing is marked produced until it is delivered, and the run checks again.",
      );
    case "needs_review":
      return waiting(
        `The video engine sent the video for ${req.label} to review at ${status.stage}: ${status.reason} ${reviewItemsLine(status.openItems)} ` +
          "The run waits for a person.",
      );
    case "paused":
      return {
        kind: "stop",
        reason: `The video engine paused the video for ${req.label} at ${status.stage} (${pauseWordsOf(status.pauseKind)}): ${status.reason}`,
      };
    case "failed":
      return { kind: "stop", reason: `The video engine did not deliver the video for ${req.label}: ${status.reasons.join(" ")}` };
    case "delivered":
      return materializeEngineMaster(sql, input, scope, req, requestId);
    default:
      return { kind: "stop", reason: `The video engine reported a status for ${req.label} that this Factory does not know, so the run stops.` };
  }
}

/**
 * Makes the delivered master the Factory creative: its MP4 is the asset, its manifest and rendered-video artifact are recorded on the
 * creative, and the creative is linked to the variant. Every write is idempotent on the request id, so a run that stops after one of them
 * finishes the rest the next time it runs.
 */
async function materializeEngineMaster(sql: Sql, input: ProduceInput, scope: Scope, req: VideoRequest, requestId: string): Promise<Step> {
  let master: DeliveredMaster;
  try {
    master = await engineDeliveredMaster(sql, scope.organizationId, requestId);
  } catch (error) {
    return { kind: "stop", reason: `The video engine delivered the video for ${req.label}, but its master could not be read. ${errorText(error)}` };
  }
  const { renderedVideo } = master;
  const creativeId = `engine-creative-${requestId}`;
  const assetId = `engine-asset-${requestId}`;
  const approver = await approverOf(sql, scope, input.runId);

  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
      message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
    ) values (
      ${creativeId}, ${scope.organizationId}, ${scope.brandId}, 'generated', ${`${req.label} video`}, ${req.copy},
      ${req.productName}, ${req.hook}, '', ${req.angle}, ${req.copy}, '', 'video_ugc', '', null, null, 'in_review', ${approver},
      ${JSON.stringify({
        generationRunId: input.runId,
        provider: ENGINE_PROVIDER,
        kind: "video",
        planDeliverableId: req.planDeliverableId,
        engineRequestId: requestId,
        engineManifestId: master.manifestId,
        engineVideoId: renderedVideo.videoId,
        engineRenderedVideoArtifactId: master.renderedVideoArtifactId,
        engineRenderer: renderedVideo.renderer,
        engineRecordHash: master.recordHash,
      })}
    )
    on conflict (id) do nothing
  `;

  // The content hash is the hash of the engine's rendered_video record. The engine does not hash the MP4 bytes, so no checksum is claimed.
  await sql`
    insert into assets (
      id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status,
      lifecycle, checksum, width, height, byte_size, duration_ms, provider, model, prompt_version, generation_run_id,
      kind, qa_decision, review_status, media_status, variant_index, provenance
    ) values (
      ${assetId}, ${scope.organizationId}, ${scope.brandId}, ${creativeId}, 1, ${renderedVideo.uri}, ${master.recordHash}, ${ENGINE_MIME},
      ${ENGINE_PROVIDER}, 'stored', 'qa_required', '', null, null, ${renderedVideo.bytes}, ${renderedVideo.durationMs}, ${ENGINE_PROVIDER},
      '', '', ${input.runId}, 'video', '', 'in_review', 'completed', 0, 'generated'
    )
    on conflict (id) do nothing
  `;

  await linkCreative(sql, scope, {
    runId: input.runId,
    variantId: req.variant.id,
    format: "video",
    slideIndex: NOT_A_SLIDE,
    creativeId,
    jobId: requestId,
    provider: ENGINE_PROVIDER,
  });
  return { kind: "linked" };
}

/**
 * Starts the engine request for one variant. Nothing is written unless the engine can run the request: readiness, the mapping and the
 * caps are checked first. The request and its link to the run are written in one transaction, so a request is never queued without the
 * link that counts its spend.
 */
async function startEngineVideo(sql: Sql, input: ProduceInput, scope: Scope, req: VideoRequest): Promise<Step> {
  const label = req.label;
  const requestId = engineRequestIdFor(req.jobId, req.plan.createdAt);

  const readiness = await engineReadiness(scope.organizationId, input.engine?.readiness ?? (await productionReadinessPorts(sql)), { variantCount: 0 });
  if (readiness.status === "not_connected") {
    return { kind: "stop", reason: `The video engine is not connected, so no request was sent for ${label}. ${readiness.reasons.join(" ")}` };
  }

  const fields = input.engine?.fields?.({ plan: req.plan, deliverableId: req.planDeliverableId, variantId: req.variant.id }) ?? {};
  const mapped = mapVideoToEngineRequest({
    organizationId: scope.organizationId,
    requestId,
    plan: req.plan,
    deliverableId: req.planDeliverableId,
    engine: fields,
    budgetUsd: input.costPerMasterUsd,
  });
  if (mapped.status !== "mapped") return { kind: "stop", reason: mappingReasonOf(label, mapped) };
  const request = mapped.request;
  const budgetUsd = request.constraints.budgetUsd;

  // A cap that is reached stops the run, and the reservations the run holds are paused. A request that would pass a cap with the spend
  // and the holds of the run is not started. The run is still inside its caps then, so nothing is paused.
  const reached = await capStopOf(sql, input, scope);
  if (reached) {
    await pauseRunEngineSpend(sql, scope.organizationId, scope.brandId, input.runId, reached);
    return { kind: "stop", reason: reached };
  }
  const budgetCents = centsOfUsd(budgetUsd);
  const metered = await meteredSpendOf(sql, scope.organizationId, scope.brandId, input.runId);
  const held = await engineHeldOf(sql, scope.organizationId, scope.brandId, input.runId);
  if (input.caps.totalCents !== null && metered.totalCents + held.totalCents + budgetCents > input.caps.totalCents) {
    return {
      kind: "stop",
      reason: `The video for ${label} has a budget of $${budgetUsd.toFixed(2)}, and with the spend and the holds of this run it would pass the total spend cap, so no request was sent.`,
    };
  }
  if (input.caps.dailyCents !== null && metered.dailyCents + held.dailyCents + budgetCents > input.caps.dailyCents) {
    return {
      kind: "stop",
      reason: `The video for ${label} has a budget of $${budgetUsd.toFixed(2)}, and with the spend and the holds of this run it would pass the daily spend cap, so no request was sent.`,
    };
  }

  const linkRequest = async (tx: Sql): Promise<void> => {
    await tx`
      insert into factory_engine_requests (request_id, organization_id, brand_id, run_id, variant_id, factory_job_id, budget_usd, created_at)
      values (${request.requestId}, ${scope.organizationId}, ${scope.brandId}, ${input.runId}, ${req.variant.id}, ${req.jobId}, ${budgetUsd}, now())
      on conflict do nothing
    `;
  };
  try {
    const started = await startEngineRequest(sql, {
      organizationId: scope.organizationId,
      brandId: scope.brandId,
      request,
      variantCount: 0,
      beforeQueue: linkRequest,
    });
    // A request that already exists in the workspace is linked here, so the run's spend counts it.
    if (started.status === "exists") await linkRequest(sql);
  } catch (error) {
    return { kind: "stop", reason: `The video engine refused the request for ${label}, so nothing was made. ${errorText(error)}` };
  }
  return waiting(`The video engine has accepted the request for ${label} (${request.requestId}) and has not started it yet. The run checks again.`);
}

function waiting(reason: string): Step {
  return { kind: "waiting", reason };
}

/** The reason a mapping that the engine cannot take stops the run. It names the budget or the fields, and nothing is guessed. */
function mappingReasonOf(label: string, mapped: Exclude<EngineMapping, { status: "mapped" }>): string {
  if (mapped.status === "needs_budget") return `${mapped.message} The video for ${label} was not sent to the engine.`;
  return `The video engine needs ${mapped.missing.join(", ")} for ${label}, and the Factory plan does not carry them, so no request was sent.`;
}

function pauseWordsOf(kind: "budget" | "dead_letter"): string {
  return kind === "budget" ? "waiting on the budget" : "a job failed for good";
}

function reviewItemsLine(openItems: number): string {
  if (openItems <= 0) return "No open review item is recorded yet.";
  return `${openItems} open review ${openItems === 1 ? "item is" : "items are"} in the review inbox.`;
}

/** A USD amount in whole cents, rounded up, so a budget is never counted under. It is read in micro-dollars, so float error does not add a cent. */
function centsOfUsd(usd: number): number {
  return Math.ceil(Math.round(usd * 1_000_000) / 10_000);
}
