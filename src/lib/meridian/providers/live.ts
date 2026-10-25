import { gatedTransport } from "./capability.ts";
import { liveTransport, type Transport } from "./http.ts";
import { probeAdLibrary, probeMeta, publishMetaPaused } from "./meta.ts";
import { probeGoogleAds, publishGoogleFlow } from "./google-ads.ts";
import { probeTikTok, publishTikTokFlow } from "./tiktok.ts";
import { connectionPhase, type ConnectionPhase } from "./phase.ts";
import { DEPLOYMENT_ONLY_KEY_ENV } from "../credentials/contract.ts";
import type { ProviderCredentialState } from "./access-token.ts";

export const LIVE_PROVIDERS = ["meta", "tiktok", "google", "ad_library"] as const;
export type LiveProvider = (typeof LIVE_PROVIDERS)[number];

export function isLiveProvider(value: string): value is LiveProvider {
  return (LIVE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Probes a provider with the token the caller passes, which is the workspace's stored token. The probe never reads an access
 * token from the environment. The Google developer token is the deployment-only key. The account ids are deployment settings, read from `env`.
 */
function googleDeveloperToken(env: NodeJS.ProcessEnv): string {
  const rule = DEPLOYMENT_ONLY_KEY_ENV.google_ads_developer;
  if ((env[rule.variable] ?? "").trim().toLowerCase() !== rule.accepts) return "";
  return (env[rule.keyVariable] ?? "").trim();
}
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
    const result = await probeMeta({ accessToken: token }, transport);
    return result.ok
      ? { ok: true, accountId: result.accountId, accountName: result.accountName, permissions: result.permissions, error: "" }
      : { ok: false, accountId: "", accountName: "", permissions: [], error: result.error };
  }
  if (provider === "tiktok") {
    // The account is the token's own advertiser, found by the probe. The deployment's advertiser id is not passed in.
    const result = await probeTikTok({ accessToken: token, appId: env.TIKTOK_APP_ID, appSecret: env.TIKTOK_APP_SECRET }, transport);
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
        developerToken: googleDeveloperToken(env),
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

/**
 * The phase of one probe. `configured` has no default: the caller reads whether the workspace has a credential, so no caller
 * can assume one.
 */
export function phaseForProbe(input: {
  provider: LiveProvider;
  ok: boolean | null;
  error: string;
  disconnected: boolean;
  env?: NodeJS.ProcessEnv;
  configured: boolean;
}): { phase: ConnectionPhase; detail: string } {
  return connectionPhase({
    configured: input.configured,
    disconnected: input.disconnected,
    probing: false,
    syncing: false,
    lastOk: input.ok,
    stale: false,
    lastError: input.error,
  });
}

/**
 * The phase of a stored connection. The workspace's credential decides whether there is a credential at all. An unusable
 * credential is a failure with its reason, so an earlier success never shows HEALTHY. Otherwise the phase follows the recorded
 * provider result, as it always has. DISCONNECTED comes first.
 */
export function phaseForStoredConnection(input: {
  provider: LiveProvider;
  credential: ProviderCredentialState;
  lastSuccessAt: unknown;
  lastError: string;
  disconnected: boolean;
}): { phase: ConnectionPhase; detail: string } {
  const unusable = input.credential.state === "unusable";
  return phaseForProbe({
    provider: input.provider,
    // The most recent probe decides: a recorded error is a failure, even when an earlier probe succeeded (the success stays on record).
    ok: (unusable || input.lastError) ? false : input.lastSuccessAt ? true : null,
    error: unusable ? input.credential.reason : input.lastError,
    disconnected: input.disconnected,
    configured: input.credential.state !== "not_configured",
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
  /**
   * The brand's saved ad account for this provider (Connected accounts): the Meta ad account, the Google Ads customer or the TikTok
   * advertiser. A publish needs it. The deployment's environment is not read for it.
   */
  adAccountId?: string;
  headlines?: string[];
  descriptions?: string[];
  cpcBidCents?: number;
  existing?: Partial<Record<string, string>>;
  accessToken?: string;
  env?: NodeJS.ProcessEnv;
  transport?: Transport;
}): Promise<PausedStage[]> {
  const env = input.env ?? process.env;
  // A paused publish writes ads to the provider. Its default transport is gated per provider, so nothing is sent until that write is guarded.
  const writeCapability = input.provider === "meta" ? "ads.meta_write" : input.provider === "tiktok" ? "ads.tiktok_write" : "ads.google_ads_write";
  const transport = input.transport ?? gatedTransport(writeCapability);
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
      { accessToken: token, adAccountId: input.adAccountId },
      {
        adAccountId: input.adAccountId ?? "",
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
      { accessToken: token, advertiserId: input.adAccountId },
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
      developerToken: googleDeveloperToken(env),
      customerId: input.adAccountId,
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
  /** The brand's saved ad account for this provider (Connected accounts). A publish needs it. */
  adAccountId?: string;
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
