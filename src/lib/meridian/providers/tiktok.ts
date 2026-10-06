import { sendWithRetry, type Transport } from "./http.ts";
import type { ProbeResult } from "./meta.ts";

const ROOT = "https://business-api.tiktok.com/open_api/v1.3";

export type TikTokCredentials = {
  accessToken: string;
  appId?: string;
  appSecret?: string;
  advertiserId?: string;
};

function headers(token: string): Record<string, string> {
  return { "Access-Token": token, "content-type": "application/json" };
}

export async function probeTikTok(credentials: TikTokCredentials, transport: Transport): Promise<ProbeResult> {
  if (!credentials.accessToken.trim()) return { ok: false, error: "TikTok access token is empty.", status: 0 };
  const user = await sendWithRetry(transport, {
    method: "GET",
    url: `${ROOT}/user/info/`,
    headers: headers(credentials.accessToken),
  });
  const code = numberField(user.json, "code");
  if (!user.ok || code !== 0) {
    return { ok: false, error: textField(user.json, "message") || user.error || "TikTok did not confirm the token.", status: user.status };
  }
  const accounts = await advertiserList(credentials, transport);
  const name = nested(user.json, "display_name");
  return {
    ok: true,
    accountId: accounts[0]?.id || credentials.advertiserId || "",
    accountName: name || accounts[0]?.name || "",
    accounts,
    permissions: [],
  };
}

async function advertiserList(credentials: TikTokCredentials, transport: Transport): Promise<{ id: string; name: string }[]> {
  if (!credentials.appId?.trim() || !credentials.appSecret?.trim()) return [];
  const url = `${ROOT}/oauth2/advertiser/get/?app_id=${encodeURIComponent(credentials.appId)}&secret=${encodeURIComponent(credentials.appSecret)}`;
  const result = await sendWithRetry(transport, { method: "GET", url, headers: headers(credentials.accessToken) });
  if (numberField(result.json, "code") !== 0) return [];
  const list = nestedList(result.json);
  return list
    .map((row) => ({ id: textField(row, "advertiser_id"), name: textField(row, "advertiser_name") }))
    .filter((row) => row.id);
}

export async function publishTikTokPaused(
  credentials: TikTokCredentials,
  input: { name: string; dailyBudget: number; existingCampaignId?: string },
  transport: Transport,
): Promise<{ status: "stored"; externalId: string; reused: boolean } | { status: "failed"; externalId: null; error: string }> {
  if (input.existingCampaignId?.trim()) return { status: "stored", externalId: input.existingCampaignId, reused: true };
  if (!credentials.advertiserId?.trim()) {
    return { status: "failed", externalId: null, error: "TikTok publishing needs TIKTOK_ADVERTISER_ID. Nothing was sent." };
  }
  if (input.dailyBudget <= 0) {
    return { status: "failed", externalId: null, error: "TikTok campaign needs a daily budget. Nothing was sent." };
  }
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: `${ROOT}/campaign/create/`,
    headers: headers(credentials.accessToken),
    body: JSON.stringify({
      advertiser_id: credentials.advertiserId,
      campaign_name: input.name,
      objective_type: "TRAFFIC",
      budget_mode: "BUDGET_MODE_DAY",
      budget: input.dailyBudget,
      operation_status: "DISABLE",
    }),
  });
  const id = nested(result.json, "campaign_id");
  if (!result.ok || numberField(result.json, "code") !== 0 || !id) {
    return { status: "failed", externalId: null, error: textField(result.json, "message") || result.error || "TikTok did not return a campaign id." };
  }
  return { status: "stored", externalId: id, reused: false };
}

function textField(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
}

function numberField(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" ? raw : null;
}

function nested(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return "";
  const raw = (data as Record<string, unknown>)[key];
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
}

function nestedList(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const data = (value as { data?: { list?: unknown } }).data;
  return Array.isArray(data?.list) ? data.list.filter((row) => row && typeof row === "object") as Record<string, unknown>[] : [];
}

export type TikTokStage = "campaign" | "ad_group" | "creative" | "ad";

export type TikTokStageResult =
  | { status: "stored"; externalId: string; reused: boolean }
  | { status: "failed"; externalId: null; error: string }
  | { status: "EXTERNAL_CONNECTION_REQUIRED"; externalId: null; error: string };

export type TikTokFlowInput = {
  name: string;
  dailyBudget: number;
  locationIds: string[];
  scheduleStart: string;
  landingPageUrl: string;
  adText: string;
  imageIds?: string[];
  videoId?: string;
  existing?: Partial<Record<TikTokStage, string>>;
};

