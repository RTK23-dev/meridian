// The Content Factory session functions: list, create, brief, read, message, settings, uploads and sources. Moved out of
// content-factory/service.ts unchanged (coding loop, T6). service.ts re-exports the public names.

import { briefTextOf, evidenceSummariesOf } from "./opportunity-brief.ts";
import { canMakeBrief } from "../opportunity/triage-states.ts";
import { randomUUID } from "node:crypto";
import { withTransaction, type Sql } from "../learning/store.ts";
import { extractPdf } from "../ingestion/pdf.ts";
import { characterCount, checkFile, decodeUpload, driveFileStore, imageDimensions, safeFileName, sessionFileKey, type ContentFactoryFileStore, type FileStoreReadiness } from "./files.ts";
import { isPriority, isScriptRole, isSourcePage, MAX_SECONDS, MIN_SECONDS, TEXT_FILE_MAX_CHARS, PDF_OVER_LIMIT_CONTENT, type Attachment, type FilePurpose, type KeepableGene, type Message, type ScriptRole, type SessionDetail, type SessionSummary, type SourcePage, type SourceResult } from "./model.ts";
import { readSourceRecord, searchSourceRecords } from "./sources.ts";
import { SESSION_REFUSAL, STARTED_REFUSAL, SESSION_COLUMNS, iso, jsonList, summaryOf, settingsOf, audit, requireWorkspaceAdmin, sessionAccess, requireBrandInWorkspace, requireDraft, lockDraft, hasReferenceVideo, requireMessage, touch } from "./service-core.ts";
import type { ContentFactoryPorts, SessionRow } from "./service-core.ts";

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

/**
 * Makes a draft session from one opportunity: the session is titled with the idea, its first message is the idea's brief (briefTextOf), and
 * the idea is marked briefed. All of it is one transaction, and the idea's row is locked, so two clicks make one session. A draft already made
 * from this idea is returned unchanged. A rejected, dismissed or unread idea is refused. Only the workspace's admins, as every session action.
 */
export async function briefFromOpportunity(
  sql: Sql,
  userId: string,
  input: { organizationId: string; brandId: string; opportunityId: string },
): Promise<{ sessionId: string; created: boolean }> {
  await requireWorkspaceAdmin(sql, userId, input.organizationId);
  await requireBrandInWorkspace(sql, input.organizationId, input.brandId);
  return withTransaction(sql, async (tx) => {
    const ideas = await tx<{
      id: string;
      status: string;
      label: string;
      angle: string;
      hook_type: string;
      audience: string;
      format: string;
      proof_type: string;
      product_name: string;
      reason: string;
      evidence: string;
    }>`
      select id, status, label, angle, hook_type, audience, format, proof_type, product_name, reason, evidence
      from opportunities
      where id = ${input.opportunityId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      for update
    `;
    const idea = ideas[0];
    if (!idea) throw new Error("That idea is not in this brand.");
    const existing = await tx<{ id: string }>`
      select id from content_factory_sessions
      where organization_id = ${input.organizationId} and opportunity_id = ${idea.id} and status = 'draft'
      order by created_at desc, id desc limit 1
    `;
    if (existing[0]) return { sessionId: existing[0].id, created: false };
    if (!canMakeBrief(idea.status)) {
      throw new Error("This idea was rejected or dismissed, or has not been researched yet, so no brief can be made from it.");
    }
    const sessionId = randomUUID();
    const text = briefTextOf({
      label: idea.label,
      angle: idea.angle,
      hookType: idea.hook_type,
      audience: idea.audience,
      format: idea.format,
      proofType: idea.proof_type,
      productName: idea.product_name,
      reason: idea.reason,
      evidence: evidenceSummariesOf(idea.evidence),
    });
    await tx`
      insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, opportunity_id)
      values (${sessionId}, ${input.organizationId}, ${input.brandId}, ${userId}, ${idea.label.slice(0, 120)}, ${idea.id})
    `;
    await tx`
      insert into content_factory_messages (id, organization_id, session_id, author_id, text, beat_role)
      values (${randomUUID()}, ${input.organizationId}, ${sessionId}, ${userId}, ${text}, null)
    `;
    await tx`update opportunities set status = 'briefed' where id = ${idea.id} and organization_id = ${input.organizationId}`;
    await audit(tx, {
      organizationId: input.organizationId,
      brandId: input.brandId,
      actorId: userId,
      action: "content_factory.brief_from_opportunity",
      objectId: sessionId,
      metadata: { opportunityId: idea.id },
    });
    return { sessionId, created: true };
  });
}

export async function messagesOf(sql: Sql, row: SessionRow): Promise<Message[]> {
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
