import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { hasRole, isRole } from "@/lib/meridian/access";
import { auditCsv } from "@/lib/meridian/exports/csv";
import { NOTIFICATION_KINDS, resolveNotificationPreferences, type NotificationKind } from "@/lib/meridian/notifications/preferences";
import { isoTimestamp } from "@/lib/meridian/observability/timestamps";

const AUDIT_PAGE_SIZE = 50;
const AUDIT_EXPORT_LIMIT = 5_000;

type AuditFilters = {
  organizationId: string;
  actor: string;
  action: string;
  brandId: string;
  from: string;
  to: string;
  page: number;
};

function auditFilterInput(input: unknown): AuditFilters {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const organizationId = typeof value.organizationId === "string" ? value.organizationId.trim() : "";
  const actor = typeof value.actor === "string" ? value.actor.trim().slice(0, 100) : "";
  const action = typeof value.action === "string" ? value.action.trim().slice(0, 100) : "";
  const brandId = typeof value.brandId === "string" ? value.brandId.trim() : "";
  const from = typeof value.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.from) ? value.from : "";
  const to = typeof value.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.to) ? value.to : "";
  const page = typeof value.page === "number" && Number.isInteger(value.page) ? Math.max(0, Math.min(value.page, 100_000)) : 0;
  if (!organizationId || organizationId.length > 100) throw new Error("Choose a workspace.");
  return { organizationId, actor, action, brandId, from, to, page };
}

