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
