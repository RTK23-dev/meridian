// The shot remake and decision functions: remake a shot, quote it, replace it with a clip, decide it, and read its take.
// Moved out of engine/api/index.ts unchanged (coding loop, T8). index.ts re-exports the public names.

import { EngineError, newId, productionRequestSchema, scenePlanSchema, takeSchema, takeVerdictSchema, type ProductionRequest, type ScenePlan } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { mediaKey, readArtifact, writeArtifact, type MediaStorePort } from "../jobs/artifact-store.ts";
import type { MediaFunctions } from "../media/interface.ts";
import { takeShapeOf } from "../jobs/handlers/produce-shot.ts";
import { applyEngineEvent, readEngineRequest } from "../jobs/orchestrator-sql.ts";
import { withWorkspaceLedger } from "../jobs/sql-ledger-store.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";
import type { CatalogRead, ModelCatalogSource } from "../gateway/catalog.ts";
import { budgets } from "../config/budgets.ts";
import { committedFor, reserve } from "../budget/reserve.ts";
import { releaseReservation } from "../budget/reconcile.ts";
import { estimatePlan, type ChosenCallPrices } from "../budget/estimate.ts";
import { shotSpecSchema, shotSourceSchema, type ShotSource, type VisualType } from "../contracts/plan.ts";
import { shotSummaryOf } from "../jobs/handlers/plan.ts";
import { shotChangeFor, type ShotDecision } from "../review/shot-decision.ts";
import { modelChoiceSchema as modelChoiceContract, type ModelChoice } from "../contracts/assets.ts";
import { contentHash } from "../contracts/hash.ts";
import type { ReviewerTake } from "../jobs/types.ts";
import { needFor, catalogCallUsd } from "../assets/model-choice.ts";
import { eligibleCandidates, rejectionOf, type ModelNeed } from "../gateway/catalog-fit.ts";
import { chosenCallPricesOf, SINGLE_CALL_OUTPUT } from "../plan/model-choices.ts";
import type { ModelCatalogEntry } from "../contracts/catalog.ts";
import type { ShotSummary } from "../jobs/types.ts";
import { sumUsd } from "../contracts/money.ts";
import { ENGINE_MEDIA_LINK_TTL_SECONDS, type MediaLinkSigner } from "../jobs/media-link.ts";
import { modelChoicesSchema } from "../contracts/model-choices.ts";
import { remakeRefusalOf, type OrchestratorState } from "../jobs/orchestrator.ts";
import { remakeDirectiveOf } from "../jobs/remake.ts";
import { productionReadinessPorts } from "./readiness.ts";

// --- Remakes (Bible 5.5) -----------------------------------------------------------------------------------------------------

export type RemakeInput = {
  organizationId: string;
  requestId: string;
  shotId: string;
  /** The reviewer's direction for the shot, as typed. Null or blank: no direction. */
  directive: string | null;
  /** When the reviewer asked, as an ISO time. The event carries it, so replaying the event gives the same state. */
  now: string;
  /** Replaces the shot's visual type and source (D7). Absent: the shot is made again as it was. */
  replacement?: ShotReplacement | null;
  /** The reviewer's model for this shot's remake, by its catalog id (D11). Absent: the orchestrator's choice. Generated shots only. */
  modelId?: string | null;
  /** The reviewer's own clip for this shot (D12). It replaces the shot's source and is accepted as its take. */
  clip?: ReviewerClipInput | null;
};

/** A shot's new visual type and source, for a remake that changes what the shot is (D7). The shot keeps its beat, its timing and its layer. */

export type ShotReplacement = { visualType: VisualType; source: ShotSource };

/** What a remake reads to price itself: the workspace's monthly budget, and the model catalog that prices the chosen models (Bible 10.5). */

export type RemakePorts = {
  monthBudget: WorkspaceBudgetSource;
  catalog?: ModelCatalogSource;
  /** Probes a clip the reviewer supplies (D12). Absent: a clip is refused. */
  media?: Pick<MediaFunctions, "probe">;
  /** Stores a clip the reviewer supplies, as the take's media. Absent: a clip is refused. */
  objects?: MediaStorePort;
};

/** The shape a clip must state: its duration and its size, as the probe read them (takeShapeOf). */

export type ClipShape = { durationMs: number; width: number; height: number };

/**
 * A clip a reviewer supplies for one shot (D12). The bytes are the file to store. A quote passes the shape alone (bytes null), since the
 * price does not depend on the file.
 */
export type ReviewerClipInput = { shape: ClipShape; bytes: Uint8Array | null };

export type RemakeResult = { status: "queued"; revision: number; reservationId: string } | { status: "refused"; reasons: string[] };

/** What the checks before a remake read: the video's record, the shot, the month's budget and the revision the remake would make. */

