// Shared pieces of the Content Factory service: the refusals, the session row and its mapping, the access checks and the
// small helpers. Moved out of content-factory/service.ts unchanged (coding loop, T6).

import { randomUUID } from "node:crypto";
import type { EngineReadinessPorts } from "../../../engine/api/index.ts";
import { hasRole, isRole } from "../access.ts";
import type { Sql } from "../learning/store.ts";
import type { ContentFactoryFileStore } from "./files.ts";
import { isKeepableGene, isPriority, type SessionSettings, type SessionSummary } from "./model.ts";

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

export type SessionRow = {
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
  source_session_id: string | null;
  started_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

export const SESSION_COLUMNS = `s.id, s.organization_id, s.brand_id, s.title, s.status, s.engine_request_id, s.revision, s.prior_request_ids,
  s.budget_usd, s.max_seconds, s.language, s.priority, s.keep_genes, s.last_refusal, s.source_session_id, s.started_at, s.created_at, s.updated_at`;

export function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

export function jsonList(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function priorIds(text: string): string[] {
  return jsonList(text).filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function summaryOf(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    brandId: row.brand_id,
    status: row.status === "started" ? "started" : "draft",
    engineRequestId: row.engine_request_id,
    sourceSessionId: row.source_session_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function settingsOf(row: SessionRow): SessionSettings {
  const budget = row.budget_usd === null ? null : Number(row.budget_usd);
  return {
    budgetUsd: budget !== null && Number.isFinite(budget) ? budget : null,
    maxSeconds: row.max_seconds === null ? null : Number(row.max_seconds),
    language: row.language,
    priority: isPriority(row.priority) ? row.priority : null,
    keepGenes: jsonList(row.keep_genes).filter(isKeepableGene),
  };
}

export async function audit(sql: Sql, entry: { organizationId: string; brandId: string | null; actorId: string; action: string; objectId: string; metadata?: Record<string, string> }): Promise<void> {
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

export async function sessionAccess(sql: Sql, userId: string, sessionId: string): Promise<SessionRow> {
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

export async function requireBrandInWorkspace(sql: Sql, organizationId: string, brandId: string): Promise<void> {
  const rows = await sql<{ id: string }>`
    select id from brands where id = ${brandId} and organization_id = ${organizationId} and deleted_at is null limit 1
  `;
  if (!rows[0]) throw new Error(BRAND_REFUSAL);
}

export function requireDraft(row: { status: string }): void {
  if (row.status !== "draft") throw new Error(STARTED_REFUSAL);
}

/**
 * Locks the session row until the transaction ends, then refuses unless the session is still a draft. A write that must not land on a
 * started session runs after this in the same transaction: a start that is waiting on the lock cannot commit before the write.
 */
export async function lockDraft(tx: Sql, row: SessionRow): Promise<void> {
  const [locked] = await tx<{ status: string }>`
    select status from content_factory_sessions where id = ${row.id} and organization_id = ${row.organization_id} for update
  `;
  if (!locked) throw new Error(SESSION_REFUSAL);
  requireDraft(locked);
}

export async function hasReferenceVideo(sql: Sql, row: SessionRow): Promise<boolean> {
  const existing = await sql<{ id: string }>`
    select id from content_factory_attachments where session_id = ${row.id} and organization_id = ${row.organization_id} and purpose = 'reference_video' limit 1
  `;
  return existing[0] !== undefined;
}

export async function requireMessage(sql: Sql, row: SessionRow, messageId: string): Promise<void> {
  const rows = await sql<{ id: string }>`
    select id from content_factory_messages where id = ${messageId} and session_id = ${row.id} and organization_id = ${row.organization_id} limit 1
  `;
  if (!rows[0]) throw new Error(MESSAGE_REFUSAL);
}

export async function touch(sql: Sql, row: SessionRow): Promise<void> {
  await sql`update content_factory_sessions set updated_at = now() where id = ${row.id} and organization_id = ${row.organization_id}`;
}

// --- Sessions and messages -------------------------------------------------------------------------------------------------

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function dateString(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** The stored files a session's video was made from. Each one needs a rights record before the video can be approved. */

export function idListOf(value: unknown): string[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}
