import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";
import { deriveAlerts } from "../observability/alerts.ts";
import { alertSeverity, deliveryUrlAllowed } from "./lifecycle.ts";

async function adminSql(userId: string, organizationId: string) {
  const sql = await getSql();
  const members = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = members[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, "admin");
  return sql;
}

export const getAlerts = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const organizationId = input && typeof input === "object" && typeof (input as { organizationId?: unknown }).organizationId === "string"
      ? (input as { organizationId: string }).organizationId
      : "";
    if (!organizationId) throw new Error("Choose a workspace.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await adminSql(context.userId, data.organizationId);
    const alerts = await sql<{
      id: string;
      code: string;
      severity: string;
      detail: string;
      first_seen: string;
      last_seen: string;
      acknowledged_at: string | null;
      delivery_status: string;
    }>`
      select id, code, severity, detail, first_seen, last_seen, acknowledged_at, delivery_status
      from alert_events
      where organization_id = ${data.organizationId}
      order by last_seen desc
      limit 40
    `;
    const targets = await sql<{ url: string; enabled: boolean }>`
      select url, enabled from delivery_targets where organization_id = ${data.organizationId} limit 1
    `;
    return {
      alerts: alerts.map((row) => ({
        id: row.id,
        code: row.code,
        severity: row.severity,
        detail: row.detail,
        firstSeen: String(row.first_seen),
        lastSeen: String(row.last_seen),
        acknowledged: Boolean(row.acknowledged_at),
        deliveryStatus: row.delivery_status,
      })),
      target: targets[0]?.enabled ? "webhook configured" : "not configured",
    };
  });

export const acknowledgeStoredAlert = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { organizationId?: unknown; alertId?: unknown }) : {};
    const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
    const alertId = typeof body.alertId === "string" ? body.alertId : "";
    if (!organizationId || !alertId) throw new Error("Choose an alert in this workspace.");
    return { organizationId, alertId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await adminSql(context.userId, data.organizationId);
    const updated = await sql<{ id: string }>`
      update alert_events set acknowledged_at = now()
      where id = ${data.alertId} and organization_id = ${data.organizationId} and acknowledged_at is null
      returning id
    `;
    if (!updated[0]) throw new Error("That alert is not open in this workspace.");
    return { status: "acknowledged" as const };
  });

export const saveDeliveryTarget = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { organizationId?: unknown; url?: unknown }) : {};
    const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!organizationId) throw new Error("Choose a workspace.");
    if (url && !deliveryUrlAllowed(url)) throw new Error("A delivery target must be https, or http on localhost. Nothing was saved.");
    return { organizationId, url };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await adminSql(context.userId, data.organizationId);
    if (!data.url) {
      await sql`update delivery_targets set enabled = false where organization_id = ${data.organizationId}`;
      return { status: "cleared" as const };
    }
    await sql`
      insert into delivery_targets (id, organization_id, kind, url, enabled)
      values (${crypto.randomUUID()}, ${data.organizationId}, 'webhook', ${data.url}, true)
      on conflict (organization_id) do update set url = excluded.url, kind = 'webhook', enabled = true
    `;
    return { status: "saved" as const };
  });

export const refreshAlerts = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const organizationId = input && typeof input === "object" && typeof (input as { organizationId?: unknown }).organizationId === "string"
      ? (input as { organizationId: string }).organizationId
      : "";
    if (!organizationId) throw new Error("Choose a workspace.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await adminSql(context.userId, data.organizationId);
    const beats = await sql<{ name: string; beat_at: string }>`
      select name, beat_at from process_heartbeats where name in ('worker', 'scheduler')
    `;
    const now = Date.now();
    const fresh = (name: string) => {
      const beat = beats.find((row) => row.name === name);
      const time = beat ? Date.parse(String(beat.beat_at)) : NaN;
      return Number.isFinite(time) && now - time < 30_000;
    };
    const jobs = await sql<{ status: string }>`
      select status from jobs where organization_id = ${data.organizationId}
    `;
    const queued = jobs.filter((row) => row.status === "queued" || row.status === "retry").length;
    const dead = jobs.filter((row) => row.status === "dead").length;
    const derived = deriveAlerts({
      worker: fresh("worker") ? "running" : "stopped",
      scheduler: fresh("scheduler") ? "running" : "stopped",
      queuedJobs: queued,
      deadJobs: dead,
      providerFailures: 0,
      publishFailures: 0,
      performanceFailures: 0,
      marketFailures: 0,
      storageFailed: false,
    });
    const targets = await sql<{ url: string; enabled: boolean }>`
      select url, enabled from delivery_targets where organization_id = ${data.organizationId} and enabled = true limit 1
    `;
    const targetUrl = targets[0]?.url ?? "";
    for (const alert of derived) {
      const open = await sql<{ id: string }>`
        select id from alert_events
        where organization_id = ${data.organizationId} and code = ${alert.code} and acknowledged_at is null
        limit 1
      `;
      const severity = alertSeverity(alert.code);
      let alertId = open[0]?.id ?? "";
      if (alertId) {
        await sql`
          update alert_events set last_seen = now(), detail = ${alert.detail}, severity = ${severity}
          where id = ${alertId}
        `;
      } else {
        alertId = crypto.randomUUID();
        await sql`
          insert into alert_events (id, organization_id, code, severity, detail, delivery_status)
          values (${alertId}, ${data.organizationId}, ${alert.code}, ${severity}, ${alert.detail}, 'NOT_CONFIGURED')
        `;
      }
      if (targetUrl && deliveryUrlAllowed(targetUrl)) {
        await sql`
          insert into jobs (id, organization_id, job_type, idempotency_key, status, payload)
          values (
            ${crypto.randomUUID()}, ${data.organizationId}, 'alert.deliver',
            ${`alert:${alertId}:${new Date().toISOString().slice(0, 16)}`}, 'queued',
            ${JSON.stringify({ organizationId: data.organizationId, alertId, targetUrl, title: alert.code })}
          )
          on conflict (organization_id, idempotency_key) do nothing
        `;
        await sql`update alert_events set delivery_status = 'queued' where id = ${alertId} and delivery_status = 'NOT_CONFIGURED'`;
      }
    }
    return { raised: derived.length, paging: targetUrl ? "queued" : "not configured" };
  });
