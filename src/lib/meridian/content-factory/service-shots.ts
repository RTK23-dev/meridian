// The Content Factory shot functions: remake, the clip and its quote, the model choices and the decisions. Moved out of
// content-factory/service.ts unchanged (coding loop, T6). service.ts re-exports the public names.

import { decideEngineShot, quoteEngineDecision, quoteEngineClip, quoteEngineShotRemake, remakeEngineShot, replaceShotWithClip, shotTakeLink, type RemakePorts, type RemakeQuote, type ShotModelOptions, shotModelOptions, type ShotTakeLink } from "../../../engine/api/index.ts";
import type { MediaLinkSigner } from "../../../engine/jobs/media-link.ts";
import type { ShotDecision } from "../../../engine/review/shot-decision.ts";
import type { Sql } from "../learning/store.ts";
import { audit, sessionAccess } from "./service-core.ts";

export type RemakeOutcome = { status: "queued"; revision: number } | { status: "refused"; reasons: string[] };

/**
 * Makes one shot of the session's delivered video again (Bible 5.5). Only an admin of the session's workspace can: the session's access
 * check is the same one every change in Content Factory uses. The session keeps its request, so the shot's new take, its edit, its render
 * and its review run on the same video, and the video is delivered again as its next revision. A refusal says why, and nothing is
 * reserved for it.
 */
export async function remakeShot(sql: Sql, userId: string, input: { sessionId: string; shotId: string; directive: string | null; modelId: string | null }, ports?: RemakePorts): Promise<RemakeOutcome> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  if (row.status !== "started" || row.engine_request_id === null) {
    return { status: "refused", reasons: ["This session has no video yet. Make the video first."] };
  }
  const outcome = await remakeEngineShot(
    sql,
    { organizationId: row.organization_id, requestId: row.engine_request_id, shotId: input.shotId, directive: input.directive, modelId: input.modelId, now: new Date().toISOString() },
    ports,
  );
  if (outcome.status === "refused") return outcome;
  await audit(sql, {
    organizationId: row.organization_id,
    brandId: row.brand_id,
    actorId: userId,
    action: "content_factory.shot_remade",
    objectId: row.id,
    metadata: { requestId: row.engine_request_id, shotId: input.shotId, revision: String(outcome.revision) },
  });
  return { status: "queued", revision: outcome.revision };
}

/**
 * The take a shot shows, as a short-lived link for the session's admin (Bible 5.5). Only an admin of the session's workspace can; a session
 * with no video has no take. Nothing is written. The link is signed for the request's organization only, and the signer is loaded here so
 * the storage client is not loaded for the tests that do not need it.
 */
export async function shotTakeOf(sql: Sql, userId: string, input: { sessionId: string; shotId: string }, signer?: MediaLinkSigner): Promise<ShotTakeLink> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  if (row.status !== "started" || row.engine_request_id === null) return { status: "not_ready", reason: "This session has no video yet." };
  const mediaLinks = signer ?? (await import("../storage/engine-media-link.ts")).engineMediaLinkSigner();
  return shotTakeLink(sql, { organizationId: row.organization_id, requestId: row.engine_request_id, shotId: input.shotId }, mediaLinks);
}

/**
 * A reviewer's own clip for one shot of the session's video (D12). The file is probed and must be an H.264 MP4 at the take size that covers
 * the shot. The remake runs with the clip as the shot's take: no model is called for it. Admin of the session's workspace only.
 */
export async function shotClip(sql: Sql, userId: string, input: { sessionId: string; shotId: string; bytes: Uint8Array<ArrayBuffer> }, ports?: RemakePorts): Promise<RemakeOutcome> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  if (row.status !== "started" || row.engine_request_id === null) {
    return { status: "refused", reasons: ["This session has no video yet. Make the video first."] };
  }
  const outcome = await replaceShotWithClip(sql, { organizationId: row.organization_id, requestId: row.engine_request_id, shotId: input.shotId, bytes: input.bytes, now: new Date().toISOString() }, ports);
  if (outcome.status === "refused") return outcome;
  await audit(sql, {
    organizationId: row.organization_id,
    brandId: row.brand_id,
    actorId: userId,
    action: "content_factory.shot_clip",
    objectId: row.id,
    metadata: { requestId: row.engine_request_id, shotId: input.shotId, revision: String(outcome.revision) },
  });
  return { status: "queued", revision: outcome.revision };
}

