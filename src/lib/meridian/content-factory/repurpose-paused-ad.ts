// Creates one PAUSED Meta ad from a repurposed variation that was uploaded to the brand's ad account. It creates a paused ad only: nothing
// here switches an ad, an ad set or a campaign on, and nothing creates an ad set or a campaign.
//
// One operation per variation and ad account (the table's unique key). Its inputs are fixed when it is first claimed: the ad set, the
// Page, the destination link, the ad text and the uploaded video. A later request with different inputs is refused with a conflict, and
// a takeover never rewrites them. Only a definite refusal from Meta lets a request reopen the operation, with corrected inputs.
//
// States (migration 0129):
//   claimed           one request holds the lease; no create has been sent
//   creative_attempt  a creative create may have reached Meta
//   ad_attempt        an ad create may have reached Meta; its creative id is recorded before the ad is sent
//   uncertain         an attempt may have reached Meta and its outcome is unknown. Only a reconciliation may act on it
//   unexpected        an object exists that is not a verified paused ad of this operation. It is shown and never changed
//   refused           Meta refused the create and created nothing, or a pre-create check failed
//   verified          Meta returned the ad id, a read-back confirmed PAUSED in the chosen ad set, and the receipt is stored
//
// Fencing. Each claim, takeover or reconciliation gives its holder a new lease token. Every write names the token it holds, so a request
// whose lease has been taken over cannot record an outcome. A takeover is only possible from `claimed`, where no create has been sent. From
// an attempt state, an expired lease leads to reconciliation, never to another create. A create is sent only after the attempt state that
// permits it has been committed.
//
// Reconciliation searches the whole ad account by the operation's marker name, not one ad set. It concludes that nothing exists only from a
// complete search, and only after the attempt window has passed, so a request still in flight at Meta cannot be missed. Even then the
// conclusion is recorded, and a new attempt needs an explicit confirmation from the person.

import { createHash, randomUUID } from "node:crypto";
import { withTransaction, type Sql } from "../learning/store.ts";
import { liveTransport, type Transport } from "../providers/http.ts";
import { AD_ACCOUNT_PLATFORM, savedAdAccountId } from "../providers/ad-account.ts";
import { providerAccessToken } from "../providers/access-token.ts";
import {
  createPausedAdObject,
  createPausedCreative,
  listMetaAdSets,
  lookupPausedAdObjects,
  readPausedAd,
  verifyMetaAdSet,
  type MetaAdSetOption,
} from "../providers/meta-paused-ad.ts";
import type { MetaCredentials } from "../providers/meta.ts";
import { sessionAccess } from "./service.ts";
import { repurposePublishReadiness } from "./repurpose-publish.ts";
import { sqlRepurposeUploadStore } from "./repurpose-upload.ts";
import type { RepurposeVariationStatus } from "./repurpose.ts";
import { repurposeReviewsOf, type RepurposeReviewState } from "./repurpose-review.ts";

/** A lease that has not been renewed for this long may be taken over. Meta answers well inside this window. */
export const PAUSED_AD_LEASE_MS = 10 * 60 * 1000;

/**
 * After an attempt starts, nothing is concluded absent until this long has passed. A request in flight at Meta is bounded by the transport
 * timeout, so the window only has to cover processing that continues after a client timed out.
 */
export const PAUSED_AD_ABSENCE_WINDOW_MS = PAUSED_AD_LEASE_MS + 5 * 60 * 1000;

export type PausedAdBinding = {
  adAccountId: string;
  adSetId: string;
  pageId: string;
  videoId: string;
  destinationUrl: string;
  message: string;
};

