import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { localSemanticModel, embeddingProviderState } from "@/lib/meridian/embeddings/provider";
import { INTEGRATIONS } from "@/lib/meridian/providers/integrations";
import { externalObjectStorageStatus } from "@/lib/meridian/storage/object-store";
import { publishingProviderStatus } from "@/lib/meridian/publishing/provider";
import { accountProviderState } from "@/lib/meridian/providers/boundaries";
import { isLiveProvider, phaseForProbe, providerConfigured, type LiveProvider } from "@/lib/meridian/providers/live";

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
    const embeddings = embeddingProviderState({ openRouterKey: process.env.OPENROUTER_API_KEY });
    const publishing = publishingProviderStatus();
    const objectStorage = externalObjectStorageStatus({
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      endpoint: process.env.S3_ENDPOINT,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    });
    const now = Date.now();
    let worker: "running" | "stopped" = "stopped";
    let scheduler: "running" | "stopped" = "stopped";
    let database: "up" | "down" = "down";
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
    } catch {
      database = "down";
    }
    const providers = (["meta", "tiktok", "google", "ad_library"] as const).map((provider) => accountProviderState(provider));
    let connections: { provider: LiveProvider; phase: string; detail: string; accountId: string; accountName: string; lastError: string }[] = [];
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
          connections = (["meta", "tiktok", "google", "ad_library"] as const).map((provider) => {
            const row = rows.find((item) => item.provider === provider);
            const phase = phaseForProbe({
              provider,
              ok: row?.last_success_at ? true : row?.last_error ? false : null,
              error: row?.last_error ?? "",
              disconnected: Boolean(row?.disconnected_at),
            });
            if (!row && providerConfigured(provider)) {
              return { provider, phase: phase.phase, detail: phase.detail, accountId: "", accountName: "", lastError: "" };
            }
            return {
              provider,
              phase: row ? phase.phase : phase.phase,
              detail: phase.detail,
              accountId: row?.account_id ?? "",
              accountName: row?.account_name ?? "",
              lastError: row?.last_error ?? "",
            };
          });
        }
      } catch {
        connections = [];
      }
    }
    if (connections.length === 0) {
      connections = (["meta", "tiktok", "google", "ad_library"] as const).filter(isLiveProvider).map((provider) => {
        const phase = phaseForProbe({ provider, ok: null, error: "", disconnected: false });
        return { provider, phase: phase.phase, detail: phase.detail, accountId: "", accountName: "", lastError: "" };
      });
    }
    return {
      worker,
      scheduler,
      database,
      objectStorage: {
        database: "MIGRATION_SOURCE" as const,
        active: objectStorage.status === "CONFIGURED" ? ("s3" as const) : ("filesystem" as const),
        external: objectStorage.status,
        detail: objectStorage.detail,
      },
      embeddings,
      localSemantic: localSemanticModel(),
      publishing,
      providers,
      connections,
      integrations: INTEGRATIONS.map((item) => ({ id: item.id, status: item.status, detail: item.detail })),
    };
  });
