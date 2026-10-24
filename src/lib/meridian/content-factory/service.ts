/**
 * The checks and the reads and writes behind the Content Factory server functions (actions.ts). Everything that decides who may see or
 * change what is here, so the tests run it on PGlite without the server runtime.
 *
 * - Roles (AGENTS.md rule 2). Every read and every write needs the admin role in the workspace (access.ts hasRole). The role is the one
 *   the database holds for the caller, never one the client sends.
 * - Tenancy. A workspace read needs a membership in that workspace. A session is read in the workspace it belongs to, and the server
 *   looks that workspace up from the session id: a client never names the workspace of a session. A caller who is not a member gets the
 *   same refusal as for an unknown session, so a session id reveals nothing about other workspaces. A brand must be a brand of the
 *   session's workspace.
 * - One video at a time. While a request is running, the session takes no more messages, files or settings. When that request is
 *   delivered or has failed, a revision reopens the session. The earlier request stays stored, and the next video gets its own id.
 * - The engine is reached only through src/engine/api: start, requestProblems (through request.ts), readiness and the request feed.
 */
import { hookHistoryOf, type HookHistory } from "./hook-history.ts";
import { readStartedHooks } from "./hook-history-store.ts";
import { economicsOf, type BrandEconomics } from "./economics.ts";
import { readBrandLedger, readBrandRuns } from "./economics-store.ts";
import { approvalProblem, approvalStateFor, isApprovalDecision, publishStateOf, type ApprovalRecord, type ApprovalState, type PublishState } from "./approval.ts";
import { coveringRightsRecordIds, rightsGate, type FileReference, type RightsRecordFacts } from "./governance.ts";
import { deliveredManifestOf } from "./manifest.ts";
import { randomUUID } from "node:crypto";
import {
  engineReadiness,
  engineRequestFeed,
  engineRequestStatus,
  productionReadinessPorts,
  decideEngineShot,
  quoteEngineDecision,
  quoteEngineClip,
  quoteEngineShotRemake,
  remakeEngineShot,
  replaceShotWithClip,
  engineDeliveredMaster,
  shotTakeLink,
  startEngineRequest,
  type EngineReadiness,
  type EngineReadinessPorts,
  type RemakePorts,
  type RemakeQuote,
  type ShotModelOptions,
  shotModelOptions,
  type ShotTakeLink,
} from "../../../engine/api/index.ts";
import { ENGINE_MEDIA_LINK_TTL_SECONDS, type MediaLinkSigner } from "../../../engine/jobs/media-link.ts";
import type { ShotDecision } from "../../../engine/review/shot-decision.ts";
import { hasRole, isRole } from "../access.ts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { feedCards, type RunFeed } from "./feed.ts";
import { extractPdf } from "../ingestion/pdf.ts";
import { characterCount, checkFile, decodeUpload, driveFileStore, imageDimensions, safeFileName, sessionFileKey, type ContentFactoryFileStore, type FileStoreReadiness } from "./files.ts";
import {
  isKeepableGene,
  isPriority,
  isScriptRole,
  isSourcePage,
  MAX_SECONDS,
  MIN_SECONDS,
  TEXT_FILE_MAX_CHARS,
  PDF_OVER_LIMIT_CONTENT,
  type Attachment,
  type FilePurpose,
  type KeepableGene,
  type Message,
  type ScriptRole,
  type SessionDetail,
  type SessionSettings,
  type SessionSummary,
  type SourcePage,
  type SourceResult,
} from "./model.ts";
import { buildProductionRequest, inputNotes, referenceOf } from "./request.ts";
import { readSourceRecord, searchSourceRecords, themePageKits } from "./sources.ts";

export const WORKSPACE_REFUSAL = "This workspace is not available to you.";
export const SESSION_REFUSAL = "This session is not available to you.";
export const ADMIN_REFUSAL = "Content Factory is for workspace admins. Your role in this workspace does not include it.";
export const BRAND_REFUSAL = "That brand is not in this workspace.";
export const STARTED_REFUSAL = "This session has already made its video. Revise it to make another, or start a new session.";
export const MESSAGE_REFUSAL = "That message is not in this session.";