/** A fingerprint of every input the ad depends on. Two requests with the same fingerprint describe the same paused ad. */
export function bindingFingerprint(binding: PausedAdBinding): string {
  const canonical = [binding.adAccountId, binding.adSetId, binding.pageId, binding.videoId, binding.destinationUrl, binding.message];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The marker name of an operation's creative and ad. It carries the operation key and its inputs, so a retry finds only its own objects. */
export function operationName(input: { variantKey: string; key: string; fingerprint: string }): string {
  const digest = createHash("sha256").update(`${input.key}|${input.fingerprint}`).digest("hex").slice(0, 32);
  return `Repurposed ${input.variantKey} [Meridian:${digest}]`;
}

/** The key of one paused ad: the brand, the variation and the ad account. The ad set is not part of it, by the one-per-account rule. */
export function pausedAdKey(input: { brandId: string; variantId: string; adAccountId: string }): string {
  return `${input.brandId}:${input.variantId}:${input.adAccountId}:meta_paused_ad`;
}

function publicationId(key: string): string {
  return `pad_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

export type PausedAdReceipt = {
  id: string;
  organizationId: string;
  brandId: string;
  variantId: string;
  adAccountId: string;
  adSetId: string;
  pageId: string;
  destinationUrl: string;
  creativeId: string;
  adId: string;
  verifiedStatus: "PAUSED";
};

export type PausedAdState = "claimed" | "creative_attempt" | "ad_attempt" | "uncertain" | "unexpected" | "refused" | "verified";

/** An operation as the table holds it. Its bound inputs are the ones the claim recorded, so an attempt sends exactly those. */
export type PausedAdOperation = {
  publicationId: string;
  organizationId: string;
  brandId: string;
  key: string;
  variantId: string;
  adAccountId: string;
  name: string;
  fingerprint: string;
  videoId: string;
  message: string;
  adSetId: string;
  pageId: string;
  destinationUrl: string;
  state: PausedAdState;
  attempt: number;
  leaseEpoch: number;
  attemptStartedAt: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  creativeId: string;
  adId: string;
  verifiedStatus: string;
  reason: string;
};

/** The holder of one lease. Every transition names the token, so a holder whose lease was taken over is refused. */
export type PausedAdLease = { organizationId: string; key: string; token: string; epoch: number };

export type PausedAdCandidate = {
  brandId: string;
  variantId: string;
  adAccountId: string;
  name: string;
  fingerprint: string;
  videoId: string;
  message: string;
  adSetId: string;
  pageId: string;
  destinationUrl: string;
};

export type AcquireResult =
  | { kind: "claimed"; operation: PausedAdOperation; lease: PausedAdLease }
  | { kind: "reconcile"; operation: PausedAdOperation; lease: PausedAdLease }
  | { kind: "verified"; operation: PausedAdOperation }
  | { kind: "unexpected"; operation: PausedAdOperation }
  | { kind: "in_progress"; operation: PausedAdOperation }
  | { kind: "conflict"; operation: PausedAdOperation };

/** The paused-ad operations (migration 0129). Every method is scoped to the organization, and every transition names its lease token. */
export type PausedAdStore = {
  acquire(input: { organizationId: string; key: string; candidate: PausedAdCandidate; token: string; now: Date; leaseMs: number; confirmRetry: boolean }): Promise<AcquireResult>;
  beginCreative(lease: PausedAdLease, now: Date, leaseMs: number): Promise<boolean>;
  beginAd(lease: PausedAdLease, now: Date, leaseMs: number): Promise<boolean>;
  recordCreative(lease: PausedAdLease, creativeId: string): Promise<boolean>;
  noteCreative(lease: PausedAdLease, creativeId: string): Promise<boolean>;
  recordAdId(lease: PausedAdLease, adId: string): Promise<boolean>;
  verify(lease: PausedAdLease, receipt: { adId: string; creativeId: string }): Promise<boolean>;
  refuse(lease: PausedAdLease, reason: string): Promise<boolean>;
  markUncertain(lease: PausedAdLease, reason: string, evidence?: "reconciled_absent"): Promise<boolean>;
  markUnexpected(lease: PausedAdLease, adId: string, status: string, reason: string): Promise<boolean>;
  fenced(lease: PausedAdLease, step: string): Promise<void>;
  find(organizationId: string, variantId: string, adAccountId: string): Promise<PausedAdReceipt | null>;
  load(organizationId: string, key: string): Promise<PausedAdOperation | null>;
};

type OperationRow = {
  id: string;
  organization_id: string;
  brand_id: string;
  variant_id: string;
  platform_account_id: string;
  idempotency_key: string;
  operation_name: string | null;
  input_fingerprint: string | null;
  meta_video_id: string;
  ad_message: string;
  ad_set_id: string | null;
  page_id: string | null;
  destination_url: string | null;
  meta_creative_id: string | null;
  external_id: string;
  verified_status: string | null;
  state: string;
  attempt: number;
  lease_epoch: number;
  attempt_started_at: string | Date | null;
  lease_token: string | null;
  lease_expires_at: string | Date | null;
  reason: string;
};

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function operationOf(row: OperationRow): PausedAdOperation {
  return {
    publicationId: row.id,
    organizationId: row.organization_id,
    brandId: row.brand_id,
    key: row.idempotency_key,
    variantId: row.variant_id,
    adAccountId: row.platform_account_id,
    name: row.operation_name ?? "",
    fingerprint: row.input_fingerprint ?? "",
    videoId: row.meta_video_id,
    message: row.ad_message,
    adSetId: row.ad_set_id ?? "",
    pageId: row.page_id ?? "",
    destinationUrl: row.destination_url ?? "",
    state: row.state as PausedAdState,
    attempt: row.attempt,
    leaseEpoch: row.lease_epoch,
    attemptStartedAt: iso(row.attempt_started_at),
    leaseToken: row.lease_token,
    leaseExpiresAt: iso(row.lease_expires_at),
    creativeId: row.meta_creative_id ?? "",
    adId: row.external_id,
    verifiedStatus: row.verified_status ?? "",
    reason: row.reason,
  };
}

function receiptOf(operation: PausedAdOperation): PausedAdReceipt {
  return {
    id: publicationId(operation.key),
    organizationId: operation.organizationId,
    brandId: operation.brandId,
    variantId: operation.variantId,
    adAccountId: operation.adAccountId,
    adSetId: operation.adSetId,
    pageId: operation.pageId,
    destinationUrl: operation.destinationUrl,
    creativeId: operation.creativeId,
    adId: operation.adId,
    verifiedStatus: "PAUSED",
  };
}

async function loadOperation(sql: Sql, organizationId: string, key: string): Promise<OperationRow | null> {
  const rows = await sql<OperationRow>`
    select id, organization_id, brand_id, variant_id, platform_account_id, idempotency_key, operation_name, input_fingerprint,
          meta_video_id, ad_message, ad_set_id, page_id, destination_url, meta_creative_id, external_id, verified_status, state, attempt,
          lease_epoch, attempt_started_at, lease_token, lease_expires_at, reason from content_factory_repurpose_publications
    where organization_id = ${organizationId} and idempotency_key = ${key} and kind = 'meta_paused_ad'
    limit 1
  `;
  return rows[0] ?? null;
}

async function recordEvent(sql: Sql, input: { organizationId: string; publicationId: string; event: string; epoch: number; detail: string }): Promise<void> {
  await sql`
    insert into content_factory_repurpose_publication_events (id, organization_id, publication_id, event, lease_epoch, detail)
    values (${randomUUID()}, ${input.organizationId}, ${input.publicationId}, ${input.event}, ${input.epoch}, ${input.detail})
  `;
}

export function sqlPausedAdStore(sql: Sql): PausedAdStore {
  // A transition is one conditional write in a transaction with its event. It changes nothing unless the lease token still matches.
  async function transition(
    lease: PausedAdLease,
    update: (tx: Sql) => Promise<{ id: string; epoch: number }[]>,
    event: { name: string; detail: string },
  ): Promise<boolean> {
    return withTransaction(sql, async (tx) => {
      const rows = await update(tx);
      if (rows.length === 0) return false;
      await recordEvent(tx, { organizationId: lease.organizationId, publicationId: rows[0]!.id, event: event.name, epoch: rows[0]!.epoch, detail: event.detail });
      return true;
    });
  }

  return {
    async acquire(input) {
      const { organizationId, key, candidate, token, now, leaseMs, confirmRetry } = input;
      const expires = new Date(now.getTime() + leaseMs).toISOString();
      const nowIso = now.toISOString();
      return withTransaction(sql, async (tx) => {
        // The variation must belong to the workspace the operation is written under. The table's keys do not check that.
        const owned = await tx<{ id: string }>`
          select id from content_factory_repurpose_variants where id = ${candidate.variantId} and organization_id = ${organizationId}
        `;
        if (owned.length === 0) throw new Error("That variation is not in this workspace. Nothing was sent.");

        const inserted = await tx<{ id: string }>`
          insert into content_factory_repurpose_publications (
            id, organization_id, brand_id, variant_id, platform, kind, platform_account_id, external_id, idempotency_key,
            ad_set_id, page_id, destination_url, state, claimed_at, operation_name, input_fingerprint, meta_video_id, ad_message,
            attempt, lease_token, lease_epoch, lease_expires_at, reason
          ) values (
            ${publicationId(key)}, ${organizationId}, ${candidate.brandId}, ${candidate.variantId}, 'meta', 'meta_paused_ad',
            ${candidate.adAccountId}, '', ${key}, ${candidate.adSetId}, ${candidate.pageId}, ${candidate.destinationUrl},
            'claimed', ${nowIso}::timestamptz, ${candidate.name}, ${candidate.fingerprint}, ${candidate.videoId}, ${candidate.message},
            1, ${token}, 1, ${expires}::timestamptz, ''
          )
          on conflict do nothing
          returning id
        `;
        if (inserted.length > 0) {
          await recordEvent(tx, { organizationId, publicationId: inserted[0]!.id, event: "claimed", epoch: 1, detail: "attempt:1" });
          const row = (await loadOperation(tx, organizationId, key))!;
          return { kind: "claimed", operation: operationOf(row), lease: { organizationId, key, token, epoch: 1 } };
        }

        const locked = await tx<OperationRow>`
          select id, organization_id, brand_id, variant_id, platform_account_id, idempotency_key, operation_name, input_fingerprint,
          meta_video_id, ad_message, ad_set_id, page_id, destination_url, meta_creative_id, external_id, verified_status, state, attempt,
          lease_epoch, attempt_started_at, lease_token, lease_expires_at, reason from content_factory_repurpose_publications
          where organization_id = ${organizationId} and idempotency_key = ${key} and kind = 'meta_paused_ad'
          for update
        `;
        const row = locked[0];
        if (!row) throw new Error("The paused-ad operation could not be read. Nothing was sent.");
        const op = operationOf(row);
        const live = op.leaseExpiresAt !== null && Date.parse(op.leaseExpiresAt) > now.getTime();

        if (op.state === "verified") return { kind: "verified", operation: op };
        if (op.state === "unexpected") return { kind: "unexpected", operation: op };

        if (op.state === "refused") {
          // Meta created nothing, so corrected inputs may replace the refused ones. The previous inputs are kept in the events table.
          const previous = JSON.stringify({ adSetId: op.adSetId, pageId: op.pageId, destinationUrl: op.destinationUrl, fingerprint: op.fingerprint });
          const reopened = await tx<{ id: string }>`
            update content_factory_repurpose_publications
            set state = 'claimed', attempt = attempt + 1, lease_token = ${token}, lease_epoch = lease_epoch + 1,
                lease_expires_at = ${expires}::timestamptz, attempt_started_at = null,
                operation_name = ${candidate.name}, input_fingerprint = ${candidate.fingerprint},
                meta_video_id = ${candidate.videoId}, ad_message = ${candidate.message},
                ad_set_id = ${candidate.adSetId}, page_id = ${candidate.pageId}, destination_url = ${candidate.destinationUrl},
                meta_creative_id = case when input_fingerprint = ${candidate.fingerprint} then meta_creative_id else null end,
                reason = '', updated_at = now()
            where organization_id = ${organizationId} and idempotency_key = ${key} and state = 'refused' and lease_epoch = ${op.leaseEpoch}
            returning id
          `;
          if (reopened.length === 0) return { kind: "in_progress", operation: op };
          await recordEvent(tx, { organizationId, publicationId: op.publicationId, event: "reopened", epoch: op.leaseEpoch + 1, detail: previous });
          const next = (await loadOperation(tx, organizationId, key))!;
          return { kind: "claimed", operation: operationOf(next), lease: { organizationId, key, token, epoch: next.lease_epoch } };
        }

        if (op.fingerprint !== candidate.fingerprint) {
          await recordEvent(tx, { organizationId, publicationId: op.publicationId, event: "conflict", epoch: op.leaseEpoch, detail: candidate.fingerprint });
          return { kind: "conflict", operation: op };
        }
        if (live) return { kind: "in_progress", operation: op };

        if (op.state === "uncertain" && confirmRetry) {
          // The person confirmed a new attempt. Only a recorded absence from a complete search for this attempt allows it.
          const absence = await tx<{ n: number }>`
            select count(*)::int as n from content_factory_repurpose_publication_events
            where organization_id = ${organizationId} and publication_id = ${op.publicationId}
              and event = 'reconciled_absent' and detail = ${`attempt:${op.attempt}`}
          `;
          if ((absence[0]?.n ?? 0) > 0) {
            const retried = await tx<{ id: string }>`
              update content_factory_repurpose_publications
              set state = 'claimed', attempt = attempt + 1, lease_token = ${token}, lease_epoch = lease_epoch + 1,
                  lease_expires_at = ${expires}::timestamptz, attempt_started_at = null, reason = '', updated_at = now()
              where organization_id = ${organizationId} and idempotency_key = ${key} and state = 'uncertain' and lease_epoch = ${op.leaseEpoch}
              returning id
            `;
            if (retried.length === 0) return { kind: "in_progress", operation: op };
            await recordEvent(tx, { organizationId, publicationId: op.publicationId, event: "reopened", epoch: op.leaseEpoch + 1, detail: `after-absence:attempt:${op.attempt}` });
            const next = (await loadOperation(tx, organizationId, key))!;
            return { kind: "claimed", operation: operationOf(next), lease: { organizationId, key, token, epoch: next.lease_epoch } };
          }
        }

        if (op.state === "claimed") {
          // Nothing was sent by the earlier holder, so a takeover is safe. Its inputs are kept as they are.
          const taken = await tx<{ id: string }>`
            update content_factory_repurpose_publications
            set lease_token = ${token}, lease_epoch = lease_epoch + 1, lease_expires_at = ${expires}::timestamptz, updated_at = now()
            where organization_id = ${organizationId} and idempotency_key = ${key} and state = 'claimed' and lease_epoch = ${op.leaseEpoch}
            returning id
          `;
          if (taken.length === 0) return { kind: "in_progress", operation: op };
          await recordEvent(tx, { organizationId, publicationId: op.publicationId, event: "taken_over", epoch: op.leaseEpoch + 1, detail: "attempt:" + op.attempt });
          const next = (await loadOperation(tx, organizationId, key))!;
          return { kind: "claimed", operation: operationOf(next), lease: { organizationId, key, token, epoch: next.lease_epoch } };
        }

        // An attempt that may have reached Meta, or an uncertain outcome, is only reconciled. This lease can never create.
        const reconciling = await tx<{ id: string }>`
          update content_factory_repurpose_publications
          set lease_token = ${token}, lease_epoch = lease_epoch + 1, lease_expires_at = ${expires}::timestamptz, updated_at = now()
          where organization_id = ${organizationId} and idempotency_key = ${key} and state in ('creative_attempt', 'ad_attempt', 'uncertain')
            and lease_epoch = ${op.leaseEpoch}
          returning id
        `;
        if (reconciling.length === 0) return { kind: "in_progress", operation: op };
        await recordEvent(tx, { organizationId, publicationId: op.publicationId, event: "reconcile_started", epoch: op.leaseEpoch + 1, detail: "attempt:" + op.attempt });
        const next = (await loadOperation(tx, organizationId, key))!;
        return { kind: "reconcile", operation: operationOf(next), lease: { organizationId, key, token, epoch: next.lease_epoch } };
      });
    },

    async beginCreative(lease, now, leaseMs) {
      const expires = new Date(now.getTime() + leaseMs).toISOString();
      return transition(
        lease,
        (tx) => tx<{ id: string; epoch: number }>`
          update content_factory_repurpose_publications
          set state = 'creative_attempt', attempt_started_at = ${now.toISOString()}::timestamptz, lease_expires_at = ${expires}::timestamptz, updated_at = now()
          where organization_id = ${lease.organizationId} and idempotency_key = ${lease.key} and state = 'claimed' and lease_token = ${lease.token}
          returning id, lease_epoch as epoch
        `,
        { name: "attempt_started", detail: "creative" },
      );
    },

    async beginAd(lease, now, leaseMs) {
      const expires = new Date(now.getTime() + leaseMs).toISOString();
      return transition(
        lease,
        (tx) => tx<{ id: string; epoch: number }>`
          update content_factory_repurpose_publications
          set state = 'ad_attempt', attempt_started_at = ${now.toISOString()}::timestamptz, lease_expires_at = ${expires}::timestamptz, updated_at = now()
          where organization_id = ${lease.organizationId} and idempotency_key = ${lease.key} and state = 'claimed' and lease_token = ${lease.token}
          returning id, lease_epoch as epoch
        `,
        { name: "attempt_started", detail: "ad" },
      );
    },

    async recordCreative(lease, creativeId) {
      return transition(
        lease,
        (tx) => tx<{ id: string; epoch: number }>`
          update content_factory_repurpose_publications
          set state = 'ad_attempt', meta_creative_id = ${creativeId}, updated_at = now()
          where organization_id = ${lease.organizationId} and idempotency_key = ${lease.key} and state = 'creative_attempt' and lease_token = ${lease.token}
          returning id, lease_epoch as epoch
        `,
        { name: "creative_created", detail: creativeId },
      );
    },

    async noteCreative(lease, creativeId) {
      return transition(
        lease,
        (tx) => tx<{ id: string; epoch: number }>`
          update content_factory_repurpose_publications
          set meta_creative_id = ${creativeId}, updated_at = now()
          where organization_id = ${lease.organizationId} and idempotency_key = ${lease.key} and lease_token = ${lease.token}
            and state in ('creative_attempt', 'ad_attempt', 'uncertain') and meta_creative_id is null
          returning id, lease_epoch as epoch
        `,
        { name: "creative_created", detail: creativeId },
      );
    },

    async recordAdId(lease, adId) {
      return transition(
        lease,
        (tx) => tx<{ id: string; epoch: number }>`
          update content_factory_repurpose_publications
          set external_id = ${adId}, updated_at = now()
          where organization_id = ${lease.organizationId} and idempotency_key = ${lease.key} and lease_token = ${lease.token}
            and state in ('ad_attempt', 'uncertain') and external_id = ''
          returning id, lease_epoch as epoch
        `,
        { name: "ad_created", detail: adId },
      );
    },

    async verify(lease, receipt) {
      return transition(
        lease,
        (tx) => tx<{ id: string; epoch: number }>`
          update content_factory_repurpose_publications
          set state = 'verified', external_id = ${receipt.adId}, meta_creative_id = coalesce(meta_creative_id, ${receipt.creativeId}),
              verified_status = 'PAUSED', lease_token = null, lease_expires_at = null, reason = '', updated_at = now()
          where organization_id = ${lease.organizationId} and idempotency_key = ${lease.key} and lease_token = ${lease.token}
            and state in ('creative_attempt', 'ad_attempt', 'uncertain') and (external_id = '' or external_id = ${receipt.adId})
          returning id, lease_epoch as epoch
        `,
        { name: "verified", detail: receipt.adId },
      );
    },

    async refuse(lease, reason) {
      return transition(
        lease,
        (tx) => tx<{ id: string; epoch: number }>`
          update content_factory_repurpose_publications
          set state = 'refused', lease_token = null, lease_expires_at = null, reason = ${reason}, updated_at = now()
          where organization_id = ${lease.organizationId} and idempotency_key = ${lease.key} and lease_token = ${lease.token}
            and state in ('claimed', 'creative_attempt', 'ad_attempt') and external_id = ''
          returning id, lease_epoch as epoch
        `,
        { name: "refused", detail: reason },
      );
    },

    async markUncertain(lease, reason, evidence) {
      return withTransaction(sql, async (tx) => {
        const rows = await tx<{ id: string; epoch: number; attempt: number }>`
          update content_factory_repurpose_publications
          set state = 'uncertain', lease_expires_at = null, reason = ${reason}, updated_at = now()
          where organization_id = ${lease.organizationId} and idempotency_key = ${lease.key} and lease_token = ${lease.token}
            and state in ('creative_attempt', 'ad_attempt', 'uncertain')
          returning id, lease_epoch as epoch, attempt
        `;
        if (rows.length === 0) return false;
        const { id, epoch, attempt } = rows[0]!;
        if (evidence === "reconciled_absent") {
          await recordEvent(tx, { organizationId: lease.organizationId, publicationId: id, event: "reconciled_absent", epoch, detail: `attempt:${attempt}` });
        } else {
          await recordEvent(tx, { organizationId: lease.organizationId, publicationId: id, event: "uncertain", epoch, detail: reason });
        }
        return true;
      });
    },

    async markUnexpected(lease, adId, status, reason) {
      if (status === "PAUSED") throw new Error("A paused ad is not recorded as unexpected.");
      return transition(
        lease,
        (tx) => tx<{ id: string; epoch: number }>`
          update content_factory_repurpose_publications
          set state = 'unexpected', external_id = ${adId}, verified_status = ${status}, lease_token = null, lease_expires_at = null,
              reason = ${reason}, updated_at = now()
          where organization_id = ${lease.organizationId} and idempotency_key = ${lease.key} and lease_token = ${lease.token}
            and state in ('creative_attempt', 'ad_attempt', 'uncertain') and (external_id = '' or external_id = ${adId})
          returning id, lease_epoch as epoch
        `,
        { name: "unexpected", detail: `${status}:${adId}` },
      );
    },

    async fenced(lease, step) {
      await sql`
        insert into content_factory_repurpose_publication_events (id, organization_id, publication_id, event, lease_epoch, detail)
        select ${randomUUID()}, organization_id, id, 'fenced', lease_epoch, ${step}
        from content_factory_repurpose_publications
        where organization_id = ${lease.organizationId} and idempotency_key = ${lease.key} and kind = 'meta_paused_ad'
      `;
    },

    async find(organizationId, variantId, adAccountId) {
      const rows = await sql<OperationRow>`
        select id, organization_id, brand_id, variant_id, platform_account_id, idempotency_key, operation_name, input_fingerprint,
          meta_video_id, ad_message, ad_set_id, page_id, destination_url, meta_creative_id, external_id, verified_status, state, attempt,
          lease_epoch, attempt_started_at, lease_token, lease_expires_at, reason from content_factory_repurpose_publications
        where organization_id = ${organizationId} and variant_id = ${variantId} and platform_account_id = ${adAccountId}
          and kind = 'meta_paused_ad' and state = 'verified' and verified_status = 'PAUSED'
        limit 1
      `;
      return rows[0] ? receiptOf(operationOf(rows[0])) : null;
    },

    async load(organizationId, key) {
      const row = await loadOperation(sql, organizationId, key);
      return row ? operationOf(row) : null;
    },
  };
}

export type CreatePausedAdInput = {
  sessionId: string;
  runId: string;
  variantKey: string;
  /** The ad set the person chose. */
  adSetId: string;
  /** The same ad set again. The second choice is the confirmation: a mismatch sends nothing. */
  confirmAdSetId: string;
  /** The Page the ad is created under. It must be a Page saved for this brand. */
  pageId: string;
  /** The link the ad sends people to. It is entered for this ad; no brand website is stored to take it from. */
  destinationUrl: string;
  message: string;
  /** Set only when the person has confirmed a new attempt after a search found no ad. */
  confirmRetryAfterAbsence?: boolean;
};

/** The checks that need no database: the confirmation, the identifiers' shape, and the link. Nothing is sent when one fails. */
export function pausedAdPreflight(input: Pick<CreatePausedAdInput, "adSetId" | "confirmAdSetId" | "pageId" | "destinationUrl" | "message">): { ok: true } | { ok: false; reason: string } {
  if (!/^\d{1,30}$/.test(input.adSetId.trim())) return { ok: false, reason: "Choose an ad set from the list. Nothing was created." };
  if (input.confirmAdSetId.trim() !== input.adSetId.trim()) {
    return { ok: false, reason: "Confirm the same ad set you chose. Nothing was created." };
  }
  if (!/^\d{1,30}$/.test(input.pageId.trim())) return { ok: false, reason: "Choose the Facebook Page the ad is created under. Nothing was created." };
  let link: URL;
  try {
    link = new URL(input.destinationUrl.trim());
  } catch {
    return { ok: false, reason: "Enter the destination link as a full https address. Nothing was created." };
  }
  if (link.protocol !== "https:" || input.destinationUrl.length > 2048) {
    return { ok: false, reason: "The destination link must be an https address of at most 2048 characters. Nothing was created." };
  }
  if (input.message.length > 2000) return { ok: false, reason: "The ad text is longer than 2000 characters. Nothing was created." };
  return { ok: true };
}

export type CreatePausedAdOutcome =
  | { status: "created_paused"; receipt: PausedAdReceipt }
  | { status: "already_created"; receipt: PausedAdReceipt; bindingMatches: boolean; reconciled: boolean }
  | { status: "in_progress"; reason: string }
  | { status: "conflict"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "refused"; reason: string }
  | { status: "uncertain"; stage: "creative" | "ad" | "reconcile"; reason: string }
  | { status: "absent"; reason: string }
  | { status: "unexpected"; adId: string; verifiedStatus: string; reason: string };

export type PausedAdContext = {
  credentials: MetaCredentials;
  adAccountId: string;
  transport: Transport;
  now: Date;
  leaseMs: number;
};

function fenced(step: string): CreatePausedAdOutcome {
  return {
    status: "in_progress",
    reason: `Another request now holds this operation (${step}), so this request sent nothing. Check again in a few minutes.`,
  };
}

async function readBackAndVerify(
  store: PausedAdStore,
  lease: PausedAdLease,
  op: PausedAdOperation,
  ctx: PausedAdContext,
  adId: string,
  reconciled: boolean,
): Promise<CreatePausedAdOutcome> {
  const read = await readPausedAd(ctx.credentials, adId, { adAccountId: ctx.adAccountId, adSetId: op.adSetId, name: op.name }, ctx.transport);
  if (read.kind === "paused") {
    const verified = await store.verify(lease, { adId, creativeId: read.creativeId });
    if (!verified) {
      return {
        status: "uncertain",
        stage: "ad",
        reason: "Meta created and verified the ad, but its receipt could not be recorded under this request's lease. The next request confirms it by its id.",
      };
    }
    const receipt = receiptOf({ ...op, creativeId: op.creativeId || read.creativeId, adId, verifiedStatus: "PAUSED", state: "verified", leaseToken: null });
    return reconciled
      ? { status: "already_created", receipt, bindingMatches: true, reconciled: true }
      : { status: "created_paused", receipt };
  }
  if (read.kind === "not_paused") {
    await store.markUnexpected(lease, adId, read.status, `Meta reports the ad as ${read.status}, not PAUSED. Meridian did not change it.`);
    return {
      status: "unexpected",
      adId,
      verifiedStatus: read.status,
      reason: `Meta reports this ad as ${read.status}, not PAUSED. Meridian did not change it. Check it in Meta before doing anything else.`,
    };
  }
  if (read.kind === "not_this_object") {
    await store.markUnexpected(lease, adId, "UNVERIFIED", read.reason);
    return { status: "unexpected", adId, verifiedStatus: "UNVERIFIED", reason: `${read.reason} Meridian did not change it.` };
  }
  await store.markUncertain(lease, `The read-back of ad ${adId} did not confirm it: ${read.error}`);
  return { status: "uncertain", stage: "ad", reason: `The read-back did not confirm the ad. ${read.error}` };
}

/** The first attempt of an operation (a claim, a takeover or a reopen). Each create is sent only after the attempt state permitting it is committed. */
export async function runPausedAdAttempt(store: PausedAdStore, lease: PausedAdLease, op: PausedAdOperation, ctx: PausedAdContext): Promise<CreatePausedAdOutcome> {
  // A read-only check, made after the claim so that a takeover cannot send a create on an ad set that was never checked.
  const adSet = await verifyMetaAdSet(ctx.credentials, ctx.adAccountId, op.adSetId, ctx.transport);
  if (!adSet.ok) {
    const reason = `${adSet.error} Nothing was created; correct the ad set and try again.`;
    await store.refuse(lease, reason);
    return { status: "blocked", reason };
  }

  let creativeId = op.creativeId;
  if (creativeId) {
    if (!(await store.beginAd(lease, ctx.now, ctx.leaseMs))) {
      await store.fenced(lease, "begin ad");
      return fenced("ad");
    }
  } else {
    if (!(await store.beginCreative(lease, ctx.now, ctx.leaseMs))) {
      await store.fenced(lease, "begin creative");
      return fenced("creative");
    }
    const creative = await createPausedCreative(
      ctx.credentials,
      { adAccountId: ctx.adAccountId, name: op.name, pageId: op.pageId, videoId: op.videoId, message: op.message, link: op.destinationUrl },
      ctx.transport,
    );
    if (creative.kind === "refused") {
      await store.refuse(lease, creative.error);
      return { status: "refused", reason: creative.error };
    }
    if (creative.kind === "uncertain") {
      await store.markUncertain(lease, creative.error);
      return { status: "uncertain", stage: "creative", reason: creative.error };
    }
    creativeId = creative.id;
    if (!(await store.recordCreative(lease, creativeId))) {
      // The creative exists, but this request no longer holds the lease, so it cannot record it. Reconciliation finds it by name.
      await store.fenced(lease, "record creative");
      return { status: "uncertain", stage: "creative", reason: "Meta created the creative, but this request lost its lease before recording it. The next request finds it by name." };
    }
  }

  const ad = await createPausedAdObject(ctx.credentials, { adAccountId: ctx.adAccountId, adSetId: op.adSetId, creativeId, name: op.name }, ctx.transport);
  if (ad.kind === "refused") {
    await store.refuse(lease, ad.error);
    return { status: "refused", reason: ad.error };
  }
  if (ad.kind === "uncertain") {
    await store.markUncertain(lease, ad.error);
    return { status: "uncertain", stage: "ad", reason: ad.error };
  }
  if (!(await store.recordAdId(lease, ad.id))) {
    await store.fenced(lease, "record ad id");
    return { status: "uncertain", stage: "ad", reason: "Meta returned an ad id, but this request lost its lease before recording it. The next request finds the ad by name." };
  }
  return readBackAndVerify(store, lease, { ...op, creativeId }, ctx, ad.id, false);
}

/** A reconciliation: looks at the whole ad account for this operation's objects. It never creates, and it concludes nothing from a read that did not finish. */
export async function reconcilePausedAd(store: PausedAdStore, lease: PausedAdLease, op: PausedAdOperation, ctx: PausedAdContext): Promise<CreatePausedAdOutcome> {
  if (!op.name) {
    const reason = "This operation has no marker name, so Meridian cannot find its objects. Review the ad account in Meta before any new attempt.";
    await store.markUncertain(lease, reason);
    return { status: "uncertain", stage: "reconcile", reason };
  }
  const lookup = await lookupPausedAdObjects(ctx.credentials, ctx.adAccountId, op.name, ctx.transport);
  if (!lookup.ok) {
    const reason = `Meta's account search did not finish: ${lookup.error} Nothing is treated as absent.`;
    await store.markUncertain(lease, reason);
    return { status: "uncertain", stage: "reconcile", reason };
  }
  if (lookup.ads.length > 1 || lookup.creatives.length > 1) {
    const reason = "More than one object carries this operation's marker name. Meridian does not choose one; review them in Meta.";
    await store.markUncertain(lease, reason);
    return { status: "uncertain", stage: "reconcile", reason };
  }
  const found = lookup.ads[0];
  if (op.adId && found && found.id !== op.adId) {
    const reason = "The ad found by name is not the ad this operation recorded. Meridian does not choose between them; review them in Meta.";
    await store.markUncertain(lease, reason);
    return { status: "uncertain", stage: "reconcile", reason };
  }
  if (lookup.creatives[0] && !op.creativeId) await store.noteCreative(lease, lookup.creatives[0].id);

  const adId = op.adId || found?.id || "";
  if (adId) return readBackAndVerify(store, lease, op, ctx, adId, true);

  // No ad was found. That is a conclusion only once the attempt window has passed and the search has finished.
  const started = op.attemptStartedAt ? Date.parse(op.attemptStartedAt) : Number.NaN;
  if (!Number.isFinite(started) || ctx.now.getTime() < started + PAUSED_AD_ABSENCE_WINDOW_MS) {
    const reason = "The search found no ad yet, and this attempt is too recent to conclude that none was created. Search again later.";
    await store.markUncertain(lease, reason);
    return { status: "uncertain", stage: "reconcile", reason };
  }
  const reason = `A complete search of the ad account found no ad named for this operation (attempt ${op.attempt}). Nothing is retried automatically.`;
  await store.markUncertain(lease, reason, "reconciled_absent");
  return { status: "absent", reason };
}

