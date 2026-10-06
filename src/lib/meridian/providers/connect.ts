import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole, type Role } from "@/lib/meridian/access";
import { isLiveProvider, phaseForProbe, probeLive, providerConfigured, type LiveProvider } from "./live.ts";

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
  const result = await probeLive(provider);
  const phase = phaseForProbe({
    provider,
    ok: providerConfigured(provider) ? result.ok : null,
    error: result.error,
    disconnected: false,
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
    return saveProbe(data.organizationId, data.provider, context.userId);
  });