type RemakeContext = {
  organizationId: string;
  requestId: string;
  planId: string;
  state: OrchestratorState;
  plan: ScenePlan;
  request: ProductionRequest;
  shot: ScenePlan["shots"][number];
  month: { usd: number };
  catalog: ModelCatalogSource | undefined;
  revision: number;
};

/**
 * The checks every remake passes before it reserves anything (Bible 5.5). Read only: nothing is written. A refusal names its reasons.
 */
async function remakeContextOf(sql: Sql, input: { organizationId: string; requestId: string; shotId: string; now: string }, ports?: RemakePorts): Promise<{ ok: true; context: RemakeContext } | { ok: false; reasons: string[] }> {
  const read = await readEngineRequest(sql, input.organizationId, input.requestId);
  if (!read) throw new EngineError("not_found", `request ${input.requestId} is not in this workspace`);
  const state = read.state;
  const refusal = remakeRefusalOf(state, input.shotId);
  if (refusal !== null) return { ok: false, reasons: [refusal] };

  const planId = state.artifacts.plan;
  const requestId = state.artifacts.request;
  if (planId === undefined || requestId === undefined) {
    return { ok: false, reasons: ["this video has no plan or request record to price a remake from"] };
  }
  const plan = scenePlanSchema.parse((await readArtifact(sql, { organizationId: input.organizationId, artifactId: planId })).envelope.body);
  const request = productionRequestSchema.parse((await readArtifact(sql, { organizationId: input.organizationId, artifactId: requestId })).envelope.body);
  const shot = plan.shots.find((candidate) => candidate.shotId === input.shotId);
  if (shot === undefined) return { ok: false, reasons: ["That shot is not in the plan of this video."] };
  const resolved = ports ?? (await productionRemakePorts(sql));

  const month = await resolved.monthBudget.monthBudget({ organizationId: input.organizationId, requestId: input.requestId, now: input.now });
  if (month.status !== "known") return { ok: false, reasons: [month.reason] };
  return {
    ok: true,
    context: { organizationId: input.organizationId, requestId: input.requestId, planId, state, plan, request, shot, month, catalog: resolved.catalog, revision: (state.revision ?? 0) + 1 },
  };
}

/**
 * Makes one accepted shot of a delivered video again (Bible 5.5). The remake reserves its own estimate first: the shot's take, the edit
 * that follows, the render and the review, with the fixed per-master lines. The event is applied only with that reservation held. When
 * the event is refused, or another remake of the same revision got there first, the reservation is released, so no money stays held
 * for a remake that did not happen. A refusal names its reasons and changes nothing.
 */
export async function remakeEngineShot(sql: Sql, input: RemakeInput, ports?: RemakePorts): Promise<RemakeResult> {
  let directive: string | null;
  try {
    directive = remakeDirectiveOf(input.directive);
  } catch (error) {
    return { status: "refused", reasons: [messageOf(error)] };
  }
  const checked = await remakeContextOf(sql, input, ports);
  if (!checked.ok) return { status: "refused", reasons: checked.reasons };
  const { context } = checked;
  if (context.state.status === "running") return remakeWhileMaking(sql, input, context, directive);

  // A reviewer's clip (D12) is the shot's new source. Its store uri is named before the plan is written, so the plan and the take agree.
  const clipped = input.clip ? clipPlanOf(input.clip, input, context) : null;
  if (typeof clipped === "string") return { status: "refused", reasons: [clipped] };
  const storage = clipped !== null ? (ports ?? (await productionRemakePorts(sql))) : null;
  if (clipped !== null && (storage?.objects === undefined || storage.media === undefined)) {
    return { status: "refused", reasons: ["this runtime cannot read or store a clip, so the clip is not used"] };
  }
  const replacement = clipped !== null ? clipReplacementOf(context, input.replacement, clipped.uri) : (input.replacement ?? null);

  const reservationId = newId("res_");
  let replaced: ReplacedPlan | null = null;
  let modelChoice: ModelChoice | null = null;
  try {
    replaced = replacement ? await replacedPlanOf(sql, context, replacement, clipped !== null) : null;
    const picked = await pickedRemake(sql, context, replaced, input.modelId ?? null);
    modelChoice = picked.modelChoice;
    const chosenPrices = picked.chosenPrices;
    const reservedPlan = picked.plan;
    const reservedShot = picked.shot;
    const reserved = await withWorkspaceLedger(sql, input.organizationId, (store) =>
      reserve(store, {
        requestId: input.requestId,
        workspaceId: input.organizationId,
        mode: budgets.productionMode,
        plan: { ...reservedPlan, shots: [reservedShot] },
        requestBudgetUsd: context.request.constraints.budgetUsd,
        workspaceMonthBudgetUsd: context.month.usd,
        now: input.now,
        reservationId,
        ...(chosenPrices === undefined ? {} : { chosenPrices }),
      }),
    );
    if (reserved.reservation.state !== "reserved") {
      return { status: "refused", reasons: [reserved.reservation.pausedReason ?? "the remake would take the request or the month over its budget"] };
    }
  } catch (error) {
    return { status: "refused", reasons: [messageOf(error)] };
  }

  try {
    // A replacement's plan is written before the event that names it, so the event carries the artifact it applies.
    const planArtifactId = replaced === null ? null : (await writeReplacedPlan(sql, input, context, replaced.plan)).artifactId;
    const reviewerTake = clipped === null || storage?.objects === undefined ? null : await writeReviewerTake(sql, input, clipped, planArtifactId, storage.objects);
    const outcome = await applyEngineEvent(sql, {
      organizationId: input.organizationId,
      requestId: input.requestId,
      event: {
        type: "remake",
        shotId: input.shotId,
        directive,
        budgetReservationId: reservationId,
        at: input.now,
        planArtifactId,
        replacement: replaced?.summary ?? null,
        modelChoice,
        reviewerTake,
      },
      dedupeKey: `remake|${input.requestId}|${input.shotId}|${context.revision}`,
    });
    if (outcome.applied) return { status: "queued", revision: context.revision, reservationId };
    // Another click made this revision first. Its reservation is the one in force, and this one is not used.
    await releaseRemakeReservation(sql, input.organizationId, reservationId);
    const current = await readEngineRequest(sql, input.organizationId, input.requestId);
    return { status: "queued", revision: current?.state.revision ?? context.revision, reservationId: current?.state.budgetReservationId ?? reservationId };
  } catch (error) {
    await releaseRemakeReservation(sql, input.organizationId, reservationId);
    return { status: "refused", reasons: [messageOf(error)] };
  }
}

