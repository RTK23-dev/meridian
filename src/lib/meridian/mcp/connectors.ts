// Connector links: the secret a Claude chat uses to reach one workspace (migration 0156). The secret is made here from 32 random bytes and
// shown once; only its SHA-256 is stored, with its last four characters to tell links apart. A link acts as the person who made it, with
// that person's role read from the workspace at every call, so a member who leaves, or whose role changes, changes what the link may do.
// Only an admin makes or revokes a link, and every change is written to the audit log.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assertRole, isRole, type Role } from "../access.ts";
import type { Sql } from "../learning/store.ts";

export const CONNECTOR_SECRET_PREFIX = "mrd_";
const SECRET_PATTERN = /^mrd_[A-Za-z0-9_-]{43}$/;
/** A link records when it was last used at most this often, so a busy chat does not write on every call. */
const LAST_USED_EVERY_MS = 5 * 60 * 1000;
export const CONNECTOR_NAME_MAX = 80;

export type ConnectorSummary = { id: string; name: string; hint: string; createdAt: string; createdBy: string; lastUsedAt: string | null; revokedAt: string | null };

/** The workspace, maker and role a live link acts as. */
export type ResolvedConnector = { id: string; name: string; organizationId: string; userId: string; role: Role };

export function newConnectorSecret(): string {
  return `${CONNECTOR_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isConnectorSecret(value: unknown): value is string {
  return typeof value === "string" && SECRET_PATTERN.test(value);
}

export function hashConnectorSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** The secret from a request: the link's last path part, or a Bearer header for clients that send one. */
export function secretFrom(input: { pathSecret?: string | null; authorization?: string | null }): string | null {
  if (isConnectorSecret(input.pathSecret)) return input.pathSecret;
  const bearer = /^Bearer\s+(\S+)$/i.exec(input.authorization ?? "")?.[1] ?? null;
  return isConnectorSecret(bearer) ? bearer : null;
}

async function roleOf(sql: Sql, userId: string, organizationId: string): Promise<Role | null> {
  const rows = await sql<{ role: string }>`select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1`;
  const role = rows[0]?.role;
  return role && isRole(role) ? role : null;
}

async function requireAdmin(sql: Sql, userId: string, organizationId: string): Promise<void> {
  const role = await roleOf(sql, userId, organizationId);
  if (!role) throw new Error("That workspace is not available to you.");
  assertRole(role, "admin");
}

async function audit(sql: Sql, entry: { organizationId: string; actorId: string; action: string; objectId: string; metadata?: Record<string, string> }): Promise<void> {
  await sql`
    insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
    values (${randomUUID()}, ${entry.organizationId}, null, ${entry.actorId}, ${entry.action}, 'mcp_connector', ${entry.objectId}, ${JSON.stringify(entry.metadata ?? {})})
  `;
}

/** Makes a link. The secret is returned once and never stored. Admin only. */
export async function createConnector(sql: Sql, input: { organizationId: string; userId: string; name: string }): Promise<{ connector: ConnectorSummary; secret: string }> {
  await requireAdmin(sql, input.userId, input.organizationId);
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, CONNECTOR_NAME_MAX) || "Claude";
  const secret = newConnectorSecret();
  const id = randomUUID();
  const hint = secret.slice(-4);
  const rows = await sql<{ created_at: unknown }>`
    insert into mcp_connectors (id, organization_id, created_by, name, token_hash, token_hint)
    values (${id}, ${input.organizationId}, ${input.userId}, ${name}, ${hashConnectorSecret(secret)}, ${hint})
    returning created_at
  `;
  await audit(sql, { organizationId: input.organizationId, actorId: input.userId, action: "mcp_connector.created", objectId: id, metadata: { name, hint } });
  return {
    secret,
    connector: { id, name, hint, createdAt: new Date(rows[0]!.created_at as string).toISOString(), createdBy: input.userId, lastUsedAt: null, revokedAt: null },
  };
}

/** The workspace's links, newest first, without their secrets. Admin only. */
export async function listConnectors(sql: Sql, input: { organizationId: string; userId: string }): Promise<ConnectorSummary[]> {
  await requireAdmin(sql, input.userId, input.organizationId);
  const rows = await sql<{ id: string; name: string; token_hint: string; created_at: unknown; created_by: string; last_used_at: unknown; revoked_at: unknown }>`
    select id, name, token_hint, created_at, created_by, last_used_at, revoked_at from mcp_connectors
    where organization_id = ${input.organizationId} order by created_at desc limit 50
  `;
  const time = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string).toISOString());
  return rows.map((row) => ({ id: row.id, name: row.name, hint: row.token_hint, createdAt: time(row.created_at)!, createdBy: row.created_by, lastUsedAt: time(row.last_used_at), revokedAt: time(row.revoked_at) }));
}

/** Revokes a link of this workspace. A revoked link answers nothing from then on. Admin only. */
export async function revokeConnector(sql: Sql, input: { organizationId: string; userId: string; connectorId: string }): Promise<{ revoked: boolean }> {
  await requireAdmin(sql, input.userId, input.organizationId);
  const rows = await sql<{ id: string }>`
    update mcp_connectors set revoked_at = now(), revoked_by = ${input.userId}
    where id = ${input.connectorId} and organization_id = ${input.organizationId} and revoked_at is null
    returning id
  `;
  if (rows.length === 0) return { revoked: false };
  await audit(sql, { organizationId: input.organizationId, actorId: input.userId, action: "mcp_connector.revoked", objectId: input.connectorId });
  return { revoked: true };
}

/**
 * The live link a secret names, with its maker's current role, or null: an unknown or revoked secret, or a maker who is no longer a
 * member, is refused the same way, so nothing tells a guesser which.
 */
export async function resolveConnector(sql: Sql, secret: string, now: Date = new Date()): Promise<ResolvedConnector | null> {
  if (!isConnectorSecret(secret)) return null;
  const rows = await sql<{ id: string; name: string; organization_id: string; created_by: string; last_used_at: unknown; role: string | null }>`
    select c.id, c.name, c.organization_id, c.created_by, c.last_used_at, m.role
    from mcp_connectors c
    left join memberships m on m.organization_id = c.organization_id and m.user_id = c.created_by
    where c.token_hash = ${hashConnectorSecret(secret)} and c.revoked_at is null
    limit 1
  `;
  const row = rows[0];
  if (!row || !row.role || !isRole(row.role)) return null;
  const lastUsed = row.last_used_at ? new Date(row.last_used_at as string).getTime() : 0;
  if (now.getTime() - lastUsed > LAST_USED_EVERY_MS) {
    await sql`update mcp_connectors set last_used_at = ${now.toISOString()} where id = ${row.id}`;
  }
  return { id: row.id, name: row.name, organizationId: row.organization_id, userId: row.created_by, role: row.role };
}
