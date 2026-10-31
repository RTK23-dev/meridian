// The Content Factory run functions: start a run, revise it, and read it. Moved out of content-factory/service.ts unchanged
// (coding loop, T6). service.ts re-exports the public names.

import { engineReadiness, engineRequestFeed, engineRequestStatus, productionReadinessPorts, startEngineRequest, type EngineReadiness } from "../../../engine/api/index.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { feedCards, type RunFeed } from "./feed.ts";
import { driveFileStore, type FileStoreReadiness } from "./files.ts";
import type { Message } from "./model.ts";
import { buildProductionRequest, inputNotes, referenceOf } from "./request.ts";
import { themePageKits } from "./sources.ts";
import { REFERENCE_NOTE, iso, priorIds, settingsOf, audit, sessionAccess, requireDraft } from "./service-core.ts";
import type { ContentFactoryPorts, SessionRow } from "./service-core.ts";
import { messagesOf, postMessage } from "./service-sessions.ts";

async function buildFor(sql: Sql, row: SessionRow, messages: Message[]) {
  const pageSource = messages.flatMap((message) => message.attachments).find((item) => item.kind === "source" && item.page === "page");
  const themePage = pageSource && pageSource.kind === "source"
    ? await themePageKits(sql, { organizationId: row.organization_id, brandId: pageSource.brandId }, pageSource.recordId)
    : null;
  return buildProductionRequest({
    id: row.id,
    organizationId: row.organization_id,
    createdAt: iso(row.created_at),
    revision: Number(row.revision) || 0,
    settings: settingsOf(row),
    messages,
    themePage,
  });
}

async function readinessOf(sql: Sql, organizationId: string, ports: ContentFactoryPorts): Promise<EngineReadiness> {
  // A session's reference video is analysed from its transcript, so speech-to-text must be connected for every Content Factory run.
  return engineReadiness(organizationId, ports.readiness ?? (await productionReadinessPorts(sql)), { variantCount: 0, speech: true });
}

export type StartOutcome =
  | { status: "started"; auditRecorded: boolean; requestId: string }
  | { status: "refused"; problems: string[]; notConnected: string[] };

/**
 * "Make the video": builds the production request from the session and starts it through the engine's API. Nothing is started unless
 * the engine's schema accepts the request and the engine is connected; every reason is returned and kept on the session. The session is
 * marked started in the transaction that queues the request.
 */
export async function startRun(sql: Sql, userId: string, input: { sessionId: string }, ports: ContentFactoryPorts = {}): Promise<StartOutcome> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  requireDraft(row);
  const messages = await messagesOf(sql, row);
  const build = await buildFor(sql, row, messages);
  const readiness = await readinessOf(sql, row.organization_id, ports);
  const problems = build.status === "incomplete" ? build.problems : [];
  const notConnected = readiness.status === "not_connected" ? readiness.reasons : [];
  const refuse = async (problemList: string[], notConnectedList: string[]): Promise<StartOutcome> => {
    await sql`
      update content_factory_sessions set last_refusal = ${JSON.stringify([...problemList, ...notConnectedList])}, updated_at = now()
      where id = ${row.id} and organization_id = ${row.organization_id}
    `;
    return { status: "refused", problems: problemList, notConnected: notConnectedList };
  };
  if (build.status !== "ready" || notConnected.length > 0) return refuse(problems, notConnected);

  const request = build.request;
  const markStarted = async (tx: Sql): Promise<void> => {
    await tx`
      update content_factory_sessions set status = 'started', engine_request_id = ${request.requestId}, started_at = now(), last_refusal = '[]', updated_at = now()
      where id = ${row.id} and organization_id = ${row.organization_id} and status = 'draft'
    `;
  };
  try {
    const started = await startEngineRequest(sql, { organizationId: row.organization_id, brandId: row.brand_id, request, variantCount: 0, beforeQueue: markStarted });
    if (started.status === "exists") await markStarted(sql);
  } catch (error) {
    // A second start of the same session, racing this one, meets the unique key of the request: say so, not the database's words (review 2026-10-22, item 11).
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "23505") return refuse(["This session is already starting a video. Refresh to see it; nothing was started twice."], []);
    if (code !== "") return refuse(["The request could not be stored right now. Nothing was started. Try again."], []);
    return refuse([`The engine refused the request: ${error instanceof Error ? error.message : "no reason was given."}`], []);
  }
  // The video has started. A failure to write its audit line is not a failed start: the outcome says the line is missing (review item 11).
  const auditRecorded = await audit(sql, { organizationId: row.organization_id, brandId: row.brand_id, actorId: userId, action: "content_factory.run_started", objectId: row.id, metadata: { requestId: request.requestId } }).then(
    () => true,
    () => false,
  );
  return { status: "started", requestId: request.requestId, auditRecorded };
}

export type ReviseOutcome =
  | { status: "draft"; revision: number; priorRequestId: string }
  | { status: "refused"; reason: string };

/**
 * Reopens a session after its current video is delivered or has failed. The current request id is kept. The next start uses
 * the next revision, so it does not reuse that request. A video that is still running is left alone.
 */

