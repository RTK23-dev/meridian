import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { isWorkerLoopRunning } from "@/lib/meridian/jobs/state";
import { embeddingProviderState } from "@/lib/meridian/embeddings/provider";
import { INTEGRATIONS } from "@/lib/meridian/providers/integrations";
import { externalObjectStorageStatus } from "@/lib/meridian/storage/object-store";
import { publishingProviderStatus } from "@/lib/meridian/publishing/provider";

export const getSystemStatus = createServerFn({ method: "POST" })
  .validator(() => ({}))
  .middleware([authMiddleware])
  .handler(async () => {
    const embeddings = embeddingProviderState({ openRouterKey: process.env.OPENROUTER_API_KEY });
    const publishing = publishingProviderStatus();
    const objectStorage = externalObjectStorageStatus({
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
    });
    return {
      worker: isWorkerLoopRunning() ? ("running" as const) : ("stopped" as const),
      objectStorage: {
        database: "AVAILABLE" as const,
        external: objectStorage.status,
        detail: objectStorage.detail,
      },
      embeddings,
      publishing,
      integrations: INTEGRATIONS.map((item) => ({ id: item.id, status: item.status, detail: item.detail })),
    };
  });
