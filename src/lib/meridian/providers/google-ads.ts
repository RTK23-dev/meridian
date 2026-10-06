import { sendWithRetry, type Transport } from "./http.ts";
import type { ProbeResult } from "./meta.ts";

const VERSION = "v18";
const ROOT = `https://googleads.googleapis.com/${VERSION}`;

export type GoogleAdsCredentials = {
  accessToken: string;
  developerToken: string;
  customerId?: string;
};

function headers(credentials: GoogleAdsCredentials): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.accessToken}`,
    "developer-token": credentials.developerToken,
    "content-type": "application/json",
  };
}

export async function probeGoogleAds(credentials: GoogleAdsCredentials, transport: Transport): Promise<ProbeResult> {
  if (!credentials.accessToken.trim() || !credentials.developerToken.trim()) {
    return { ok: false, error: "Google Ads needs an OAuth access token and a developer token.", status: 0 };
  }
  const result = await sendWithRetry(transport, {
    method: "GET",
    url: `${ROOT}/customers:listAccessibleCustomers`,
    headers: headers(credentials),
  });
  const names = result.json && typeof result.json === "object" ? (result.json as { resourceNames?: unknown }).resourceNames : undefined;
  if (!result.ok || !Array.isArray(names)) {
    return { ok: false, error: result.error || "Google Ads did not return accessible customers.", status: result.status };
  }
  const accounts = names
    .filter((name): name is string => typeof name === "string" && name.startsWith("customers/"))
    .map((name) => ({ id: name.replace("customers/", ""), name }));
  return {
    ok: true,
    accountId: accounts[0]?.id || "",
    accountName: accounts[0]?.name || "",
    accounts,
    permissions: ["listAccessibleCustomers"],
  };
}

export async function publishGooglePaused(
  credentials: GoogleAdsCredentials,
  input: { name: string; dailyBudgetCents: number; existingCampaignResource?: string },
  transport: Transport,
): Promise<{ status: "stored"; externalId: string; reused: boolean } | { status: "failed"; externalId: null; error: string }> {
  if (input.existingCampaignResource?.trim()) {
    return { status: "stored", externalId: input.existingCampaignResource, reused: true };
  }
  const customerId = credentials.customerId?.replaceAll("-", "") || "";
  if (!customerId) return { status: "failed", externalId: null, error: "Google Ads publishing needs a customer id. Nothing was sent." };
  if (input.dailyBudgetCents <= 0) return { status: "failed", externalId: null, error: "Google Ads needs a daily budget. Nothing was sent." };
  const budget = await sendWithRetry(transport, {
    method: "POST",
    url: `${ROOT}/customers/${customerId}/campaignBudgets:mutate`,
    headers: headers(credentials),
    body: JSON.stringify({
      operations: [
        {
          create: {
            name: input.name,
            amountMicros: String(input.dailyBudgetCents * 10_000),
            deliveryMethod: "STANDARD",
            explicitlyShared: false,
          },
        },
      ],
    }),
  });
  const budgetName = resourceName(budget.json);
  if (!budget.ok || !budgetName) {
    return { status: "failed", externalId: null, error: budget.error || "Google Ads did not return a budget resource. No campaign was created." };
  }
  const campaign = await sendWithRetry(transport, {
    method: "POST",
    url: `${ROOT}/customers/${customerId}/campaigns:mutate`,
    headers: headers(credentials),
    body: JSON.stringify({
      operations: [
        {
          create: {
            name: input.name,
            status: "PAUSED",
            advertisingChannelType: "SEARCH",
            campaignBudget: budgetName,
          },
        },
      ],
    }),
  });
  const campaignName = resourceName(campaign.json);
  if (!campaign.ok || !campaignName) {
    return { status: "failed", externalId: null, error: campaign.error || "Google Ads did not return a campaign resource. Nothing was stored." };
  }
  return { status: "stored", externalId: campaignName, reused: false };
}

function resourceName(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results) || !results[0] || typeof results[0] !== "object") return "";
  const name = (results[0] as { resourceName?: unknown }).resourceName;
  return typeof name === "string" ? name : "";
}

export type GoogleStage = "budget" | "campaign" | "ad_group" | "ad";

export type GoogleStageResult =
  | { status: "stored"; externalId: string; reused: boolean }
  | { status: "failed"; externalId: null; error: string };

export type GoogleFlowInput = {
  name: string;
  dailyBudgetCents: number;
  cpcBidCents: number;
  finalUrl: string;
  headlines: string[];
  descriptions: string[];
  existing?: Partial<Record<GoogleStage, string>>;
};

/** Resumes at the first stage that does not already have a confirmed resource name. */
export async function publishGoogleFlow(
  credentials: GoogleAdsCredentials,
  input: GoogleFlowInput,
  transport: Transport,
): Promise<Record<GoogleStage, GoogleStageResult>> {
  const failed = (error: string): GoogleStageResult => ({ status: "failed", externalId: null, error });
  const customerId = credentials.customerId?.replaceAll("-", "") || "";
  if (!customerId || !credentials.accessToken.trim() || !credentials.developerToken.trim()) {
    const error = "Google Ads publishing needs a customer id, an access token, and a developer token. Nothing was sent.";
    return { budget: failed(error), campaign: failed(error), ad_group: failed(error), ad: failed(error) };
  }
  const budget = await googleBudget(credentials, customerId, input, transport);
  if (budget.status !== "stored" && !input.existing?.campaign?.trim()) {
    return { budget, campaign: failed(budget.error), ad_group: failed(budget.error), ad: failed(budget.error) };
  }
  const campaign = await googleCampaign(credentials, customerId, input, budget.status === "stored" ? budget.externalId : "", transport);
  if (campaign.status !== "stored") {
    return { budget, campaign, ad_group: failed(campaign.error), ad: failed(campaign.error) };
  }
  const adGroup = await googleAdGroup(credentials, customerId, input, campaign.externalId, transport);
  if (adGroup.status !== "stored") {
    return { budget, campaign, ad_group: adGroup, ad: failed(adGroup.error) };
  }
  const ad = await googleAd(credentials, customerId, input, adGroup.externalId, transport);
  return { budget, campaign, ad_group: adGroup, ad };
}

async function googleBudget(
  credentials: GoogleAdsCredentials,
  customerId: string,
  input: GoogleFlowInput,
  transport: Transport,
): Promise<GoogleStageResult> {
  if (input.existing?.budget?.trim()) return { status: "stored", externalId: input.existing.budget, reused: true };
  if (input.existing?.campaign?.trim()) {
    return { status: "stored", externalId: "", reused: true };
  }
  if (input.dailyBudgetCents <= 0) return { status: "failed", externalId: null, error: "Google Ads needs a daily budget. Nothing was sent." };
  const budget = await sendWithRetry(transport, {
    method: "POST",
    url: `${ROOT}/customers/${customerId}/campaignBudgets:mutate`,
    headers: headers(credentials),
    body: JSON.stringify({
      operations: [{ create: { name: input.name, amountMicros: String(input.dailyBudgetCents * 10_000), deliveryMethod: "STANDARD", explicitlyShared: false } }],
    }),
  });
  const name = resourceName(budget.json);
  if (!budget.ok || !name) return { status: "failed", externalId: null, error: budget.error || "Google Ads did not return a budget resource. No campaign was created." };
  return { status: "stored", externalId: name, reused: false };
}

async function googleCampaign(
  credentials: GoogleAdsCredentials,
  customerId: string,
  input: GoogleFlowInput,
  budgetName: string,
  transport: Transport,
): Promise<GoogleStageResult> {
  if (input.existing?.campaign?.trim()) return { status: "stored", externalId: input.existing.campaign, reused: true };
  const campaign = await sendWithRetry(transport, {
    method: "POST",
    url: `${ROOT}/customers/${customerId}/campaigns:mutate`,
    headers: headers(credentials),
    body: JSON.stringify({
      operations: [{ create: { name: input.name, status: "PAUSED", advertisingChannelType: "SEARCH", campaignBudget: budgetName } }],
    }),
  });
  const name = resourceName(campaign.json);
  if (!campaign.ok || !name) return { status: "failed", externalId: null, error: campaign.error || "Google Ads did not return a campaign resource. Nothing downstream was stored." };
  return { status: "stored", externalId: name, reused: false };
}

async function googleAdGroup(
  credentials: GoogleAdsCredentials,
  customerId: string,
  input: GoogleFlowInput,
  campaignName: string,
  transport: Transport,
): Promise<GoogleStageResult> {
  if (input.existing?.ad_group?.trim()) return { status: "stored", externalId: input.existing.ad_group, reused: true };
  if (input.cpcBidCents <= 0) return { status: "failed", externalId: null, error: "Google ad group needs a CPC bid. Nothing further was sent." };
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: `${ROOT}/customers/${customerId}/adGroups:mutate`,
    headers: headers(credentials),
    body: JSON.stringify({
      operations: [{ create: { name: input.name, campaign: campaignName, status: "PAUSED", type: "SEARCH_STANDARD", cpcBidMicros: String(input.cpcBidCents * 10_000) } }],
    }),
  });
  const name = resourceName(result.json);
  if (!result.ok || !name) return { status: "failed", externalId: null, error: result.error || "Google Ads did not return an ad group resource." };
  return { status: "stored", externalId: name, reused: false };
}

async function googleAd(
  credentials: GoogleAdsCredentials,
  customerId: string,
  input: GoogleFlowInput,
  adGroupName: string,
  transport: Transport,
): Promise<GoogleStageResult> {
  if (input.existing?.ad?.trim()) return { status: "stored", externalId: input.existing.ad, reused: true };
  if (!input.finalUrl.trim() || input.headlines.length === 0 || input.descriptions.length === 0) {
    return { status: "failed", externalId: null, error: "Google ad needs a final URL, a headline, and a description. Nothing further was sent." };
  }
  if (input.headlines.some((line) => line.length > 30) || input.descriptions.some((line) => line.length > 90)) {
    return { status: "failed", externalId: null, error: "A Google headline must be 30 characters or fewer and a description 90 or fewer. Nothing was sent." };
  }
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: `${ROOT}/customers/${customerId}/adGroupAds:mutate`,
    headers: headers(credentials),
    body: JSON.stringify({
      operations: [{
        create: {
          adGroup: adGroupName,
          status: "PAUSED",
          ad: {
            finalUrls: [input.finalUrl],
            responsiveSearchAd: {
              headlines: input.headlines.map((text) => ({ text })),
              descriptions: input.descriptions.map((text) => ({ text })),
            },
          },
        },
      }],
    }),
  });
  const name = resourceName(result.json);
  if (!result.ok || !name) return { status: "failed", externalId: null, error: result.error || "Google Ads did not return an ad resource. Nothing was stored." };
  return { status: "stored", externalId: name, reused: false };
}

/** GAQL insights for one ad. The query is built only from a checked customer id, resource name, and dates. */
export async function fetchGoogleInsights(
  credentials: GoogleAdsCredentials,
  input: { adResourceName: string; startDate: string; endDate: string },
  transport: Transport,
): Promise<{ ok: boolean; rows: Record<string, unknown>[]; error: string }> {
  const customerId = credentials.customerId?.replaceAll("-", "") ?? "";
  if (!credentials.accessToken.trim() || !credentials.developerToken.trim() || !/^\d+$/.test(customerId)) {
    return { ok: false, rows: [], error: "Google Ads insights need a token, a developer token, and a customer id. Nothing was stored." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
    return { ok: false, rows: [], error: "Google Ads insights need a YYYY-MM-DD range. Nothing was sent." };
  }
  if (!new RegExp(`^customers/${customerId}/adGroupAds/\\d+~\\d+$`).test(input.adResourceName)) {
    return { ok: false, rows: [], error: "Google Ads insights need the ad's resource name. Nothing was sent." };
  }
  const query = `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM ad_group_ad WHERE ad_group_ad.resource_name = '${input.adResourceName}' AND segments.date BETWEEN '${input.startDate}' AND '${input.endDate}'`;
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: `${ROOT}/customers/${customerId}/googleAds:search`,
    headers: headers(credentials),
    body: JSON.stringify({ query }),
  });
  const results = result.json && typeof result.json === "object" ? (result.json as { results?: unknown }).results : undefined;
  if (!result.ok || !Array.isArray(results)) {
    return { ok: false, rows: [], error: result.error || "Google Ads did not return insight rows. Nothing was stored." };
  }
  return { ok: true, rows: results.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object"), error: "" };
}
