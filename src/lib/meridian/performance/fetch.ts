import { redactSecrets } from "../observability/redact.ts";
import type { Transport } from "../providers/http.ts";
import { fetchGoogleInsights } from "../providers/google-ads.ts";
import { fetchMetaInsights } from "../providers/meta.ts";
import { fetchTikTokInsights } from "../providers/tiktok.ts";
import { googleInsightEvent, metaInsightEvent, performanceApiImplemented, tiktokInsightEvent, type InsightRow } from "./sync.ts";
import type { PerformanceEvent } from "./normalize.ts";

export type InsightRequest = {
  provider: string;
  externalAdId: string;
  creativeId: string;
  currency: string;
  timezone: string;
  startDate: string;
  endDate: string;
  env: NodeJS.ProcessEnv;
};

/** Fetches one provider's insights. A missing credential or a failed response stores nothing. */
export async function loadProviderInsights(
  input: InsightRequest,
  transport: Transport,
): Promise<{ events: PerformanceEvent[] } | { error: string }> {
  if (!performanceApiImplemented(input.provider)) {
    return { error: `${input.provider} performance sync is not implemented. No observations were stored.` };
  }
  if (!input.creativeId.trim() || !input.externalAdId.trim() || !input.currency.trim() || !input.timezone.trim()) {
    return { error: "Performance sync needs a creative, an external ad id, a currency, and a timezone. Nothing was stored." };
  }
  try {
    if (input.provider === "meta") return await metaEvents(input, transport);
    if (input.provider === "tiktok") return await tiktokEvents(input, transport);
    return await googleEvents(input, transport);
  } catch (error) {
    return { error: redactSecrets(error instanceof Error ? error.message : "The provider request failed. Nothing was stored.") };
  }
}

async function metaEvents(input: InsightRequest, transport: Transport): Promise<{ events: PerformanceEvent[] } | { error: string }> {
  const token = input.env.META_ACCESS_TOKEN?.trim() ?? "";
  if (!token) return { error: "Meta performance sync has no access token. No observations were stored." };
  const fetched = await fetchMetaInsights({ accessToken: token }, input.externalAdId, transport);
  if (!fetched.ok) return { error: redactSecrets(fetched.error || "Meta insights failed. No observations were stored.") };
  return {
    events: fetched.rows.map((row, index) =>
      metaInsightEvent({
        row: row as InsightRow,
        creativeId: input.creativeId,
        externalId: `${input.externalAdId}:${index}:${(row as InsightRow).date_start ?? ""}`,
        currency: input.currency,
        timezone: input.timezone,
      }),
    ),
  };
}

async function tiktokEvents(input: InsightRequest, transport: Transport): Promise<{ events: PerformanceEvent[] } | { error: string }> {
  const token = input.env.TIKTOK_ACCESS_TOKEN?.trim() ?? "";
  const advertiserId = input.env.TIKTOK_ADVERTISER_ID?.trim() ?? "";
  if (!token || !advertiserId) return { error: "TikTok performance sync has no access token or advertiser id. No observations were stored." };
  const fetched = await fetchTikTokInsights(
    { accessToken: token, advertiserId },
    { adId: input.externalAdId, startDate: input.startDate, endDate: input.endDate },
    transport,
  );
  if (!fetched.ok) return { error: redactSecrets(fetched.error || "TikTok insights failed. No observations were stored.") };
  return {
    events: fetched.rows.map((row, index) =>
      tiktokInsightEvent({
        row,
        creativeId: input.creativeId,
        externalId: `${input.externalAdId}:${index}:${dayOf(row)}`,
        currency: input.currency,
        timezone: input.timezone,
      }),
    ),
  };
}

async function googleEvents(input: InsightRequest, transport: Transport): Promise<{ events: PerformanceEvent[] } | { error: string }> {
  const token = input.env.GOOGLE_ADS_ACCESS_TOKEN?.trim() ?? "";
  const developerToken = input.env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() ?? "";
  const customerId = input.env.GOOGLE_ADS_CUSTOMER_ID?.trim() ?? "";
  if (!token || !developerToken || !customerId) {
    return { error: "Google Ads performance sync is missing a token, developer token, or customer id. No observations were stored." };
  }
  const fetched = await fetchGoogleInsights(
    { accessToken: token, developerToken, customerId },
    { adResourceName: input.externalAdId, startDate: input.startDate, endDate: input.endDate },
    transport,
  );
  if (!fetched.ok) return { error: redactSecrets(fetched.error || "Google Ads insights failed. No observations were stored.") };
  return {
    events: fetched.rows.map((row, index) =>
      googleInsightEvent({
        row,
        creativeId: input.creativeId,
        externalId: `${input.externalAdId}:${index}:${typeof row.segments === "object" && row.segments && "date" in row.segments ? String((row.segments as { date?: unknown }).date ?? "") : ""}`,
        currency: input.currency,
        timezone: input.timezone,
      }),
    ),
  };
}

function dayOf(row: Record<string, unknown>): string {
  const dimensions = row.dimensions;
  if (!dimensions || typeof dimensions !== "object") return "";
  const day = (dimensions as { stat_time_day?: unknown }).stat_time_day;
  return typeof day === "string" ? day.slice(0, 10) : "";
}
