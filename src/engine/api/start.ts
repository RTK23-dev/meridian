// Starting a request and reading its status: the start input, the problems a request has, and the delivered master.
// Moved out of engine/api/index.ts unchanged (coding loop, T8). index.ts re-exports the public names.

import { EngineError, manifestSchema, newId, productionRequestSchema, renderedVideoSchema, type Manifest, type ProductionRequest, type RenderedVideo } from "../contracts/index.ts";
import type { Sql } from "../../lib/meridian/learning/store.ts";
import { readArtifact, writeArtifact } from "../jobs/artifact-store.ts";
import { readEngineRequest, startEngineRequest as startOrchestratorRequest } from "../jobs/orchestrator-sql.ts";
import type { GoldMetrics } from "../review/gold.ts";

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
