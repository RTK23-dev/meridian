// The guard that stops an organic post from being sent twice. A claim row is written before a channel is called, under a unique key of
// workspace, brand, creative, channel and connected account. Modelled on content-factory/repurpose-organic.ts.
//
// States: claimed (a request holds the lease) -> published / scheduled (the provider confirmed) | uncertain (the outcome is unknown) |
// failed (a definite refusal) | refused (Meridian sent nothing). Only failed and refused can be tried again by a plain request. An
// uncertain attempt is tried again only when the caller says a person checked the platform (`confirmRetry`). A claim whose lease
// expired is an attempt that may have reached the provider, so it becomes uncertain and is never re-sent in the same call.

import { randomUUID } from "node:crypto";
import { withTransaction, type Sql } from "../learning/store.ts";
import { isCapabilityDisabledError } from "../providers/capability.ts";
import type { OrganicPublishReceipt } from "./types.ts";

/** A claim not finished for this long is an attempt whose outcome is unknown. It is longer than the 30 second transport timeout. */
export const PUBLISH_LEASE_MS = 10 * 60 * 1000;

export type ClaimStatus = "claimed" | "published" | "scheduled" | "uncertain" | "failed" | "refused";

export type ClaimKey = { organizationId: string; brandId: string; creativeId: string; channelId: string; targetId: string };

export type ClaimLease = ClaimKey & { token: string };

export type ClaimRow = {
  status: ClaimStatus;
  externalId: string;
  postUrl: string;
  receiptCode: string;
  error: string;
  attempt: number;
};

export type ClaimAcquire =
  | { kind: "claimed"; lease: ClaimLease; attempt: number }
  | { kind: "done"; claim: ClaimRow }
  | { kind: "in_progress" }
  | { kind: "uncertain"; claim: ClaimRow };

export const UNCERTAIN_EXPIRED_REASON =
  "The earlier attempt did not finish, so the post may have gone out. Check the platform for it before sending again.";

type DbRow = {
  id: string;
  status: string;
  attempt: number | string;
  lease_token: string | null;
  lease_expires_at: string | Date | null;
  external_id: string;
  post_url: string;
  receipt_code: string;
  error: string;
};

function toClaim(row: DbRow, override?: Partial<ClaimRow>): ClaimRow {
  return {
    status: row.status as ClaimStatus,
    externalId: row.external_id,
    postUrl: row.post_url,
    receiptCode: row.receipt_code,
    error: row.error,
    attempt: Number(row.attempt),
    ...override,
  };
}

/**
 * Takes the claim for one destination in one transaction. A new row is inserted; a published or scheduled one is returned as it is; an
 * unexpired claim is in progress; an expired claim and an unconfirmed retry are uncertain; a failed or refused row, or an uncertain one
 * with `confirmRetry`, is taken over for a new attempt.
 */
