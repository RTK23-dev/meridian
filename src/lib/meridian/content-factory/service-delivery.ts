// The Content Factory delivery functions: the hook history, the economics, the delivered link and the delivery approval.
// Moved out of content-factory/service.ts unchanged (coding loop, T6). service.ts re-exports the public names.

import { hookHistoryOf, type HookHistory } from "./hook-history.ts";
import { readStartedHooks } from "./hook-history-store.ts";
import { economicsOf, type BrandEconomics } from "./economics.ts";
import { readBrandLedger, readBrandRuns } from "./economics-store.ts";
import { approvalProblem, approvalStateFor, isApprovalDecision, publishStateOf, type ApprovalRecord, type ApprovalState, type PublishState } from "./approval.ts";
import { coveringRightsRecordIds, rightsGate, type FileReference, type RightsRecordFacts } from "./governance.ts";
import { deliveredManifestOf } from "./manifest.ts";
import { randomUUID } from "node:crypto";
import { engineDeliveredMaster } from "../../../engine/api/index.ts";
import { ENGINE_MEDIA_LINK_TTL_SECONDS, type MediaLinkSigner } from "../../../engine/jobs/media-link.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { iso, audit, requireWorkspaceAdmin, sessionAccess, requireBrandInWorkspace, todayIso, dateString, idListOf } from "./service-core.ts";

/**
 * The hooks of a brand's started videos, and where they repeat (portfolio). Admins of the brand's workspace only, and the brand must be in
 * that workspace. Reads what the runs stored; it writes nothing and invents no hook.
 */
export async function brandHookHistory(sql: Sql, userId: string, input: { organizationId: string; brandId: string }): Promise<HookHistory> {
  await requireWorkspaceAdmin(sql, userId, input.organizationId);
  await requireBrandInWorkspace(sql, input.organizationId, input.brandId);
  return hookHistoryOf(await readStartedHooks(sql, input.organizationId, input.brandId));
}

/**
 * What a brand's video runs cost (portfolio economics): billed, estimated and held amounts, and the cost per delivered video with whether
 * it is final. Admins of the brand's workspace only. It reads the ledger; it estimates no bill.
 */
export async function brandEconomics(sql: Sql, userId: string, input: { organizationId: string; brandId: string }): Promise<BrandEconomics> {
  await requireWorkspaceAdmin(sql, userId, input.organizationId);
  await requireBrandInWorkspace(sql, input.organizationId, input.brandId);
  const runs = await readBrandRuns(sql, input.organizationId, input.brandId);
  const lines = await readBrandLedger(sql, input.organizationId, input.brandId);
  return economicsOf(runs, lines);
}

export type DeliveredLink =
  | { status: "ready"; url: string; ttlSeconds: number; bytes: number; durationMs: number }
  | { status: "not_ready" | "not_connected" | "refused"; reason: string };

/**
 * A short-lived link to the delivered master of a session's video. The engine reads the master back through its contracts (the manifest and
 * the rendered video must name the same video), and refuses unless the request is delivered, so a link is never made for an undelivered
 * video. The link is signed on request and expires after the media-link TTL. Admins of the session's workspace only.
 */
