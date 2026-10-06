import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole, type Role } from "@/lib/meridian/access";
import { isLiveProvider, phaseForProbe, probeLive, providerConfigured, type LiveProvider } from "./live.ts";
import { liveTransport } from "./http.ts";

export type { LiveProvider };
export { isLiveProvider, phaseForProbe, probeLive, providerConfigured, publishPausedCampaign } from "./live.ts";

function id(): string {
  return crypto.randomUUID();
}

async function requireOrg(userId: string, organizationId: string, minimum: Role) {
  const sql = await getSql();
  const members = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = members[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, minimum);
  return sql;
}

function readRequest(input: unknown): { provider: LiveProvider; organizationId: string } {
  const body = input && typeof input === "object" ? (input as { organizationId?: unknown; provider?: unknown }) : {};
  const provider = typeof body.provider === "string" ? body.provider : "";
  const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
  if (!isLiveProvider(provider)) throw new Error("Unknown provider.");
  if (!organizationId) throw new Error("Choose a workspace.");
  return { provider, organizationId };
}

async function saveProbe(organizationId: string, provider: LiveProvider, userId: string) {
  const sql = await requireOrg(userId, organizationId, "admin");
  const secrets = await sql<{ sealed_token: string }>`
    select sealed_token from provider_secrets
    where organization_id = ${organizationId} and provider = ${provider}
    limit 1
  `;
  const sealed = secrets[0]?.sealed_token ?? "";
  let accessToken = "";
  if (sealed.trim()) {
    const { openAccessToken } = await import("./stages.ts");
    const opened = openAccessToken({ sealed, key: process.env.TOKEN_ENCRYPTION_KEY ?? "", envToken: "" });
    if ("error" in opened) {
      await sql`
        insert into provider_connections (id, organization_id, provider, status, last_error, disconnected_at)
        values (${id()}, ${organizationId}, ${provider}, 'FAILED', ${opened.error}, null)
        on conflict (organization_id, provider) do update set
          status = 'FAILED', last_error = excluded.last_error, disconnected_at = null, updated_at = now()
      `;
      return { phase: "FAILED" as const, detail: opened.error, accountId: "", accountName: "" };
    }
    accessToken = opened.token;
  }
  const result = await probeLive(provider, process.env, liveTransport(), accessToken);
  const configured = providerConfigured(provider) || Boolean(accessToken);
  const phase = phaseForProbe({
    provider,
    ok: configured ? result.ok : null,
    error: result.error,
    disconnected: false,
    configured,
  });
  await sql`
    insert into provider_connections (
      id, organization_id, provider, status, account_id, account_name, permissions, last_error, last_success_at, disconnected_at
    ) values (
      ${id()}, ${organizationId}, ${provider}, ${phase.phase}, ${result.accountId}, ${result.accountName},
      ${JSON.stringify(result.permissions)}, ${result.error}, ${result.ok ? new Date().toISOString() : null}, null
    )
    on conflict (organization_id, provider) do update set
      status = excluded.status,
      account_id = excluded.account_id,
      account_name = excluded.account_name,
      permissions = excluded.permissions,
      last_error = excluded.last_error,
      last_success_at = coalesce(excluded.last_success_at, provider_connections.last_success_at),
      disconnected_at = null,
      updated_at = now()
  `;
  return { phase: phase.phase, detail: phase.detail, accountId: result.accountId, accountName: result.accountName };
}

export const probeProviderConnection = createServerFn({ method: "POST" })
  .validator(readRequest)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireOrg(context.userId, data.organizationId, "admin");
    const existing = await sql<{ disconnected_at: unknown }>`
      select disconnected_at from provider_connections
      where organization_id = ${data.organizationId} and provider = ${data.provider} limit 1
    `;
    if (existing[0]?.disconnected_at) {
      return { phase: "DISCONNECTED" as const, detail: "Reconnect before testing. Disconnect stops requests.", accountId: "", accountName: "" };
    }
    return saveProbe(data.organizationId, data.provider, context.userId);
  });

export const disconnectProvider = createServerFn({ method: "POST" })
  .validator(readRequest)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireOrg(context.userId, data.organizationId, "admin");
    await sql`
      insert into provider_connections (id, organization_id, provider, status, disconnected_at)
      values (${id()}, ${data.organizationId}, ${data.provider}, 'DISCONNECTED', now())
      on conflict (organization_id, provider) do update set
        status = 'DISCONNECTED', disconnected_at = now(), updated_at = now()
    `;
    if (data.provider === "meta" || data.provider === "tiktok" || data.provider === "google") {
      await sql`
        update job_schedules set enabled = false
        where organization_id = ${data.organizationId}
          and job_type = 'performance.sync'
          and id like ${`perf:${data.organizationId}:%:${data.provider}`}
      `;
    }
    return { phase: "DISCONNECTED" as const, detail: "Disconnected. Stored external ids were kept. No further requests are sent." };
  });

export const reconnectProvider = createServerFn({ method: "POST" })
  .validator(readRequest)
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await requireOrg(context.userId, data.organizationId, "admin");
    await sql`
      update provider_connections set disconnected_at = null, updated_at = now()
      where organization_id = ${data.organizationId} and provider = ${data.provider}
    `;
    const saved = await saveProbe(data.organizationId, data.provider, context.userId);
    if (saved.phase === "HEALTHY" || saved.phase === "CONNECTED") {
      await sql`
        update job_schedules set enabled = true
        where organization_id = ${data.organizationId}
          and job_type = 'performance.sync'
          and id like ${`perf:${data.organizationId}:%:${data.provider}`}
      `;
    }
    return saved;
  });