export async function acquireClaim(
  sql: Sql,
  input: ClaimKey & { platform: string; createdBy: string; scheduledFor: string | null; now: Date; leaseMs?: number; confirmRetry: boolean },
): Promise<ClaimAcquire> {
  const token = randomUUID();
  const expires = new Date(input.now.getTime() + (input.leaseMs ?? PUBLISH_LEASE_MS)).toISOString();
  const lease: ClaimLease = {
    organizationId: input.organizationId,
    brandId: input.brandId,
    creativeId: input.creativeId,
    channelId: input.channelId,
    targetId: input.targetId,
    token,
  };
  return withTransaction(sql, async (tx): Promise<ClaimAcquire> => {
    const inserted = await tx<{ id: string }>`
      insert into organic_publish_claims (
        id, organization_id, brand_id, creative_id, channel_id, platform, target_id, status, attempt, lease_token, lease_expires_at,
        scheduled_for, created_by
      ) values (
        ${randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.creativeId}, ${input.channelId}, ${input.platform}, ${input.targetId},
        'claimed', 1, ${token}, ${expires}::timestamptz, ${input.scheduledFor}::timestamptz, ${input.createdBy}
      )
      on conflict do nothing
      returning id
    `;
    if (inserted.length > 0) return { kind: "claimed", lease, attempt: 1 };

    const rows = await tx<DbRow>`
      select id, status, attempt, lease_token, lease_expires_at, external_id, post_url, receipt_code, error
      from organic_publish_claims
      where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and creative_id = ${input.creativeId}
        and channel_id = ${input.channelId} and target_id = ${input.targetId}
      for update
    `;
    const row = rows[0];
    if (!row) throw new Error("The publish record could not be read. Nothing was sent.");
    const attempt = Number(row.attempt);

    if (row.status === "published" || row.status === "scheduled") return { kind: "done", claim: toClaim(row) };
    if (row.status === "claimed") {
      const expiry = row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : 0;
      if (expiry > input.now.getTime()) return { kind: "in_progress" };
      // The earlier request may have reached the provider. The lease token is kept, so that request can still record a confirmed post
      // if it finishes. Nothing is sent again here, not even with confirmRetry: the person has not yet seen this state.
      await tx`
        update organic_publish_claims
        set status = 'uncertain', error = ${UNCERTAIN_EXPIRED_REASON}, receipt_code = 'LEASE_EXPIRED', updated_at = now()
        where id = ${row.id} and status = 'claimed' and attempt = ${attempt}
      `;
      return { kind: "uncertain", claim: toClaim(row, { status: "uncertain", error: UNCERTAIN_EXPIRED_REASON, receiptCode: "LEASE_EXPIRED" }) };
    }
    if (row.status === "uncertain" && !input.confirmRetry) return { kind: "uncertain", claim: toClaim(row) };

    // failed and refused sent nothing. A confirmed retry of an uncertain attempt has been checked by the person. Either starts again.
    const reopened = await tx<{ id: string }>`
      update organic_publish_claims
      set status = 'claimed', attempt = attempt + 1, lease_token = ${token}, lease_expires_at = ${expires}::timestamptz,
          scheduled_for = ${input.scheduledFor}::timestamptz, created_by = ${input.createdBy}, error = '', receipt_code = '', updated_at = now()
      where id = ${row.id} and status = ${row.status} and attempt = ${attempt}
      returning id
    `;
    if (reopened.length === 0) return { kind: "in_progress" };
    return { kind: "claimed", lease, attempt: attempt + 1 };
  });
}

/** What a finished attempt did to the claim. */
export type ClaimOutcome =
  | { status: "published" | "scheduled"; externalId: string; postUrl: string; receiptCode: string }
  | { status: "uncertain" | "failed" | "refused"; receiptCode: string; error: string };

/** How a channel's receipt, or an error it threw, settles the claim. Unknown outcomes are uncertain: the post may have gone out. */
export function outcomeOfReceipt(receipt: OrganicPublishReceipt): ClaimOutcome {
  const code = receipt.code ?? "";
  if ((receipt.status === "published" || receipt.status === "scheduled") && receipt.externalId) {
    return { status: receipt.status, externalId: receipt.externalId, postUrl: receipt.postUrl ?? "", receiptCode: code };
  }
  const error = receipt.error ?? "The platform did not confirm the post.";
  // A post the channel calls published with no id cannot be shown to exist, and may be live. It is uncertain, not a failure.
  if (receipt.status !== "failed") return { status: "uncertain", receiptCode: code || "NO_ID", error };
  if (code === "NOT_CONNECTED") return { status: "refused", receiptCode: code, error };
  if (code === "AUTH_FAILED" || code === "REJECTED") return { status: "failed", receiptCode: code, error };
  // RETRYABLE, UNCONFIRMED, or a failure with no code: the provider may have accepted the upload.
  return { status: "uncertain", receiptCode: code || "UNKNOWN", error };
}

