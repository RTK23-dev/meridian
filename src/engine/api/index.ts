// The engine's API for Meridian (lead task I1 to I3). The Factory and the review inbox reach the engine through these functions
// only: start a request, read its status, read a delivered master, read the spend on its ledger, pause its reservations, list its
// open review items, and check that the engine can run at all. Nothing here calls a provider or reads a key: readiness asks the
// credential source whether a key is connected, and the answer never carries the secret.
//
// Fail closed: a request the engine cannot run is NOT_CONNECTED with its reasons, an unknown state is reported as it is, and no
// status is guessed. Tenancy: every read and write is scoped to the request's own workspace (organization_id).

import { z } from "zod";
import {
  EngineError,
  edlSchema,
  manifestSchema,
  newId,
  productionRequestSchema,
  writtenScriptSchema,
  renderedVideoSchema,
  roundUsd,
  scenePlanSchema,
  takeSchema,
  takeVerdictSchema,
  validatedRequestSchema,
  videoDnaSchema,
  voiceTrackSchema,
  type Manifest,
  type ProductionRequest,
  type RenderedVideo,
  type ScenePlan,
} from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { readArtifact, writeArtifact } from "../jobs/artifact-store.ts";
import { applyEngineEvent, readEngineRequest, startEngineRequest as startOrchestratorRequest } from "../jobs/orchestrator-sql.ts";
import { ENGINE_STAGES, type EngineStage } from "../jobs/registry.ts";
import { sqlLedgerStore, withReservationLedger, withWorkspaceLedger } from "../jobs/sql-ledger-store.ts";
import type { EngineRuntime } from "../jobs/types.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";
import type { BudgetReservation } from "../contracts/index.ts";
import type { CredentialSource } from "../gateway/types.ts";
import type { CatalogRead, ModelCatalogSource } from "../gateway/catalog.ts";
import type { GoldMetrics } from "../review/gold.ts";
import { takeReviewItemSchema } from "../review/inbox.ts";
import { routes } from "../config/routes.ts";
import { budgets } from "../config/budgets.ts";
import { reserve } from "../budget/reserve.ts";
import { releaseReservation } from "../budget/reconcile.ts";
import { estimatePlan, type ChosenCallPrices } from "../budget/estimate.ts";
import { shotSpecSchema, shotSourceSchema, type ShotSource, type VisualType } from "../contracts/plan.ts";
import { shotSummaryOf } from "../jobs/handlers/plan.ts";
import type { ShotSummary } from "../jobs/types.ts";
import { sumUsd } from "../contracts/money.ts";
import { ENGINE_MEDIA_LINK_TTL_SECONDS, type MediaLinkSigner } from "../jobs/media-link.ts";
import { modelChoicesSchema } from "../contracts/model-choices.ts";
import { chosenCallPricesOf } from "../plan/model-choices.ts";
import { remakeRefusalOf, type OrchestratorState } from "../jobs/orchestrator.ts";
import { remakeDirectiveOf } from "../jobs/remake.ts";

// --- Start -----------------------------------------------------------------------------------------------------------------

export type StartInput = {
  organizationId: string;
  brandId: string | null;
  /** The production request. It is validated here with the engine's own schema, so anything else is refused before a row exists. */
  request: unknown;
  /** Variants the request will make besides its master. The Factory asks for the master only (0). */
  variantCount?: number;
  /** Gold metrics the gates are judged by (Bible 12.4). Absent: no check is proven, so every gate failure is reviewed. */
  gateMetrics?: Record<string, GoldMetrics>;
  /** The time the request artifact is stamped with. Defaults to the wall clock. */
  now?: string;
  /**
   * Runs in the start's transaction, after the request row and its production_request artifact exist, and before intake is queued. The
   * Factory writes its link to the request here, so a request is never queued without the link that counts its spend for the run's caps.
   * It is not called when the request already exists.
   */
  beforeQueue?: (tx: Sql) => Promise<void>;
};

export type StartResult =
  | { status: "started"; requestId: string; requestArtifactId: string }
  /** The request id is already in this workspace. Nothing new was written; the caller reads its status. */
  | { status: "exists"; requestId: string };

/** The paths of a request that fails the engine's schema, as "a.b.c". The request itself is never echoed back. */
export function requestProblems(request: unknown): string[] {
  const parsed = productionRequestSchema.safeParse(request);
  if (parsed.success) return [];
  return [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "request"))];
}

/**
 * Validates the ProductionRequest, stores it as the request's production_request artifact and emits the orchestrator's start event,
 * all in one transaction: intake is queued only when the artifact is stored. A request id that already exists in the workspace is
 * reported as "exists" and changes nothing. A request for another workspace is refused.
 */
