import { createFileRoute } from "@tanstack/react-router";
import { getSql, type Sql } from "@/lib/db";
import { auth } from "@/lib/auth/server";
import { DEV_USER_ID, authConfigured } from "@/lib/auth/verify.server";
import { gateIdentityEnabled } from "@/lib/auth/gate-identity.server";
import { localSemanticModel, embeddingProviderState } from "@/lib/meridian/embeddings/provider";
import { externalObjectStorageStatus } from "@/lib/meridian/storage/object-store";
import { accountProviderState } from "@/lib/meridian/providers/boundaries";
import { videoGenerationStatus } from "@/lib/meridian/video/provider";
import { pickActiveOrganization } from "@/lib/meridian/storage/media-access";
import { openRouterChatCredential } from "@/lib/meridian/providers/chat.server";
import { healthResult, loadHealthDetail } from "@/lib/meridian/observability/health";

/** Which integrations this deployment has configured. It carries no key, and no count. Shown only to a workspace admin. */
function deploymentStatus() {
  return {
    storage: externalObjectStorageStatus({
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      endpoint: process.env.S3_ENDPOINT,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    }),
    localSemantic: localSemanticModel().kind,
    // Only the presence of a resolved key is passed. The key itself never reaches the status function.
    externalEmbeddings: embeddingProviderState({ openRouterKey: openRouterChatCredential().status === "ready" ? "resolved" : undefined }).status,
    providers: (["meta", "tiktok", "google", "ad_library"] as const).map((provider) => accountProviderState(provider).status),
    video: videoGenerationStatus({ baseUrl: process.env.HYPIT_BASE_URL }).status,
  };
}

/** The signed-in user, using the same rule as the asset route. Null when nobody is signed in. */
async function signedInUserId(request: Request): Promise<string | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  const devFallbackAllowed = !authConfigured && !gateIdentityEnabled() && !process.env.DATABASE_URL?.trim();
  return session?.user?.id ?? (devFallbackAllowed ? DEV_USER_ID : null);
}

/** The caller's active workspace and role, chosen the way the asset route chooses it. */
async function activeWorkspaceOf(sql: Sql, userId: string) {
  const memberships = await sql<{ organization_id: string; role: string }>`
    select m.organization_id, m.role
    from memberships m
    join organizations o on o.id = m.organization_id
    where m.user_id = ${userId}
    order by o.created_at asc
  `;
  const preferences = await sql<{ active_organization_id: string | null }>`
    select active_organization_id from user_settings where user_id = ${userId} limit 1
  `;
  return pickActiveOrganization(
    preferences[0]?.active_organization_id,
    memberships.map((row) => ({ organizationId: String(row.organization_id), role: String(row.role) })),
  );
}

/**
 * GET /api/health is liveness only: `{ status: "ok" }`, with no database read and no counts. `?detail=1` returns the
 * operational detail for the caller's own workspace, and only to a signed-in workspace admin.
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const detailRequested = new URL(request.url).searchParams.get("detail") === "1";
        const result = await healthResult(detailRequested, {
          resolveUserId: () => signedInUserId(request),
          resolveActiveWorkspace: async (userId) => activeWorkspaceOf(await getSql(), userId),
          loadDetail: async (organizationId) => ({
            ...(await loadHealthDetail(await getSql(), organizationId)),
            ...deploymentStatus(),
          }),
        });
        return Response.json(result.body, {
          status: result.status,
          headers: detailRequested ? { "cache-control": "no-store" } : undefined,
        });
      },
    },
  },
});
