// Publishes one reviewed, rights-cleared repurposed variation to a Facebook Page, as an organic video post. It is an explicit action by an
// admin, for one Page the admin chose. It uses the existing Facebook Page channel (distribution/facebook.ts) and the workspace's own connection.
// Publishing never happens as a side effect of approval, upload, rendering, measurement or learning.
//
// One organic publish per variation and Page. A claim is written before Facebook is called, so two requests cannot both publish. A
// successful post is recorded as an organic_posts row, the same record the organic telemetry reads, so measurement uses the existing path.
//
// A lost reply, a rate limit, or a lease that expired during an attempt leaves the operation uncertain. Facebook may have published the
// video, and nothing here can prove it did not. Such an operation is never published again automatically: a later request is refused until the
// person confirms, after checking the Page in Facebook, that they want a second post.

import { randomUUID } from "node:crypto";
import { withTransaction, type Sql } from "../learning/store.ts";
import { FacebookPagesChannel } from "../distribution/facebook.ts";
import { resolveOrganicConnection } from "../distribution/connection.ts";
import type { OrganicConnection } from "../distribution/types.ts";
import { liveTransport, type Transport } from "../providers/http.ts";
import { linkRepurposedVariantCreative, repurposedVariantSource, type RepurposedVariantSource } from "./repurpose-creative.ts";
import { sessionAccess } from "./service.ts";

/** A claim that has not been finished for this long is an attempt whose outcome is unknown. */
export const ORGANIC_LEASE_MS = 10 * 60 * 1000;

export type OrganicLease = { organizationId: string; variantId: string; pageId: string; token: string };

export type OrganicAcquire =
  | { kind: "claimed"; lease: OrganicLease; attempt: number }
  | { kind: "published"; externalId: string; postUrl: string }
  | { kind: "in_progress" }
  | { kind: "uncertain"; reason: string };

export type OrganicStore = {
  acquire(input: {
    organizationId: string;
    brandId: string;
    variantId: string;
    creativeId: string;
    pageId: string;
    createdBy: string;
    token: string;
    now: Date;
    leaseMs: number;
    confirmRetry: boolean;
  }): Promise<OrganicAcquire>;
  markPublished(lease: OrganicLease, post: { creativeId: string; assetId: string; externalId: string; postUrl: string; caption: string; title: string }): Promise<boolean>;
  markUncertain(lease: OrganicLease, reason: string): Promise<boolean>;
  refuse(lease: OrganicLease, reason: string): Promise<boolean>;
};