/** The engine's own statement about the reference video, shown on the screen (Bible principle 4 and 6.2 step 7). */
export const REFERENCE_NOTE =
  "The reference video is analysed only. Its footage, words, voice and music never enter the new video, and the engine deletes the source media after the analysis.";

/** Ports a test replaces. Production: Meridian's Drive-backed store and the engine's production readiness ports. */
export type ContentFactoryPorts = {
  files?: ContentFactoryFileStore;
  readiness?: EngineReadinessPorts;
};

type SessionRow = {
  id: string;
  organization_id: string;
  brand_id: string | null;
  title: string;
  status: string;
  engine_request_id: string | null;
  revision: number;
  prior_request_ids: string;
  budget_usd: string | number | null;
  max_seconds: number | null;
  language: string | null;
  priority: string | null;
  keep_genes: string;
  last_refusal: string;
  started_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

const SESSION_COLUMNS = `s.id, s.organization_id, s.brand_id, s.title, s.status, s.engine_request_id, s.revision, s.prior_request_ids,
  s.budget_usd, s.max_seconds, s.language, s.priority, s.keep_genes, s.last_refusal, s.started_at, s.created_at, s.updated_at`;

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

function jsonList(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function priorIds(text: string): string[] {
  return jsonList(text).filter((item): item is string => typeof item === "string" && item.length > 0);
}

function summaryOf(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    brandId: row.brand_id,
    status: row.status === "started" ? "started" : "draft",
    engineRequestId: row.engine_request_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function settingsOf(row: SessionRow): SessionSettings {
  const budget = row.budget_usd === null ? null : Number(row.budget_usd);
  return {
    budgetUsd: budget !== null && Number.isFinite(budget) ? budget : null,
    maxSeconds: row.max_seconds === null ? null : Number(row.max_seconds),
    language: row.language,
    priority: isPriority(row.priority) ? row.priority : null,
    keepGenes: jsonList(row.keep_genes).filter(isKeepableGene),
  };
}

async function audit(sql: Sql, entry: { organizationId: string; brandId: string | null; actorId: string; action: string; objectId: string; metadata?: Record<string, string> }): Promise<void> {
  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (${randomUUID()}, ${entry.organizationId}, ${entry.brandId}, ${entry.actorId}, ${entry.action}, 'content_factory_session', ${entry.objectId}, ${JSON.stringify(entry.metadata ?? {})})
  `;
}

// --- Access ----------------------------------------------------------------------------------------------------------------

/** Refuses a caller who is not an admin (or owner) of the workspace. */
export async function requireWorkspaceAdmin(sql: Sql, userId: string, organizationId: string): Promise<void> {
  const rows = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = rows[0]?.role;
  if (!role || !isRole(role)) throw new Error(WORKSPACE_REFUSAL);
  if (!hasRole(role, "admin")) throw new Error(ADMIN_REFUSAL);
}

/** The session and its workspace, read in one statement with the caller's role. Unknown and foreign sessions get the same refusal. */
async function sessionAccess(sql: Sql, userId: string, sessionId: string): Promise<SessionRow> {
  const rows = await sql.query<SessionRow & { role: string | null }>(
    `select ${SESSION_COLUMNS}, m.role
     from content_factory_sessions s
     left join memberships m on m.organization_id = s.organization_id and m.user_id = $2
     where s.id = $1 limit 1`,
    [sessionId, userId],
  );
  const row = rows[0];
  if (!row || row.role === null || !isRole(row.role)) throw new Error(SESSION_REFUSAL);
  if (!hasRole(row.role, "admin")) throw new Error(ADMIN_REFUSAL);
  return row;
}

async function requireBrandInWorkspace(sql: Sql, organizationId: string, brandId: string): Promise<void> {
  const rows = await sql<{ id: string }>`
    select id from brands where id = ${brandId} and organization_id = ${organizationId} and deleted_at is null limit 1
  `;
  if (!rows[0]) throw new Error(BRAND_REFUSAL);
}

function requireDraft(row: { status: string }): void {
  if (row.status !== "draft") throw new Error(STARTED_REFUSAL);
}

/**
 * Locks the session row until the transaction ends, then refuses unless the session is still a draft. A write that must not land on a
 * started session runs after this in the same transaction: a start that is waiting on the lock cannot commit before the write.
 */
async function lockDraft(tx: Sql, row: SessionRow): Promise<void> {
  const [locked] = await tx<{ status: string }>`
    select status from content_factory_sessions where id = ${row.id} and organization_id = ${row.organization_id} for update
  `;
  if (!locked) throw new Error(SESSION_REFUSAL);
  requireDraft(locked);
}

async function hasReferenceVideo(sql: Sql, row: SessionRow): Promise<boolean> {
  const existing = await sql<{ id: string }>`
    select id from content_factory_attachments where session_id = ${row.id} and organization_id = ${row.organization_id} and purpose = 'reference_video' limit 1
  `;
  return existing[0] !== undefined;
}

async function requireMessage(sql: Sql, row: SessionRow, messageId: string): Promise<void> {
  const rows = await sql<{ id: string }>`
    select id from content_factory_messages where id = ${messageId} and session_id = ${row.id} and organization_id = ${row.organization_id} limit 1
  `;
  if (!rows[0]) throw new Error(MESSAGE_REFUSAL);
}

async function touch(sql: Sql, row: SessionRow): Promise<void> {
  await sql`update content_factory_sessions set updated_at = now() where id = ${row.id} and organization_id = ${row.organization_id}`;
}

// --- Sessions and messages -------------------------------------------------------------------------------------------------

export async function listSessions(sql: Sql, userId: string, input: { organizationId: string }): Promise<SessionSummary[]> {
  await requireWorkspaceAdmin(sql, userId, input.organizationId);
  const rows = await sql.query<SessionRow>(
    `select ${SESSION_COLUMNS} from content_factory_sessions s where s.organization_id = $1 order by s.updated_at desc, s.id desc limit 100`,
    [input.organizationId],
  );
  return rows.map(summaryOf);
}

export async function createSession(sql: Sql, userId: string, input: { organizationId: string; brandId: string | null; title: string }): Promise<SessionSummary> {
  await requireWorkspaceAdmin(sql, userId, input.organizationId);
  if (input.brandId !== null) await requireBrandInWorkspace(sql, input.organizationId, input.brandId);
  const id = randomUUID();
  await sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title)
    values (${id}, ${input.organizationId}, ${input.brandId}, ${userId}, ${input.title})
  `;
  await audit(sql, { organizationId: input.organizationId, brandId: input.brandId, actorId: userId, action: "content_factory.session_created", objectId: id });
  const rows = await sql.query<SessionRow>(`select ${SESSION_COLUMNS} from content_factory_sessions s where s.id = $1 and s.organization_id = $2`, [id, input.organizationId]);
  const row = rows[0];
  if (!row) throw new Error("The session was not saved.");
  return summaryOf(row);
}

async function messagesOf(sql: Sql, row: SessionRow): Promise<Message[]> {
  const messageRows = await sql<{ id: string; author_id: string | null; author_name: string | null; text: string; beat_role: string | null; created_at: unknown }>`
    select m.id, m.author_id, u.name as author_name, m.text, m.beat_role, m.created_at
    from content_factory_messages m
    left join "user" u on u.id = m.author_id
    where m.session_id = ${row.id} and m.organization_id = ${row.organization_id}
    order by m.created_at asc, m.id asc
  `;
  const attachmentRows = await sql<Record<string, unknown>>`
    select id, message_id, kind, purpose, file_name, storage_object_id, storage_key, media_type, byte_size, sha256, content,
      source_page, source_brand_id, source_record_id, snapshot, created_at
    from content_factory_attachments
    where session_id = ${row.id} and organization_id = ${row.organization_id}
    order by created_at asc, id asc
  `;
  const byMessage = new Map<string, Attachment[]>();
  for (const item of attachmentRows) {
    const messageId = String(item.message_id);
    const list = byMessage.get(messageId) ?? [];
    if (item.kind === "file") {
      list.push({
        id: String(item.id),
        kind: "file",
        messageId,
        purpose: item.purpose === "reference_video" ? "reference_video" : "material",
        fileName: String(item.file_name ?? ""),
        storageObjectId: item.storage_object_id === null ? null : String(item.storage_object_id),
        storageKey: String(item.storage_key ?? ""),
        mediaType: String(item.media_type ?? ""),
        bytes: Number(item.byte_size ?? 0),
        sha256: String(item.sha256 ?? ""),
        content: item.content === null || item.content === undefined ? null : String(item.content),
        createdAt: iso(item.created_at),
      });
    } else if (isSourcePage(item.source_page)) {
      list.push({
        id: String(item.id),
        kind: "source",
        messageId,
        page: item.source_page,
        brandId: String(item.source_brand_id ?? ""),
        recordId: String(item.source_record_id ?? ""),
        snapshot: String(item.snapshot ?? ""),
        createdAt: iso(item.created_at),
      });
    }
    byMessage.set(messageId, list);
  }
  return messageRows.map((message) => ({
    id: message.id,
    authorId: message.author_id,
    authorName: message.author_name,
    text: message.text,
    beatRole: isScriptRole(message.beat_role) ? message.beat_role : null,
    createdAt: iso(message.created_at),
    attachments: byMessage.get(message.id) ?? [],
  }));
}

function detailOf(row: SessionRow, messages: Message[]): SessionDetail {
  return {
    ...summaryOf(row),
    settings: settingsOf(row),
    lastRefusal: jsonList(row.last_refusal).filter((item): item is string => typeof item === "string"),
    startedAt: row.started_at === null ? null : iso(row.started_at),
    messages,
  };
}

export async function getSession(sql: Sql, userId: string, input: { sessionId: string }): Promise<SessionDetail> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  return detailOf(row, await messagesOf(sql, row));
}

export async function postMessage(sql: Sql, userId: string, input: { sessionId: string; text: string; beatRole: ScriptRole | null }): Promise<{ messageId: string }> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  requireDraft(row);
  if (input.beatRole !== null && input.text.trim() === "") throw new Error("A script line needs text.");
  const id = randomUUID();
  await withTransaction(sql, async (tx) => {
    await lockDraft(tx, row);
    await tx`
      insert into content_factory_messages (id, organization_id, session_id, author_id, text, beat_role)
      values (${id}, ${row.organization_id}, ${row.id}, ${userId}, ${input.text}, ${input.beatRole})
    `;
    await touch(tx, row);
  });
  return { messageId: id };
}

export type SettingsInput = {
  sessionId: string;
  /** Undefined leaves the brand as it is; null clears it. */
  brandId?: string | null;
  budgetUsd: number | null;
  maxSeconds: number | null;
  language: string | null;
  priority: string | null;
  keepGenes: KeepableGene[];
};

export async function saveSettings(sql: Sql, userId: string, input: SettingsInput): Promise<SessionDetail> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  requireDraft(row);
  if (input.maxSeconds !== null && (!Number.isInteger(input.maxSeconds) || input.maxSeconds < MIN_SECONDS || input.maxSeconds > MAX_SECONDS)) {
    throw new Error(`Set a length from ${MIN_SECONDS} to ${MAX_SECONDS} seconds.`);
  }
  if (input.budgetUsd !== null && (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0 || input.budgetUsd > 1000)) {
    throw new Error("Set a budget above $0 and at most $1,000.");
  }
  if (input.priority !== null && !isPriority(input.priority)) throw new Error("Choose rush, normal or batch.");
  let brandId = row.brand_id;
  if (input.brandId !== undefined && input.brandId !== row.brand_id) {
    if (input.brandId !== null) await requireBrandInWorkspace(sql, row.organization_id, input.brandId);
    // A video in a batch is checked and budgeted against its batch's brand. Moving it to another brand would split the two (security review).
    const batched = await sql<{ batch_id: string }>`select batch_id from content_factory_batch_items where session_id = ${row.id} limit 1`;
    if (batched.length > 0) throw new Error("This video is in a batch under its brand, so the brand cannot change. Start a new video for another brand.");
    const files = await sql<{ n: number }>`
      select count(*)::int as n from content_factory_attachments where session_id = ${row.id} and organization_id = ${row.organization_id} and kind = 'file'
    `;
    if (Number(files[0]?.n ?? 0) > 0) throw new Error("Files are stored under the session's brand, so the brand cannot change once a file is attached. Start a new session for another brand.");
    brandId = input.brandId;
  }
  await sql`
    update content_factory_sessions set
      brand_id = ${brandId}, budget_usd = ${input.budgetUsd}, max_seconds = ${input.maxSeconds}, language = ${input.language},
      priority = ${input.priority}, keep_genes = ${JSON.stringify([...new Set(input.keepGenes)])}, updated_at = now()
    where id = ${row.id} and organization_id = ${row.organization_id} and status = 'draft'
  `;
  return getSession(sql, userId, { sessionId: row.id });
}

