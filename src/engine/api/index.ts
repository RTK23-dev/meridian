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
  manifestSchema,
  newId,
  productionRequestSchema,
  renderedVideoSchema,
  roundUsd,
  type Manifest,
  type ProductionRequest,
  type RenderedVideo,
} from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { readArtifact, writeArtifact } from "../jobs/artifact-store.ts";
import { readEngineRequest, startEngineRequest as startOrchestratorRequest } from "../jobs/orchestrator-sql.ts";
import { ENGINE_STAGES, type EngineStage } from "../jobs/registry.ts";
import { sqlLedgerStore, withReservationLedger } from "../jobs/sql-ledger-store.ts";
import type { EngineRuntime } from "../jobs/types.ts";
import type { WorkspaceBudgetSource } from "../jobs/handlers/estimate-reserve.ts";
import type { CredentialSource } from "../gateway/types.ts";
import type { GoldMetrics } from "../review/gold.ts";
import { takeReviewItemSchema } from "../review/inbox.ts";

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
  const manifestStored = await readArtifact(sql, { organizationId, artifactId: read.state.manifestId });
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
export async function reservationState(sql: Sql, organizationId: string, reservationId: string): Promise<"reserved" | "paused" | "released" | null> {
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
