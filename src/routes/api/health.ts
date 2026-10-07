import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { localSemanticModel, embeddingProviderState } from "@/lib/meridian/embeddings/provider";
import { externalObjectStorageStatus } from "@/lib/meridian/storage/object-store";
import { accountProviderState } from "@/lib/meridian/providers/boundaries";
import { videoGenerationStatus } from "@/lib/meridian/video/provider";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const body: Record<string, unknown> = {
          application: "up",
          database: "down",
          worker: "stopped",
          scheduler: "stopped",
          storage: externalObjectStorageStatus({
            bucket: process.env.S3_BUCKET,
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            endpoint: process.env.S3_ENDPOINT,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }),
          localSemantic: localSemanticModel().kind,
          externalEmbeddings: embeddingProviderState({ openRouterKey: process.env.OPENROUTER_API_KEY }).status,
          providers: (["meta", "tiktok", "google", "ad_library"] as const).map((provider) => accountProviderState(provider).status),
          video: videoGenerationStatus({ baseUrl: process.env.HYPIT_BASE_URL }).status,
          jobs: null,
        };
        try {
          const sql = await getSql();
          await sql`select 1 as ok`;
          body.database = "up";
          const beats = await sql<{ name: string; beat_at: string }>`
            select name, beat_at from process_heartbeats where name in ('worker', 'scheduler')
          `;
          const now = Date.now();
          for (const beat of beats) {
            const time = Date.parse(String(beat.beat_at));
            const fresh = Number.isFinite(time) && now - time < 30_000;
            if (beat.name === "worker") body.worker = fresh ? "running" : "stopped";
            if (beat.name === "scheduler") body.scheduler = fresh ? "running" : "stopped";
          }
          const jobs = await sql<{ status: string; count: number }>`
            select status, count(*) as count from jobs group by status
          `;
          body.jobs = jobs;
          try {
            const queueCounts = await sql<{ status: string; count: number }>`
              select status, count(*) as count from publishing_queues group by status
            `;
            body.publishingQueue = queueCounts;
          } catch {
            body.publishingQueue = [];
          }
        } catch (error) {
          body.database = error instanceof Error ? "down" : "down";
        }
        return Response.json(body);
      },
    },
  },
});