/** A remake's plan with one shot replaced (D7): the new shot, the plan holding it, its estimate, and the summary the orchestrator takes. */

type ReplacedPlan = { plan: ScenePlan; shot: ScenePlan["shots"][number]; summary: ShotSummary; chosenPrices: ChosenCallPrices | undefined };

/**
 * The plan with its shot replaced. The shot keeps its id, beat, timing and layer; its visual type and source are the replacement's. Its
 * estimate is priced the way reserve() prices it. Throws when the replacement is not a valid shot or is not one a take makes.
 */
async function replacedPlanOf(sql: Sql, context: RemakeContext, replacement: ShotReplacement, allowAsset = false): Promise<ReplacedPlan> {
  const original = context.plan.shots.find((candidate) => candidate.shotId === context.shot.shotId);
  if (original === undefined) throw new EngineError("invalid_input", "that shot is not in the plan of this video", { stage: "produce_shot" });
  const shot = shotSpecSchema.parse({
    ...original,
    visualType: replacement.visualType,
    source: shotSourceSchema.parse(replacement.source),
    downgradeTo: original.downgradeTo === replacement.visualType ? undefined : original.downgradeTo,
  });
  // Only a shot that a take makes can be replaced: the produce path is the one that makes it. Refused before anything is written.
  const takes = shot.source.kind === "generate" || shot.source.kind === "stock" || shot.source.kind === "chain";
  if (!takes && !(allowAsset && shot.source.kind === "asset")) {
    throw new EngineError("invalid_input", "a replacement must be a shot that a take makes (generate, stock or chain), or the reviewer's own clip", { stage: "produce_shot" });
  }
  const draft = scenePlanSchema.parse({ ...context.plan, shots: context.plan.shots.map((candidate) => (candidate.shotId === shot.shotId ? shot : candidate)) });
  const chosenPrices = await chosenPricesFor({ sql, organizationId: context.organizationId, state: context.state, plan: draft, catalog: context.catalog });
  const estimate = estimatePlan(draft, chosenPrices ?? new Map());
  return {
    plan: scenePlanSchema.parse({ ...draft, estimatedUsd: estimate.shotsUsd }),
    shot,
    summary: shotSummaryOf(shot),
    chosenPrices,
  };
}

/**
 * A change to a shot still being made (D10): its direction and its model, on the video's own reservation. The new call is authorized against
 * that reservation when it is made, so a change that does not fit pauses the video for budget rather than overrunning it. Its source changes
 * wait for delivery, when the video's shots are final.
 */
