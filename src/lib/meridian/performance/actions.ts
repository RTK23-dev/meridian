import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";
import { phaseForProbe, type LiveProvider } from "../providers/live.ts";
import { planPerformanceSchedule } from "./schedule.ts";
import { validatePerformanceOwnership } from "./ownership.ts";

export const getPerformanceRowsForExport = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const brandId = input && typeof input === "object" && typeof (input as { brandId?: unknown }).brandId === "string" ? (input as { brandId: string }).brandId.trim() : "";
    if (!brandId || brandId.length > 100) throw new Error("Choose a brand.");
    return { brandId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const members = await sql<{ organization_id: string; role: string }>`
      select b.organization_id, m.role from brands b
      join memberships m on m.organization_id = b.organization_id and m.user_id = ${context.userId}
      where b.id = ${data.brandId} and b.deleted_at is null limit 1
    `;
    const membership = members[0];
    if (!membership || !isRole(membership.role)) throw new Error("That brand is not available to you.");
    assertRole(membership.role, "member");
    const rows = await sql<Record<string, unknown>>`
      select o.id, o.creative_id, o.experiment_id, o.platform, o.impressions, o.reach, o.clicks,
        o.conversions, o.spend_cents, o.revenue_cents, o.observed_on, o.source, o.created_at
      from performance_observations o
      join creative_records c on c.id = o.creative_id and c.brand_id = o.brand_id and c.organization_id = o.organization_id
      where o.organization_id = ${membership.organization_id} and o.brand_id = ${data.brandId}
      order by o.observed_on desc, o.created_at desc limit 10_000
    `;
    return rows.map((row) => ({
      id: String(row.id), creativeId: String(row.creative_id), experimentId: row.experiment_id == null ? "" : String(row.experiment_id),
      platform: String(row.platform), impressions: Number(row.impressions), reach: Number(row.reach), clicks: Number(row.clicks),
      conversions: Number(row.conversions), spendCents: Number(row.spend_cents), revenueCents: Number(row.revenue_cents),
      observedOn: String(row.observed_on), source: String(row.source), createdAt: String(row.created_at),
    }));
  });

export const setPerformanceSchedule = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const provider = body.provider === "meta" || body.provider === "tiktok" || body.provider === "google" ? body.provider : "";
    const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
    const brandId = typeof body.brandId === "string" ? body.brandId : "";
    const creativeId = typeof body.creativeId === "string" ? body.creativeId : "";
    const externalAdId = typeof body.externalAdId === "string" ? body.externalAdId : "";
    const currency = typeof body.currency === "string" ? body.currency : "";
    const timezone = typeof body.timezone === "string" ? body.timezone : "";
    const startDate = typeof body.startDate === "string" ? body.startDate : "";
    const endDate = typeof body.endDate === "string" ? body.endDate : "";
    const everySeconds = typeof body.everySeconds === "number" ? body.everySeconds : Number(body.everySeconds);
    if (!provider || !organizationId || !brandId) throw new Error("Choose a workspace, a brand, and a provider.");
    return { provider, organizationId, brandId, creativeId, externalAdId, currency, timezone, startDate, endDate, everySeconds };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const members = await sql<{ role: string }>`
      select m.role from memberships m
      join brands b on b.organization_id = m.organization_id
      where m.user_id = ${context.userId} and m.organization_id = ${data.organizationId} and b.id = ${data.brandId} and b.deleted_at is null
      limit 1
    `;
    const role = members[0]?.role;
    if (!role || !isRole(role)) throw new Error("That brand is not in this workspace.");
    assertRole(role, "admin");
    const ownership = await validatePerformanceOwnership(sql, {
      organizationId: data.organizationId,
      brandId: data.brandId,
      creativeId: data.creativeId,
      externalAdId: data.externalAdId,
      provider: data.provider,
    });
    if (!ownership.ok) throw new Error(ownership.error);
    const connections = await sql<{ last_error: string; last_success_at: string | null; disconnected_at: string | null }>`
      select last_error, last_success_at, disconnected_at from provider_connections
      where organization_id = ${data.organizationId} and provider = ${data.provider}
      limit 1
    `;
    const row = connections[0];
    const phase = phaseForProbe({
      provider: data.provider as LiveProvider,
      ok: row?.last_success_at ? true : row?.last_error ? false : null,
      error: row?.last_error ?? "",
      disconnected: Boolean(row?.disconnected_at),
    });
    const plan = planPerformanceSchedule({
      ...data,
      phase: phase.phase,
      disconnected: Boolean(row?.disconnected_at),
    });
    if ("error" in plan) throw new Error(plan.error);
    if (!plan.enabled) throw new Error(plan.reason);
    await sql`
      insert into job_schedules (id, organization_id, brand_id, job_type, every_seconds, next_run, enabled, payload)
      values (
        ${plan.id}, ${plan.organizationId}, ${plan.brandId}, ${plan.jobType}, ${plan.everySeconds}, now(), true, ${JSON.stringify(plan.payload)}
      )
      on conflict (id) do update set
        every_seconds = excluded.every_seconds,
        enabled = true,
        payload = excluded.payload,
        brand_id = excluded.brand_id
    `;
    return { id: plan.id, enabled: true, reason: plan.reason };
  });
