// The production caller of the repurposed variation upload. It loads what the readiness gate needs from the database, reads the variation's
// own stored video from the engine's object store, resolves the workspace's Meta token and ad account the way the publish action does, and
// then runs the upload step. Admins only, through sessionAccess. Nothing is sent unless every condition in the gate holds.

import { readArtifact, readMediaBytes } from "../../../engine/jobs/artifact-store.ts";
import type { Sql } from "../learning/store.ts";
import { engineObjectStore } from "../storage/engine-media-link.ts";
import { gatedTransport } from "../providers/capability.ts";
import type { Transport } from "../providers/http.ts";
import { AD_ACCOUNT_PLATFORM, savedAdAccountId } from "../providers/ad-account.ts";
import { providerAccessToken } from "../providers/access-token.ts";
import { uploadMetaVideo } from "../providers/meta.ts";
import type { RepurposeVariationStatus } from "./repurpose.ts";
import { repurposeReviewsOf, type RepurposeReviewState } from "./repurpose-review.ts";
import { sessionAccess } from "./service.ts";
import { sqlRepurposeUploadStore, uploadRepurposedVariantToMeta, type UploadRepurposedVariantOutcome } from "./repurpose-upload.ts";

export type UploadRepurposeVariantInput = { sessionId: string; runId: string; variantKey: string };

export async function uploadRepurposeVariantToMeta(
  sql: Sql,
  userId: string,
  input: UploadRepurposeVariantInput,
  options: { env: { TOKEN_ENCRYPTION_KEY?: string }; transport?: Transport },
): Promise<UploadRepurposedVariantOutcome> {
  const session = await sessionAccess(sql, userId, input.sessionId);
  const brandId = session.brand_id;
  if (!brandId) throw new Error("This session has no brand, so no ad account can belong to it.");
  const organizationId = session.organization_id;

  const found = await sql<{ id: string; status: string; rendered_artifact_id: string | null }>`
    select v.id, v.status, v.rendered_artifact_id
    from content_factory_repurpose_variants v
    join content_factory_repurpose_runs r on r.id = v.run_id and r.organization_id = v.organization_id
    where v.organization_id = ${organizationId} and r.session_id = ${session.id} and v.run_id = ${input.runId} and v.variant_key = ${input.variantKey}
    limit 1
  `;
  const variant = found[0];
  if (!variant) throw new Error("That variation is not part of this run.");

  // The reviewer's latest decision on this variation, read the same way the review screen reads it.
  const reviews = await repurposeReviewsOf(sql, userId, { sessionId: input.sessionId, runId: input.runId });
  const review: RepurposeReviewState = reviews[input.variantKey] ?? { status: "not_decided" };

  // The variation's own rendered video, from the engine's object store. A video that is missing or does not match its hash is not read.
  let bytes: Uint8Array | null = null;
  if (variant.rendered_artifact_id) {
    try {
      const stored = await readArtifact(sql, { organizationId, artifactId: variant.rendered_artifact_id });
      bytes = await readMediaBytes(engineObjectStore(sql), { organizationId, brandId, stored });
    } catch {
      bytes = null;
    }
  }

  // The Meta ad account saved for the brand, and the workspace's Meta token, opened as the publish action opens it.
  const adAccountId = await savedAdAccountId(sql, organizationId, brandId, AD_ACCOUNT_PLATFORM.meta);
  const secrets = await sql<{ sealed_token: string; sealed_refresh: string; expires_at: string | null }>`
    select sealed_token, sealed_refresh, expires_at from provider_secrets
    where organization_id = ${organizationId} and provider = 'meta'
    limit 1
  `;
  const opened = await providerAccessToken(sql, {
    organizationId,
    provider: "meta",
    sealed: secrets[0]?.sealed_token ?? "",
    encryptionKey: options.env.TOKEN_ENCRYPTION_KEY ?? "",
    env: options.env,
    expiresAt: secrets[0]?.expires_at ? new Date(secrets[0].expires_at).toISOString() : null,
    hasRefresh: (secrets[0]?.sealed_refresh ?? "").trim() !== "",
  });
  const accessToken = "token" in opened ? opened.token : "";

  return uploadRepurposedVariantToMeta(
    {
      organizationId,
      brandId,
      runId: input.runId,
      variantId: variant.id,
      variantKey: input.variantKey,
      readiness: {
        variantStatus: variant.status as RepurposeVariationStatus,
        review,
        hasStoredVideo: bytes !== null,
        metaConnected: accessToken !== "" && adAccountId.startsWith("act_"),
      },
      bytes,
      platformAccountId: adAccountId,
      adAccountId,
      accessToken,
    },
    {
      store: sqlRepurposeUploadStore(sql),
      upload: uploadMetaVideo,
      transport: options.transport ?? gatedTransport("publish.meta_video_upload"),
    },
  );
}