export async function startEngineRequest(sql: Sql, input: StartInput): Promise<StartResult> {
  const parsed = productionRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    throw new EngineError("invalid_input", `the production request is not valid: ${requestProblems(input.request).join(", ")}`);
  }
  const request: ProductionRequest = parsed.data;
  if (request.workspaceId !== input.organizationId) {
    throw new EngineError("invalid_input", "the production request names another workspace, so it was not started");
  }
  const variantCount = input.variantCount ?? 0;
  if (!Number.isInteger(variantCount) || variantCount < 0) throw new EngineError("invalid_input", "variantCount must be a whole number of zero or more");

  const existing = await sql<{ id: string }>`
    select id from engine_requests where id = ${request.requestId} and organization_id = ${input.organizationId} limit 1
  `;
  if (existing[0]) return { status: "exists", requestId: request.requestId };

  const requestArtifactId = newId("art_");
  const createdAt = input.now ?? new Date().toISOString();
  await startOrchestratorRequest(
    sql,
    {
      organizationId: input.organizationId,
      brandId: input.brandId,
      requestId: request.requestId,
      formatId: request.format.formatId,
      priority: request.constraints.priority,
      // No VideoDNA artifact is handed over, so the reference is analysed (Bible 6.2). Intake's own lookup may still find a cached one.
      cachedDna: false,
      variantCount,
      requestArtifactId,
      // A brief has no script: its write_script stage writes the script after analysis (contract v8).
      brief: request.brief !== undefined,
      ...(input.gateMetrics ? { gateMetrics: input.gateMetrics } : {}),
    },
    {
      beforeQueue: async (tx) => {
        await writeArtifact(tx, {
          organizationId: input.organizationId,
          requestId: request.requestId,
          stage: "intake",
          type: "production_request",
          body: request,
          createdAt,
          artifactId: requestArtifactId,
        });
        if (input.beforeQueue) await input.beforeQueue(tx);
      },
    },
  );
  return { status: "started", requestId: request.requestId, requestArtifactId };
}

// --- Status ----------------------------------------------------------------------------------------------------------------

export type EngineRequestStatus =
  /** Started, and intake has not passed yet. */
  | { status: "queued"; requestId: string }
  | { status: "running"; requestId: string; stage: string }
  /** Waiting on budget or on a job that died. The reason is the engine's own. */
  | { status: "paused"; requestId: string; pauseKind: "budget" | "dead_letter"; stage: string; reason: string }
  /** Escalated to a person (Bible 5.3). openItems counts the request's open review items. */
  | { status: "needs_review"; requestId: string; stage: string; reason: string; openItems: number }
  | { status: "delivered"; requestId: string; manifestId: string }
  /** Rejected at intake, or delivered with no manifest. reasons are the failing checks the engine recorded. */
  | { status: "failed"; requestId: string; reasons: string[] };

/** The status of one request in its workspace, or null when the workspace has no such request. */
export async function engineRequestStatus(sql: Sql, organizationId: string, requestId: string): Promise<EngineRequestStatus | null> {
  const read = await readEngineRequest(sql, organizationId, requestId);
  if (!read) return null;
  const state = read.state;
  if (read.status === "delivered") {
    if (state.manifestId === null) return { status: "failed", requestId, reasons: ["the engine marked the request delivered without a manifest"] };
    return { status: "delivered", requestId, manifestId: state.manifestId };
  }
  if (read.status === "rejected") return { status: "failed", requestId, reasons: await rejectionReasons(sql, organizationId, requestId) };
  if (read.status === "paused") {
    const pause = state.pause;
    if (pause === null) return { status: "paused", requestId, pauseKind: "dead_letter", stage: read.currentStage, reason: "the engine paused the request and recorded no reason" };
    if (pause.kind === "escalation") {
      const open = await sql<{ n: number }>`
        select count(*)::int as n from engine_review_items
        where organization_id = ${organizationId} and request_id = ${requestId} and status = 'open'
      `;
      return { status: "needs_review", requestId, stage: pause.stage, reason: pause.reason, openItems: Number(open[0]?.n ?? 0) };
    }
    return { status: "paused", requestId, pauseKind: pause.kind, stage: pause.stage, reason: pause.reason };
  }
  if (state.nodes.intake.status !== "passed") return { status: "queued", requestId };
  return { status: "running", requestId, stage: read.currentStage };
}

/** The failing checks of the request gate, newest first, as "rule: detail". Only rule names and code-written details are stored. */
async function rejectionReasons(sql: Sql, organizationId: string, requestId: string): Promise<string[]> {
  const rows = await sql<{ checks: string }>`
    select checks from engine_gate_results
    where organization_id = ${organizationId} and request_id = ${requestId} and gate = 'request' and passed = false
    order by created_at desc limit 1
  `;
  const reasons: string[] = [];
  try {
    const checks = JSON.parse(rows[0]?.checks ?? "[]") as Array<{ rule?: unknown; pass?: unknown; detail?: unknown }>;
    for (const check of checks) {
      if (check.pass !== false || typeof check.rule !== "string") continue;
      reasons.push(typeof check.detail === "string" && check.detail ? `${check.rule}: ${check.detail}` : check.rule);
    }
  } catch {
    // An unreadable record is reported as unknown below, never as a reason.
  }
  return reasons.length > 0 ? reasons : ["the engine rejected the request at intake and no failing check was recorded"];
}

// --- Delivered master ------------------------------------------------------------------------------------------------------

export type DeliveredMaster = {
  requestId: string;
  manifestId: string;
  manifest: Manifest;
  /** The rendered_video artifact of the master. Its uri is the object key of the MP4 in Meridian's object store. */
  renderedVideoArtifactId: string;
  renderedVideo: RenderedVideo;
  /** The rendered_video artifact's content hash (a hash of its record, not of the MP4 bytes, which the engine does not record). */
  recordHash: string;
};

/**
 * The master of a delivered request: its manifest and its rendered video, both read back through their contracts. Refused when the
 * request is not delivered, or when the manifest and the rendered video do not name the same video.
 */