async function remakeWhileMaking(sql: Sql, input: RemakeInput, context: RemakeContext, directive: string | null): Promise<RemakeResult> {
  if (input.replacement || input.clip) {
    return { status: "refused", reasons: ["A shot's visual type and source change once the video is delivered. While it is being made, its direction and model change."] };
  }
  const reservationId = context.state.budgetReservationId;
  if (!reservationId) return { status: "refused", reasons: ["the video has no budget reservation yet, so the shot cannot be changed until it has one"] };
  let modelChoice: ModelChoice | null;
  try {
    modelChoice = (await pickedRemake(sql, context, null, input.modelId ?? null)).modelChoice;
  } catch (error) {
    return { status: "refused", reasons: [messageOf(error)] };
  }
  const changes = (context.state.shots[input.shotId]?.remakes ?? 0) + 1;
  try {
    const outcome = await applyEngineEvent(sql, {
      organizationId: input.organizationId,
      requestId: input.requestId,
      event: { type: "remake", shotId: input.shotId, directive, budgetReservationId: reservationId, at: input.now, modelChoice },
      dedupeKey: `change|${input.requestId}|${input.shotId}|${changes}`,
    });
    const current = outcome.applied ? null : await readEngineRequest(sql, input.organizationId, input.requestId);
    return { status: "queued", revision: current?.state.revision ?? context.state.revision ?? 0, reservationId: current?.state.budgetReservationId ?? reservationId };
  } catch (error) {
    return { status: "refused", reasons: [messageOf(error)] };
  }
}

/** A quote of a change to a shot still being made: its estimate, and whether the video's reservation has room for it (D10). Read only. */

async function quoteWhileMaking(sql: Sql, input: Omit<RemakeInput, "directive">, context: RemakeContext): Promise<RemakeQuote> {
  if (input.replacement || input.clip) {
    return { status: "refused", reasons: ["A shot's visual type and source change once the video is delivered. While it is being made, its direction and model change."] };
  }
  const reservationId = context.state.budgetReservationId;
  if (!reservationId) return { status: "refused", reasons: ["the video has no budget reservation yet, so the shot cannot be changed until it has one"] };
  try {
    const picked = await pickedRemake(sql, context, null, input.modelId ?? null);
    const estimate = estimatePlan({ ...picked.plan, shots: [picked.shot] }, picked.chosenPrices ?? new Map());
    const { reservedUsd, committedUsd } = await withWorkspaceLedger(sql, input.organizationId, async (store) => ({
      reservedUsd: (await store.getReservation(reservationId))?.reservedUsd ?? 0,
      committedUsd: await committedFor(store, reservationId),
    }));
    const projected = sumUsd([committedUsd, estimate.estimateUsd]);
    const reasons = projected > reservedUsd ? [`the change would take the video's reservation to $${projected.toFixed(4)}, above its $${reservedUsd.toFixed(4)}`] : [];
    return {
      status: "quoted",
      revision: context.state.revision ?? 0,
      estimateUsd: estimate.estimateUsd,
      reservedUsd: estimate.estimateUsd,
      redoAllowanceUsd: estimate.redoAllowanceUsd,
      fits: reasons.length === 0,
      reasons,
    };
  } catch (error) {
    return { status: "refused", reasons: [messageOf(error)] };
  }
}

/** A remake's pricing inputs: the plan and shot it reserves, its chosen prices, and the reviewer's model when one is picked (D11). */

type PickedRemake = { plan: ScenePlan; shot: ScenePlan["shots"][number]; chosenPrices: ChosenCallPrices | undefined; modelChoice: ModelChoice | null };

async function pickedRemake(sql: Sql, context: RemakeContext, replaced: ReplacedPlan | null, modelId: string | null): Promise<PickedRemake> {
  const plan = replaced?.plan ?? context.plan;
  const shot = replaced?.shot ?? context.shot;
  if (modelId === null) {
    const chosenPrices = replaced !== null ? replaced.chosenPrices : await chosenPricesFor({ sql, organizationId: context.organizationId, state: context.state, plan, catalog: context.catalog });
    return { plan, shot, chosenPrices, modelChoice: null };
  }
  const picked = await reviewerChoiceFor(context, plan, shot, modelId);
  return { plan, shot, chosenPrices: picked.prices, modelChoice: picked.modelChoice };
}

/**
 * The reviewer's pick of a model for one generated shot (D11). The model must be in the live catalog and eligible for the shot's need, as
 * the orchestrator's candidates are. It is priced the way the orchestrator's choices are, so the reserve and the take use one price.
 */
