import type { Sql } from "../learning/store.ts";
import { assertRole, type Role, isRole } from "../access.ts";
import { getDistributionChannel } from "./registry.ts";
import { applyLearnedPatterns } from "../learning/store.ts";
import { publishThrough } from "../providers/boundaries.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import { isOrganicPlatform, resolveOrganicConnection, resolveOrganicConnections } from "./connection.ts";
import type { OrganicPlatform } from "./types.ts";
import type { TrialRequest } from "./trial.ts";
import { recordTrialStep } from "./trial-check.ts";
import { mediaDeliveryFor, signMediaLink, signedMediaUrl } from "../storage/media-link.ts";

export async function requireBrandAccess(
  sql: Sql,
  userId: string,
  brandId: string,
  minimum: Role,
): Promise<{ organizationId: string; role: Role }> {
  const rows = await sql<{ organization_id: string }>`
    select organization_id from brands where id = ${brandId} and deleted_at is null limit 1
  `;
  const organizationId = rows[0]?.organization_id;
  if (!organizationId) throw new Error("Brand not found.");
  const members = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = members[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, minimum);
  return { organizationId, role };
}


export type ChannelDefinition = {
  id: string;
  name: string;
  type: "organic" | "paid";
  platform: "instagram" | "facebook" | "youtube" | "meta" | "tiktok" | "google" | "test";
  description: string;
  connected: boolean;
  accountName?: string;
  /** Why the destination is not connected. Undefined when it is connected. Never a secret. */
  reason?: string;
};

export type PublishMultiChannelInput = {
  organizationId: string;
  brandId: string;
  creativeId: string;
  channelIds: string[];
  caption?: string;
  title?: string;
  scheduledFor?: string;
  userId: string;
  /**
   * Post the Instagram Reel as a trial first (trial.ts). Null or absent is an ordinary publish. A Factory run passes its page's default here,
   * and a person may pass a choice for one post. Other channels ignore it.
   */
  trial?: TrialRequest | null;
};

/**
 * One channel's receipt. `published` and `scheduled` are organic posts the provider confirmed. `paused` is a paid object the
 * provider created with its status PAUSED: it is never live, and it is not an organic publish. `not_connected` means nothing was
 * sent, and the reason says why. It is never counted as published.
 */
export type PublishChannelResult = {
  channelId: string;
  platform: string;
  type: "organic" | "paid";
  surface: "organic" | "paid";
  status: "published" | "scheduled" | "paused" | "not_connected" | "failed";
  externalId?: string;
  url?: string;
  error?: string;
};