export function outcomeOfThrown(error: unknown): ClaimOutcome {
  const message = error instanceof Error ? error.message : String(error);
  // A disabled path throws before any request, so nothing was sent.
  if (isCapabilityDisabledError(error)) return { status: "refused", receiptCode: "NOT_CONNECTED", error: message };
  return { status: "uncertain", receiptCode: "TRANSPORT_ERROR", error: `The request ended without an answer (${message}). The post may have gone out. Check the platform before sending again.` };
}

/**
 * Settles the claim, and for a confirmed post writes the organic_posts receipt in the same transaction. The claim is updated first and
 * is the guard: when the receipt insert fails, the claim is still recorded as published with the provider id. A claim whose lease expired
 * (now uncertain) can still be settled by the request that held it, because it keeps its token. Returns false when another attempt owns the
 * claim, so this outcome was not recorded.
 */
export async function settleClaim(
  sql: Sql,
  lease: ClaimLease,
  outcome: ClaimOutcome,
  post: { assetId: string | null; platform: string; caption: string; title: string; scheduledFor: string | null },
  organicStatus: string,
): Promise<{ recorded: boolean; postId: string | null; receiptError?: string }> {
  const postId = randomUUID();
  const error = "error" in outcome ? outcome.error : "";
  const externalId = "externalId" in outcome ? outcome.externalId : "";
  const postUrl = "postUrl" in outcome ? outcome.postUrl : "";
  const keyMatch = (tx: Sql) => tx<{ id: string }>`
    update organic_publish_claims
    set status = ${outcome.status}, external_id = ${externalId}, post_url = ${postUrl}, receipt_code = ${outcome.receiptCode}, error = ${error},
        lease_token = ${outcome.status === "uncertain" ? lease.token : null}, lease_expires_at = null, updated_at = now()
    where organization_id = ${lease.organizationId} and brand_id = ${lease.brandId} and creative_id = ${lease.creativeId}
      and channel_id = ${lease.channelId} and target_id = ${lease.targetId}
      and status in ('claimed', 'uncertain') and lease_token = ${lease.token}
    returning id
  `;
  const insertPost = (tx: Sql) => tx`
    insert into organic_posts (
      id, organization_id, brand_id, creative_id, asset_id, platform, external_id, post_url, caption, title, aspect_ratio,
      status, scheduled_for, published_at, error, surface
    ) values (
      ${postId}, ${lease.organizationId}, ${lease.brandId}, ${lease.creativeId}, ${post.assetId}, ${post.platform},
      ${externalId || null}, ${postUrl || null}, ${post.caption}, ${post.title}, '9:16', ${organicStatus}, ${post.scheduledFor},
      ${outcome.status === "published" ? new Date().toISOString() : null}, ${error || null}, 'organic'
    )
  `;
  try {
    return await withTransaction(sql, async (tx) => {
      const updated = await keyMatch(tx);
      if (updated.length === 0) return { recorded: false, postId: null };
      await insertPost(tx);
      return { recorded: true, postId };
    });
  } catch (first) {
    // The receipt row failed. The guard must still say what happened, so the claim alone is written.
    const receiptError = first instanceof Error ? first.message : String(first);
    try {
      const updated = await keyMatch(sql);
      return updated.length > 0 ? { recorded: true, postId: null, receiptError } : { recorded: false, postId: null, receiptError };
    } catch {
      // The claim stays 'claimed' and its lease expires into 'uncertain'. It is never sent again by a plain request.
      return { recorded: false, postId: null, receiptError };
    }
  }
}

/** The latest state of each destination of one creative, for a screen that wants to show an uncertain one. Scoped to the workspace. */
export async function claimsForCreative(
  sql: Sql,
  scope: { organizationId: string; brandId: string; creativeId: string },
): Promise<{ channelId: string; status: ClaimStatus }[]> {
  const rows = await sql<{ channel_id: string; status: string }>`
    select channel_id, status from organic_publish_claims
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and creative_id = ${scope.creativeId}
  `;
  return rows.map((row) => ({ channelId: row.channel_id, status: row.status as ClaimStatus }));
}