export function sqlOrganicStore(sql: Sql): OrganicStore {
  return {
    async acquire(input) {
      const expires = new Date(input.now.getTime() + input.leaseMs).toISOString();
      return withTransaction(sql, async (tx) => {
        const inserted = await tx<{ id: string }>`
          insert into content_factory_repurpose_organic_publications (
            id, organization_id, brand_id, variant_id, creative_id, platform, page_id, state, attempt, lease_token, lease_expires_at, created_by
          ) values (
            ${randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.variantId}, ${input.creativeId}, 'facebook', ${input.pageId},
            'claimed', 1, ${input.token}, ${expires}::timestamptz, ${input.createdBy}
          )
          on conflict do nothing
          returning id
        `;
        if (inserted.length > 0) return { kind: "claimed", lease: lease(input), attempt: 1 };

        const rows = await tx<{
          id: string;
          state: string;
          attempt: number;
          lease_token: string | null;
          lease_expires_at: string | Date | null;
          external_id: string;
          post_url: string;
          reason: string;
        }>`
          select id, state, attempt, lease_token, lease_expires_at, external_id, post_url, reason
          from content_factory_repurpose_organic_publications
          where organization_id = ${input.organizationId} and variant_id = ${input.variantId} and platform = 'facebook' and page_id = ${input.pageId}
          for update
        `;
        const row = rows[0];
        if (!row) throw new Error("The organic publish record could not be read. Nothing was sent.");
        if (row.state === "published") return { kind: "published", externalId: row.external_id, postUrl: row.post_url };
        if (row.state === "claimed") {
          const expiry = row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : 0;
          if (expiry > input.now.getTime()) return { kind: "in_progress" };
          // The earlier request may have reached Facebook. It is not sent again: the operation becomes uncertain.
          await tx`
            update content_factory_repurpose_organic_publications
            set state = 'uncertain', reason = 'The earlier attempt did not finish. Facebook may have published the video. Check the Page before any new post.', updated_at = now()
            where id = ${row.id} and state = 'claimed' and attempt = ${row.attempt}
          `;
          return { kind: "uncertain", reason: "The earlier attempt did not finish, so Facebook may have published the video. Check the Page before any new post." };
        }
        if (row.state === "uncertain" && !input.confirmRetry) {
          return { kind: "uncertain", reason: row.reason };
        }
        // A refusal sent nothing, and a confirmed retry of an uncertain attempt has been checked by the person. Either one starts again.
        const reopened = await tx<{ id: string }>`
          update content_factory_repurpose_organic_publications
          set state = 'claimed', attempt = attempt + 1, lease_token = ${input.token}, lease_expires_at = ${expires}::timestamptz,
              reason = '', updated_at = now()
          where id = ${row.id} and state = ${row.state} and attempt = ${row.attempt}
          returning id
        `;
        if (reopened.length === 0) return { kind: "in_progress" };
        return { kind: "claimed", lease: lease(input), attempt: row.attempt + 1 };
      });

      function lease(value: { organizationId: string; variantId: string; pageId: string; token: string }): OrganicLease {
        return { organizationId: value.organizationId, variantId: value.variantId, pageId: value.pageId, token: value.token };
      }
    },

    async markPublished(lease, post) {
      return withTransaction(sql, async (tx) => {
        const rows = await tx<{ brand_id: string }>`
          update content_factory_repurpose_organic_publications
          set state = 'published', external_id = ${post.externalId}, post_url = ${post.postUrl}, lease_token = null, lease_expires_at = null,
              reason = '', updated_at = now()
          where organization_id = ${lease.organizationId} and variant_id = ${lease.variantId} and platform = 'facebook' and page_id = ${lease.pageId}
            and state = 'claimed' and lease_token = ${lease.token}
          returning brand_id
        `;
        if (rows.length === 0) return false;
        // The receipt the organic telemetry reads. It is written in the same transaction, so a published row always has its post.
        await tx`
          insert into organic_posts (
            id, organization_id, brand_id, creative_id, asset_id, platform, external_id, post_url, caption, title, aspect_ratio,
            status, published_at, surface
          ) values (
            ${randomUUID()}, ${lease.organizationId}, ${rows[0]!.brand_id}, ${post.creativeId}, ${post.assetId}, 'facebook',
            ${post.externalId}, ${post.postUrl}, ${post.caption}, ${post.title}, '9:16', 'published', now(), 'organic'
          )
        `;
        return true;
      });
    },

    async markUncertain(lease, reason) {
      const rows = await sql<{ id: string }>`
        update content_factory_repurpose_organic_publications
        set state = 'uncertain', reason = ${reason}, lease_expires_at = null, updated_at = now()
        where organization_id = ${lease.organizationId} and variant_id = ${lease.variantId} and platform = 'facebook' and page_id = ${lease.pageId}
          and state = 'claimed' and lease_token = ${lease.token}
        returning id
      `;
      return rows.length > 0;
    },

    async refuse(lease, reason) {
      const rows = await sql<{ id: string }>`
        update content_factory_repurpose_organic_publications
        set state = 'refused', reason = ${reason}, lease_token = null, lease_expires_at = null, updated_at = now()
        where organization_id = ${lease.organizationId} and variant_id = ${lease.variantId} and platform = 'facebook' and page_id = ${lease.pageId}
          and state = 'claimed' and lease_token = ${lease.token} and external_id = ''
        returning id
      `;
      return rows.length > 0;
    },
  };
}

export type OrganicPublishOutcome =
  | { status: "published"; externalId: string; postUrl: string }
  | { status: "already_published"; externalId: string; postUrl: string }
  | { status: "in_progress"; reason: string }
  | { status: "uncertain"; reason: string }
  | { status: "refused"; reason: string }
  | { status: "blocked"; reason: string };