// --- Files -----------------------------------------------------------------------------------------------------------------

export type UploadInput = { sessionId: string; messageId: string; fileName: string; purpose: FilePurpose; base64: string };

export type UploadOutcome =
  | { status: "stored"; attachmentId: string; mediaType: string; bytes: number }
  | { status: "refused"; reason: string }
  | { status: "not_connected"; reason: string };

/**
 * Stores one file of a message. The bytes are checked first (type from the bytes, size), then the store is asked whether it is connected,
 * and only then are they sent. Nothing is recorded for a file that was refused or not stored.
 */
export async function uploadFile(sql: Sql, userId: string, input: UploadInput, ports: ContentFactoryPorts = {}): Promise<UploadOutcome> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  requireDraft(row);
  await requireMessage(sql, row, input.messageId);
  const decoded = decodeUpload(input.base64);
  if (!decoded.ok) return { status: "refused", reason: decoded.reason };
  const checked = checkFile(decoded.bytes, input.purpose, input.fileName);
  if (!checked.ok) return { status: "refused", reason: checked.reason };
  // Refused before anything is sent. The same check runs again under the session's lock, in the transaction that records the file.
  if (input.purpose === "reference_video" && (await hasReferenceVideo(sql, row))) {
    return { status: "refused", reason: "This session already has a reference video. One session uses one reference." };
  }
  if (row.brand_id === null) {
    return { status: "not_connected", reason: "Choose a brand for this session first. Meridian keeps files in the brand's Google Drive folder." };
  }
  const store = ports.files ?? driveFileStore(sql);
  const ready: FileStoreReadiness = await store.ready(row.organization_id);
  if (ready.status !== "ready") return { status: "not_connected", reason: ready.reason };

  const file = checked.file;
  if (file.mediaType === "application/pdf") {
    const extracted = await extractPdf(decoded.bytes);
    if (extracted.status === "stored") {
      file.content = characterCount(extracted.text) <= TEXT_FILE_MAX_CHARS ? extracted.text : PDF_OVER_LIMIT_CONTENT;
    }
  }
  if (file.kind === "image") {
    const size = imageDimensions(decoded.bytes);
    if (size) file.content = `${size.width}×${size.height}`;
  }
  const key = sessionFileKey(row.id, file);
  let storageObjectId: string | null;
  try {
    ({ storageObjectId } = await store.put({ organizationId: row.organization_id, brandId: row.brand_id, key, mimeType: file.mediaType, bytes: decoded.bytes }));
  } catch (error) {
    return { status: "refused", reason: `The file was not stored: ${error instanceof Error ? error.message : "the store refused it."}` };
  }
  const id = randomUUID();
  // The draft check and the reference check run again here, under the session's lock, in the same transaction that records the file. A
  // session started after the checks above takes no file, and two reference uploads cannot both pass the check.
  let outcome: UploadOutcome;
  try {
    outcome = await withTransaction<UploadOutcome>(sql, async (tx) => {
      const refusal = await draftRefusalOf(tx, row);
      if (refusal) return { status: "refused", reason: refusal };
      if (input.purpose === "reference_video" && (await hasReferenceVideo(tx, row))) {
        return { status: "refused", reason: "This session already has a reference video. One session uses one reference." };
      }
      await tx`
        insert into content_factory_attachments (id, organization_id, session_id, message_id, kind, purpose, file_name, storage_object_id, storage_key, media_type, byte_size, sha256, content)
        values (${id}, ${row.organization_id}, ${row.id}, ${input.messageId}, 'file', ${input.purpose}, ${safeFileName(input.fileName)}, ${storageObjectId}, ${key},
          ${file.mediaType}, ${file.bytes}, ${file.sha256}, ${file.content})
      `;
      await touch(tx, row);
      await audit(tx, { organizationId: row.organization_id, brandId: row.brand_id, actorId: userId, action: "content_factory.file_stored", objectId: row.id, metadata: { attachmentId: id, mediaType: file.mediaType } });
      return { status: "stored", attachmentId: id, mediaType: file.mediaType, bytes: file.bytes };
    });
  } catch {
    outcome = { status: "refused", reason: "The file was not recorded. Nothing was added to the session." };
  }
  // The bytes are already in the store. A file that was not recorded is removed again, so no object is left that no session refers to.
  if (outcome.status !== "stored") await discardUnrecorded(store, row, key);
  return outcome;
}