export async function engineDeliveredMaster(sql: Sql, organizationId: string, requestId: string): Promise<DeliveredMaster> {
  const read = await readEngineRequest(sql, organizationId, requestId);
  if (!read) throw new EngineError("not_found", `request ${requestId} is not in this workspace`);
  if (read.status !== "delivered" || read.state.manifestId === null) {
    throw new EngineError("conflict", `request ${requestId} is ${read.status}, not delivered`);
  }
  const masterEdlId = read.state.masterEdlId;
  const renderArtifactId = masterEdlId === null ? undefined : read.state.artifacts[`render:${masterEdlId}`];
  if (renderArtifactId === undefined) throw new EngineError("internal", `request ${requestId} is delivered and names no rendered master`);
  // The state names the master's video id. Its manifest artifact is stored under the slot manifest:<videoId> (deliver/handlers), not under
  // that id, so the artifact is read from its slot.
  const manifestArtifactId = read.state.artifacts[`manifest:${read.state.manifestId}`];
  if (manifestArtifactId === undefined) {
    throw new EngineError("internal", `request ${requestId} is delivered and names no manifest artifact for ${read.state.manifestId}`);
  }
  const manifestStored = await readArtifact(sql, { organizationId, artifactId: manifestArtifactId });
  const renderStored = await readArtifact(sql, { organizationId, artifactId: renderArtifactId });
  if (manifestStored.envelope.requestId !== requestId || renderStored.envelope.requestId !== requestId) {
    throw new EngineError("internal", `an artifact of ${requestId} belongs to another request`);
  }
  const manifest = manifestSchema.parse(manifestStored.envelope.body);
  const renderedVideo = renderedVideoSchema.parse(renderStored.envelope.body);
  if (manifest.videoId !== renderedVideo.videoId || manifest.variantOf !== undefined) {
    throw new EngineError("internal", `the manifest of ${requestId} does not describe its rendered master`);
  }
  return {
    requestId,
    manifestId: read.state.manifestId,
    manifest,
    renderedVideoArtifactId: renderArtifactId,
    renderedVideo,
    recordHash: renderStored.envelope.contentHash,
  };
}

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
};

/** A shot's new visual type and source, for a remake that changes what the shot is (D7). The shot keeps its beat, its timing and its layer. */
export type ShotReplacement = { visualType: VisualType; source: ShotSource };

/** What a remake reads to price itself: the workspace's monthly budget, and the model catalog that prices the chosen models (Bible 10.5). */
export type RemakePorts = {
  monthBudget: WorkspaceBudgetSource;
  catalog?: ModelCatalogSource;
};

export type RemakeResult = { status: "queued"; revision: number; reservationId: string } | { status: "refused"; reasons: string[] };