/** What a reviewer's clip would reserve for one shot, before it is confirmed. Read only. */

export async function shotClipQuote(sql: Sql, userId: string, input: { sessionId: string; shotId: string; bytes: Uint8Array<ArrayBuffer> }, ports?: RemakePorts): Promise<RemakeQuote> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  if (row.status !== "started" || row.engine_request_id === null) {
    return { status: "refused", reasons: ["This session has no video yet. Make the video first."] };
  }
  return quoteEngineClip(sql, { organizationId: row.organization_id, requestId: row.engine_request_id, shotId: input.shotId, bytes: input.bytes, now: new Date().toISOString() }, ports);
}

/** The models a reviewer may pick for one generated shot of the session's video (D11). Read only. */

export async function shotModelChoices(sql: Sql, userId: string, input: { sessionId: string; shotId: string }, ports?: RemakePorts): Promise<ShotModelOptions> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  if (row.status !== "started" || row.engine_request_id === null) {
    return { status: "refused", reasons: ["This session has no video yet. Make the video first."] };
  }
  return shotModelOptions(sql, { organizationId: row.organization_id, requestId: row.engine_request_id, shotId: input.shotId, now: new Date().toISOString() }, ports);
}

/** What remaking one shot would reserve, before the reviewer confirms it (Bible 5.5). Read only: nothing is reserved, queued or called. */

export async function shotRemakeQuote(sql: Sql, userId: string, input: { sessionId: string; shotId: string; modelId: string | null }, ports?: RemakePorts): Promise<RemakeQuote> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  if (row.status !== "started" || row.engine_request_id === null) {
    return { status: "refused", reasons: ["This session has no video yet. Make the video first."] };
  }
  return quoteEngineShotRemake(sql, { organizationId: row.organization_id, requestId: row.engine_request_id, shotId: input.shotId, modelId: input.modelId, now: new Date().toISOString() }, ports);
}

/**
 * A reviewer's change to one shot of the session's video (edit_prompt or change_visual_type, Bible 12.5). It is a remake of that shot with
 * the change (D7 and D8), and the same rules apply: an admin of the session's workspace only, and only once the video exists.
 */
export async function shotDecision(sql: Sql, userId: string, input: { sessionId: string; shotId: string; decision: ShotDecision; modelId: string | null }, ports?: RemakePorts): Promise<RemakeOutcome> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  if (row.status !== "started" || row.engine_request_id === null) {
    return { status: "refused", reasons: ["This session has no video yet. Make the video first."] };
  }
  const outcome = await decideEngineShot(sql, { organizationId: row.organization_id, requestId: row.engine_request_id, shotId: input.shotId, decision: input.decision, modelId: input.modelId, now: new Date().toISOString() }, ports);
  if (outcome.status === "refused") return outcome;
  await audit(sql, {
    organizationId: row.organization_id,
    brandId: row.brand_id,
    actorId: userId,
    action: "content_factory.shot_changed",
    objectId: row.id,
    metadata: { requestId: row.engine_request_id, shotId: input.shotId, action: input.decision.action, revision: String(outcome.revision) },
  });
  return { status: "queued", revision: outcome.revision };
}

/** What a reviewer's change to one shot would reserve, before it is confirmed. Read only. */

export async function shotDecisionQuote(sql: Sql, userId: string, input: { sessionId: string; shotId: string; decision: ShotDecision; modelId: string | null }, ports?: RemakePorts): Promise<RemakeQuote> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  if (row.status !== "started" || row.engine_request_id === null) {
    return { status: "refused", reasons: ["This session has no video yet. Make the video first."] };
  }
  return quoteEngineDecision(sql, { organizationId: row.organization_id, requestId: row.engine_request_id, shotId: input.shotId, decision: input.decision, modelId: input.modelId, now: new Date().toISOString() }, ports);
}