/** The facts one organic publish needs once the Page, its connection and the media are known. */
export type OrganicPublishRequest = {
  source: RepurposedVariantSource;
  creativeId: string;
  assetId: string;
  pageId: string;
  createdBy: string;
  caption: string;
  title: string;
  mediaBytes: Uint8Array;
  mimeType: string;
  connection: Extract<OrganicConnection, { connected: true }>;
  confirmRetry: boolean;
};

/**
 * Publishes once, through the connection given, and records the result. Lower-level than the action: it does not read the session or the
 * Page, so the tests can drive the claim, the receipt and every failure with a fake Facebook.
 */
export async function publishRepurposedVariantWith(
  request: OrganicPublishRequest,
  deps: { store: OrganicStore; transport: Transport; now?: () => Date; leaseMs?: number },
): Promise<OrganicPublishOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const token = randomUUID();
  const acquired = await deps.store.acquire({
    organizationId: request.source.organizationId,
    brandId: request.source.brandId,
    variantId: request.source.variantId,
    creativeId: request.creativeId,
    pageId: request.pageId,
    createdBy: request.createdBy,
    token,
    now,
    leaseMs: deps.leaseMs ?? ORGANIC_LEASE_MS,
    confirmRetry: request.confirmRetry,
  });
  if (acquired.kind === "published") return { status: "already_published", externalId: acquired.externalId, postUrl: acquired.postUrl };
  if (acquired.kind === "in_progress") {
    return { status: "in_progress", reason: "Another request is publishing this variation to this Page. Nothing was sent. Check again in a few minutes." };
  }
  if (acquired.kind === "uncertain") return { status: "uncertain", reason: acquired.reason };

  const channel = new FacebookPagesChannel({ transport: deps.transport });
  const receipt = await channel.publish({
    brandId: request.source.brandId,
    organizationId: request.source.organizationId,
    creativeId: request.creativeId,
    assetId: request.assetId,
    mediaBytes: request.mediaBytes,
    mimeType: request.mimeType,
    caption: request.caption,
    title: request.title,
    aspectRatio: "9:16",
    allowTestProvider: false,
    connection: request.connection,
  });

  if (receipt.status === "published" && receipt.externalId) {
    const recorded = await deps.store.markPublished(acquired.lease, {
      creativeId: request.creativeId,
      assetId: request.assetId,
      externalId: receipt.externalId,
      postUrl: receipt.postUrl ?? "",
      caption: request.caption,
      title: request.title,
    });
    if (!recorded) {
      return {
        status: "uncertain",
        reason: "Facebook accepted the video, but Meridian could not record it under this request's claim. Check the Page before any new post.",
      };
    }
    return { status: "published", externalId: receipt.externalId, postUrl: receipt.postUrl ?? "" };
  }

  // A rate limit or a missing reply can follow an accepted post, so both are uncertain. A refusal that names a token, a permission or the
  // content is definite: nothing was published, and the operation can be started again.
  const reason = receipt.error ?? "Facebook did not confirm the video.";
  if (receipt.code === "UNCONFIRMED" || receipt.code === "RETRYABLE") {
    await deps.store.markUncertain(acquired.lease, reason);
    return { status: "uncertain", reason };
  }
  await deps.store.refuse(acquired.lease, reason);
  return { status: "refused", reason };
}

/**
 * The action behind "Publish to Facebook Page": checks the variation, links it to the library (once), resolves the Page this workspace
 * connected, and publishes. Admins only. Nothing is sent unless every check passes.
 */