/** Campaign, ad group, then creative and ad. A missing uploaded asset stops before the ad call. */
export async function publishTikTokFlow(
  credentials: TikTokCredentials,
  input: TikTokFlowInput,
  transport: Transport,
): Promise<Record<TikTokStage, TikTokStageResult>> {
  const failed = (error: string): TikTokStageResult => ({ status: "failed", externalId: null, error });
  const campaign = await tikTokCampaign(credentials, input, transport);
  if (campaign.status !== "stored") {
    return { campaign, ad_group: failed(campaign.error), creative: failed(campaign.error), ad: failed(campaign.error) };
  }
  const adGroup = await tikTokAdGroup(credentials, input, campaign.externalId, transport);
  if (adGroup.status !== "stored") {
    return { campaign, ad_group: adGroup, creative: failed(adGroup.error), ad: failed(adGroup.error) };
  }
  const asset = input.videoId?.trim() || input.imageIds?.find((id) => id.trim()) || "";
  if (!asset) {
    const required: TikTokStageResult = {
      status: "EXTERNAL_CONNECTION_REQUIRED",
      externalId: null,
      error: "TikTok needs an uploaded image id or video id before an ad can be created. Nothing further was sent.",
    };
    return { campaign, ad_group: adGroup, creative: required, ad: required };
  }
  const storedCreative = input.existing?.creative?.trim() ?? "";
  const storedAd = input.existing?.ad?.trim() ?? "";
  if (storedCreative && storedAd) {
    return {
      campaign,
      ad_group: adGroup,
      creative: { status: "stored", externalId: storedCreative, reused: true },
      ad: { status: "stored", externalId: storedAd, reused: true },
    };
  }
  if (storedCreative || storedAd) {
    return {
      campaign,
      ad_group: adGroup,
      creative: storedCreative
        ? { status: "stored", externalId: storedCreative, reused: true }
        : { status: "failed", externalId: null, error: "The TikTok ad id is stored, but the creative id is not. The ad was not recreated and no creative id was invented." },
      ad: storedAd
        ? { status: "stored", externalId: storedAd, reused: true }
        : {
            status: "failed",
            externalId: null,
            error: "TikTok creates the creative and the ad in one request. The creative id is already stored, so the ad was not sent again.",
          },
    };
  }
  if (!input.landingPageUrl.trim() || !input.adText.trim()) {
    const error = "TikTok ad needs ad text and a landing page. Nothing further was sent.";
    return { campaign, ad_group: adGroup, creative: failed(error), ad: failed(error) };
  }
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: `${ROOT}/ad/create/`,
    headers: headers(credentials.accessToken),
    body: JSON.stringify({
      advertiser_id: credentials.advertiserId,
      adgroup_id: adGroup.externalId,
      creatives: [
        {
          ad_name: input.name,
          ad_format: input.videoId ? "SINGLE_VIDEO" : "SINGLE_IMAGE",
          ad_text: input.adText,
          image_ids: input.imageIds ?? [],
          video_id: input.videoId || undefined,
          landing_page_url: input.landingPageUrl,
          operation_status: "DISABLE",
        },
      ],
    }),
  });
  const creativeId = nested(result.json, "creative_id") || nestedCreative(result.json, "creative_id");
  const adId = nestedCreative(result.json, "ad_id") || firstAdId(result.json);
  const providerOk = result.ok && numberField(result.json, "code") === 0;
  if (!providerOk || !creativeId) {
    return {
      campaign,
      ad_group: adGroup,
      creative: {
        status: "failed",
        externalId: null,
        error: textField(result.json, "message") || result.error || "TikTok did not return a creative id. No ad id was stored.",
      },
      ad: { status: "failed", externalId: null, error: "TikTok did not confirm a creative, so no ad id was stored." },
    };
  }
  if (!adId) {
    return {
      campaign,
      ad_group: adGroup,
      creative: { status: "stored", externalId: creativeId, reused: false },
      ad: { status: "failed", externalId: null, error: "TikTok returned a creative id but not an ad id. The missing ad id was not invented." },
    };
  }
  return {
    campaign,
    ad_group: adGroup,
    creative: { status: "stored", externalId: creativeId, reused: false },
    ad: { status: "stored", externalId: adId, reused: false },
  };
}

