import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";
import { startOperation, redactSecrets } from "../observability/redact.ts";
import type { Transport } from "./http.ts";
import type { PausedStage } from "./live.ts";

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function list(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clip(item, 80)).filter(Boolean).slice(0, max);
}

export type PublishView = {
  correlationId: string;
  detail: string;
  stages: { objectType: string; status: string; externalId: string | null; detail: string }[];
};

/** Admin-only paused publish. Ids are loaded from this brand and stored only when the provider confirms them. */
export async function publishPausedForBrand(
  sql: Awaited<ReturnType<typeof getSql>>,
  input: {
    organizationId: string;
    brandId: string;
    actorId: string;
    provider: "meta" | "tiktok" | "google";
    creativeId: string;
    name: string;
    dailyBudgetCents: number;
    countries: string[];
    locationIds: string[];
    pageId: string;
    link: string;
    message: string;
    scheduleStart: string;
    imageIds: string[];
    videoId: string;
    headlines: string[];
    descriptions: string[];
    cpcBidCents: number;
    env?: NodeJS.ProcessEnv;
    transport?: Transport;
  },
): Promise<PublishView> {
  const { liveTransport } = await import("./http.ts");
  const { publishPausedStages } = await import("./live.ts");
  const { stageWrites } = await import("./stages.ts");
  const { providerAccessToken } = await import("./access-token.ts");
  const { AD_ACCOUNT_LABEL, AD_ACCOUNT_PLATFORM, savedAdAccountId } = await import("./ad-account.ts");
  const operation = startOperation({
    provider: input.provider,
    operation: "publishing.paused",
    organizationId: input.organizationId,
    brandId: input.brandId,
  });
  const env = input.env ?? process.env;
  const secrets = await sql<{ sealed_token: string; sealed_refresh: string; expires_at: string | null }>`
    select sealed_token, sealed_refresh, expires_at from provider_secrets
    where organization_id = ${input.organizationId} and provider = ${input.provider}
    limit 1
  `;
  // The sealed OAuth token, or the workspace's saved key through the resolver. Environment tokens are not read. A sealed token past its expiry is refused.
  const opened = await providerAccessToken(sql, {
    organizationId: input.organizationId,
    provider: input.provider,
    sealed: secrets[0]?.sealed_token ?? "",
    encryptionKey: env.TOKEN_ENCRYPTION_KEY ?? "",
    env,
    expiresAt: secrets[0]?.expires_at ? new Date(secrets[0].expires_at).toISOString() : null,
    hasRefresh: (secrets[0]?.sealed_refresh ?? "").trim() !== "",
  });
  if ("error" in opened) {
    const record = operation.finish(false, 0, opened.error);
    const notConnected = input.provider === "meta";
    return {
      correlationId: String(record.correlationId),
      detail: opened.error,
      stages: notConnected ? [{ objectType: "video", status: "NOT_CONNECTED", externalId: null, detail: opened.error }] : [],
    };
  }
  // Every publish goes to the brand's saved ad account on Connected accounts, the account the performance sync reads. No environment id is used.
  const adAccountId = await savedAdAccountId(sql, input.organizationId, input.brandId, AD_ACCOUNT_PLATFORM[input.provider]);
  if (!adAccountId) {
    const reason = `No ${AD_ACCOUNT_LABEL[input.provider]} ad account is saved for this brand. Add it on Connected accounts. Nothing was sent.`;
    const record = operation.finish(false, 0, reason);
    return { correlationId: String(record.correlationId), detail: reason, stages: [] };
  }
  const disconnected = await sql<{ disconnected_at: string | null }>`
    select disconnected_at from provider_connections
    where organization_id = ${input.organizationId} and provider = ${input.provider}
    limit 1
  `;
  if (disconnected[0]?.disconnected_at) {
    const record = operation.finish(false, 0, "disconnected");
    return {
      correlationId: String(record.correlationId),
      detail: "That provider is disconnected. Nothing was sent.",
      stages: [],
    };
  }
  const stored = await sql<{ organization_id: string; idempotency_key: string; external_id: string }>`
    select organization_id, idempotency_key, external_id from provider_objects
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and provider = ${input.provider}
  `;
  const prefix = `${input.brandId}:${input.creativeId}:`;
  const existing: Record<string, string> = {};
  for (const row of stored) {
    if (row.organization_id !== input.organizationId) throw new Error("That external id belongs to another workspace.");
    if (row.idempotency_key.startsWith(prefix) && row.external_id.trim()) {
      existing[row.idempotency_key.slice(prefix.length)] = row.external_id;
    }
  }
  const bodies: string[] = [];
  const transport = input.transport ?? liveTransport();
  const recording: Transport = async (request) => {
    const response = await transport(request);
    bodies.push(redactSecrets(response.body).slice(0, 500));
    return response;
  };
  let confirmedVideo: {
    status: "stored"; externalId: string; reused: boolean; hypitJobId: string; jevDecisionId: string;
    briefId: string; storageKey: string; sha256: string; byteLength: number;
  } | null = null;
  if (input.provider === "meta") {
    const { publishHypitVideoToMeta } = await import("../publishing/hypit-meta.ts");
    const video = await publishHypitVideoToMeta(sql, {
      organizationId: input.organizationId,
      brandId: input.brandId,
      creativeId: input.creativeId,
      actorId: input.actorId,
      name: input.name,
      accessToken: opened.token,
      adAccountId,
      existingVideoId: existing.video,
      transport: recording,
      correlationId: operation.correlationId,
    });
    if (video && video.status !== "stored") {
      const status = video.status === "NOT_CONNECTED" ? "NOT_CONNECTED" : "failed";
      const record = operation.finish(false, 1, video.error);
      return {
        correlationId: String(record.correlationId),
        detail: video.error,
        stages: [{ objectType: "video", status, externalId: null, detail: video.error }],
      };
    }
    if (video?.status === "stored") {
      confirmedVideo = video;
      existing.video = video.externalId;
      if (!stored.some((row) => row.idempotency_key === `${input.brandId}:${input.creativeId}:video`)) {
        stored.push({ organization_id: input.organizationId, idempotency_key: `${input.brandId}:${input.creativeId}:video`, external_id: video.externalId });
      }
    }
  }
  let stages: PausedStage[] = await publishPausedStages({
    provider: input.provider,
    name: input.name,
    dailyBudgetCents: input.dailyBudgetCents,
    countries: input.countries,
    locationIds: input.locationIds,
    pageId: input.pageId,
    link: input.link,
    message: input.message,
    scheduleStart: input.scheduleStart,
    imageIds: input.imageIds,
    videoId: input.provider === "meta" ? confirmedVideo?.externalId : input.videoId,
    adAccountId,
    headlines: input.headlines,
    descriptions: input.descriptions,
    cpcBidCents: input.cpcBidCents,
    existing,
    accessToken: opened.token,
    env,
    transport: recording,
  });
  if (confirmedVideo) stages = [{ objectType: "video", status: "stored", externalId: confirmedVideo.externalId, reused: confirmedVideo.reused, error: "" }, ...stages];
  const evidence = redactSecrets(bodies.join("\n")).slice(0, 2000);
  const writes = stageWrites({
    organizationId: input.organizationId,
    brandId: input.brandId,
    creativeId: input.creativeId,
    existing: stored.map((row) => ({
      organizationId: row.organization_id,
      idempotencyKey: row.idempotency_key,
      externalId: row.external_id,
    })),
    stages: stages.map((stage) => ({
      objectType: stage.objectType,
      status: stage.status,
      externalId: stage.externalId,
      responseText: evidence || stage.error,
    })),
  });
  for (const write of writes) {
    if (write.action !== "insert") continue;
    await sql`
      insert into provider_objects (
        id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status, last_error, synced_at
      ) values (
        ${crypto.randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.provider}, ${write.objectType},
        ${write.idempotencyKey}, ${write.externalId}, 'stored', '', now()
      )
      on conflict (organization_id, provider, object_type, idempotency_key) do update set
        synced_at = now()
      where provider_objects.external_id = excluded.external_id
    `;
    await sql`
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (
        ${crypto.randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.actorId},
        'publishing.confirmed', ${write.objectType}, ${write.externalId},
        ${JSON.stringify({
          response: write.responseText,
          correlationId: operation.correlationId,
          ...(confirmedVideo ? { hypitLineage: {
            videoId: confirmedVideo.externalId,
            hypitJobId: confirmedVideo.hypitJobId,
            jevDecisionId: confirmedVideo.jevDecisionId,
            briefId: confirmedVideo.briefId,
            storageKey: confirmedVideo.storageKey,
            sha256: confirmedVideo.sha256,
            byteLength: confirmedVideo.byteLength,
          } } : {}),
        })}
      )
    `;
  }
  const failed = stages.find((stage) => stage.status !== "stored" && stage.status !== "not_stored");
  const record = operation.finish(!failed, 1, failed?.error || `stored:${writes.length}`);
  return {
    correlationId: String(record.correlationId),
    detail: failed?.error || (writes.length ? "Confirmed ids were stored. Objects stay paused." : "No new id was stored."),
    stages: stages.map((stage) => ({
      objectType: stage.objectType,
      status: stage.status,
      externalId: stage.externalId,
      detail: stage.error,
    })),
  };
}