/** The reason the session can no longer take a file, or null while it is a draft. The session row is locked until the transaction ends. */
async function draftRefusalOf(tx: Sql, row: SessionRow): Promise<string | null> {
  const [locked] = await tx<{ status: string }>`
    select status from content_factory_sessions where id = ${row.id} and organization_id = ${row.organization_id} for update
  `;
  if (!locked) return SESSION_REFUSAL;
  return locked.status === "draft" ? null : STARTED_REFUSAL;
}

/** Removes a stored object that no attachment records. Best effort: a failed removal leaves the object in the brand's folder, unreferenced. */
async function discardUnrecorded(store: ContentFactoryFileStore, row: SessionRow, key: string): Promise<void> {
  if (!store.discard || row.brand_id === null) return;
  try {
    await store.discard({ organizationId: row.organization_id, brandId: row.brand_id, key });
  } catch {
    // The object stays where it was stored. No session records it, and a later upload of the same file writes the same key.
  }
}

// --- Sources ---------------------------------------------------------------------------------------------------------------

export async function searchSources(sql: Sql, userId: string, input: { sessionId: string; brandId: string; page: SourcePage; query: string }): Promise<SourceResult[]> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  await requireBrandInWorkspace(sql, row.organization_id, input.brandId);
  return searchSourceRecords(sql, { organizationId: row.organization_id, brandId: input.brandId }, input.page, input.query);
}