async function reviewerChoiceFor(context: RemakeContext, plan: ScenePlan, shot: ScenePlan["shots"][number], modelId: string): Promise<{ modelChoice: ModelChoice; prices: ChosenCallPrices }> {
  if (shot.source.kind !== "generate") throw new EngineError("invalid_input", "only a generated shot has a model to choose", { stage: "produce_shot" });
  if (context.catalog === undefined) throw new EngineError("config", "this runtime has no model catalog, so no model can be chosen", { stage: "produce_shot" });
  const read = await context.catalog.read(context.organizationId);
  if (read.status !== "read") throw new EngineError("config", `the model catalog is not connected: ${read.reason}`, { stage: "produce_shot" });
  const entry = read.catalog.entries.find((candidate) => candidate.id === modelId);
  if (entry === undefined) throw new EngineError("invalid_input", `${modelId} is not in the live catalog`, { stage: "produce_shot" });
  const rejection = rejectionOf(modelNeedOf(shot), entry);
  if (rejection !== null) throw new EngineError("invalid_input", `${modelId} cannot make this shot: ${rejection.detail}`, { stage: "produce_shot" });
  const modelChoice = modelChoiceContract.parse({ provider: "openrouter", modelId, source: "reviewer", reason: "chosen by the reviewer for this remake", catalogReadAt: read.catalog.readAt });
  const choices = modelChoicesSchema.parse({
    schema: "meridian.model_choices/v1",
    requestId: context.requestId,
    catalogReadAt: read.catalog.readAt,
    choices: [{ shotId: shot.shotId, output: SINGLE_CALL_OUTPUT, modelClass: shot.source.modelClass, modelChoice }],
  });
  return { modelChoice, prices: chosenCallPricesOf({ plan, choices, catalog: read }).prices };
}

/** The need a generated shot states, for the catalog's eligibility rules (assets/model-choice.ts needFor). */

function modelNeedOf(shot: ScenePlan["shots"][number]): ModelNeed {
  if (shot.source.kind !== "generate") throw new EngineError("invalid_input", "only a generated shot has a model to choose", { stage: "produce_shot" });
  return needFor({
    modelClass: shot.source.modelClass,
    durationMs: shot.endMs - shot.startMs,
    firstFrame: shot.source.firstFrame !== undefined,
    lastFrame: shot.source.lastFrame !== undefined,
    refCount: shot.source.refs.length,
  });
}

export type ShotModelOptions =
  | { status: "ok"; takenAt: string; options: Array<{ modelId: string; usdPerCall: number | null }> }
  | { status: "refused"; reasons: string[] };

/**
 * The models a reviewer may pick for one generated shot: the live catalog's candidates that are eligible for the shot (D11), with the price of
 * one call where the listing states one. Read only.
 */
export async function shotModelOptions(sql: Sql, input: { organizationId: string; requestId: string; shotId: string; now: string }, ports?: RemakePorts): Promise<ShotModelOptions> {
  const checked = await remakeContextOf(sql, input, ports);
  if (!checked.ok) return { status: "refused", reasons: checked.reasons };
  const { context } = checked;
  if (context.shot.source.kind !== "generate") return { status: "refused", reasons: ["only a generated shot has a model to choose"] };
  if (context.catalog === undefined) return { status: "refused", reasons: ["this runtime has no model catalog, so no model can be chosen"] };
  const read = await context.catalog.read(input.organizationId);
  if (read.status !== "read") return { status: "refused", reasons: [`the model catalog is not connected: ${read.reason}`] };
  const need = modelNeedOf(context.shot);
  const durationMs = context.shot.endMs - context.shot.startMs;
  const options = eligibleCandidates(need, read.catalog.entries).eligible.map((entry) => ({
    modelId: entry.id,
    usdPerCall: priceOfCall(entry, durationMs),
  }));
  options.sort((a, b) => (a.usdPerCall ?? Number.MAX_SAFE_INTEGER) - (b.usdPerCall ?? Number.MAX_SAFE_INTEGER) || a.modelId.localeCompare(b.modelId));
  return { status: "ok", takenAt: read.catalog.readAt, options };
}

/** One call's price in USD where the listing states it (a per-token price is not known before the call), otherwise null. */

function priceOfCall(entry: ModelCatalogEntry, durationMs: number): number | null {
  try {
    return catalogCallUsd(entry, durationMs);
  } catch {
    return null;
  }
}

/** A clip as the remake plans it: its shape, its bytes (null for a quote), and the ids and store uri its take will have. */

type ClipPlan = { shape: ClipShape; bytes: Uint8Array | null; artifactId: string; takeId: string; uri: string };

/** A clip's plan, or the reason it does not fit the shot: a clip must cover the shot's length. */

function clipPlanOf(clip: ReviewerClipInput, input: { organizationId: string; requestId: string }, context: RemakeContext): ClipPlan | string {
  const span = context.shot.endMs - context.shot.startMs;
  if (clip.shape.durationMs < span) return `the clip is ${clip.shape.durationMs} ms, shorter than the shot's ${span} ms`;
  const artifactId = newId("art_");
  const uri = mediaKey({ workspaceId: input.organizationId, requestId: input.requestId, stage: "produce_shot", artifactId, extension: "mp4" });
  return { shape: clip.shape, bytes: clip.bytes, artifactId, takeId: newId("take_"), uri };
}

