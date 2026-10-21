import type { Sql } from "./learning/store.ts";
import { embeddingProviderState, localSemanticModel } from "./embeddings/provider.ts";
import { INTEGRATIONS } from "./providers/integrations.ts";
import { objectStorageStatus } from "./storage/object-store.ts";
import { emailDeliveryState, isoOrNull } from "./notifications/email-state.ts";
import { CHANNEL_PUBLISHING_DETAIL, publishingProviderStatus } from "./publishing/provider.ts";
import { providerCredentialState, type ProviderCredentialState } from "./providers/access-token.ts";
import { isLiveProvider, phaseForProbe, phaseForStoredConnection, type LiveProvider } from "./providers/live.ts";

const CONNECTION_PROVIDERS = ["meta", "tiktok", "google", "ad_library"] as const;

function ageMs(value: unknown, now: number): number | null {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  if (!Number.isFinite(time)) return null;
  return now - time;
}

/**
 * The status the Integrations page reads. Account state comes from the workspace's stored connection rows, and those are read
 * only for a member of the workspace. No account state is read from the environment.
 */
export async function readSystemStatus(input: { userId: string; organizationId: string; loadSql: () => Promise<Sql> }) {
  const embeddings = embeddingProviderState({ url: process.env.EXTERNAL_SEMANTIC_URL, key: process.env.EXTERNAL_SEMANTIC_KEY });
  const publishing = { ...publishingProviderStatus(), detail: CHANNEL_PUBLISHING_DETAIL };
  const objectStorage = objectStorageStatus();
  const now = Date.now();
  let worker: "running" | "stopped" = "stopped";
  let scheduler: "running" | "stopped" = "stopped";
  let database: "up" | "down" = "down";
  try {
    const sql = await input.loadSql();
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
  } catch {
    database = "down";
  }
  let connections: { provider: LiveProvider; phase: string; detail: string; accountId: string; accountName: string; lastError: string; lastSuccessAt: string | null }[] = [];
  if (database === "up" && input.organizationId) {
    try {
      const sql = await input.loadSql();
      const members = await sql<{ role: string }>`
        select role from memberships where user_id = ${input.userId} and organization_id = ${input.organizationId} limit 1
      `;
      if (members[0]) {
        const rows = await sql<{ provider: string; status: string; account_id: string; account_name: string; last_error: string; last_success_at: unknown; disconnected_at: unknown }>`
          select provider, status, account_id, account_name, last_error, last_success_at, disconnected_at
          from provider_connections where organization_id = ${input.organizationId}
        `;
        // The sealed tokens of this workspace only. Each provider's credential state comes from providerCredentialState, so no
        // environment variable can make a provider connected.
        const secrets = await sql<{ provider: string; sealed_token: string }>`
          select provider, sealed_token from provider_secrets where organization_id = ${input.organizationId}
        `;
        const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY ?? "";
        const credentials: Record<string, ProviderCredentialState> = {};
        for (const provider of CONNECTION_PROVIDERS) {
          const sealed = secrets.find((item) => item.provider === provider)?.sealed_token ?? "";
          credentials[provider] = await providerCredentialState(sql, {
            organizationId: input.organizationId,
            provider,
            sealed,
            encryptionKey,
            env: process.env,
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
    } catch {
      connections = [];
    }
  }
  if (connections.length === 0) {
    // No workspace is in scope, or the database could not be read. No credential is in scope, so none is configured.
    connections = (["meta", "tiktok", "google", "ad_library"] as const).filter(isLiveProvider).map((provider) => {
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
    connections,
    integrations: INTEGRATIONS.map((item) => ({ id: item.id, status: item.status, detail: item.detail })),
  };
}