export async function createRepurposedPausedAd(
  sql: Sql,
  userId: string,
  input: CreatePausedAdInput,
  options: {
    env: { TOKEN_ENCRYPTION_KEY?: string };
    transport?: Transport;
    store?: PausedAdStore;
    now?: () => Date;
  },
): Promise<CreatePausedAdOutcome> {
  const session = await sessionAccess(sql, userId, input.sessionId);
  if (!session.brand_id) return { status: "blocked", reason: "This session has no brand, so no ad account can belong to it." };
  const organizationId = session.organization_id;
  const brandId = session.brand_id;

  const check = pausedAdPreflight(input);
  if (!check.ok) return { status: "blocked", reason: check.reason };

  const found = await sql<{ id: string; status: string }>`
    select v.id, v.status from content_factory_repurpose_variants v
    join content_factory_repurpose_runs r on r.id = v.run_id and r.organization_id = v.organization_id
    where v.organization_id = ${organizationId} and r.session_id = ${session.id} and v.run_id = ${input.runId} and v.variant_key = ${input.variantKey}
    limit 1
  `;
  const variant = found[0];
  if (!variant) throw new Error("That variation is not part of this run.");

  // The reviewer's decision, read as the review screen reads it. The readiness gate then checks the variation's state.
  const reviews = await repurposeReviewsOf(sql, userId, { sessionId: input.sessionId, runId: input.runId });
  const review: RepurposeReviewState = reviews[input.variantKey] ?? { status: "not_decided" };
  const adAccountId = await savedAdAccountId(sql, organizationId, brandId, AD_ACCOUNT_PLATFORM.meta);

  // Only a variation already uploaded to this ad account can become a paused ad. Its upload receipt holds the Meta video id.
  const upload = adAccountId ? await sqlRepurposeUploadStore(sql).find(organizationId, variant.id, adAccountId) : null;
  if (!upload) return { status: "blocked", reason: "Upload this variation to the Meta ad account first. Nothing was created." };
  // The gate checks the variation's state and review. Meta's connection is checked below, with the token, so the gate's own check is passed here.
  const gate = repurposePublishReadiness({
    variantStatus: variant.status as RepurposeVariationStatus,
    review,
    hasStoredVideo: true,
    metaConnected: true,
  });
  if (gate.state === "blocked") return { status: "blocked", reason: gate.reason };

  const pageRows = await sql<{ id: string }>`
    select id from platform_accounts
    where organization_id = ${organizationId} and brand_id = ${brandId} and account_type = 'social_page' and external_account_id = ${input.pageId.trim()}
    limit 1
  `;
  if (pageRows.length === 0) return { status: "blocked", reason: "That Page is not saved for this brand. Save it on Connected accounts first. Nothing was created." };

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
  if (!accessToken || !adAccountId.startsWith("act_")) {
    return { status: "blocked", reason: "Meta is not connected for this brand. Nothing was created." };
  }

  const binding: PausedAdBinding = {
    adAccountId,
    adSetId: input.adSetId.trim(),
    pageId: input.pageId.trim(),
    videoId: upload.externalId,
    destinationUrl: input.destinationUrl.trim(),
    message: input.message,
  };
  const fingerprint = bindingFingerprint(binding);
  const key = pausedAdKey({ brandId, variantId: variant.id, adAccountId });
  const name = operationName({ variantKey: input.variantKey, key, fingerprint });
  const candidate: PausedAdCandidate = {
    brandId,
    variantId: variant.id,
    adAccountId,
    name,
    fingerprint,
    videoId: binding.videoId,
    message: binding.message,
    adSetId: binding.adSetId,
    pageId: binding.pageId,
    destinationUrl: binding.destinationUrl,
  };
  const store = options.store ?? sqlPausedAdStore(sql);
  const now = (options.now ?? (() => new Date()))();
  const acquired = await store.acquire({
    organizationId,
    key,
    candidate,
    token: randomUUID(),
    now,
    leaseMs: PAUSED_AD_LEASE_MS,
    confirmRetry: input.confirmRetryAfterAbsence === true,
  });

  if (acquired.kind === "verified") {
    return {
      status: "already_created",
      receipt: receiptOf(acquired.operation),
      bindingMatches: acquired.operation.fingerprint === fingerprint,
      reconciled: false,
    };
  }
  if (acquired.kind === "in_progress") {
    return {
      status: "in_progress",
      reason: "Another request holds this variation's paused-ad operation, or its last attempt is not confirmed yet. This request sent nothing. Check again in a few minutes.",
    };
  }
  if (acquired.kind === "conflict") {
    return {
      status: "conflict",
      reason: "This variation already has a paused-ad operation with different inputs (ad set, Page, destination or text). Nothing was sent or changed. Use the original inputs.",
    };
  }
  if (acquired.kind === "unexpected") {
    return {
      status: "unexpected",
      adId: acquired.operation.adId,
      verifiedStatus: acquired.operation.verifiedStatus,
      reason: `A paused-ad object for this variation is ${acquired.operation.verifiedStatus || "not verified"} in Meta. Meridian did not change it. Check it in Meta.`,
    };
  }

  const ctx: PausedAdContext = { credentials: { accessToken, adAccountId }, adAccountId, transport: options.transport ?? liveTransport(), now, leaseMs: PAUSED_AD_LEASE_MS };
  try {
    if (acquired.kind === "reconcile") return await reconcilePausedAd(store, acquired.lease, acquired.operation, ctx);
    return await runPausedAdAttempt(store, acquired.lease, acquired.operation, ctx);
  } catch {
    // A database error after an attempt began leaves the state committed before the send. The lease expires, and the next request reconciles.
    return {
      status: "uncertain",
      stage: "reconcile",
      reason: "Meridian could not record a step of this attempt. Nothing is retried now; the next request reconciles it before anything is created.",
    };
  }
}

