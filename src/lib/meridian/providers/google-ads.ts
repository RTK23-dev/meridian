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