export const publishPausedObjects = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const rawProvider = body.provider;
    const provider = rawProvider === "meta" || rawProvider === "tiktok" || rawProvider === "google" ? rawProvider : null;
    const brandId = clip(body.brandId, 80);
    const creativeId = clip(body.creativeId, 80);
    const name = clip(body.name, 120);
    const dailyBudgetCents = Number(body.dailyBudgetCents);
    if (!provider || !brandId || !creativeId || !name) throw new Error("Publishing needs a provider, a brand, a creative, and a name.");
    if (!Number.isFinite(dailyBudgetCents) || dailyBudgetCents <= 0) throw new Error("Publishing needs a daily budget in cents.");
    return {
      provider,
      brandId,
      creativeId,
      name,
      dailyBudgetCents: Math.round(dailyBudgetCents),
      countries: list(body.countries, 20),
      locationIds: list(body.locationIds, 20),
      pageId: clip(body.pageId, 80),
      link: clip(body.link, 500),
      message: clip(body.message, 500),
      scheduleStart: clip(body.scheduleStart, 40),
      imageIds: list(body.imageIds, 10),
      videoId: clip(body.videoId, 80),
      headlines: list(body.headlines, 15),
      descriptions: list(body.descriptions, 5),
      cpcBidCents: Number.isFinite(Number(body.cpcBidCents)) ? Math.round(Number(body.cpcBidCents)) : 0,
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const brands = await sql<{ organization_id: string }>`
      select organization_id from brands where id = ${data.brandId} and deleted_at is null limit 1
    `;
    const organizationId = brands[0]?.organization_id ?? "";
    if (!organizationId) throw new Error("Brand not found.");
    const members = await sql<{ role: string }>`
      select role from memberships where user_id = ${context.userId} and organization_id = ${organizationId} limit 1
    `;
    const role = members[0]?.role;
    if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
    assertRole(role, "admin");
    if (data.provider !== "meta" && data.provider !== "tiktok" && data.provider !== "google") {
      throw new Error("Unknown provider.");
    }
    return publishPausedForBrand(sql, { ...data, provider: data.provider, organizationId, actorId: context.userId });
  });