export async function attachSource(
  sql: Sql,
  userId: string,
  input: { sessionId: string; messageId: string; brandId: string; page: SourcePage; recordId: string },
): Promise<{ attachmentId: string; snapshot: string }> {
  const row = await sessionAccess(sql, userId, input.sessionId);
  requireDraft(row);
  await requireMessage(sql, row, input.messageId);
  await requireBrandInWorkspace(sql, row.organization_id, input.brandId);
  const record = await readSourceRecord(sql, { organizationId: row.organization_id, brandId: input.brandId }, input.page, input.recordId);
  if (!record) throw new Error("That record is not on the page any more, so it was not attached.");
  const id = randomUUID();
  await withTransaction(sql, async (tx) => {
    await lockDraft(tx, row);
    await tx`
      insert into content_factory_attachments (id, organization_id, session_id, message_id, kind, source_page, source_brand_id, source_record_id, snapshot)
      values (${id}, ${row.organization_id}, ${row.id}, ${input.messageId}, 'source', ${record.page}, ${input.brandId}, ${record.recordId}, ${record.snapshot})
    `;
    await touch(tx, row);
  });
  return { attachmentId: id, snapshot: record.snapshot };
}

// --- The run ---------------------------------------------------------------------------------------------------------------

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
function idListOf(value: unknown): string[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateString(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** The stored files a session's video was made from. Each one needs a rights record before the video can be approved. */
async function storedFilesOf(sql: Sql, organizationId: string, sessionId: string): Promise<FileReference[]> {
  const rows = await sql<{ id: string; file_name: string | null }>`
    select id, file_name from content_factory_attachments
    where organization_id = ${organizationId} and session_id = ${sessionId} and kind = 'file'
  `;
  return rows.map((row) => ({ attachmentId: row.id, fileName: row.file_name ?? "an unnamed file" }));
}

/** The rights records of a brand that name a stored file. A record with an end date, or a revocation, is read as it stands. */
async function rightsRecordsOf(sql: Sql, organizationId: string, brandId: string | null): Promise<RightsRecordFacts[]> {
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
