import { liveTransport, type Transport } from "./http.ts";
import { probeAdLibrary, probeMeta, publishMetaPaused } from "./meta.ts";
import { probeGoogleAds, publishGoogleFlow } from "./google-ads.ts";
import { probeTikTok, publishTikTokFlow } from "./tiktok.ts";
import { connectionPhase, type ConnectionPhase } from "./phase.ts";

export const LIVE_PROVIDERS = ["meta", "tiktok", "google", "ad_library"] as const;
export type LiveProvider = (typeof LIVE_PROVIDERS)[number];

export function isLiveProvider(value: string): value is LiveProvider {
  return (LIVE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Whether a provider is configured. An environment token never configures a provider, so this is always false: a provider is
 * configured only by a token stored for the workspace, and callers decide that from the token they hold.
 */
export function providerConfigured(provider: LiveProvider): boolean {
  void provider;
  return false;
}

/**
 * Probes a provider with the token the caller passes, which is the workspace's stored token. The probe never reads an access
 * token from the environment. The Google developer token and the account ids are deployment settings, read from `env`.
 */
export async function probeLive(
  provider: LiveProvider,
  env: NodeJS.ProcessEnv = process.env,
  transport: Transport = liveTransport(),
  accessToken = "",
): Promise<{ ok: boolean; accountId: string; accountName: string; permissions: string[]; error: string }> {
  const token = accessToken.trim();
  if (!token) {
    return { ok: false, accountId: "", accountName: "", permissions: [], error: "No credentials are configured." };
  }
  if (provider === "meta") {
    const result = await probeMeta({ accessToken: token, adAccountId: env.META_AD_ACCOUNT_ID }, transport);
    return result.ok
      ? { ok: true, accountId: result.accountId, accountName: result.accountName, permissions: result.permissions, error: "" }
      : { ok: false, accountId: "", accountName: "", permissions: [], error: result.error };
  }
  if (provider === "tiktok") {
    const result = await probeTikTok(
      {
        accessToken: token,
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
        accessToken: token,
        // The developer token identifies the deployment's Google Ads API client. It is not an account token, and it is the one
        // deployment token the probe still reads from the environment.
        developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
        customerId: env.GOOGLE_ADS_CUSTOMER_ID,
      },
      transport,
    );
    return result.ok
      ? { ok: true, accountId: result.accountId, accountName: result.accountName, permissions: result.permissions, error: "" }
      : { ok: false, accountId: "", accountName: "", permissions: [], error: result.error };
  }
  const library = await probeAdLibrary(token, transport);
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
  configured?: boolean;
}): { phase: ConnectionPhase; detail: string } {
  return connectionPhase({
    configured: input.configured ?? providerConfigured(input.provider),
    disconnected: input.disconnected,
    probing: false,
    syncing: false,
    lastOk: input.ok,
    stale: false,
    lastError: input.error,
  });
}

export type PausedStage = {
  objectType: string;
  status: string;
  externalId: string | null;
  reused: boolean;
  error: string;
};

function asStage(
  objectType: string,
  result: { status: string; externalId: string | null; reused?: boolean; error?: string },
): PausedStage {
  const id = result.externalId?.trim() ?? "";
  const confirmed = result.status === "stored" && id.length > 0;
  return {
    objectType,
    status: confirmed ? "stored" : result.status === "stored" ? "not_stored" : result.status,
    externalId: confirmed ? id : null,
    reused: confirmed ? Boolean(result.reused) : false,
    error: confirmed ? "" : result.error || (result.status === "stored" ? "" : "The provider did not confirm this stage."),
  };
}

/** Full paused chain. A stored campaign id is not enough to call the stage published. */
export async function publishPausedStages(input: {
  provider: "meta" | "tiktok" | "google";
  name: string;
  dailyBudgetCents: number;
  countries: string[];
  locationIds?: string[];
  pageId: string;
  link: string;
  message: string;
  scheduleStart?: string;
  imageIds?: string[];
  videoId?: string;
  headlines?: string[];
  descriptions?: string[];
  cpcBidCents?: number;
  existing?: Partial<Record<string, string>>;
  accessToken?: string;
  env?: NodeJS.ProcessEnv;
  transport?: Transport;
}): Promise<PausedStage[]> {
  const env = input.env ?? process.env;
  const transport = input.transport ?? liveTransport();
  const token = input.accessToken?.trim() ?? "";
  if (!token) {
    // No stored token means nothing is sent. Every stage is reported as not connected, with the reason.
    const names = input.provider === "meta" ? ["campaign", "ad_set", "creative", "ad"] : input.provider === "tiktok" ? ["campaign", "ad_group", "creative", "ad"] : ["budget", "campaign", "ad_group", "ad"];
    return names.map((objectType) => ({
      objectType,
      status: "NOT_CONNECTED",
      externalId: null,
      reused: false,
      error: "No access token is stored for this workspace. Nothing was sent.",
    }));
  }
  if (input.provider === "meta") {
    const published = await publishMetaPaused(
      { accessToken: token, adAccountId: env.META_AD_ACCOUNT_ID },
      {
        adAccountId: env.META_AD_ACCOUNT_ID ?? "",
        name: input.name,
        dailyBudgetCents: input.dailyBudgetCents,
        countries: input.countries,
        pageId: input.pageId,
        message: input.message,
        link: input.link,
        videoId: input.videoId,
        existing: {
          campaign: input.existing?.campaign,
          ad_set: input.existing?.ad_set,
          creative: input.existing?.creative,
          ad: input.existing?.ad,
        },
      },
      transport,
    );
    return (["campaign", "ad_set", "creative", "ad"] as const).map((stage) => asStage(stage, published[stage]));
  }
  if (input.provider === "tiktok") {
    const published = await publishTikTokFlow(
      { accessToken: token, advertiserId: env.TIKTOK_ADVERTISER_ID },
      {
        name: input.name,
        dailyBudget: input.dailyBudgetCents / 100,
        locationIds: input.locationIds ?? [],
        scheduleStart: input.scheduleStart ?? "",
        landingPageUrl: input.link,
        adText: input.message,
        imageIds: input.imageIds,
        videoId: input.videoId,
        existing: {
          campaign: input.existing?.campaign,
          ad_group: input.existing?.ad_group,
          creative: input.existing?.creative,
          ad: input.existing?.ad,
        },
      },
      transport,
    );
    return (["campaign", "ad_group", "creative", "ad"] as const).map((stage) => asStage(stage, published[stage]));
  }
  const published = await publishGoogleFlow(
    {
      accessToken: token,
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
      customerId: env.GOOGLE_ADS_CUSTOMER_ID,
    },
    {
      name: input.name,
      dailyBudgetCents: input.dailyBudgetCents,
      cpcBidCents: input.cpcBidCents ?? 0,
      finalUrl: input.link,
      headlines: input.headlines ?? [],
      descriptions: input.descriptions ?? [],
      existing: {
        budget: input.existing?.budget,
        campaign: input.existing?.campaign,
        ad_group: input.existing?.ad_group,
        ad: input.existing?.ad,
      },
    },
    transport,
  );
  return (["budget", "campaign", "ad_group", "ad"] as const).map((stage) => asStage(stage, published[stage]));
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
  accessToken?: string;
  env?: NodeJS.ProcessEnv;
  transport?: Transport;
}): Promise<{ externalId: string | null; reused: boolean; error: string }> {
  const stages = await publishPausedStages({
    ...input,
    existing: input.existingCampaignId ? { campaign: input.existingCampaignId } : undefined,
  });
  const campaign = stages.find((stage) => stage.objectType === "campaign");
  const blocked = stages.find((stage) => stage.status !== "stored" && stage.status !== "not_stored");
  if (!campaign || campaign.status !== "stored" || !campaign.externalId) {
    return { externalId: null, reused: false, error: campaign?.error || blocked?.error || "Nothing was stored." };
  }
  return { externalId: campaign.externalId, reused: campaign.reused, error: blocked?.error ?? "" };
}
