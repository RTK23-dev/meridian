import { collectPages, sendWithRetry, type Transport } from "./http.ts";

const GRAPH = "https://graph.facebook.com/v21.0";

export type MetaCredentials = {
  accessToken: string;
  adAccountId?: string;
};

export type ProbeAccount = { id: string; name: string };

export type ProbeResult =
  | { ok: true; accountId: string; accountName: string; accounts: ProbeAccount[]; permissions: string[] }
  | { ok: false; error: string; status: number };

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export async function probeMeta(credentials: MetaCredentials, transport: Transport): Promise<ProbeResult> {
  if (!credentials.accessToken.trim()) return { ok: false, error: "Meta access token is empty.", status: 0 };
  const me = await sendWithRetry(transport, {
    method: "GET",
    url: `${GRAPH}/me?fields=id,name`,
    headers: authHeaders(credentials.accessToken),
  });
  const meId = textField(me.json, "id");
  if (!me.ok || !meId) {
    return { ok: false, error: me.error || "Meta did not return an account id.", status: me.status };
  }
  const accounts = await adAccounts(credentials.accessToken, transport);
  const permissions = await grantedPermissions(credentials.accessToken, transport);
  return {
    ok: true,
    accountId: meId,
    accountName: textField(me.json, "name"),
    accounts: accounts.accounts,
    permissions,
  };
}

async function adAccounts(token: string, transport: Transport): Promise<{ accounts: ProbeAccount[]; error: string }> {
  const collected = await collectPages(
    transport,
    { method: "GET", url: `${GRAPH}/me/adaccounts?fields=id,name,account_status&limit=25`, headers: authHeaders(token) },
    (json) => {
      const paging = json && typeof json === "object" ? (json as { paging?: { next?: string } }).paging : undefined;
      return paging?.next || null;
    },
  );
  const accounts: ProbeAccount[] = [];
  for (const page of collected.pages) {
    const data = page && typeof page === "object" ? (page as { data?: unknown }).data : undefined;
    if (!Array.isArray(data)) continue;
    for (const row of data) {
      const id = textField(row, "id");
      if (id) accounts.push({ id, name: textField(row, "name") });
    }
  }
  return { accounts, error: collected.error };
}

async function grantedPermissions(token: string, transport: Transport): Promise<string[]> {
  const result = await sendWithRetry(transport, {
    method: "GET",
    url: `${GRAPH}/me/permissions`,
    headers: authHeaders(token),
  });
  const data = result.json && typeof result.json === "object" ? (result.json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => {
      if (!row || typeof row !== "object") return "";
      const record = row as { permission?: string; status?: string };
      return record.status === "granted" && record.permission ? record.permission : "";
    })
    .filter(Boolean);
}

export type PublishStep = "campaign" | "ad_set" | "creative" | "ad";

export type MetaPublishInput = {
  adAccountId: string;
  name: string;
  dailyBudgetCents: number;
  countries: string[];
  pageId: string;
  message: string;
  link: string;
  existing?: Partial<Record<PublishStep, string>>;
};

export type PublishStepResult =
  | { status: "stored"; externalId: string; reused: boolean }
  | { status: "failed"; externalId: null; error: string };