export async function deliveredMasterLink(sql: Sql, userId: string, input: { sessionId: string }, signer?: MediaLinkSigner): Promise<DeliveredLink> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  if (row.status !== "started" || row.engine_request_id === null) return { status: "not_ready", reason: "This session has no video yet." };
  // A download is an export of the video, so the rights gate applies to it as it does to an approval (AGENTS.md rule 8). A file the video was
  // made from with no valid rights record blocks the link.
  const gate = rightsGate(await storedFilesOf(sql, row.organization_id, row.id), await rightsRecordsOf(sql, row.organization_id, row.brand_id), todayIso());
  if (!gate.ok) {
    return { status: "not_ready", reason: `No valid rights record covers ${gate.missing.join(", ")}, so the video cannot be downloaded. Add the rights under Content standards.` };
  }
  let master: Awaited<ReturnType<typeof engineDeliveredMaster>>;
  try {
    master = await engineDeliveredMaster(sql, row.organization_id, row.engine_request_id);
  } catch (error) {
    // The engine names the state of the request ("is running, not delivered"). A person needs the consequence, not the state.
    const message = error instanceof Error ? error.message : "";
    if (/not delivered/.test(message)) return { status: "not_ready", reason: "The engine has not delivered this video yet, so there is no file to download." };
    return { status: "not_ready", reason: message || "The video is not delivered yet, so there is no file to download." };
  }
  const mediaLinks = signer ?? (await import("../storage/engine-media-link.ts")).engineMediaLinkSigner();
  const result = await mediaLinks.sign(row.organization_id, master.renderedVideo.uri, ENGINE_MEDIA_LINK_TTL_SECONDS);
  if (result.status === "ok") {
    return { status: "ready", url: result.url, ttlSeconds: ENGINE_MEDIA_LINK_TTL_SECONDS, bytes: master.renderedVideo.bytes, durationMs: master.renderedVideo.durationMs };
  }
  return { status: result.status, reason: result.reason };
}

/** The approval of a session's video: the current video's state, every decision on the session, and the publish state (not connected). */

export type DeliveryApproval = {
  /** The engine request of the session's current video, or null when the session has no video yet. */
  requestId: string | null;
  /** Whether the engine has delivered the current video. Only a delivered video can be decided. */
  delivered: boolean;
  state: ApprovalState;
  /** Every decision made on the session, oldest first. Each names the video it was made on. Rows are never edited. */
  history: ApprovalRecord[];
  /** The stored files of the video that have no valid rights record. An approval is blocked while this is not empty. */
  rightsMissing: string[];
  publish: PublishState;
};

async function approvalRecords(sql: Sql, organizationId: string, sessionId: string): Promise<ApprovalRecord[]> {
  const rows = await sql<{ engine_request_id: string; manifest_id: string | null; decision: string; reason: string; actor_id: string; created_at: unknown; rights_record_ids: unknown }>`
    select engine_request_id, manifest_id, decision, reason, actor_id, created_at, rights_record_ids from content_factory_approvals
    where organization_id = ${organizationId} and session_id = ${sessionId}
    order by created_at asc
  `;
  return rows.flatMap((row) => (isApprovalDecision(row.decision)
    ? [{
      engineRequestId: row.engine_request_id,
      manifestId: row.manifest_id,
      decision: row.decision,
      reason: row.reason,
      actorId: row.actor_id,
      createdAt: iso(row.created_at),
      rightsRecordIds: idListOf(row.rights_record_ids),
    }]
    : []));
}

/** A list of record ids as stored in a jsonb column. A value that is not a list of text reads as no ids. */

export async function storedFilesOf(sql: Sql, organizationId: string, sessionId: string): Promise<FileReference[]> {
  const rows = await sql<{ id: string; file_name: string | null }>`
    select id, file_name from content_factory_attachments
    where organization_id = ${organizationId} and session_id = ${sessionId} and kind = 'file'
  `;
  return rows.map((row) => ({ attachmentId: row.id, fileName: row.file_name ?? "an unnamed file" }));
}

/** The rights records of a brand that name a stored file. A record with an end date, or a revocation, is read as it stands. */

export async function rightsRecordsOf(sql: Sql, organizationId: string, brandId: string | null): Promise<RightsRecordFacts[]> {
  if (brandId === null) return [];
  const rows = await sql<{ id: string; attachment_id: string | null; valid_until: unknown; revoked_at: unknown }>`
    select id, attachment_id, valid_until, revoked_at from rights_records
    where organization_id = ${organizationId} and brand_id = ${brandId} and attachment_id is not null
  `;
  return rows.map((row) => ({
    id: row.id,
    attachmentId: row.attachment_id,
    validUntil: row.valid_until === null || row.valid_until === undefined ? null : dateString(row.valid_until),
    revoked: row.revoked_at !== null && row.revoked_at !== undefined,
  }));
}