export type PausedAdChoices =
  | { status: "listed"; adAccountId: string; adSets: MetaAdSetOption[]; pages: { id: string; name: string }[] }
  | { status: "blocked"; reason: string }
  | { status: "failed"; error: string };

/**
 * What the paused-ad form offers: the ad sets of the brand's saved ad account, and the Pages saved for the brand. A read only. Nothing is
 * created, and a list that cannot be read says so instead of showing an empty choice.
 */
export async function listPausedAdChoices(
  sql: Sql,
  userId: string,
  input: { sessionId: string },
  options: { env: { TOKEN_ENCRYPTION_KEY?: string }; transport?: Transport },
): Promise<PausedAdChoices> {
  const session = await sessionAccess(sql, userId, input.sessionId);
  if (!session.brand_id) return { status: "blocked", reason: "This session has no brand, so no ad account can belong to it." };
  const organizationId = session.organization_id;
  const brandId = session.brand_id;
  const adAccountId = await savedAdAccountId(sql, organizationId, brandId, AD_ACCOUNT_PLATFORM.meta);
  if (!adAccountId) return { status: "blocked", reason: "No Meta ad account is saved for this brand. Save one on Connected accounts first." };
  const pages = await sql<{ external_account_id: string; name: string }>`
    select external_account_id, name from platform_accounts
    where organization_id = ${organizationId} and brand_id = ${brandId} and account_type = 'social_page'
      and external_account_id is not null and external_account_id <> ''
    order by name asc
  `;
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
  if (!("token" in opened)) return { status: "blocked", reason: "Meta is not connected for this brand. Nothing was read." };
  const listed = await listMetaAdSets({ accessToken: opened.token, adAccountId }, adAccountId, options.transport ?? liveTransport());
  if (!listed.ok) return { status: "failed", error: listed.error };
  return {
    status: "listed",
    adAccountId,
    adSets: listed.adSets,
    pages: pages.map((row) => ({ id: row.external_account_id, name: row.name })),
  };
}