export type OrganicPostSummary = {
  id: string;
  creativeId: string;
  platform: string;
  externalId: string;
  postUrl: string;
  caption: string;
  title: string;
  status: string;
  scheduledFor: string | null;
  publishedAt: string | null;
  createdAt: string;
  // A metric the platform did not report is null. It is never shown or summed as zero.
  views: number | null;
  threeSecondViews: number | null;
  completionRate: number | null;
  shares: number | null;
  likes: number | null;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** A stored metric, or null when it was never reported. Zero is a value, so it stays zero. */
function asMetric(value: unknown): number | null {
  if (value == null) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Returns all supported distribution channels alongside real connection status for a brand.
 * Does not invent connected states.
 */
export async function listAvailableChannels(
  sql: Sql,
  organizationId: string,
  brandId: string,
): Promise<ChannelDefinition[]> {
  // Paid ad connections are provider_connections rows. A healthy connection is stored as HEALTHY or CONNECTED, the two states
  // readiness.ts counts as connected. Any other status is not connected.
  const adAccounts = await sql<Record<string, unknown>>`
    select provider, account_name, status
    from provider_connections
    where organization_id = ${organizationId} and status in ('CONNECTED', 'HEALTHY')
  `;
  const paidByProvider = new Map<string, string>();
  for (const row of adAccounts) {
    paidByProvider.set(asText(row.provider), asText(row.account_name));
  }

  // Organic connections are platform_accounts rows whose token is in the vault. The publisher resolves the same way, so the
  // list and a publish cannot disagree about whether an account is connected.
  const organic = await resolveOrganicConnections(sql, { organizationId, brandId });
  const organicState = (platform: OrganicPlatform): Pick<ChannelDefinition, "connected" | "accountName" | "reason"> => {
    const state = organic[platform];
    return state.connected
      ? { connected: true, accountName: state.accountName, reason: undefined }
      : { connected: false, accountName: undefined, reason: state.reason };
  };
  // A channel that publishes by URL (Instagram, TikTok) is connected only when its signed media link can be delivered. A missing
  // secret, origin, or unverified TikTok domain shows not connected, with the reason.
  const byUrlState = (platform: "instagram" | "tiktok", state: Pick<ChannelDefinition, "connected" | "accountName" | "reason">) => {
    if (!state.connected) return state;
    const delivery = mediaDeliveryFor(platform);
    return delivery.ready ? state : { connected: false, accountName: undefined, reason: delivery.reason };
  };
  const paidReason = (label: string) => `No ${label} account is connected for this workspace. Connect it on the Integrations screen.`;

  return [
    // Paid Ad Channels
    {
      id: "test-publisher",
      name: "Test Ad Publisher",
      type: "paid",
      platform: "test",
      description: "Deterministic sandbox publisher for automated tests and safe preview validation.",
      connected: isTestingRuntimeNow(),
      accountName: isTestingRuntimeNow() ? "Test Sandbox Ad Account" : "Not available outside the testing runtime",
      reason: isTestingRuntimeNow() ? undefined : "The test publisher runs only in the testing runtime.",
    },
    {
      id: "meta-ads",
      name: "Meta Ads (Instagram & Facebook)",
      type: "paid",
      platform: "meta",
      description: "Direct-response paid advertising campaigns across Facebook & Instagram Feeds and Stories.",
      connected: paidByProvider.has("meta"),
      accountName: paidByProvider.get("meta"),
      reason: paidByProvider.has("meta") ? undefined : paidReason("Meta ad"),
    },
    {
      id: "tiktok-ads",
      name: "TikTok Ads",
      type: "paid",
      platform: "tiktok",
      description: "Paid direct-response in-feed video ads with Spark Ads and objective tracking.",
      connected: paidByProvider.has("tiktok"),
      accountName: paidByProvider.get("tiktok"),
      reason: paidByProvider.has("tiktok") ? undefined : paidReason("TikTok ad"),
    },
    {
      id: "google-ads",
      name: "Google Ads (YouTube Video Action)",
      type: "paid",
      platform: "google",
      description: "Targeted video action and Performance Max placements.",
      connected: paidByProvider.has("google"),
      accountName: paidByProvider.get("google"),
      reason: paidByProvider.has("google") ? undefined : paidReason("Google Ads"),
    },
    // Organic Social Channels
    {
      id: "instagram-reels",
      name: "Instagram Reels",
      type: "organic",
      platform: "instagram",
      description: "Full-screen vertical short-form organic video (9:16) with captions and hashtag targeting.",
      ...byUrlState("instagram", organicState("instagram")),
    },
    {
      id: "facebook-pages",
      name: "Facebook Page & Reels",
      type: "organic",
      platform: "facebook",
      description: "Organic feed videos and Reels distributed to page followers and algorithmic recommendations.",
      ...organicState("facebook"),
    },
    {
      id: "youtube-shorts",
      name: "YouTube Shorts",
      type: "organic",
      platform: "youtube",
      description: "Organic short-form vertical video (<=60s) published to the brand's official YouTube channel.",
      ...organicState("youtube"),
    },
    {
      id: "tiktok-organic",
      name: "TikTok (regular video)",
      type: "organic",
      platform: "tiktok",
      description: "Organic MP4 or MOV video posted to the brand's TikTok account. Posts stay private until TikTok approves the app for public posting.",
      ...byUrlState("tiktok", organicState("tiktok")),
    },
  ];
}

/** Records a channel that was not connected, or could not be given a link, as a not_connected receipt. It is never counted as published. */
async function recordNotConnectedPost(
  sql: Sql,
  row: { organizationId: string; brandId: string; creativeId: string; assetId: string | null; platform: string; caption: string; title: string; error: string },
): Promise<void> {
  await sql`
    insert into organic_posts (
      id, organization_id, brand_id, creative_id, asset_id, platform, external_id, post_url, caption, title, aspect_ratio,
      status, scheduled_for, published_at, error, surface
    ) values (
      ${globalThis.crypto.randomUUID()}, ${row.organizationId}, ${row.brandId}, ${row.creativeId}, ${row.assetId},
      ${row.platform}, null, null, ${row.caption}, ${row.title}, '9:16', 'not_connected', null, null, ${row.error}, 'organic'
    )
  `;
}

/**
 * Publishes an approved creative to any combination of user-selected channels.
 * Paid and organic channels are dispatched selectively: users choose where to publish,
 * with no mandatory accounts.
 */
export async function publishCreativeToChannels(
  sql: Sql,
  input: PublishMultiChannelInput,
): Promise<PublishChannelResult[]> {
  const access = await requireBrandAccess(sql, input.userId, input.brandId, "member");

  if (input.channelIds.length === 0) {
    throw new Error("Select at least one destination channel (paid or organic).");
  }

  const creatives = await sql<{ status: string; title: string; hook: string; raw_text: string }>`
    select status, title, hook, raw_text from creative_records
    where id = ${input.creativeId} and brand_id = ${input.brandId} and organization_id = ${access.organizationId}
    limit 1
  `;
  if (!creatives[0]) throw new Error("Variant creative not found.");
  if (creatives[0].status !== "approved" && creatives[0].status !== "testing") {
    throw new Error("Publish only an approved variant.");
  }

  const assets = await sql<{ id: string; storage_key: string; mime_type: string; kind: string }>`
    select id, storage_key, mime_type, kind from assets
    where creative_id = ${input.creativeId} and organization_id = ${access.organizationId}
    order by created_at desc limit 1
  `;
  const asset = assets[0];
  const results: PublishChannelResult[] = [];

  const caption = input.caption?.trim() || creatives[0].raw_text || creatives[0].title || "";
  const title = input.title?.trim() || creatives[0].title || "Meridian Creative";

  for (const channelId of input.channelIds) {
    // 1. Paid Channels
    if (channelId === "test-publisher" || channelId === "test") {
      const existing = await sql<{ external_id: string }>`
        select external_id from provider_objects
        where organization_id = ${access.organizationId} and provider = 'test' and object_type = 'ad' and idempotency_key = ${input.creativeId}
        limit 1
      `;
      let extId = existing[0]?.external_id;
      if (!extId) {
        if (!isTestingRuntimeNow()) {
          throw new Error("The test publisher runs only in the testing runtime. Connect a live channel to publish.");
        }
        const published = publishThrough({ provider: "test", creativeId: input.creativeId, allowTestProvider: true });
        extId = published.externalId ?? "";
        // The test ad is created paused, the same as a live paid object. Nothing here switches it on.
        await sql`
          insert into provider_objects (
            id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status, surface
          ) values (
            ${globalThis.crypto.randomUUID()}, ${access.organizationId}, ${input.brandId}, 'test', 'ad', ${input.creativeId},
            ${extId}, 'paused', 'paid'
          )
        `;
      }
      results.push({
        channelId: "test-publisher",
        platform: "test",
        type: "paid",
        surface: "paid",
        status: "paused",
        externalId: extId,
        url: extId ? `https://ads.test.meridian.internal/campaigns/${extId}` : undefined,
      });
      continue;
    }

    if (channelId === "meta-ads" || channelId === "tiktok-ads" || channelId === "google-ads") {
      // A live paid account is not connected for this workspace in this build, so nothing is sent. The receipt says so.
      results.push({
        channelId,
        platform: channelId.replace("-ads", ""),
        type: "paid",
        surface: "paid",
        status: "not_connected",
        error: `No live ${channelId.replace("-ads", "")} ad account connected. Connect credentials in Settings.`,
      });
      continue;
    }

    // 2. Organic Channels
    const organicChannel = getDistributionChannel(channelId);
    if (!organicChannel) {
      results.push({
        channelId,
        platform: "unknown",
        type: "organic",
        surface: "organic",
        status: "failed",
        error: `Channel "${channelId}" is not a recognized distribution destination.`,
      });
      continue;
    }

    const scheduledDate = input.scheduledFor ? new Date(input.scheduledFor) : undefined;

    // The connection is resolved first, for this brand. A channel with no usable connection records not_connected with its reason,
    // before any media is read, and no request is sent. It is never counted as published.
    const connection = isOrganicPlatform(organicChannel.platform)
      ? await resolveOrganicConnection(sql, { organizationId: access.organizationId, brandId: input.brandId, platform: organicChannel.platform })
      : undefined;
    const check = organicChannel.checkConnection(connection);
    if (!check.connected) {
      const error = check.reason ?? "This channel is not connected. Nothing was sent.";
      await recordNotConnectedPost(sql, {
        organizationId: access.organizationId,
        brandId: input.brandId,
        creativeId: input.creativeId,
        assetId: asset?.id ?? null,
        platform: organicChannel.platform,
        caption,
        title,
        error,
      });
      results.push({
        channelId,
        platform: organicChannel.platform,
        type: "organic",
        surface: "organic",
        status: "not_connected",
        error,
      });
      continue;
    }

    if (!asset) {
      results.push({
        channelId,
        platform: organicChannel.platform,
        type: "organic",
        surface: "organic",
        status: "failed",
        error: "Missing video asset for creative. Stored artifact required for publishing.",
      });
      continue;
    }

    // A channel that publishes by URL gets a signed, short-lived link to this approved creative. The platform fetches the file through
    // the link, so the link is the only thing sent. When no link can be delivered, nothing is sent and the receipt says why. The link is
    // never stored or logged.
    let mediaUrl: string | undefined;
    let verifiedMediaDomains: string[] | undefined;
    if (organicChannel.platform === "instagram" || organicChannel.platform === "tiktok") {
      const delivery = mediaDeliveryFor(organicChannel.platform);
      if (!delivery.ready) {
        await recordNotConnectedPost(sql, {
          organizationId: access.organizationId,
          brandId: input.brandId,
          creativeId: input.creativeId,
          assetId: asset.id,
          platform: organicChannel.platform,
          caption,
          title,
          error: delivery.reason,
        });
        results.push({ channelId, platform: organicChannel.platform, type: "organic", surface: "organic", status: "not_connected", error: delivery.reason });
        continue;
      }
      const signed = signMediaLink({ creativeId: input.creativeId, nowSeconds: Math.floor(Date.now() / 1000), secret: delivery.secret });
      mediaUrl = signedMediaUrl({ origin: delivery.origin, creativeId: input.creativeId, expires: signed.expires, sig: signed.sig });
      verifiedMediaDomains = delivery.verifiedDomains;
    }

    let mediaBytes: Uint8Array | null = null;
    try {
      // The bytes live in Postgres (asset_blobs) or in Google Drive, located by the storage_objects row. This is the same read a
      // download makes, so a publish sends the file that the person can see.
      const { loadStoredSource } = await import("../storage/asset-response.ts");
      const { defaultArtifactDrive } = await import("../storage/artifact-drive.ts");
      const stored = await loadStoredSource(sql, async () => defaultArtifactDrive(), {
        storageKey: asset.storage_key,
        organizationId: access.organizationId,
        brandId: input.brandId,
      });
      if (stored && stored.bytes.byteLength > 0) mediaBytes = stored.bytes;
    } catch {
      // storage unavailable
    }

    if (!mediaBytes || mediaBytes.byteLength === 0) {
      results.push({
        channelId,
        platform: organicChannel.platform,
        type: "organic",
        surface: "organic",
        status: "failed",
        error: "Stored media artifact bytes not found. Cannot publish empty or placeholder media.",
      });
      continue;
    }

    try {
      // The channel receives the connection the service resolved above. It never reads a token itself.
      const publishReceipt = await organicChannel.publish({
        brandId: input.brandId,
        organizationId: access.organizationId,
        creativeId: input.creativeId,
        assetId: asset.id,
        mediaBytes,
        mimeType: asset.mime_type || "video/mp4",
        caption,
        title,
        scheduledFor: scheduledDate ? scheduledDate.toISOString() : undefined,
        aspectRatio: "9:16",
        allowTestProvider: false,
        connection,
        mediaUrl,
        verifiedMediaDomains,
        trial: organicChannel.platform === "instagram" ? (input.trial ?? null) : null,
      });

      // A channel that reports NOT_CONNECTED sent nothing, for example Instagram without a public media URL. That is a not_connected
      // receipt, not a failed publish.
      const receiptStatus = publishReceipt.code === "NOT_CONNECTED" ? "not_connected" : publishReceipt.status;
      const postId = globalThis.crypto.randomUUID();
      await sql`
        insert into organic_posts (
          id, organization_id, brand_id, creative_id, asset_id, platform, external_id,
          post_url, caption, title, aspect_ratio, status, scheduled_for, published_at, error, surface
        ) values (
          ${postId}, ${access.organizationId}, ${input.brandId}, ${input.creativeId},
          ${asset?.id ?? null}, ${publishReceipt.platform}, ${publishReceipt.externalId || null},
          ${publishReceipt.postUrl || null}, ${caption}, ${title}, '9:16',
          ${receiptStatus}, ${scheduledDate ? scheduledDate.toISOString() : null},
          ${receiptStatus === "published" ? new Date().toISOString() : null},
          ${publishReceipt.error || null}, 'organic'
        )
      `;

      // A published trial step is recorded with its media id, so the scheduled check can read the same reel later. A failure to record it
      // is reported on the result: the post is already live, and nothing is hidden.
      let trialNote = "";
      if (publishReceipt.trial && receiptStatus === "published" && publishReceipt.externalId) {
        try {
          await recordTrialStep(sql, {
            organizationId: access.organizationId,
            brandId: input.brandId,
            organicPostId: postId,
            mediaId: publishReceipt.externalId,
            graduationStrategy: publishReceipt.trial.graduationStrategy,
          });
        } catch (trialError) {
          trialNote = `The trial reel was published, but its feed check could not be scheduled: ${trialError instanceof Error ? trialError.message : String(trialError)}`;
        }
      }

      results.push({
        channelId,
        platform: publishReceipt.platform,
        type: "organic",
        surface: "organic",
        status: receiptStatus,
        externalId: publishReceipt.externalId,
        url: publishReceipt.postUrl,
        error: publishReceipt.error || trialNote || undefined,
      });
    } catch (err) {
      results.push({
        channelId,
        platform: organicChannel.platform,
        type: "organic",
        surface: "organic",
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // If any channel succeeded, transition creative and asset. A paused paid ad counts: the creative has been sent to a channel.
  const anySuccess = results.some((r) => r.status === "published" || r.status === "scheduled" || r.status === "paused");
  if (anySuccess) {
    await sql`update creative_records set status = 'testing', updated_at = now() where id = ${input.creativeId}`;
    await sql`
      update assets set lifecycle = 'published', review_status = 'published'
      where creative_id = ${input.creativeId} and organization_id = ${access.organizationId}
    `;
  }

  return results;
}

/**
 * Returns all organic posts and their telemetry metrics for a brand.
 */
export async function listOrganicPosts(
  sql: Sql,
  organizationId: string,
  brandId: string,
): Promise<OrganicPostSummary[]> {
  const posts = await sql<Record<string, unknown>>`
    select p.id, p.creative_id, p.platform, p.external_id, p.post_url, p.caption, p.title,
           p.status, p.scheduled_for, p.published_at, p.created_at,
           o.views, o.three_second_views, o.completion_rate, o.shares, o.likes
    from organic_posts p
    left join lateral (
      select views, three_second_views, completion_rate, shares, likes
      from organic_observations
      where organic_post_id = p.id
      order by created_at desc
      limit 1
    ) o on true
    where p.brand_id = ${brandId} and p.organization_id = ${organizationId}
    order by p.created_at desc
  `;

  return posts.map((row) => ({
    id: asText(row.id),
    creativeId: asText(row.creative_id),
    platform: asText(row.platform),
    externalId: asText(row.external_id),
    postUrl: asText(row.post_url),
    caption: asText(row.caption),
    title: asText(row.title),
    status: asText(row.status),
    scheduledFor: row.scheduled_for ? asText(row.scheduled_for) : null,
    publishedAt: row.published_at ? asText(row.published_at) : null,
    createdAt: asText(row.created_at),
    views: asMetric(row.views),
    threeSecondViews: asMetric(row.three_second_views),
    completionRate: asMetric(row.completion_rate),
    shares: asMetric(row.shares),
    likes: asMetric(row.likes),
  }));
}

/**
 * Counts the real (not synthetic, not simulated) organic observations, then runs applyLearnedPatterns so the feedback loop
 * trains from them. It writes no observation of its own: `recorded` is the count already stored, not a count of new rows.
 */
export async function recordOrganicTelemetryAndLearn(
  sql: Sql,
  organizationId: string,
  brandId: string,
  userId: string,
): Promise<{ recorded: number; learnedPatterns: number }> {
  await requireBrandAccess(sql, userId, brandId, "member");

  const publishedPosts = await sql<{ id: string; creative_id: string; platform: string; post_url: string | null }>`
    select id, creative_id, platform, post_url from organic_posts
    where brand_id = ${brandId} and organization_id = ${organizationId} and status = 'published'
  `;

  if (publishedPosts.length === 0) {
    throw new Error("Publish an organic post before recording telemetry.");
  }

  // Check for real non-synthetic observations; never fabricate numbers
  const realObservations = await sql<{ id: string }>`
    select id from organic_observations
    where brand_id = ${brandId}
      and organization_id = ${organizationId}
      and (raw_metrics->>'synthetic' is null or raw_metrics->>'synthetic' != 'true')
      and (raw_metrics->>'simulated' is null or raw_metrics->>'simulated' != 'true')
  `;

  const learnedCount = await applyLearnedPatterns(sql, organizationId, brandId);
  return { recorded: realObservations.length, learnedPatterns: learnedCount };
}
