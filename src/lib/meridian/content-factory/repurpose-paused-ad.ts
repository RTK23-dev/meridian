// Creates a PAUSED Meta ad from a repurposed variation that was uploaded to the brand's ad account, inside the ad set the person chose and
// confirmed. It creates a paused ad only. Activation is not in this file: an ad set or ad is never switched on here.
//
// Order of work, so that two requests cannot both reach Meta:
// 1. The person's choices are checked (confirmation, Page, link, ad text).
// 2. The variation, its review, its upload and the Page are checked on the server.
// 3. A claim is written to the database BEFORE Meta is called. The table allows one claim per variation and ad account, so a second
//    concurrent request reports "in progress" and sends nothing. A claim whose lease has expired may be taken over.
// 4. Meta is called. A receipt is written only after Meta returned the ad's id and a read-back showed it as PAUSED.
// 5. A definite refusal by Meta (nothing created) releases the claim. Anything uncertain keeps it, so the next attempt reconciles by name
//    rather than creating a second ad.

import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { liveTransport, type Transport } from "../providers/http.ts";
import { AD_ACCOUNT_PLATFORM, savedAdAccountId } from "../providers/ad-account.ts";
import { providerAccessToken } from "../providers/access-token.ts";
import { createMetaPausedAd, listMetaAdSets, type MetaAdSetOption, type PausedAdOutcome } from "../providers/meta-paused-ad.ts";
import { sessionAccess } from "./service.ts";
import { repurposePublishReadiness } from "./repurpose-publish.ts";
import { sqlRepurposeUploadStore } from "./repurpose-upload.ts";
import type { RepurposeVariationStatus } from "./repurpose.ts";
import { repurposeReviewsOf, type RepurposeReviewState } from "./repurpose-review.ts";

/** A claim that has not been confirmed for this long may be taken over. Meta answers well inside this window. */
export const PAUSED_AD_LEASE_MS = 10 * 60 * 1000;

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

export type PausedAdClaim = {
  key: string;
  organizationId: string;
  brandId: string;
  variantId: string;
  adAccountId: string;
  adSetId: string;
  pageId: string;
  destinationUrl: string;
};

export type PausedAdClaimResult =
  | { kind: "claimed" }
  | { kind: "in_progress" }
  | { kind: "verified"; receipt: PausedAdReceipt };

/** The paused-ad receipts and claims (migrations 0127 and 0128). One row per variation and ad account, enforced by the table. */
export type PausedAdStore = {
  claim(claim: PausedAdClaim, now: Date): Promise<PausedAdClaimResult>;
  complete(key: string, receipt: PausedAdReceipt): Promise<void>;
  release(key: string): Promise<void>;
  find(variantId: string, adAccountId: string): Promise<PausedAdReceipt | null>;
};

/** The key of one paused ad: the brand, the variation and the ad account. The ad set is not part of it, by the one-per-account rule. */
export function pausedAdKey(input: { brandId: string; variantId: string; adAccountId: string }): string {
  return `${input.brandId}:${input.variantId}:${input.adAccountId}:meta_paused_ad`;
}

type PausedRow = {
  id: string;
  organization_id: string;
  brand_id: string;
  variant_id: string;
  platform_account_id: string;
  ad_set_id: string | null;
  page_id: string | null;
  destination_url: string | null;
  meta_creative_id: string | null;
  external_id: string;
  verified_status: string | null;
  state: string;
};

function receiptOf(row: PausedRow): PausedAdReceipt | null {
  if (row.state !== "verified" || row.verified_status !== "PAUSED") return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    brandId: row.brand_id,
    variantId: row.variant_id,
    adAccountId: row.platform_account_id,
    adSetId: row.ad_set_id ?? "",
    pageId: row.page_id ?? "",
    destinationUrl: row.destination_url ?? "",
    creativeId: row.meta_creative_id ?? "",
    adId: row.external_id,
    verifiedStatus: "PAUSED",
  };
}

