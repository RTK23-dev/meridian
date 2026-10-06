import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { hasRole, isRole } from "@/lib/meridian/access";
import { NOTIFICATION_KINDS, resolveNotificationPreferences, type NotificationKind } from "@/lib/meridian/notifications/preferences";

export const listAuditPage = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
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
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const memberships = await sql<{ role: string }>`
      select role from memberships where user_id = ${context.userId} and organization_id = ${data.organizationId} limit 1
    `;
    const role = memberships[0]?.role;
    if (!role || !isRole(role) || !hasRole(role, "admin")) throw new Error("This workspace is not available to you.");
    const brandFilter = data.brandId
      ? await sql<{ id: string }>`select id from brands where id = ${data.brandId} and organization_id = ${data.organizationId} limit 1`
      : [];
    if (data.brandId && !brandFilter[0]) throw new Error("That brand is not available in this workspace.");
    const [rows, totals] = await Promise.all([
      sql<Record<string, unknown>>`
        select a.id, a.actor_id, coalesce(u.name, '') as actor_name, a.action, a.brand_id,
          coalesce(b.name, '') as brand_name, a.object_type, a.object_id, a.metadata, a.created_at
        from audit_log a
        left join "user" u on u.id = a.actor_id
        left join brands b on b.id = a.brand_id and b.organization_id = a.organization_id
        where a.organization_id = ${data.organizationId}
          and (${data.actor} = '' or a.actor_id ilike '%' || ${data.actor} || '%' or coalesce(u.name, '') ilike '%' || ${data.actor} || '%')
          and (${data.action} = '' or a.action ilike '%' || ${data.action} || '%')
          and (${data.brandId} = '' or a.brand_id = ${data.brandId})
          and (${data.from} = '' or a.created_at >= ${data.from}::date)
          and (${data.to} = '' or a.created_at < (${data.to}::date + interval '1 day'))
        order by a.created_at desc, a.id desc
        limit 50 offset ${data.page * 50}
      `,
      sql<{ count: number }>`select count(*) as count from audit_log a left join "user" u on u.id = a.actor_id
        where a.organization_id = ${data.organizationId}
          and (${data.actor} = '' or a.actor_id ilike '%' || ${data.actor} || '%' or coalesce(u.name, '') ilike '%' || ${data.actor} || '%')
          and (${data.action} = '' or a.action ilike '%' || ${data.action} || '%')
          and (${data.brandId} = '' or a.brand_id = ${data.brandId})
          and (${data.from} = '' or a.created_at >= ${data.from}::date)
          and (${data.to} = '' or a.created_at < (${data.to}::date + interval '1 day'))`,
    ]);
    return {
      total: Number(totals[0]?.count ?? 0),
      page: data.page,
      entries: rows.map((row) => {
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
          metadata, createdAt: String(row.created_at),
        };
      }),
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