export async function publishRepurposedVariantToFacebookPage(
  sql: Sql,
  userId: string,
  input: { sessionId: string; runId: string; variantKey: string; pageId: string; caption: string; title: string; confirmRetry?: boolean },
  options: {
    transport?: Transport;
    loadMedia: (storageKey: string, organizationId: string, brandId: string) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
    now?: () => Date;
  },
): Promise<OrganicPublishOutcome> {
  const eligible = await repurposedVariantSource(sql, userId, input);
  if (!eligible.ok) return { status: "blocked", reason: eligible.reason };
  const source = eligible.source;

  const pageId = input.pageId.trim();
  if (!/^\d{1,30}$/.test(pageId)) return { status: "blocked", reason: "Choose the Facebook Page to post to. Nothing was sent." };
  const pages = await sql<{ id: string }>`
    select id from platform_accounts
    where organization_id = ${source.organizationId} and brand_id = ${source.brandId} and account_type = 'social_page' and external_account_id = ${pageId}
    limit 1
  `;
  if (pages.length === 0) return { status: "blocked", reason: "That Page is not saved for this brand. Save it on Connected accounts first. Nothing was sent." };

  const connection = await resolveOrganicConnection(sql, { organizationId: source.organizationId, brandId: source.brandId, platform: "facebook", purpose: "publish" });
  if (!connection.connected) return { status: "blocked", reason: connection.reason };
  if (connection.accountId !== pageId) {
    return { status: "blocked", reason: "The Facebook Page connected for this brand is a different Page. Choose that Page, or connect this one. Nothing was sent." };
  }

  const linked = await linkRepurposedVariantCreative(sql, { ...source, createdBy: userId });
  const storage = await sql<{ storage_key: string }>`
    select storage_key from assets where creative_id = ${linked.creativeId} and organization_id = ${source.organizationId} order by version limit 1
  `;
  const media = storage[0] ? await options.loadMedia(storage[0].storage_key, source.organizationId, source.brandId) : null;
  if (!media || media.bytes.byteLength === 0) {
    return { status: "blocked", reason: "The stored video for this variation was not found. Nothing was sent." };
  }

  return publishRepurposedVariantWith(
    {
      source,
      creativeId: linked.creativeId,
      assetId: linked.assetId,
      pageId,
      createdBy: userId,
      caption: input.caption.trim(),
      title: input.title.trim(),
      mediaBytes: media.bytes,
      mimeType: media.mimeType || "video/mp4",
      connection,
      confirmRetry: input.confirmRetry === true,
    },
    { store: sqlOrganicStore(sql), transport: options.transport ?? liveTransport(), now: options.now },
  );
}

/** The stored bytes of a variation's video, read the way the library's own publish reads them (asset-response.ts and the artifact drive). */
export async function loadRepurposedMedia(
  sql: Sql,
  storageKey: string,
  organizationId: string,
  brandId: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const { loadStoredSource } = await import("../storage/asset-response.ts");
  const { defaultArtifactDrive } = await import("../storage/artifact-drive.ts");
  const stored = await loadStoredSource(sql, async () => defaultArtifactDrive(), { storageKey, organizationId, brandId });
  return stored && stored.bytes.byteLength > 0 ? { bytes: stored.bytes, mimeType: stored.mimeType } : null;
}

/**
 * The Facebook Pages a variation can be published to: the Pages saved for the brand, and the one Page the workspace's connection publishes
 * as, if one is connected. Read only. Admins only.
 */
export async function listRepurposeFacebookPages(
  sql: Sql,
  userId: string,
  input: { sessionId: string },
): Promise<{ pages: { id: string; name: string }[]; connectedPageId: string | null; connectedReason: string | null }> {
  const session = await sessionAccess(sql, userId, input.sessionId);
  if (!session.brand_id) return { pages: [], connectedPageId: null, connectedReason: "This session has no brand." };
  const pages = await sql<{ external_account_id: string; name: string }>`
    select external_account_id, name from platform_accounts
    where organization_id = ${session.organization_id} and brand_id = ${session.brand_id} and account_type = 'social_page'
      and external_account_id is not null and external_account_id <> ''
    order by name asc
  `;
  const connection = await resolveOrganicConnection(sql, { organizationId: session.organization_id, brandId: session.brand_id, platform: "facebook", purpose: "read" });
  return {
    pages: pages.map((row) => ({ id: row.external_account_id, name: row.name })),
    connectedPageId: connection.connected ? connection.accountId : null,
    connectedReason: connection.connected ? null : connection.reason,
  };
}