/** The replacement a clip makes of the shot: the shot keeps its visual type unless the reviewer changed it, and its source is the clip. */

function clipReplacementOf(context: RemakeContext, replacement: ShotReplacement | null | undefined, uri: string): ShotReplacement {
  return { visualType: replacement?.visualType ?? context.shot.visualType, source: { kind: "asset", assetUri: uri } };
}

/** The clip's take, stored with its media, as a take of the request. The reviewer supplied it, so it cost nothing and was checked by no model. */

async function writeReviewerTake(sql: Sql, input: RemakeInput, clip: ClipPlan, planArtifactId: string | null, objects: MediaStorePort): Promise<ReviewerTake> {
  if (clip.bytes === null) throw new EngineError("invalid_input", "a clip is stored only for a remake, not for a quote", { stage: "produce_shot" });
  const rows = (await sql<{ brand_id: string | null }>`
    select brand_id from engine_requests where id = ${input.requestId} and organization_id = ${input.organizationId} limit 1
  `) as Array<{ brand_id: string | null }>;
  const brandId = rows[0]?.brand_id ?? null;
  if (brandId === null) throw new EngineError("invalid_input", "the request has no brand, so the clip cannot be stored (Bible 5.2)", { stage: "produce_shot" });
  const take = takeSchema.parse({
    schema: "meridian.take/v1",
    takeId: clip.takeId,
    shotId: input.shotId,
    attempt: 1,
    provider: "reviewer",
    model: "upload",
    uri: clip.uri,
    durationMs: clip.shape.durationMs,
    width: clip.shape.width,
    height: clip.shape.height,
    promptHash: contentHash({ reviewerClip: clip.uri }),
    costUsd: 0,
    latencyMs: 0,
  });
  const takeArtifact = await writeArtifact(sql, {
    organizationId: input.organizationId,
    requestId: input.requestId,
    stage: "produce_shot",
    type: "take",
    body: take,
    parentIds: planArtifactId === null ? [] : [planArtifactId],
    createdAt: input.now,
    artifactId: clip.artifactId,
    media: { store: objects, brandId, extension: "mp4", bytes: clip.bytes },
  });
  // The reviewer accepted the clip: that acceptance is the take's verdict, stored as the check stage stores one.
  const verdict = takeVerdictSchema.parse({ takeId: clip.takeId, pass: true, confidence: 1, checks: [{ rule: "reviewer.accepted", pass: true }], action: "accept" });
  const verdictArtifact = await writeArtifact(sql, {
    organizationId: input.organizationId,
    requestId: input.requestId,
    stage: "check_take",
    type: "take_verdict",
    body: verdict,
    parentIds: [takeArtifact.artifactId],
    createdAt: input.now,
  });
  return {
    takeId: clip.takeId,
    artifactId: takeArtifact.artifactId,
    uri: clip.uri,
    durationMs: clip.shape.durationMs,
    width: clip.shape.width,
    height: clip.shape.height,
    verdict,
    verdictArtifactId: verdictArtifact.artifactId,
  };
}

/**
 * A reviewer's own clip for one shot (D12). The file is probed: it must be an H.264 MP4 with a readable duration and size, and it must cover
 * the shot. Then the remake runs with the clip as the shot's take, with its own reservation for the fixed lines of the master. A refusal
 * names its reasons and stores nothing.
 */
export async function replaceShotWithClip(sql: Sql, input: { organizationId: string; requestId: string; shotId: string; bytes: Uint8Array<ArrayBuffer>; now: string }, ports?: RemakePorts): Promise<RemakeResult> {
  const storage = ports ?? (await productionRemakePorts(sql));
  if (storage.media === undefined || storage.objects === undefined) {
    return { status: "refused", reasons: ["this runtime cannot read or store a clip"] };
  }
  let probe: Awaited<ReturnType<MediaFunctions["probe"]>>;
  try {
    probe = await storage.media.probe({ source: { kind: "bytes", bytes: input.bytes } });
  } catch (error) {
    return { status: "refused", reasons: [`the clip could not be read: ${messageOf(error)}`] };
  }
  const shape = takeShapeOf(probe);
  if (shape === null) return { status: "refused", reasons: ["the clip must be an H.264 MP4 at the take size, with a readable duration"] };
  return remakeEngineShot(sql, { organizationId: input.organizationId, requestId: input.requestId, shotId: input.shotId, directive: null, now: input.now, clip: { shape, bytes: input.bytes } }, storage);
}

/** The plan of a replacement, stored as the request's scene plan. Its parent is the plan it replaces, so the record keeps the history. */