async function tikTokCampaign(
  credentials: TikTokCredentials,
  input: TikTokFlowInput,
  transport: Transport,
): Promise<TikTokStageResult> {
  if (input.existing?.campaign?.trim()) return { status: "stored", externalId: input.existing.campaign, reused: true };
  const created = await publishTikTokPaused(credentials, { name: input.name, dailyBudget: input.dailyBudget }, transport);
  return created.status === "stored"
    ? { status: "stored", externalId: created.externalId, reused: created.reused }
    : { status: "failed", externalId: null, error: created.error };
}

async function tikTokAdGroup(
  credentials: TikTokCredentials,
  input: TikTokFlowInput,
  campaignId: string,
  transport: Transport,
): Promise<TikTokStageResult> {
  if (input.existing?.ad_group?.trim()) return { status: "stored", externalId: input.existing.ad_group, reused: true };
  if (!credentials.advertiserId?.trim()) {
    return { status: "failed", externalId: null, error: "TikTok ad group needs an advertiser id. Nothing was sent." };
  }
  if (!input.locationIds.length || !input.scheduleStart.trim()) {
    return { status: "failed", externalId: null, error: "TikTok ad group needs a location id and a schedule start. Nothing was sent." };
  }
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: `${ROOT}/adgroup/create/`,
    headers: headers(credentials.accessToken),
    body: JSON.stringify({
      advertiser_id: credentials.advertiserId,
      campaign_id: campaignId,
      adgroup_name: input.name,
      promotion_type: "WEBSITE",
      placement_type: "PLACEMENT_TYPE_AUTOMATIC",
      budget_mode: "BUDGET_MODE_DAY",
      budget: input.dailyBudget,
      schedule_type: "SCHEDULE_FROM_NOW",
      schedule_start_time: input.scheduleStart,
      optimization_goal: "CLICK",
      billing_event: "CPC",
      location_ids: input.locationIds,
      operation_status: "DISABLE",
    }),
  });
  const id = nested(result.json, "adgroup_id");
  if (!result.ok || numberField(result.json, "code") !== 0 || !id) {
    return { status: "failed", externalId: null, error: textField(result.json, "message") || result.error || "TikTok did not return an ad group id." };
  }
  return { status: "stored", externalId: id, reused: false };
}

function nestedCreative(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const data = (value as { data?: { creatives?: unknown } }).data;
  const creatives = data?.creatives;
  if (!Array.isArray(creatives) || !creatives[0] || typeof creatives[0] !== "object") return "";
  const raw = (creatives[0] as Record<string, unknown>)[key];
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
}

function firstAdId(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const data = (value as { data?: { ad_ids?: unknown } }).data;
  const list = data?.ad_ids;
  if (!Array.isArray(list)) return "";
  const first = list[0];
  return typeof first === "string" || typeof first === "number" ? String(first) : "";
}

/** Integrated report for one ad. Rows are whatever TikTok returned. Missing metrics are not filled in. */
export async function fetchTikTokInsights(
  credentials: TikTokCredentials,
  input: { adId: string; startDate: string; endDate: string },
  transport: Transport,
): Promise<{ ok: boolean; rows: Record<string, unknown>[]; error: string }> {
  if (!credentials.accessToken.trim() || !credentials.advertiserId?.trim()) {
    return { ok: false, rows: [], error: "TikTok insights need an access token and advertiser id. Nothing was stored." };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(input.adId) || !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
    return { ok: false, rows: [], error: "TikTok insights need an ad id and a YYYY-MM-DD range. Nothing was sent." };
  }
  const params = new URLSearchParams({
    advertiser_id: credentials.advertiserId,
    report_type: "BASIC",
    data_level: "AUCTION_AD",
    dimensions: JSON.stringify(["ad_id", "stat_time_day"]),
    metrics: JSON.stringify(["impressions", "clicks", "spend", "conversion"]),
    start_date: input.startDate,
    end_date: input.endDate,
    filtering: JSON.stringify([{ field_name: "ad_ids", filter_type: "IN", filter_value: JSON.stringify([input.adId]) }]),
    page_size: "100",
  });
  const result = await sendWithRetry(transport, {
    method: "GET",
    url: `${ROOT}/report/integrated/get/?${params.toString()}`,
    headers: headers(credentials.accessToken),
  });
  if (!result.ok || numberField(result.json, "code") !== 0) {
    return { ok: false, rows: [], error: textField(result.json, "message") || result.error || "TikTok did not return a report. Nothing was stored." };
  }
  return { ok: true, rows: nestedList(result.json), error: "" };
}