/**
 * A revision with a direction for the whole video (D9). The session reopens as a draft (reviseSession), and the direction is posted as its next
 * instruction, so the brief of the new video carries it. The whole video is planned again, as a revision is; only the plan decides which shots
 * change. A refused revision changes nothing, and the direction is not posted.
 */
export async function reviseWithDirection(sql: Sql, userId: string, input: { sessionId: string; direction: string }): Promise<ReviseOutcome> {
  const revised = await reviseSession(sql, userId, { sessionId: input.sessionId });
  if (revised.status !== "draft") return revised;
  const direction = input.direction.trim();
  if (direction !== "") await postMessage(sql, userId, { sessionId: input.sessionId, text: direction, beatRole: null });
  return revised;
}

export async function reviseSession(sql: Sql, userId: string, input: { sessionId: string }): Promise<ReviseOutcome> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  if (row.status !== "started" || row.engine_request_id === null) {
    return { status: "refused", reason: "This session has no video to revise." };
  }
  const kept = [...priorIds(row.prior_request_ids), row.engine_request_id];
  // Narrowed to a string by the check above. A value read inside the transaction below would lose that narrowing.
  const priorRequestId = row.engine_request_id;
  const revision = (Number(row.revision) || 0) + 1;
  // The request row is locked for the check and the change together. A remake of the same request takes the same lock when it is applied
  // (orchestrator-sql.ts), so the two cannot both see the video as delivered and both change it (review 2026-10-22, item 9).
  const outcome = await withTransaction<ReviseOutcome>(sql, async (tx) => {
    await tx`
      select id from engine_requests where id = ${priorRequestId} and organization_id = ${row.organization_id} for update
    `;
    // The same reading the status page uses, taken under the lock: a rejected request is failed, and a delivered one needs its manifest.
    const current = await engineRequestStatus(tx, row.organization_id, priorRequestId);
    if (!current || (current.status !== "delivered" && current.status !== "failed")) {
      return { status: "refused", reason: "A revision waits until this video is delivered or has failed. Nothing was changed." };
    }
    const updated = await tx<{ id: string }>`
      update content_factory_sessions
      set status = 'draft', engine_request_id = null, revision = ${revision}, prior_request_ids = ${JSON.stringify(kept)},
          last_refusal = '[]', updated_at = now()
      where id = ${row.id} and organization_id = ${row.organization_id} and status = 'started' and engine_request_id = ${row.engine_request_id}
      returning id
    `;
    if (!updated[0]) return { status: "refused", reason: "This session changed before the revision was saved. Nothing was changed." };
    return { status: "draft", revision, priorRequestId };
  });
  if (outcome.status !== "draft") return outcome;
  await audit(sql, {
    organizationId: row.organization_id,
    brandId: row.brand_id,
    actorId: userId,
    action: "content_factory.revised",
    objectId: row.id,
    metadata: { priorRequestId: row.engine_request_id, revision: String(revision) },
  });
  return outcome;
}

export type RunView =
  | {
      stage: "draft";
      /** What the engine's schema still needs, in plain words. */
      problems: string[];
      /** Why the engine cannot run in this workspace now. Empty when it can. */
      notConnected: string[];
      files: FileStoreReadiness;
      hasReference: boolean;
      referenceNote: string;
      /** What each file does on its way to the engine. A readable PDF is in the brief. An unreadable PDF says so. */
      inputs: string[];
      /** Earlier engine requests of this session, oldest first. Empty on the first draft. */
      priorRequestIds: string[];
    }
  | { stage: "started"; feed: RunFeed; referenceNote: string; inputs: string[]; canRevise: boolean }
  | { stage: "missing"; reason: string };

/** The run of a session: before the start, what is still missing; after it, the decision feed read from the engine. */

export async function readRun(sql: Sql, userId: string, input: { sessionId: string }, ports: ContentFactoryPorts = {}): Promise<RunView> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  const messages = await messagesOf(sql, row);
  const inputs = inputNotes(messages.flatMap((message) => message.attachments));
  if (row.status === "started" && row.engine_request_id !== null) {
    const feed = await engineRequestFeed(sql, row.organization_id, row.engine_request_id);
    if (!feed) return { stage: "missing", reason: `The engine has no request ${row.engine_request_id} in this workspace.` };
    return {
      stage: "started",
      feed: feedCards(feed),
      referenceNote: REFERENCE_NOTE,
      inputs,
      canRevise: feed.status.status === "delivered" || feed.status.status === "failed",
    };
  }
  const build = await buildFor(sql, row, messages);
  const readiness = await readinessOf(sql, row.organization_id, ports);
  const files: FileStoreReadiness = row.brand_id === null
    ? { status: "not_connected", reason: "Choose a brand for this session to attach files. Meridian keeps files in the brand's Google Drive folder." }
    : await (ports.files ?? driveFileStore(sql)).ready(row.organization_id);
  return {
    stage: "draft",
    problems: build.status === "incomplete" ? build.problems : [],
    notConnected: readiness.status === "not_connected" ? readiness.reasons : [],
    files,
    hasReference: referenceOf(messages.flatMap((message) => message.attachments)) !== null,
    referenceNote: REFERENCE_NOTE,
    inputs,
    priorRequestIds: priorIds(row.prior_request_ids),
  };
}
