import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { localSemanticModel, embeddingProviderState } from "@/lib/meridian/embeddings/provider";
import { INTEGRATIONS } from "@/lib/meridian/providers/integrations";
import { objectStorageStatus } from "@/lib/meridian/storage/object-store";
import { emailDeliveryState, isoOrNull } from "@/lib/meridian/notifications/email-state";
import { CHANNEL_PUBLISHING_DETAIL, publishingProviderStatus } from "@/lib/meridian/publishing/provider";
import { accountProviderState } from "@/lib/meridian/providers/boundaries";
import { OAUTH_METRIC_PROVIDERS, providerCredentialState, type ProviderCredentialState } from "@/lib/meridian/providers/access-token";
import { isLiveProvider, phaseForProbe, phaseForStoredConnection, type LiveProvider } from "@/lib/meridian/providers/live";

const CONNECTION_PROVIDERS = ["meta", "tiktok", "google", "ad_library"] as const;

/**
 * The kind of a failed read, for the status: a database or system error's code, or its class name. Never its message, which can carry
 * text from the database.
 */
function errorKind(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z0-9_]{1,40}$/.test(name) ? name : "unknown error";
}

function ageMs(value: unknown, now: number): number | null {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  if (!Number.isFinite(time)) return null;
  return now - time;
}

export const getSystemStatus = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { organizationId?: unknown }) : {};
    return { organizationId: typeof body.organizationId === "string" ? body.organizationId : "" };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const embeddings = embeddingProviderState({ url: process.env.EXTERNAL_SEMANTIC_URL, key: process.env.EXTERNAL_SEMANTIC_KEY });
    const publishing = { ...publishingProviderStatus(), detail: CHANNEL_PUBLISHING_DETAIL };
    const objectStorage = objectStorageStatus();
    const now = Date.now();
    let worker: "running" | "stopped" = "stopped";
    let scheduler: "running" | "stopped" = "stopped";
    let database: "up" | "down" = "down";
    let databaseError = "unavailable";
    try {
      const sql = await getSql();
      await sql`select 1 as ok`;
      database = "up";
      const beats = await sql<{ name: string; beat_at: unknown }>`
        select name, beat_at from process_heartbeats where name in ('worker', 'scheduler')
      `;
      for (const beat of beats) {
        const age = ageMs(beat.beat_at, now);
        const fresh = age != null && age < 30_000;
        if (beat.name === "worker" && fresh) worker = "running";
        if (beat.name === "scheduler" && fresh) scheduler = "running";
      }
    } catch (error) {
      database = "down";
      databaseError = errorKind(error);
    }
    const providers = (["meta", "tiktok", "google", "ad_library"] as const).map((provider) => accountProviderState(provider));
    let connections: { provider: LiveProvider; phase: string; detail: string; accountId: string; accountName: string; lastError: string; lastSuccessAt: string | null }[] = [];
    // The kind of the failed read of the stored connections, or null. A failed read leaves the credential state unknown.
    let unreadable: string | null = null;
    if (database === "down" && data.organizationId) unreadable = databaseError;
    if (database === "up" && data.organizationId) {
      try {
        const sql = await getSql();
        const members = await sql<{ role: string }>`
          select role from memberships where user_id = ${context.userId} and organization_id = ${data.organizationId} limit 1
        `;
        if (members[0]) {
          const rows = await sql<{ provider: string; status: string; account_id: string; account_name: string; last_error: string; last_success_at: unknown; disconnected_at: unknown }>`
            select provider, status, account_id, account_name, last_error, last_success_at, disconnected_at
            from provider_connections where organization_id = ${data.organizationId}
          `;
          // The sealed tokens of this workspace only. Each provider's credential state comes from providerCredentialState, so no
          // environment variable can make a provider connected.
          const secrets = await sql<{ provider: string; sealed_token: string; sealed_refresh: string; expires_at: string | null }>`
            select provider, sealed_token, sealed_refresh, expires_at from provider_secrets where organization_id = ${data.organizationId}
          `;
          const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY ?? "";
          const credentials: Record<string, ProviderCredentialState> = {};
          for (const provider of CONNECTION_PROVIDERS) {
            const stored = secrets.find((item) => item.provider === provider);
            const sealed = stored?.sealed_token ?? "";
            // A provider whose metrics are read per tenant is connected only through its OAuth token, the same rule the metric sync applies.
            credentials[provider] = await providerCredentialState(sql, {
              organizationId: data.organizationId,
              provider,
              sealed,
              encryptionKey,
              env: process.env,
              requireOAuth: OAUTH_METRIC_PROVIDERS.includes(provider),
              expiresAt: stored?.expires_at ? new Date(stored.expires_at).toISOString() : null,
              hasRefresh: (stored?.sealed_refresh ?? "").trim() !== "",
            });
          }
          connections = CONNECTION_PROVIDERS.map((provider) => {
            const row = rows.find((item) => item.provider === provider);
            const phase = phaseForStoredConnection({
              provider,
              credential: credentials[provider],
              lastSuccessAt: row?.last_success_at,
              lastError: row?.last_error ?? "",
              disconnected: Boolean(row?.disconnected_at),
            });
            return {
              provider,
              phase: phase.phase,
              detail: phase.detail,
              accountId: row?.account_id ?? "",
              accountName: row?.account_name ?? "",
              lastError: row?.last_error ?? "",
              // The last request that succeeded, from the stored connection. Null when none has succeeded.
              lastSuccessAt: isoOrNull(row?.last_success_at),
            };
          });
        }
      } catch (error) {
        connections = [];
        unreadable = errorKind(error);
      }
    }
    if (connections.length === 0) {
      // No workspace is in scope: no credential is in scope, so none is configured. A read that failed is not a missing credential: the
      // state is unknown, and the connection reports the failure with the kind of error, never its message.
      connections = (["meta", "tiktok", "google", "ad_library"] as const).filter(isLiveProvider).map((provider) => {
        if (unreadable !== null) {
          return {
            provider,
            phase: "FAILED",
            detail: `The credential state could not be read (${unreadable}). Nothing was sent, and whether a credential is configured is unknown.`,
            accountId: "",
            accountName: "",
            lastError: "",
            lastSuccessAt: null,
          };
        }
        const phase = phaseForProbe({ provider, ok: null, error: "", disconnected: false, configured: false });
        return { provider, phase: phase.phase, detail: phase.detail, accountId: "", accountName: "", lastError: "", lastSuccessAt: null };
      });
    }
    return {
      worker,
      scheduler,
      database,
      objectStorage: {
        database: "MIGRATION_SOURCE" as const,
        active: "postgres" as const,
        external: objectStorage.status,
        detail: objectStorage.detail,
      },
      embeddings,
      // Only the state is returned. The values of the email variables never leave the server.
      email: emailDeliveryState({ url: process.env.EMAIL_API_URL, key: process.env.EMAIL_API_KEY }),
      localSemantic: localSemanticModel(),
      publishing,
      providers,
      connections,
      integrations: INTEGRATIONS.map((item) => ({ id: item.id, status: item.status, detail: item.detail })),
    };
  });