/** What the checks before a remake read: the video's record, the shot, the month's budget and the revision the remake would make. */
type RemakeContext = {
  organizationId: string;
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
    context: { organizationId: input.organizationId, planId, state, plan, request, shot, month, catalog: resolved.catalog, revision: (state.revision ?? 0) + 1 },
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

  const reservationId = newId("res_");
  let replaced: ReplacedPlan | null = null;
  try {
    replaced = input.replacement ? await replacedPlanOf(sql, context, input.replacement) : null;
    const chosenPrices = replaced !== null ? replaced.chosenPrices : await chosenPricesFor({ sql, organizationId: input.organizationId, state: context.state, plan: context.plan, catalog: context.catalog });
    const reservedPlan = replaced !== null ? replaced.plan : context.plan;
    const reservedShot = replaced !== null ? replaced.shot : context.shot;
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
async function replacedPlanOf(sql: Sql, context: RemakeContext, replacement: ShotReplacement): Promise<ReplacedPlan> {
  const original = context.plan.shots.find((candidate) => candidate.shotId === context.shot.shotId);
  if (original === undefined) throw new EngineError("invalid_input", "that shot is not in the plan of this video", { stage: "produce_shot" });
  const shot = shotSpecSchema.parse({
    ...original,
    visualType: replacement.visualType,
    source: shotSourceSchema.parse(replacement.source),
    downgradeTo: original.downgradeTo === replacement.visualType ? undefined : original.downgradeTo,
  });
  // Only a shot that a take makes can be replaced: the produce path is the one that makes it. Refused before anything is written.
  if (shot.source.kind !== "generate" && shot.source.kind !== "stock" && shot.source.kind !== "chain") {
    throw new EngineError("invalid_input", "a replacement must be a shot that a take makes (generate, stock or chain)", { stage: "produce_shot" });
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
  try {
    const replaced = input.replacement ? await replacedPlanOf(sql, context, input.replacement) : null;
    const estimate =
      replaced !== null
        ? estimatePlan({ ...replaced.plan, shots: [replaced.shot] }, replaced.chosenPrices ?? new Map())
        : estimatePlan(
            { ...context.plan, shots: [context.shot] },
            (await chosenPricesFor({ sql, organizationId: input.organizationId, state: context.state, plan: context.plan, catalog: context.catalog })) ?? new Map(),
          );
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
  return { monthBudget, catalog: productionComposition(sql).shotPorts?.catalog };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "the remake was not made";
}

// --- Spend -----------------------------------------------------------------------------------------------------------------

export type EngineSpend = {
  /** Actual cost on the requests' ledger, in micro-dollars. A call whose actual is not recorded yet adds nothing here. */
  totalMicros: number;
  /** The part recorded in the last 24 hours. */
  dailyMicros: number;
  /** Ledger calls with no actual yet. Their cost is unknown, not zero. */
  pendingCalls: number;
};

const MICROS_PER_USD = 1_000_000;

/** The ledger actuals of some requests of one workspace (Bible 14). */
export async function engineSpendOf(sql: Sql, organizationId: string, requestIds: readonly string[]): Promise<EngineSpend> {
  const spend: EngineSpend = { totalMicros: 0, dailyMicros: 0, pendingCalls: 0 };
  // One query per request: a run has a handful, and every value stays a scalar parameter.
  for (const requestId of new Set(requestIds)) {
    const rows = await sql<{ total: string | number; daily: string | number; pending: number }>`
      select coalesce(sum(actual_usd), 0) as total,
        coalesce(sum(actual_usd) filter (where at >= now() - interval '1 day'), 0) as daily,
        (count(*) filter (where actual_usd is null))::int as pending
      from engine_ledger
      where organization_id = ${organizationId} and request_id = ${requestId}
    `;
    spend.totalMicros += Math.round(roundUsd(Number(rows[0]?.total ?? 0)) * MICROS_PER_USD);
    spend.dailyMicros += Math.round(roundUsd(Number(rows[0]?.daily ?? 0)) * MICROS_PER_USD);
    spend.pendingCalls += Number(rows[0]?.pending ?? 0);
  }
  return spend;
}

/**
 * Pauses every live reservation of a request (a Meridian cap or the kill switch was reached). A paused reservation refuses every
 * paid call (budget/reserve.ts, authorizeCall), so the request spends nothing more; the stage that is refused pauses the request
 * with the reason. A paused hold is never revived: a resume makes a new one. Returns how many reservations were paused.
 */
export async function pauseEngineSpend(sql: Sql, organizationId: string, requestId: string, reason: string): Promise<number> {
  if (reason.trim() === "") throw new EngineError("invalid_input", "a reservation is paused with a reason");
  const live = await sql<{ id: string }>`
    select id from engine_reservations
    where organization_id = ${organizationId} and request_id = ${requestId} and state = 'reserved'
    order by id
  `;
  let paused = 0;
  for (const row of live) {
    const changed = await withReservationLedger(sql, organizationId, row.id, async (store) => {
      const reservation = await store.getReservation(row.id);
      if (!reservation || reservation.state !== "reserved") return false;
      await store.updateReservation({ ...reservation, state: "paused", pausedReason: reason.slice(0, 500) });
      return true;
    });
    if (changed) paused += 1;
  }
  return paused;
}

/** Whether a reservation id is paused, for a caller that shows it. Null when the workspace has no such reservation. */
export async function reservationState(sql: Sql, organizationId: string, reservationId: string): Promise<BudgetReservation["state"] | null> {
  const reservation = await sqlLedgerStore(sql, organizationId).getReservation(reservationId);
  return reservation?.state ?? null;
}

// --- Review inbox ----------------------------------------------------------------------------------------------------------

export type EngineReviewItem = {
  id: string;
  requestId: string;
  kind: "escalation" | "dead_letter" | "sample";
  /** The shot, take, EDL or request the item is about. */
  subjectId: string;
  /** Built by engine code from rule names and routes, never from model prose. */
  reason: string;
  /** What the payload says, read through its contract. Fields the payload does not carry are absent. */
  shotId?: string;
  stage?: string;
  takeCount?: number;
  createdAt: string;
};

const detailStageSchema = z.object({ stage: z.string().min(1).max(60) });

/** The open review items of a brand's requests, newest first. Tenancy: the workspace and the brand of each request. */
export async function openEngineReviewItems(sql: Sql, organizationId: string, brandId: string, limit = 50): Promise<EngineReviewItem[]> {
  const rows = await sql<{ id: string; request_id: string; kind: string; subject_id: string; reason: string; detail: string; created_at: unknown }>`
    select i.id, i.request_id, i.kind, i.subject_id, i.reason, i.detail, i.created_at
    from engine_review_items i
    join engine_requests r on r.id = i.request_id and r.organization_id = i.organization_id
    where i.organization_id = ${organizationId} and r.brand_id = ${brandId} and i.status = 'open'
    order by i.created_at desc, i.id desc
    limit ${Math.min(Math.max(Math.trunc(limit), 1), 200)}
  `;
  return rows.flatMap((row) => {
    if (row.kind !== "escalation" && row.kind !== "dead_letter" && row.kind !== "sample") return [];
    const item: EngineReviewItem = {
      id: row.id,
      requestId: row.request_id,
      kind: row.kind,
      subjectId: row.subject_id,
      reason: row.reason,
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    };
    let detail: unknown = null;
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = null;
    }
    const take = takeReviewItemSchema.safeParse(detail);
    if (take.success) {
      item.shotId = take.data.shotId;
      item.takeCount = take.data.takes.length;
    }
    const staged = detailStageSchema.safeParse(detail);
    if (staged.success) item.stage = staged.data.stage;
    return [item];
  });
}

// --- Readiness -------------------------------------------------------------------------------------------------------------

export type EngineReadinessPorts = {
  /** The workspace's monthly video budget (Settings). */
  monthBudget: WorkspaceBudgetSource;
  /** Meridian's credential resolver, as the gateway sees it. Only whether a key is connected is read, never the key. */
  credentials: CredentialSource;
  /** The runtime the worker runs engine jobs with. A stage without a handler cannot run. */
  runtime: Pick<EngineRuntime, "handlers">;
};

export type EngineReadiness = { status: "ready" } | { status: "not_connected"; reasons: string[] };

/** The stages one master needs. analyze_reference runs because no VideoDNA is handed over; variants only when variants are asked for. */
export function stagesNeeded(variantCount: number): EngineStage[] {
  return ENGINE_STAGES.filter((stage) => stage !== "variants" || variantCount > 0);
}

/**
 * Whether the engine can make a video for this workspace now. NOT_CONNECTED, with every reason, when the workspace has no monthly
 * video budget, when the OpenRouter key (every model route, OpenRouter is the default platform) or a render key (HeyGen
 * HyperFrames, or the Shotstack fallback) is not connected, or when a stage has no handler in the runtime. Nothing is called.
 */
export async function engineReadiness(organizationId: string, ports: EngineReadinessPorts, options: { variantCount?: number; now?: string } = {}): Promise<EngineReadiness> {
  const reasons: string[] = [];
  const now = options.now ?? new Date().toISOString();
  const month = await ports.monthBudget.monthBudget({ organizationId, requestId: "", now }).catch(() => ({
    status: "not_connected" as const,
    reason: "the workspace monthly video budget could not be read",
  }));
  if (month.status !== "known") reasons.push(`Monthly video budget: ${month.reason}`);

  const lookup = async (credentialId: string) =>
    ports.credentials.get(credentialId, organizationId).catch(() => ({ status: "not_connected" as const, reason: `the ${credentialId} credential could not be checked` }));
  const openrouter = await lookup("openrouter");
  if (openrouter.status !== "ready") reasons.push(`OpenRouter: ${openrouter.reason}`);
  const heygen = await lookup("heygen");
  const shotstack = await lookup("shotstack");
  if (heygen.status !== "ready" && shotstack.status !== "ready") {
    reasons.push(`Render: neither HyperFrames (HeyGen) nor Shotstack is connected. ${heygen.reason}`);
  }

  const missing = stagesNeeded(options.variantCount ?? 0).filter((stage) => ports.runtime.handlers[stage] === undefined);
  if (missing.length > 0) reasons.push(`Engine stages with no handler in this deployment: ${missing.join(", ")}.`);
  return reasons.length === 0 ? { status: "ready" } : { status: "not_connected", reasons };
}

// --- Request feed ----------------------------------------------------------------------------------------------------------
//
// What the engine recorded for one request, read only, for a screen that shows each decision as it happens (Content Factory). Every
// value comes from an engine store: the request's state, its artifacts (read back through their contracts), its gate results, its
// decisions, its ledger, its reservation and its stage jobs. Nothing is derived that the stores do not hold: a cost with no bill is
// null, a model with no record is absent, and an unknown is never filled in. Tenancy: every read names the workspace.

export type FeedNodeStatus = "idle" | "queued" | "passed";

export type FeedJobCounts = { queued: number; running: number; retry: number; succeeded: number; dead: number };

export type FeedGate = {
  gate: string;
  subjectId: string;
  pass: boolean;
  /** Rule names with their code-written detail (Bible 12). */
  checks: { rule: string; pass: boolean; detail: string | null }[];
  failingShotIds: string[];
  at: string;
};

export type FeedDecision = { at: string; chose: string; alternatives: { option: string; score: number }[]; reason: string; by: string; recordedAt: string };

export type FeedLedgerRow = {
  stage: string;
  provider: string;
  model: string;
  /** The list estimate the call was written with (Bible 14.1). */
  estimateUsd: number;
  reservedUsd: number;
  /** A verified bill, 0 for a call the provider confirmed created no job, or null while neither is known (contract v6). */
  actualUsd: number | null;
  settlement: "billed" | "confirmed_absent" | null;
  at: string;
};

/** A shot's model, as the plan records it (Bible 10.5, contract v7 modelChoice). Absent until the shot spec carries one. */
export type FeedModelChoice = { model: string; provider: string | null; reason: string | null; catalogReadAt: string | null };

export type FeedShot = {
  shotId: string;
  beatId: string;
  startMs: number;
  endMs: number;
  visualType: string;
  layer: string;
  sourceKind: string;
  /** The model classes the shot's source calls (one for a generate source, one per call for a chain, none for code or stock). */
  modelClasses: string[];
  modelChoice: FeedModelChoice | null;
  /** The route table's targets for the shot's first model class, in priority order. A null model is an id not set yet. */
  routeTargets: { provider: string; model: string | null }[];
  /** The orchestrator's status for the shot, when it is tracked. */
  status: string | null;
};

export type FeedArtifact =
  | { type: "production_request"; artifactId: string; createdAt: string; language: string | null; beats: { beatId: string; role: string; text: string }[]; brief: string | null; referenceVideo: string; keep: string[]; change: string[]; maxMs: number; budgetUsd: number }
  | { type: "validated_request"; artifactId: string; createdAt: string; estimatedSpeechMs: number }
  | { type: "written_script"; artifactId: string; createdAt: string; language: string; beats: { beatId: string; role: string; text: string }[]; rationale: string }
  | { type: "video_dna"; artifactId: string; createdAt: string; durationMs: number; segments: number; transcriptWords: number; genes: string[]; transferable: string[]; sourceDeletedAt: string | null }
  | { type: "voice_track"; artifactId: string; createdAt: string; voiceId: string; provider: string; durationMs: number; lufs: number; words: number }
  | { type: "scene_plan"; artifactId: string; createdAt: string; planId: string; estimatedUsd: number; shots: FeedShot[]; decisions: FeedDecision[] }
  | { type: "take"; artifactId: string; createdAt: string; takeId: string; shotId: string; attempt: number; provider: string; model: string; durationMs: number }
  | { type: "take_verdict"; artifactId: string; createdAt: string; takeId: string; pass: boolean; action: string; confidence: number; failing: string[] }
  | { type: "edl"; artifactId: string; createdAt: string; edlId: string; durationMs: number; clips: number; variantOf: string | null }
  | { type: "rendered_video"; artifactId: string; createdAt: string; videoId: string; renderer: string; durationMs: number; bytes: number; estimateUsd: number; costUsd: number | null }
  | { type: "manifest"; artifactId: string; createdAt: string; videoId: string; variantOf: string | null; shots: { shotId: string; provider: string; model: string }[] }
  | { type: "other"; artifactId: string; createdAt: string; artifactType: string; stage: string };

export type EngineRequestFeed = {
  requestId: string;
  status: EngineRequestStatus;
  currentStage: string;
  cachedDna: boolean;
  pause: { kind: string; stage: string; reason: string } | null;
  nodes: Record<string, FeedNodeStatus>;
  branches: { edlId: string; variantOf: string | null; stage: string; status: string }[];
  jobs: Record<string, FeedJobCounts>;
  artifacts: FeedArtifact[];
  gates: FeedGate[];
  decisions: FeedDecision[];
  ledger: FeedLedgerRow[];
  reservation: { state: string; estimateUsd: number; reservedUsd: number; pausedReason: string | null } | null;
  openReviewItems: number;
  /** How many times a person has remade a shot of this video (Bible 5.5). 0 for the first delivery. */
  revision: number;
  /** One row per shot of the plan, in time order. The board draws each shot from its row. */
  shots: FeedShotRow[];
};

/**
 * A shot as the board shows it (Bible 5.5). Unknown values stay null: a shot with no plan record has no timing. `remakeRefusal` says why a
 * remake is not possible now, or is null when it is.
 */
export type FeedShotRow = {
  shotId: string;
  beatId: string | null;
  startMs: number | null;
  endMs: number | null;
  visualType: string | null;
  sourceKind: string | null;
  status: "pending" | "accepted" | "replanning" | "escalated";
  /** The produce round of the shot's current attempt, starting at 0. */
  round: number;
  /** How many times a person has remade this shot. */
  remakes: number;
  /** The takes of the shot's current plan, across its rounds, that still count. */
  takes: number;
  acceptedTakeId: string | null;
  /** The newest verdict of the shot's current takes: pass or fail, and the rule names of the failing checks. */
  lastVerdict: { pass: boolean; failing: string[] } | null;
  /** The reviewer's directions for the shot, oldest first. */
  directives: string[];
  remakeRefusal: string | null;
};

const modelChoiceSchema = z.object({
  model: z.string().min(1).max(200).optional(),
  modelId: z.string().min(1).max(200).optional(),
  provider: z.string().min(1).max(100).optional(),
  reason: z.string().min(1).max(2000).optional(),
  catalogReadAt: z.string().min(1).max(60).optional(),
});

/** The modelChoice of each shot in a stored plan body, by shot id. A plan written before contract v7 has none. */
function modelChoicesOf(body: string): Map<string, FeedModelChoice> {
  const choices = new Map<string, FeedModelChoice>();
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return choices;
  }
  const shots = (raw as { shots?: unknown }).shots;
  if (!Array.isArray(shots)) return choices;
  for (const shot of shots as Array<{ shotId?: unknown; modelChoice?: unknown }>) {
    if (typeof shot?.shotId !== "string" || shot.modelChoice === undefined) continue;
    const parsed = modelChoiceSchema.safeParse(shot.modelChoice);
    const model = parsed.success ? (parsed.data.model ?? parsed.data.modelId) : undefined;
    if (!parsed.success || model === undefined) continue;
    choices.set(shot.shotId, { model, provider: parsed.data.provider ?? null, reason: parsed.data.reason ?? null, catalogReadAt: parsed.data.catalogReadAt ?? null });
  }
  return choices;
}

function routeTargetsOf(modelClass: string | undefined): { provider: string; model: string | null }[] {
  if (modelClass === undefined) return [];
  const route = (routes.table as Record<string, { targets: readonly { provider: string; model: string | null }[] } | undefined>)[modelClass];
  return route ? route.targets.map((target) => ({ provider: target.provider, model: target.model })) : [];
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function feedArtifactOf(stored: Awaited<ReturnType<typeof readArtifact>>, stage: string, rawBody: string, shotStatus: Record<string, string>): FeedArtifact {
  const { envelope } = stored;
  const base = { artifactId: envelope.artifactId, createdAt: envelope.createdAt };
  const body = envelope.body;
  switch (envelope.type) {
    case "production_request": {
      const request = productionRequestSchema.parse(body);
      return {
        type: "production_request",
        ...base,
        // Contract v8: a request carries its own script or a brief; a brief's script arrives later as the written_script artifact.
        language: request.script?.language ?? null,
        beats: request.script?.beats.map((beat) => ({ beatId: beat.beatId, role: beat.role, text: beat.text })) ?? [],
        brief: request.brief?.text ?? null,
        referenceVideo: request.format.referenceVideo,
        keep: request.format.keep,
        change: request.format.change,
        maxMs: request.constraints.maxMs,
        budgetUsd: request.constraints.budgetUsd,
      };
    }
    case "written_script": {
      const script = writtenScriptSchema.parse(body);
      return {
        type: "written_script",
        ...base,
        language: script.language,
        beats: script.beats.map((beat) => ({ beatId: beat.beatId, role: beat.role, text: beat.text })),
        rationale: script.rationale,
      };
    }
    case "validated_request":
      return { type: "validated_request", ...base, estimatedSpeechMs: validatedRequestSchema.parse(body).estimatedSpeechMs };
    case "video_dna": {
      const dna = videoDnaSchema.parse(body);
      return {
        type: "video_dna",
        ...base,
        durationMs: dna.durationMs,
        segments: dna.segments.length,
        transcriptWords: dna.transcript.words.length,
        genes: Object.keys(dna.genome),
        transferable: dna.transferable,
        sourceDeletedAt: dna.sourceDeletedAt ?? null,
      };
    }
    case "voice_track": {
      const voice = voiceTrackSchema.parse(body);
      return { type: "voice_track", ...base, voiceId: voice.voiceId, provider: voice.provider, durationMs: voice.durationMs, lufs: voice.lufs, words: voice.words.length };
    }
    case "scene_plan": {
      const plan = scenePlanSchema.parse(body);
      const choices = modelChoicesOf(rawBody);
      return {
        type: "scene_plan",
        ...base,
        planId: plan.planId,
        estimatedUsd: plan.estimatedUsd,
        shots: plan.shots.map((shot) => {
          const modelClasses = shot.source.kind === "generate" ? [shot.source.modelClass] : shot.source.kind === "chain" ? shot.source.calls.map((call) => call.modelClass) : [];
          return {
            shotId: shot.shotId,
            beatId: shot.beatId,
            startMs: shot.startMs,
            endMs: shot.endMs,
            visualType: shot.visualType,
            layer: shot.layer,
            sourceKind: shot.source.kind,
            modelClasses,
            modelChoice: choices.get(shot.shotId) ?? null,
            routeTargets: routeTargetsOf(modelClasses[0]),
            status: shotStatus[shot.shotId] ?? null,
          };
        }),
        decisions: plan.decisions.map((decision) => ({ ...decision, recordedAt: envelope.createdAt })),
      };
    }
    case "take": {
      const take = takeSchema.parse(body);
      return { type: "take", ...base, takeId: take.takeId, shotId: take.shotId, attempt: take.attempt, provider: take.provider, model: take.model, durationMs: take.durationMs };
    }
    case "take_verdict": {
      const verdict = takeVerdictSchema.parse(body);
      return {
        type: "take_verdict",
        ...base,
        takeId: verdict.takeId,
        pass: verdict.pass,
        action: verdict.action,
        confidence: verdict.confidence,
        failing: verdict.checks.filter((check) => !check.pass).map((check) => check.rule),
      };
    }
    case "edl": {
      const edl = edlSchema.parse(body);
      return { type: "edl", ...base, edlId: edl.edlId, durationMs: edl.durationMs, clips: edl.tracks.reduce((sum, track) => sum + track.clips.length, 0), variantOf: edl.variantOf ?? null };
    }
    case "rendered_video": {
      const video = renderedVideoSchema.parse(body);
      return { type: "rendered_video", ...base, videoId: video.videoId, renderer: video.renderer, durationMs: video.durationMs, bytes: video.bytes, estimateUsd: video.estimateUsd, costUsd: video.costUsd };
    }
    case "manifest": {
      const manifest = manifestSchema.parse(body);
      return { type: "manifest", ...base, videoId: manifest.videoId, variantOf: manifest.variantOf ?? null, shots: manifest.shots.map((shot) => ({ shotId: shot.shotId, provider: shot.provider, model: shot.model })) };
    }
    default:
      return { type: "other", ...base, artifactType: envelope.type, stage };
  }
}

function jsonList<T>(text: string): T[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

const emptyCounts = (): FeedJobCounts => ({ queued: 0, running: 0, retry: 0, succeeded: 0, dead: 0 });

/**
 * Everything the engine recorded for one request of a workspace, in the order it was recorded, or null when the workspace has no such
 * request. Read only: nothing is written, queued or called.
 */
/** The board's rows for the shots of a request: the plan's timing, the orchestrator's shot state and its takes (Bible 5.5). */
async function feedShotsOf(sql: Sql, organizationId: string, state: OrchestratorState): Promise<FeedShotRow[]> {
  const planId = state.artifacts.plan;
  const parsed = planId === undefined ? null : scenePlanSchema.safeParse((await readArtifact(sql, { organizationId, artifactId: planId })).envelope.body);
  const specs = new Map((parsed?.success ? parsed.data.shots : []).map((spec) => [spec.shotId, spec]));
  const takes = Object.values(state.takes);
  const rows = Object.values(state.shots).map((shot): FeedShotRow => {
    const spec = specs.get(shot.shotId);
    const current = takes.filter((take) => take.shotId === shot.shotId && take.epoch === shot.epoch && !take.stale);
    const newest = current.filter((take) => take.verdict !== null).at(-1)?.verdict ?? null;
    return {
      shotId: shot.shotId,
      beatId: spec?.beatId ?? null,
      startMs: spec?.startMs ?? null,
      endMs: spec?.endMs ?? null,
      visualType: spec?.visualType ?? null,
      sourceKind: spec?.source.kind ?? null,
      status: shot.status,
      round: shot.round,
      remakes: shot.remakes ?? 0,
      takes: current.length,
      acceptedTakeId: shot.acceptedTakeId,
      lastVerdict: newest === null ? null : { pass: newest.pass, failing: [...newest.failing] },
      directives: [...(shot.directives ?? [])],
      remakeRefusal: remakeRefusalOf(state, shot.shotId),
    };
  });
  return rows.sort((a, b) => (a.startMs ?? Number.MAX_SAFE_INTEGER) - (b.startMs ?? Number.MAX_SAFE_INTEGER) || a.shotId.localeCompare(b.shotId));
}

export async function engineRequestFeed(sql: Sql, organizationId: string, requestId: string): Promise<EngineRequestFeed | null> {
  const read = await readEngineRequest(sql, organizationId, requestId);
  if (!read) return null;
  const status = await engineRequestStatus(sql, organizationId, requestId);
  if (!status) return null;
  const state = read.state;

  const shotStatus: Record<string, string> = Object.fromEntries(Object.entries(state.shots).map(([shotId, shot]) => [shotId, shot.status]));
  const artifactRows = await sql<{ id: string; stage: string; body: string }>`
    select id, stage, body from engine_artifacts
    where organization_id = ${organizationId} and request_id = ${requestId}
    order by created_at asc, id asc
  `;
  const artifacts: FeedArtifact[] = [];
  for (const row of artifactRows) {
    const stored = await readArtifact(sql, { organizationId, artifactId: row.id });
    artifacts.push(feedArtifactOf(stored, row.stage, row.body, shotStatus));
  }

  const gateRows = await sql<{ gate: string; subject_id: string; passed: boolean; checks: string; failing_shot_ids: string; created_at: unknown }>`
    select gate, subject_id, passed, checks, failing_shot_ids, created_at from engine_gate_results
    where organization_id = ${organizationId} and request_id = ${requestId}
    order by created_at asc, id asc
  `;
  const gates: FeedGate[] = gateRows.map((row) => ({
    gate: row.gate,
    subjectId: row.subject_id,
    pass: row.passed === true,
    checks: jsonList<{ rule?: unknown; pass?: unknown; detail?: unknown }>(row.checks)
      .filter((check) => typeof check.rule === "string")
      .map((check) => ({ rule: check.rule as string, pass: check.pass === true, detail: typeof check.detail === "string" && check.detail ? check.detail.slice(0, 500) : null })),
    failingShotIds: jsonList<unknown>(row.failing_shot_ids).filter((id): id is string => typeof id === "string"),
    at: iso(row.created_at),
  }));

  const decisionRows = await sql<{ at: string; chose: string; alternatives: string; reason: string; decided_by: string; created_at: unknown }>`
    select at, chose, alternatives, reason, decided_by, created_at from engine_decisions
    where organization_id = ${organizationId} and request_id = ${requestId}
    order by created_at asc, id asc
  `;
  const decisions: FeedDecision[] = decisionRows.map((row) => ({
    at: row.at,
    chose: row.chose,
    alternatives: jsonList<{ option?: unknown; score?: unknown }>(row.alternatives)
      .filter((item) => typeof item.option === "string" && typeof item.score === "number")
      .map((item) => ({ option: item.option as string, score: item.score as number })),
    reason: row.reason,
    by: row.decided_by,
    recordedAt: iso(row.created_at),
  }));

  const ledgerRows = await sql<{ stage: string; provider: string; model: string; estimate_usd: string | number; reserved_usd: string | number; actual_usd: string | number | null; settlement: string | null; at: unknown }>`
    select stage, provider, model, estimate_usd, reserved_usd, actual_usd, settlement, at from engine_ledger
    where organization_id = ${organizationId} and request_id = ${requestId}
    order by at asc, id asc
  `;
  const ledger: FeedLedgerRow[] = ledgerRows.map((row) => ({
    stage: row.stage,
    provider: row.provider,
    model: row.model,
    estimateUsd: roundUsd(Number(row.estimate_usd)),
    reservedUsd: roundUsd(Number(row.reserved_usd)),
    actualUsd: row.actual_usd === null || row.settlement === null ? null : roundUsd(Number(row.actual_usd)),
    settlement: row.settlement === "billed" || row.settlement === "confirmed_absent" ? row.settlement : null,
    at: iso(row.at),
  }));

  const reservationId = state.budgetReservationId;
  const reservationRows = reservationId === null
    ? []
    : await sql<{ state: string; estimate_usd: string | number; reserved_usd: string | number; paused_reason: string | null }>`
        select state, estimate_usd, reserved_usd, paused_reason from engine_reservations
        where organization_id = ${organizationId} and id = ${reservationId} limit 1
      `;
  const reservationRow = reservationRows[0];

  const jobs: Record<string, FeedJobCounts> = {};
  const prefix = `engine:${requestId}:`;
  const jobRows = await sql<{ job_type: string; status: string; n: number }>`
    select job_type, status, count(*)::int as n from jobs
    where organization_id = ${organizationId} and left(idempotency_key, ${prefix.length}::int) = ${prefix}
    group by job_type, status
  `;
  for (const row of jobRows) {
    const stage = row.job_type.startsWith("engine.") ? row.job_type.slice("engine.".length) : row.job_type;
    const counts = jobs[stage] ?? emptyCounts();
    if (row.status === "queued" || row.status === "running" || row.status === "retry" || row.status === "succeeded" || row.status === "dead") {
      counts[row.status] += Number(row.n);
    }
    jobs[stage] = counts;
  }

  const open = await sql<{ n: number }>`
    select count(*)::int as n from engine_review_items
    where organization_id = ${organizationId} and request_id = ${requestId} and status = 'open'
  `;

  return {
    requestId,
    status,
    currentStage: read.currentStage,
    cachedDna: state.cachedDna,
    pause: state.pause === null ? null : { kind: state.pause.kind, stage: state.pause.stage, reason: state.pause.reason },
    nodes: Object.fromEntries(Object.entries(state.nodes).map(([node, value]) => [node, value.status])),
    branches: Object.values(state.branches).map((branch) => ({ edlId: branch.edlId, variantOf: branch.variantOf, stage: branch.stage, status: branch.status })),
    jobs,
    artifacts,
    gates,
    decisions,
    ledger,
    reservation: reservationRow
      ? {
          state: reservationRow.state,
          estimateUsd: roundUsd(Number(reservationRow.estimate_usd)),
          reservedUsd: roundUsd(Number(reservationRow.reserved_usd)),
          pausedReason: reservationRow.paused_reason,
        }
      : null,
    openReviewItems: Number(open[0]?.n ?? 0),
    revision: state.revision ?? 0,
    shots: await feedShotsOf(sql, organizationId, state),
  };
}

/** The production readiness ports: Meridian's Settings, its credential resolver and the worker's engine runtime. */
export async function productionReadinessPorts(sql: Sql): Promise<EngineReadinessPorts> {
  const [{ workspaceBudgetFromSettings, meridianMonthlyBudgetReader }, { meridianCredentialSource }, { productionEngineRuntime }] = await Promise.all([
    import("../jobs/workspace-budget.ts"),
    import("../gateway/meridian.ts"),
    import("../jobs/runtime.ts"),
  ]);
  return {
    monthBudget: workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql)),
    credentials: meridianCredentialSource(),
    runtime: productionEngineRuntime(sql),
  };
}