/** Creates paused Meta objects. An id is returned only when the response contains one. */
export async function publishMetaPaused(
  credentials: MetaCredentials,
  input: MetaPublishInput,
  transport: Transport,
): Promise<Record<PublishStep, PublishStepResult>> {
  const account = input.adAccountId.startsWith("act_") ? input.adAccountId : "";
  const failed = (error: string): PublishStepResult => ({ status: "failed", externalId: null, error });
  if (!account) {
    const error = "Meta publishing needs an ad account id that starts with act_. Nothing was sent.";
    return { campaign: failed(error), ad_set: failed(error), creative: failed(error), ad: failed(error) };
  }
  const campaign = await createOrReuse(credentials, transport, "campaign", input.existing?.campaign, `${GRAPH}/${account}/campaigns`, {
    name: input.name,
    objective: "OUTCOME_TRAFFIC",
    status: "PAUSED",
    special_ad_categories: [],
  });
  if (campaign.status !== "stored") {
    return { campaign, ad_set: failed(campaign.error), creative: failed(campaign.error), ad: failed(campaign.error) };
  }
  if (!input.countries.length || input.dailyBudgetCents <= 0) {
    const error = "Meta ad set needs a daily budget and at least one country. Nothing further was sent.";
    return { campaign, ad_set: failed(error), creative: failed(error), ad: failed(error) };
  }
  const adSet = await createOrReuse(credentials, transport, "ad_set", input.existing?.ad_set, `${GRAPH}/${account}/adsets`, {
    name: input.name,
    campaign_id: campaign.externalId,
    daily_budget: String(input.dailyBudgetCents),
    billing_event: "IMPRESSIONS",
    optimization_goal: "LINK_CLICKS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: { geo_locations: { countries: input.countries } },
    status: "PAUSED",
  });
  if (adSet.status !== "stored") {
    return { campaign, ad_set: adSet, creative: failed(adSet.error), ad: failed(adSet.error) };
  }
  if (!input.pageId || !input.link) {
    const error = "Meta creative needs a page id and a link. Nothing further was sent.";
    return { campaign, ad_set: adSet, creative: failed(error), ad: failed(error) };
  }
  const creative = await createOrReuse(credentials, transport, "creative", input.existing?.creative, `${GRAPH}/${account}/adcreatives`, {
    name: input.name,
    object_story_spec: { page_id: input.pageId, link_data: { message: input.message, link: input.link, name: input.name } },
  });
  if (creative.status !== "stored") {
    return { campaign, ad_set: adSet, creative, ad: failed(creative.error) };
  }
  const ad = await createOrReuse(credentials, transport, "ad", input.existing?.ad, `${GRAPH}/${account}/ads`, {
    name: input.name,
    adset_id: adSet.externalId,
    creative: { creative_id: creative.externalId },
    status: "PAUSED",
  });
  return { campaign, ad_set: adSet, creative, ad };
}

async function createOrReuse(
  credentials: MetaCredentials,
  transport: Transport,
  _step: PublishStep,
  existing: string | undefined,
  url: string,
  body: unknown,
): Promise<PublishStepResult> {
  if (existing?.trim()) return { status: "stored", externalId: existing, reused: true };
  const result = await sendWithRetry(transport, {
    method: "POST",
    url,
    headers: authHeaders(credentials.accessToken),
    body: JSON.stringify(body),
  });
  const id = textField(result.json, "id");
  if (!result.ok || !id) return { status: "failed", externalId: null, error: result.error || "Meta did not return an id. Nothing was stored." };
  return { status: "stored", externalId: id, reused: false };
}

export async function setMetaStatus(
  credentials: MetaCredentials,
  externalId: string,
  status: "PAUSED" | "ACTIVE",
  transport: Transport,
): Promise<{ ok: boolean; error: string }> {
  if (!externalId.trim()) return { ok: false, error: "No external id to update." };
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: `${GRAPH}/${externalId}`,
    headers: authHeaders(credentials.accessToken),
    body: JSON.stringify({ status }),
  });
  return { ok: result.ok, error: result.ok ? "" : result.error || "Meta did not confirm the status change." };
}

export function metaInsightsUrl(externalId: string): string {
  return `${GRAPH}/${externalId}/insights?fields=impressions,reach,clicks,spend,actions&date_preset=yesterday`;
}

export async function fetchMetaInsights(
  credentials: MetaCredentials,
  externalId: string,
  transport: Transport,
): Promise<{ ok: boolean; rows: unknown[]; error: string }> {
  const collected = await collectPages(
    transport,
    { method: "GET", url: metaInsightsUrl(externalId), headers: authHeaders(credentials.accessToken) },
    (json) => {
      const paging = json && typeof json === "object" ? (json as { paging?: { next?: string } }).paging : undefined;
      return paging?.next || null;
    },
  );
  const rows: unknown[] = [];
  for (const page of collected.pages) {
    const data = page && typeof page === "object" ? (page as { data?: unknown }).data : undefined;
    if (Array.isArray(data)) rows.push(...data);
  }
  return { ok: !collected.error, rows, error: collected.error };
}

export async function probeAdLibrary(token: string, transport: Transport): Promise<ProbeResult> {
  if (!token.trim()) return { ok: false, error: "Ad library token is empty.", status: 0 };
  const result = await sendWithRetry(transport, {
    method: "GET",
    url: `${GRAPH}/ads_archive?ad_reached_countries=${encodeURIComponent('["US"]')}&ad_type=ALL&limit=1`,
    headers: authHeaders(token),
  });
  const data = result.json && typeof result.json === "object" ? (result.json as { data?: unknown }).data : undefined;
  if (!result.ok || !Array.isArray(data)) {
    return { ok: false, error: result.error || "Ad library did not return a data array. No ads were stored.", status: result.status };
  }
  return { ok: true, accountId: "", accountName: "Ad library", accounts: [], permissions: [] };
}

function textField(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
}
