import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { auth } from "@/lib/auth/server";
import { DEV_USER_ID, authConfigured } from "@/lib/auth/verify.server";
import { gateIdentityEnabled } from "@/lib/auth/gate-identity.server";
import { serveStoredAsset } from "@/lib/meridian/storage/asset-response";
import { createRateLimit } from "@/lib/meridian/security/limits";

const assetReadLimit = createRateLimit(120, 60_000);

export const Route = createFileRoute("/api/assets/$assetId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await auth.api.getSession({ headers: request.headers });
        const devFallbackAllowed = !authConfigured && !gateIdentityEnabled() && !process.env.DATABASE_URL?.trim();
        const userId = session?.user?.id ?? (devFallbackAllowed ? DEV_USER_ID : null);
        return serveStoredAsset({
          request,
          assetId: params.assetId,
          userId,
          getSql,
          loadArtifactFiles: async () => (await import("@/lib/meridian/storage/artifact-drive")).defaultArtifactDrive(),
          rateLimit: assetReadLimit,
          logError: (message, detail) => console.error(message, detail),
        });
      },
    },
  },
});
