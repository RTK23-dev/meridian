import { liveTransport, type Transport } from "./http.ts";
import { probeAdLibrary, probeMeta, publishMetaPaused } from "./meta.ts";
import { probeGoogleAds, publishGooglePaused } from "./google-ads.ts";
import { probeTikTok, publishTikTokPaused } from "./tiktok.ts";
import { connectionPhase, type ConnectionPhase } from "./phase.ts";

export const LIVE_PROVIDERS = ["meta", "tiktok", "google", "ad_library"] as const;
export type LiveProvider = (typeof LIVE_PROVIDERS)[number];

export function isLiveProvider(value: string): value is LiveProvider {
  return (LIVE_PROVIDERS as readonly string[]).includes(value);
}

export function providerConfigured(provider: LiveProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  if (provider === "meta") return Boolean(env.META_ACCESS_TOKEN?.trim());
  if (provider === "tiktok") return Boolean(env.TIKTOK_ACCESS_TOKEN?.trim());
  if (provider === "google") return Boolean(env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() && env.GOOGLE_ADS_ACCESS_TOKEN?.trim());
  return Boolean(env.META_AD_LIBRARY_TOKEN?.trim());
}

export async function probeLive(
  provider: LiveProvider,
  env: NodeJS.ProcessEnv = process.env,
  transport: Transport = liveTransport(),
): Promise<{ ok: boolean; accountId: string; accountName: string; permissions: string[]; error: string }> {
  if (!providerConfigured(provider, env)) {
    return { ok: false, accountId: "", accountName: "", permissions: [], error: "No credentials are configured." };
  }
  if (provider === "meta") {
    const result = await probeMeta({ accessToken: env.META_ACCESS_TOKEN ?? "", adAccountId: env.META_AD_ACCOUNT_ID }, transport);
    return result.ok
      ? { ok: true, accountId: result.accountId, accountName: result.accountName, permissions: result.permissions, error: "" }
      : { ok: false, accountId: "", accountName: "", permissions: [], error: result.error };
  }
  if (provider === "tiktok") {
    const result = await probeTikTok(
      {
        accessToken: env.TIKTOK_ACCESS_TOKEN ?? "",
        appId: env.TIKTOK_APP_ID,
        appSecret: env.TIKTOK_APP_SECRET,
        advertiserId: env.TIKTOK_ADVERTISER_ID,
      },
      transport,
    );
    return result.ok
      ? { ok: true, accountId: result.accountId, accountName: result.accountName, permissions: result.permissions, error: "" }
      : { ok: false, accountId: "", accountName: "", permissions: [], error: result.error };
  }
  if (provider === "google") {
    const result = await probeGoogleAds(
      {
        accessToken: env.GOOGLE_ADS_ACCESS_TOKEN ?? "",
        developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
        customerId: env.GOOGLE_ADS_CUSTOMER_ID,
      },
      transport,
    );
    return result.ok
      ? { ok: true, accountId: result.accountId, accountName: result.accountName, permissions: result.permissions, error: "" }
      : { ok: false, accountId: "", accountName: "", permissions: [], error: result.error };
  }
  const library = await probeAdLibrary(env.META_AD_LIBRARY_TOKEN ?? "", transport);
  return library.ok
    ? { ok: true, accountId: "", accountName: library.accountName, permissions: [], error: "" }
    : { ok: false, accountId: "", accountName: "", permissions: [], error: library.error };
}

export function phaseForProbe(input: {
  provider: LiveProvider;
  ok: boolean | null;
  error: string;
  disconnected: boolean;
  env?: NodeJS.ProcessEnv;
}): { phase: ConnectionPhase; detail: string } {
  return connectionPhase({
    configured: providerConfigured(input.provider, input.env),
    disconnected: input.disconnected,
    probing: false,
    syncing: false,
    lastOk: input.ok,
    stale: false,
    lastError: input.error,
  });
}

export async function publishPausedCampaign(input: {
  provider: "meta" | "tiktok" | "google";
  name: string;
  dailyBudgetCents: number;
  countries: string[];
  pageId: string;
  link: string;
  message: string;
  existingCampaignId?: string;
  env?: NodeJS.ProcessEnv;
  transport?: Transport;
}): Promise<{ externalId: string | null; reused: boolean; error: string }> {
  const env = input.env ?? process.env;
  const transport = input.transport ?? liveTransport();
  if (input.provider === "meta") {
    const published = await publishMetaPaused(
      { accessToken: env.META_ACCESS_TOKEN ?? "", adAccountId: env.META_AD_ACCOUNT_ID },
      {
        adAccountId: env.META_AD_ACCOUNT_ID ?? "",
        name: input.name,
        dailyBudgetCents: input.dailyBudgetCents,
        countries: input.countries,
        pageId: input.pageId,
        message: input.message,
        link: input.link,
        existing: input.existingCampaignId ? { campaign: input.existingCampaignId } : undefined,
      },
      transport,
    );
    const campaign = published.campaign;
    return campaign.status === "stored"
      ? { externalId: campaign.externalId, reused: campaign.reused, error: published.ad.status === "failed" ? published.ad.error : "" }
      : { externalId: null, reused: false, error: campaign.error };
  }
  if (input.provider === "tiktok") {
    const published = await publishTikTokPaused(
      { accessToken: env.TIKTOK_ACCESS_TOKEN ?? "", advertiserId: env.TIKTOK_ADVERTISER_ID },
      { name: input.name, dailyBudget: input.dailyBudgetCents / 100, existingCampaignId: input.existingCampaignId },
      transport,
    );
    return published.status === "stored"
      ? { externalId: published.externalId, reused: published.reused, error: "" }
      : { externalId: null, reused: false, error: published.error };
  }
  const published = await publishGooglePaused(
    {
      accessToken: env.GOOGLE_ADS_ACCESS_TOKEN ?? "",
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
      customerId: env.GOOGLE_ADS_CUSTOMER_ID,
    },
    { name: input.name, dailyBudgetCents: input.dailyBudgetCents, existingCampaignResource: input.existingCampaignId },
    transport,
  );
  return published.status === "stored"
    ? { externalId: published.externalId, reused: published.reused, error: "" }
    : { externalId: null, reused: false, error: published.error };
}