/** Admins only. A brand filter must name a brand in the same workspace. */
async function auditAccess(sql: Sql, userId: string, filters: AuditFilters): Promise<void> {
  const memberships = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${filters.organizationId} limit 1
  `;
  const role = memberships[0]?.role;
  if (!role || !isRole(role) || !hasRole(role, "admin")) throw new Error("This workspace is not available to you.");
  if (filters.brandId) {
    const brand = await sql<{ id: string }>`select id from brands where id = ${filters.brandId} and organization_id = ${filters.organizationId} limit 1`;
    if (!brand[0]) throw new Error("That brand is not available in this workspace.");
  }
}

async function selectAuditRows(sql: Sql, f: AuditFilters, limit: number, offset: number): Promise<Record<string, unknown>[]> {
  return sql<Record<string, unknown>>`
    select a.id, a.actor_id, coalesce(u.name, '') as actor_name, a.action, a.brand_id,
      coalesce(b.name, '') as brand_name, a.object_type, a.object_id, a.metadata, a.created_at
    from audit_log a
    left join "user" u on u.id = a.actor_id
    left join brands b on b.id = a.brand_id and b.organization_id = a.organization_id
    where a.organization_id = ${f.organizationId}
      and (${f.actor} = '' or a.actor_id ilike '%' || ${f.actor} || '%' or coalesce(u.name, '') ilike '%' || ${f.actor} || '%')
      and (${f.action} = '' or a.action ilike '%' || ${f.action} || '%')
      and (${f.brandId} = '' or a.brand_id = ${f.brandId})
      and (${f.from} = '' or a.created_at >= ${f.from}::date)
      and (${f.to} = '' or a.created_at < (${f.to}::date + interval '1 day'))
    order by a.created_at desc, a.id desc
    limit ${limit} offset ${offset}
  `;
}

async function countAuditRows(sql: Sql, f: AuditFilters): Promise<number> {
  const rows = await sql<{ count: unknown }>`
    select count(*) as count from audit_log a left join "user" u on u.id = a.actor_id
    where a.organization_id = ${f.organizationId}
      and (${f.actor} = '' or a.actor_id ilike '%' || ${f.actor} || '%' or coalesce(u.name, '') ilike '%' || ${f.actor} || '%')
      and (${f.action} = '' or a.action ilike '%' || ${f.action} || '%')
      and (${f.brandId} = '' or a.brand_id = ${f.brandId})
      and (${f.from} = '' or a.created_at >= ${f.from}::date)
      and (${f.to} = '' or a.created_at < (${f.to}::date + interval '1 day'))
  `;
  return Number(rows[0]?.count ?? 0);
}

function toAuditEntry(row: Record<string, unknown>) {
  let metadata: Record<string, string> = {};
  try {
    const parsed = JSON.parse(String(row.metadata ?? "{}")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value) ?? String(value)]));
    }
  } catch { /* malformed metadata remains unavailable in the table */ }
  return {
    id: String(row.id), actorId: String(row.actor_id), actorName: String(row.actor_name),
    action: String(row.action), brandId: row.brand_id == null ? "" : String(row.brand_id),
    brandName: String(row.brand_name), objectType: String(row.object_type), objectId: String(row.object_id),
    metadata, createdAt: isoTimestamp(row.created_at),
  };
}

export const listAuditPage = createServerFn({ method: "POST" })
  .validator((input: unknown) => auditFilterInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await auditAccess(sql, context.userId, data);
    const [rows, total] = await Promise.all([
      selectAuditRows(sql, data, AUDIT_PAGE_SIZE, data.page * AUDIT_PAGE_SIZE),
      countAuditRows(sql, data),
    ]);
    return { total, page: data.page, entries: rows.map(toAuditEntry) };
  });

/** CSV of every audit entry that matches the filters, newest first, up to 5,000 rows. `truncated` says when more matched. */
export const exportAuditCsv = createServerFn({ method: "POST" })
  .validator((input: unknown) => auditFilterInput(input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await auditAccess(sql, context.userId, data);
    const total = await countAuditRows(sql, data);
    const entries = (await selectAuditRows(sql, data, AUDIT_EXPORT_LIMIT, 0)).map(toAuditEntry);
    return {
      csv: auditCsv(entries),
      rowCount: entries.length,
      total,
      truncated: total > entries.length,
      limit: AUDIT_EXPORT_LIMIT,
    };
  });

export const listWebhookEvents = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const organizationId = typeof value.organizationId === "string" ? value.organizationId.trim() : "";
    const provider = typeof value.provider === "string" ? value.provider.trim().slice(0, 80) : "";
    const page = typeof value.page === "number" && Number.isInteger(value.page) ? Math.max(0, Math.min(value.page, 100_000)) : 0;
    if (!organizationId || organizationId.length > 100) throw new Error("Choose a workspace.");
    return { organizationId, provider, page };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const memberships = await sql<{ role: string }>`
      select role from memberships where user_id = ${context.userId} and organization_id = ${data.organizationId} limit 1
    `;
    const role = memberships[0]?.role;
    if (!role || !isRole(role) || !hasRole(role, "admin")) throw new Error("This workspace is not available to you.");
    const [events, totals] = await Promise.all([
      sql<{ id: string; provider: string; event_id: string; received_at: string }>`
        select id, provider, event_id, received_at from webhook_events
        where organization_id = ${data.organizationId} and (${data.provider} = '' or provider = ${data.provider})
        order by received_at desc, id desc limit 50 offset ${data.page * 50}
      `,
      sql<{ count: number }>`select count(*) as count from webhook_events
        where organization_id = ${data.organizationId} and (${data.provider} = '' or provider = ${data.provider})`,
    ]);
    return { total: Number(totals[0]?.count ?? 0), page: data.page, events: events.map((event) => ({
      id: event.id, provider: event.provider, eventId: event.event_id, receivedAt: String(event.received_at),
    })) };
  });

export const getNotificationPreferences = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const organizationId = input && typeof input === "object" && typeof (input as { organizationId?: unknown }).organizationId === "string"
      ? (input as { organizationId: string }).organizationId.trim() : "";
    if (!organizationId || organizationId.length > 100) throw new Error("Choose a workspace.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const member = await sql<{ id: string }>`select user_id as id from memberships where user_id = ${context.userId} and organization_id = ${data.organizationId} limit 1`;
    if (!member[0]) throw new Error("This workspace is not available to you.");
    const rows = await sql<{ kind: string; enabled: boolean }>`select kind, enabled from notification_preferences where organization_id = ${data.organizationId} and user_id = ${context.userId}`;
    const saved = new Map(rows.map((row) => [row.kind, row.enabled]));
    return { preferences: resolveNotificationPreferences(saved) };
  });

export const setNotificationPreference = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const organizationId = typeof value.organizationId === "string" ? value.organizationId.trim() : "";
    const kind = typeof value.kind === "string" && NOTIFICATION_KINDS.includes(value.kind as NotificationKind) ? value.kind as NotificationKind : null;
    if (!organizationId || organizationId.length > 100 || !kind || typeof value.enabled !== "boolean") throw new Error("Choose a valid notification preference.");
    return { organizationId, kind, enabled: value.enabled };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const member = await sql<{ user_id: string }>`select user_id from memberships where user_id = ${context.userId} and organization_id = ${data.organizationId} limit 1`;
    if (!member[0]) throw new Error("This workspace is not available to you.");
    await sql`insert into notification_preferences (organization_id, user_id, kind, enabled)
      values (${data.organizationId}, ${context.userId}, ${data.kind}, ${data.enabled})
      on conflict (organization_id, user_id, kind) do update set enabled = excluded.enabled, updated_at = now()`;
    return { status: "saved" as const };
  });