function writeReplacedPlan(sql: Sql, input: RemakeInput, context: RemakeContext, plan: ScenePlan) {
  return writeArtifact(sql, {
    organizationId: input.organizationId,
    requestId: input.requestId,
    stage: "plan",
    type: "scene_plan",
    body: plan,
    parentIds: [context.planId],
    createdAt: input.now,
  });
}

/**
 * What a remake would reserve, and whether the reservation would fit (the same checks reserve() makes). Read only: nothing is reserved,
 * queued or called. `fits` false means the remake would be refused, and `reasons` says why.
 */
export type RemakeQuote =
  | { status: "quoted"; revision: number; estimateUsd: number; reservedUsd: number; redoAllowanceUsd: number; fits: boolean; reasons: string[] }
  | { status: "refused"; reasons: string[] };

export async function quoteEngineShotRemake(sql: Sql, input: Omit<RemakeInput, "directive">, ports?: RemakePorts): Promise<RemakeQuote> {
  const checked = await remakeContextOf(sql, input, ports);
  if (!checked.ok) return { status: "refused", reasons: checked.reasons };
  const { context } = checked;
  if (context.state.status === "running") return quoteWhileMaking(sql, input, context);
  try {
    const clipped = input.clip ? clipPlanOf(input.clip, input, context) : null;
    if (typeof clipped === "string") return { status: "refused", reasons: [clipped] };
    const replacement = clipped !== null ? clipReplacementOf(context, input.replacement, clipped.uri) : (input.replacement ?? null);
    const replaced = replacement ? await replacedPlanOf(sql, context, replacement, clipped !== null) : null;
    const picked = await pickedRemake(sql, context, replaced, input.modelId ?? null);
    const estimate = estimatePlan({ ...picked.plan, shots: [picked.shot] }, picked.chosenPrices ?? new Map());
    const reasons: string[] = [];
    if (estimate.reservedUsd > context.request.constraints.budgetUsd) {
      reasons.push(`the remake would take the request over its $${context.request.constraints.budgetUsd.toFixed(4)} budget`);
    }
    const totals = await withWorkspaceLedger(sql, input.organizationId, (store) => store.sumForMonth(input.organizationId, input.now.slice(0, 7)));
    const monthUsd = sumUsd([totals.reservedUsd, estimate.reservedUsd]);
    if (monthUsd > context.month.usd) reasons.push(`the remake would take the workspace month over its $${context.month.usd.toFixed(4)} budget`);
    return {
      status: "quoted",
      revision: context.revision,
      estimateUsd: estimate.estimateUsd,
      reservedUsd: estimate.reservedUsd,
      redoAllowanceUsd: estimate.redoAllowanceUsd,
      fits: reasons.length === 0,
      reasons,
    };
  } catch (error) {
    return { status: "refused", reasons: [messageOf(error)] };
  }
}

/** A reviewer's change to one shot, as the decision it is (review/shot-decision.ts). */

export type DecideInput = { organizationId: string; requestId: string; shotId: string; decision: ShotDecision; now: string; modelId?: string | null };

/**
 * Applies a reviewer's change to one shot (the review inbox's edit_prompt and change_visual_type, Bible 12.5): the change is a replacement
 * of the shot's spec (D7), and the remake runs as any remake does, with its own reservation. A refusal names its reasons.
 */
export async function decideEngineShot(sql: Sql, input: DecideInput, ports?: RemakePorts): Promise<RemakeResult> {
  const checked = await remakeContextOf(sql, input, ports);
  if (!checked.ok) return { status: "refused", reasons: checked.reasons };
  const change = shotChangeFor(checked.context.shot, input.decision);
  if (!change.ok) return { status: "refused", reasons: [change.reason] };
  return remakeEngineShot(sql, { organizationId: input.organizationId, requestId: input.requestId, shotId: input.shotId, directive: null, now: input.now, replacement: change.change, modelId: input.modelId ?? null }, ports);
}

/** What a reviewer's change would reserve, before it is confirmed. Read only, as quoteEngineShotRemake. */

export async function quoteEngineDecision(sql: Sql, input: DecideInput, ports?: RemakePorts): Promise<RemakeQuote> {
  const checked = await remakeContextOf(sql, input, ports);
  if (!checked.ok) return { status: "refused", reasons: checked.reasons };
  const change = shotChangeFor(checked.context.shot, input.decision);
  if (!change.ok) return { status: "refused", reasons: [change.reason] };
  return quoteEngineShotRemake(sql, { organizationId: input.organizationId, requestId: input.requestId, shotId: input.shotId, now: input.now, replacement: change.change, modelId: input.modelId ?? null }, ports);
}

/** What a reviewer's clip would reserve for one shot, before it is confirmed: the file is probed, and nothing is stored or reserved (D12). */