export function sqlPausedAdStore(sql: Sql): PausedAdStore {
  return {
    async claim(claim, now) {
      const id = `pad_${createHash("sha256").update(claim.key).digest("hex").slice(0, 24)}`;
      const iso = now.toISOString();
      const inserted = await sql<{ id: string }>`
        insert into content_factory_repurpose_publications (
          id, organization_id, brand_id, variant_id, platform, kind, platform_account_id, external_id, idempotency_key,
          ad_set_id, page_id, destination_url, state, claimed_at
        ) values (
          ${id}, ${claim.organizationId}, ${claim.brandId}, ${claim.variantId}, 'meta', 'meta_paused_ad', ${claim.adAccountId}, '',
          ${claim.key}, ${claim.adSetId}, ${claim.pageId}, ${claim.destinationUrl}, 'pending', ${iso}::timestamptz
        )
        on conflict do nothing
        returning id
      `;
      if (inserted.length > 0) return { kind: "claimed" };

      const rows = await sql<PausedRow>`
        select id, organization_id, brand_id, variant_id, platform_account_id, ad_set_id, page_id, destination_url,
               meta_creative_id, external_id, verified_status, state
        from content_factory_repurpose_publications
        where variant_id = ${claim.variantId} and platform_account_id = ${claim.adAccountId} and kind = 'meta_paused_ad'
        limit 1
      `;
      const row = rows[0];
      if (!row) return { kind: "in_progress" };
      const receipt = receiptOf(row);
      if (receipt) return { kind: "verified", receipt };

      // A pending claim whose lease has expired is taken over. Only one request can win this update.
      const expiredBefore = new Date(now.getTime() - PAUSED_AD_LEASE_MS).toISOString();
      const taken = await sql<{ id: string }>`
        update content_factory_repurpose_publications
        set claimed_at = ${iso}::timestamptz, ad_set_id = ${claim.adSetId}, page_id = ${claim.pageId}, destination_url = ${claim.destinationUrl}
        where id = ${row.id} and state = 'pending' and claimed_at < ${expiredBefore}::timestamptz
        returning id
      `;
      return taken.length > 0 ? { kind: "claimed" } : { kind: "in_progress" };
    },
    async complete(key, receipt) {
      const rows = await sql<{ id: string }>`
        update content_factory_repurpose_publications
        set state = 'verified', external_id = ${receipt.adId}, meta_creative_id = ${receipt.creativeId},
            ad_set_id = ${receipt.adSetId}, page_id = ${receipt.pageId}, destination_url = ${receipt.destinationUrl},
            verified_status = 'PAUSED', claimed_at = null
        where idempotency_key = ${key} and state = 'pending'
        returning id
      `;
      if (rows.length !== 1) throw new Error("The paused-ad claim was no longer pending when its result was recorded.");
    },
    async release(key) {
      await sql`delete from content_factory_repurpose_publications where idempotency_key = ${key} and state = 'pending'`;
    },
    async find(variantId, adAccountId) {
      const rows = await sql<PausedRow>`
        select id, organization_id, brand_id, variant_id, platform_account_id, ad_set_id, page_id, destination_url,
               meta_creative_id, external_id, verified_status, state
        from content_factory_repurpose_publications
        where variant_id = ${variantId} and platform_account_id = ${adAccountId} and kind = 'meta_paused_ad'
        limit 1
      `;
      return rows[0] ? receiptOf(rows[0]) : null;
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
  | { status: "already_created"; receipt: PausedAdReceipt }
  | { status: "in_progress"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "uncertain"; stage: "creative" | "ad"; error: string }
  | { status: "failed"; error: string }
  | { status: "not_paused"; adId: string; verifiedStatus: string };

export async function createRepurposedPausedAd(
  sql: Sql,
  userId: string,
  input: CreatePausedAdInput,
  options: {
    env: { TOKEN_ENCRYPTION_KEY?: string };
    transport?: Transport;
    store?: PausedAdStore;
    createAd?: typeof createMetaPausedAd;
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
  const upload = adAccountId ? await sqlRepurposeUploadStore(sql).find(variant.id, adAccountId) : null;
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

  // The claim is written before Meta is called. Only one request can hold it for this variation and ad account.
  const store = options.store ?? sqlPausedAdStore(sql);
  const key = pausedAdKey({ brandId, variantId: variant.id, adAccountId });
  const claim = await store.claim(
    {
      key,
      organizationId,
      brandId,
      variantId: variant.id,
      adAccountId,
      adSetId: input.adSetId.trim(),
      pageId: input.pageId.trim(),
      destinationUrl: input.destinationUrl.trim(),
    },
    (options.now ?? (() => new Date()))(),
  );
  if (claim.kind === "verified") return { status: "already_created", receipt: claim.receipt };
  if (claim.kind === "in_progress") {
    return {
      status: "in_progress",
      reason: "Another attempt for this variation is running, or its last attempt is not confirmed yet. This request sent nothing. Check again in a few minutes.",
    };
  }

  // The name carries a hash of the key, so an attempt that lost its reply finds its own ad by name rather than making another.
  const name = `Repurposed ${input.variantKey} [Meridian:${createHash("sha256").update(key).digest("hex").slice(0, 32)}]`;
  const createAd = options.createAd ?? createMetaPausedAd;
  const outcome: PausedAdOutcome = await createAd(
    { accessToken, adAccountId },
    {
      adAccountId,
      adSetId: input.adSetId.trim(),
      pageId: input.pageId.trim(),
      videoId: upload.externalId,
      link: input.destinationUrl.trim(),
      message: input.message,
      name,
    },
    options.transport ?? liveTransport(),
  );

  if (outcome.status === "paused") {
    const receipt: PausedAdReceipt = {
      id: `pad_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
      organizationId,
      brandId,
      variantId: variant.id,
      adAccountId,
      adSetId: outcome.adSetId,
      pageId: input.pageId.trim(),
      destinationUrl: input.destinationUrl.trim(),
      creativeId: outcome.creativeId,
      adId: outcome.adId,
      verifiedStatus: "PAUSED",
    };
    try {
      await store.complete(key, receipt);
    } catch {
      // Meta created and verified the ad, but the receipt was not written. The claim stays pending, so the next attempt finds the ad by name.
      return {
        status: "uncertain",
        stage: "ad",
        error: "Meta created and verified the ad, but Meridian could not record it. The next attempt finds it by name, so nothing is created twice.",
      };
    }
    return { status: "created_paused", receipt };
  }
  if (outcome.status === "uncertain") {
    return { status: "uncertain", stage: outcome.stage, error: outcome.error };
  }
  if (outcome.status === "not_paused") {
    // The ad exists and is not paused. The claim stays pending, so no second ad is created by a retry.
    return { status: "not_paused", adId: outcome.adId, verifiedStatus: outcome.verifiedStatus };
  }
  // Nothing was created: a definite refusal or a blocked check. The claim is released so a corrected request can run.
  await store.release(key);
  if (outcome.status === "blocked") return { status: "blocked", reason: outcome.reason };
  return { status: "failed", error: outcome.error };
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