/** The approval state of a session's video. Admins of the session's workspace only. */

export async function deliveryApprovalOf(sql: Sql, userId: string, input: { sessionId: string }): Promise<DeliveryApproval> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  const history = await approvalRecords(sql, row.organization_id, row.id);
  const requestId = row.engine_request_id;
  const manifestId = await deliveredManifestOf(sql, row.organization_id, requestId);
  const rights = rightsGate(await storedFilesOf(sql, row.organization_id, row.id), await rightsRecordsOf(sql, row.organization_id, row.brand_id), todayIso());
  return {
    requestId,
    delivered: manifestId !== null,
    state: requestId === null ? { status: "not_decided" } : approvalStateFor(history, requestId, manifestId),
    history,
    rightsMissing: rights.ok ? [] : rights.missing,
    publish: publishStateOf(),
  };
}

/**
 * A person's decision on the delivered video: approve, or reject with the reason. Only an admin of the session's workspace can decide, and
 * only a video the engine has delivered. The decision is written once, against the video's request, and is audited. Saying the same
 * decision twice is refused, so the history holds no repeats. A later decision may change an earlier one, and both stay on record.
 */
export async function recordDeliveryApproval(sql: Sql, userId: string, input: { sessionId: string; decision: string; reason: string }): Promise<DeliveryApproval> {
  const problem = approvalProblem(input);
  if (problem) throw new Error(problem);
  if (!isApprovalDecision(input.decision)) throw new Error("Choose approve or reject.");
  const reason = input.reason.trim();
  await withTransaction(sql, async (tx) => {
    const row = await sessionAccess(tx, userId, input.sessionId);
    if (row.status !== "started" || row.engine_request_id === null) {
      throw new Error("This session has no video yet, so there is nothing to approve or reject.");
    }
    // The session row is locked, so two decisions on one video cannot both pass the check below.
    await tx`select id from content_factory_sessions where id = ${row.id} for update`;
    const manifestId = await deliveredManifestOf(tx, row.organization_id, row.engine_request_id);
    if (manifestId === null) {
      throw new Error("The engine has not delivered this video yet, so there is nothing to approve or reject.");
    }
    const current = approvalStateFor(await approvalRecords(tx, row.organization_id, row.id), row.engine_request_id, manifestId);
    if (current.status === input.decision) throw new Error(`This video is already ${input.decision}.`);
    // The rights gate blocks an approval until every file the video was made from has a valid rights record (governance.ts). A rejection
    // is not gated: a video that should not go out is always allowed to be turned down. An approval names the records it relied on.
    let rightsRecordIds: string[] = [];
    if (input.decision === "approved") {
      const files = await storedFilesOf(tx, row.organization_id, row.id);
      const records = await rightsRecordsOf(tx, row.organization_id, row.brand_id);
      const gate = rightsGate(files, records, todayIso());
      if (!gate.ok) {
        throw new Error(`The approval is blocked: no valid rights record covers ${gate.missing.join(", ")}. Add the rights under Content standards, then approve.`);
      }
      rightsRecordIds = coveringRightsRecordIds(files, records, todayIso());
    }
    await tx`
      insert into content_factory_approvals (id, organization_id, brand_id, session_id, engine_request_id, manifest_id, decision, reason, actor_id, rights_record_ids)
      values (${randomUUID()}, ${row.organization_id}, ${row.brand_id}, ${row.id}, ${row.engine_request_id}, ${manifestId}, ${input.decision}, ${reason}, ${userId}, ${JSON.stringify(rightsRecordIds)}::jsonb)
    `;
    await audit(tx, {
      organizationId: row.organization_id,
      brandId: row.brand_id,
      actorId: userId,
      action: `content_factory.video_${input.decision}`,
      objectId: row.id,
      metadata: { engineRequestId: row.engine_request_id, manifestId, rightsRecordCount: String(rightsRecordIds.length) },
    });
  });
  return deliveryApprovalOf(sql, userId, { sessionId: input.sessionId });
}
