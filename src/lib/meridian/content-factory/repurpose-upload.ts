// Uploads one approved, rendered repurposed variation to a Meta ad account, and records a receipt only when Meta returned its own video id.
// It uploads the video. It does not create a post or an ad from it, so a receipt says "uploaded", never "published".
//
// Order of checks: an existing receipt returns without an upload; the readiness gate (repurpose-publish.ts) must pass; then the upload.
// The upload's own idempotency (uploadMetaVideo looks for a video with the same name before it sends one) makes a retry after a lost reply
// reuse Meta's video rather than send a second copy.

import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { MetaCredentials } from "../providers/meta.ts";
import type { Transport } from "../providers/http.ts";
import { repurposePublishReadiness, type RepurposePublishInput } from "./repurpose-publish.ts";

export type RepurposeUploadReceipt = {
  id: string;
  organizationId: string;
  brandId: string;
  variantId: string;
  platformAccountId: string;
  externalId: string;
  idempotencyKey: string;
};

/** The receipts of uploaded variations. One per variation and account. */
export type RepurposeUploadStore = {
  find(variantId: string, platformAccountId: string): Promise<RepurposeUploadReceipt | null>;
  save(receipt: RepurposeUploadReceipt): Promise<void>;
};

/** The Meta upload this step calls. It is injected so a test can answer it, and the real one is providers/meta.ts uploadMetaVideo. */
export type MetaVideoUpload = (
  credentials: MetaCredentials,
  input: { adAccountId: string; bytes: Uint8Array; uploadName: string; idempotencyKey: string },
  transport: Transport,
) => Promise<{ status: "stored"; externalId: string; reused: boolean } | { status: "failed"; externalId: null; error: string }>;

export type UploadRepurposedVariantInput = {
  organizationId: string;
  brandId: string;
  runId: string;
  variantId: string;
  variantKey: string;
  readiness: RepurposePublishInput;
  /** The variation's own stored video, read by the caller. Null when it could not be read. */
  bytes: Uint8Array | null;
  platformAccountId: string;
  adAccountId: string;
  accessToken: string;
};

export type UploadRepurposedVariantOutcome =
  | { status: "uploaded"; receipt: RepurposeUploadReceipt }
  | { status: "already_uploaded"; receipt: RepurposeUploadReceipt }
  | { status: "blocked"; reason: string }
  | { status: "failed"; error: string };

export async function uploadRepurposedVariantToMeta(
  input: UploadRepurposedVariantInput,
  deps: { store: RepurposeUploadStore; upload: MetaVideoUpload; transport: Transport },
): Promise<UploadRepurposedVariantOutcome> {
  const existing = await deps.store.find(input.variantId, input.platformAccountId);
  if (existing) return { status: "already_uploaded", receipt: existing };

  const readiness = repurposePublishReadiness(input.readiness);
  if (readiness.state === "blocked") return { status: "blocked", reason: readiness.reason };
  if (input.bytes === null || input.bytes.byteLength === 0) {
    return { status: "blocked", reason: "The rendered video for this variation could not be read. Nothing was sent." };
  }

  const idempotencyKey = `${input.brandId}:${input.runId}:${input.variantKey}:${input.platformAccountId}:meta_ad_video`;
  // The name carries a hash of the key, as the Hypit upload's does, so Meta can find an earlier upload of the same variation on a retry.
  const uploadName = `Repurposed ${input.variantKey} [Meridian:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}]`;
  const result = await deps.upload(
    { accessToken: input.accessToken, adAccountId: input.adAccountId },
    { adAccountId: input.adAccountId, bytes: input.bytes, uploadName, idempotencyKey },
    deps.transport,
  );
  // A failed upload leaves no receipt, so the next attempt uploads again, and Meta's name lookup prevents a duplicate.
  if (result.status !== "stored") return { status: "failed", error: result.error };

  const receipt: RepurposeUploadReceipt = {
    id: randomUUID(),
    organizationId: input.organizationId,
    brandId: input.brandId,
    variantId: input.variantId,
    platformAccountId: input.platformAccountId,
    externalId: result.externalId,
    idempotencyKey,
  };
  await deps.store.save(receipt);
  return { status: "uploaded", receipt };
}

/** A receipt store for tests and for a caller that keeps receipts in memory. */
export function memoryRepurposeUploadStore(): RepurposeUploadStore & { all(): RepurposeUploadReceipt[] } {
  const receipts = new Map<string, RepurposeUploadReceipt>();
  return {
    async find(variantId, platformAccountId) {
      return receipts.get(`${variantId}|${platformAccountId}`) ?? null;
    },
    async save(receipt) {
      const key = `${receipt.variantId}|${receipt.platformAccountId}`;
      if (receipts.has(key)) throw new Error("a receipt already exists for this variation and account");
      receipts.set(key, receipt);
    },
    all() {
      return [...receipts.values()];
    },
  };
}

/** The receipt store in Postgres (migration 0126). A save for an existing variation and account is rejected by its unique key. */
export function sqlRepurposeUploadStore(sql: Sql): RepurposeUploadStore {
  return {
    async find(variantId, platformAccountId) {
      const rows = await sql<Record<string, string>>`
        select id, organization_id, brand_id, variant_id, platform_account_id, external_id, idempotency_key
        from content_factory_repurpose_publications
        where variant_id = ${variantId} and platform_account_id = ${platformAccountId} and kind = 'meta_ad_video'
        limit 1
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id!,
        organizationId: row.organization_id!,
        brandId: row.brand_id!,
        variantId: row.variant_id!,
        platformAccountId: row.platform_account_id!,
        externalId: row.external_id!,
        idempotencyKey: row.idempotency_key!,
      };
    },
    async save(receipt) {
      await sql`
        insert into content_factory_repurpose_publications (
          id, organization_id, brand_id, variant_id, platform, kind, platform_account_id, external_id, idempotency_key
        ) values (
          ${receipt.id}, ${receipt.organizationId}, ${receipt.brandId}, ${receipt.variantId}, 'meta', 'meta_ad_video',
          ${receipt.platformAccountId}, ${receipt.externalId}, ${receipt.idempotencyKey}
        )
      `;
    },
  };
}
