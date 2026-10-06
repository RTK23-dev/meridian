import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { localSemanticModel, embeddingProviderState } from "@/lib/meridian/embeddings/provider";
import { INTEGRATIONS } from "@/lib/meridian/providers/integrations";
import { externalObjectStorageStatus } from "@/lib/meridian/storage/object-store";
import { publishingProviderStatus } from "@/lib/meridian/publishing/provider";
import { accountProviderState } from "@/lib/meridian/providers/boundaries";

function ageMs(value: unknown, now: number): number | null {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  if (!Number.isFinite(time)) return null;
  return now - time;
}

export const getSystemStatus = createServerFn({ method: "POST" })
  .validator(() => ({}))
  .middleware([authMiddleware])
  .handler(async () => {
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
      providers: (["meta", "tiktok", "google", "ad_library"] as const).map((provider) => accountProviderState(provider)),
      integrations: INTEGRATIONS.map((item) => ({ id: item.id, status: item.status, detail: item.detail })),
    };
  });