export async function quoteEngineClip(sql: Sql, input: { organizationId: string; requestId: string; shotId: string; bytes: Uint8Array<ArrayBuffer>; now: string }, ports?: RemakePorts): Promise<RemakeQuote> {
  const storage = ports ?? (await productionRemakePorts(sql));
  if (storage.media === undefined) return { status: "refused", reasons: ["this runtime cannot read a clip"] };
  let probe: Awaited<ReturnType<MediaFunctions["probe"]>>;
  try {
    probe = await storage.media.probe({ source: { kind: "bytes", bytes: input.bytes } });
  } catch (error) {
    return { status: "refused", reasons: [`the clip could not be read: ${messageOf(error)}`] };
  }
  const shape = takeShapeOf(probe);
  if (shape === null) return { status: "refused", reasons: ["the clip must be an H.264 MP4 at the take size, with a readable duration"] };
  return quoteEngineShotRemake(sql, { organizationId: input.organizationId, requestId: input.requestId, shotId: input.shotId, now: input.now, clip: { shape, bytes: null } }, storage);
}

/** The take a shot shows: its accepted take, or else its newest take made in the current plan epoch. Null when the shot has none. */

export function takeOfShot(state: OrchestratorState, shotId: string): string | null {
  const shot = state.shots[shotId];
  if (shot === undefined) return null;
  if (shot.acceptedTakeId !== null) return shot.acceptedTakeId;
  const current = Object.values(state.takes).filter((take) => take.shotId === shotId && take.epoch === shot.epoch && !take.stale);
  return current.at(-1)?.takeId ?? null;
}

export type ShotTakeLink =
  | { status: "ready"; url: string; takeId: string; ttlSeconds: number }
  | { status: "not_ready"; reason: string }
  | { status: "not_connected" | "refused"; reason: string };

/**
 * A short-lived link to the take a shot shows, for a reviewer to watch (the media route serves it to the request's organization only).
 * Read only. The link is never logged and never stored. A take with no record that matches its contract is refused, not linked.
 */
export async function shotTakeLink(sql: Sql, input: { organizationId: string; requestId: string; shotId: string }, signer: MediaLinkSigner): Promise<ShotTakeLink> {
  const read = await readEngineRequest(sql, input.organizationId, input.requestId);
  if (!read) throw new EngineError("not_found", `request ${input.requestId} is not in this workspace`);
  const takeId = takeOfShot(read.state, input.shotId);
  if (takeId === null) return { status: "not_ready", reason: "This shot has no take yet." };
  const artifactId = read.state.artifacts[`take:${takeId}`];
  if (artifactId === undefined) return { status: "not_ready", reason: "The take is not stored yet." };
  const parsed = takeSchema.safeParse((await readArtifact(sql, { organizationId: input.organizationId, artifactId })).envelope.body);
  if (!parsed.success) return { status: "refused", reason: "The take's record does not match its contract, so no link is made." };
  const result = await signer.sign(input.organizationId, parsed.data.uri, ENGINE_MEDIA_LINK_TTL_SECONDS);
  if (result.status === "ok") return { status: "ready", url: result.url, takeId, ttlSeconds: ENGINE_MEDIA_LINK_TTL_SECONDS };
  return { status: result.status, reason: result.reason };
}

/** The chosen models' catalog prices for a remake (Bible 10.5), read the way estimate_reserve reads them. Absent: no model was chosen. */

async function chosenPricesFor(input: {
  sql: Sql;
  organizationId: string;
  state: OrchestratorState;
  plan: ScenePlan;
  catalog: ModelCatalogSource | undefined;
}): Promise<ChosenCallPrices | undefined> {
  const slot = input.state.artifacts.model_choices;
  if (slot === undefined) return undefined;
  const choices = modelChoicesSchema.parse((await readArtifact(input.sql, { organizationId: input.organizationId, artifactId: slot })).envelope.body);
  const catalog: CatalogRead =
    input.catalog === undefined ? { status: "not_connected", reason: "this runtime has no model catalog" } : await input.catalog.read(input.organizationId);
  return chosenCallPricesOf({ plan: input.plan, choices, catalog }).prices;
}

async function releaseRemakeReservation(sql: Sql, organizationId: string, reservationId: string): Promise<void> {
  await withWorkspaceLedger(sql, organizationId, (store) => releaseReservation(store, reservationId));
}

/** The production ports of a remake: the workspace's monthly budget and the composition's model catalog. */

export async function productionRemakePorts(sql: Sql): Promise<RemakePorts> {
  const [{ monthBudget }, { productionComposition }] = await Promise.all([productionReadinessPorts(sql), import("../jobs/runtime.ts")]);
  const shot = productionComposition(sql).shotPorts;
  return { monthBudget, catalog: shot?.catalog, media: shot?.media, objects: shot?.objects };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "the remake was not made";
}
