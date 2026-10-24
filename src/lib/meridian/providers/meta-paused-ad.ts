// The Meta calls behind a paused ad, one step at a time. The state machine that orders them is content-factory/repurpose-paused-ad.ts.
// Nothing here decides whether to create anything: each create function sends at most one POST, and each read says what it proved.
//
// What an answer proves:
// - A 2xx reply that names the object's id: the object was created. That id is the only proof of it.
// - A 4xx reply other than 429: Meta refused the request and created nothing.
// - Anything else (no reply, a 5xx, a 429, a 2xx with no id): uncertain. Meta may have created the object.
// A list that does not finish (a failed page, an unparseable reply, or more pages than the limit) is never evidence that an object is absent.

import { sendWithRetry, type Transport } from "./http.ts";
import { GRAPH, authHeaders, type MetaCredentials } from "./meta.ts";

export type MetaAdSetOption = { id: string; name: string; status: string; campaignId: string };

/** Pages read per list before the list is declared incomplete. A longer list is never treated as the whole list. */
const MAX_LIST_PAGES = 50;

type Row = Record<string, unknown>;

function text(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : typeof field === "number" ? String(field) : "";
}

function creativeIdOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return text((value as Record<string, unknown>).creative, "id");
}

type ListRead = { ok: true; rows: Row[] } | { ok: false; error: string };

/** Every row of a Graph list, following its paging. Any failure, or a list longer than the page limit, makes the read incomplete. */
async function readAllRows(credentials: MetaCredentials, transport: Transport, firstUrl: string): Promise<ListRead> {
  const rows: Row[] = [];
  let url: string | null = firstUrl;
  for (let page = 0; url !== null; page += 1) {
    if (page >= MAX_LIST_PAGES) {
      return { ok: false, error: `The list has more than ${MAX_LIST_PAGES} pages. Its end was not read, so nothing is treated as absent.` };
    }
    const result = await sendWithRetry(transport, { method: "GET", url, headers: authHeaders(credentials.accessToken) });
    if (!result.ok) return { ok: false, error: result.error || "Meta did not answer the list read." };
    const body = result.json && typeof result.json === "object" ? (result.json as { data?: unknown; paging?: { next?: unknown } }) : {};
    if (!Array.isArray(body.data)) return { ok: false, error: "Meta's list reply had no data list, so the list was not read." };
    for (const row of body.data) if (row && typeof row === "object") rows.push(row as Row);
    url = typeof body.paging?.next === "string" ? body.paging.next : null;
  }
  return { ok: true, rows };
}

/** The ad sets of the ad account, for the person to choose from. A read only; nothing is created. */
export async function listMetaAdSets(
  credentials: MetaCredentials,
  adAccountId: string,
  transport: Transport,
): Promise<{ ok: true; adSets: MetaAdSetOption[] } | { ok: false; error: string }> {
  if (!adAccountId.startsWith("act_")) return { ok: false, error: "The ad account id must start with act_." };
  const result = await readAllRows(credentials, transport, `${GRAPH}/${adAccountId}/adsets?fields=id,name,status,campaign_id&limit=100`);
  if (!result.ok) return result;
  const adSets = result.rows
    .map((row) => ({ id: text(row, "id"), name: text(row, "name"), status: text(row, "status"), campaignId: text(row, "campaign_id") }))
    .filter((adSet) => adSet.id !== "");
  return { ok: true, adSets };
}

/** Checks that an ad set exists and belongs to the ad account. Refuses otherwise, before anything is created. */
export async function verifyMetaAdSet(
  credentials: MetaCredentials,
  adAccountId: string,
  adSetId: string,
  transport: Transport,
): Promise<{ ok: true; adSet: MetaAdSetOption } | { ok: false; error: string }> {
  const numeric = adAccountId.slice(4);
  const result = await sendWithRetry(transport, {
    method: "GET",
    url: `${GRAPH}/${adSetId}?fields=id,account_id,name,status,campaign_id`,
    headers: authHeaders(credentials.accessToken),
  });
  if (!result.ok) return { ok: false, error: result.error || "Meta did not confirm the ad set. Nothing was created." };
  const body = result.json;
  if (text(body, "account_id") !== numeric) return { ok: false, error: "That ad set belongs to another ad account. Nothing was created." };
  return {
    ok: true,
    adSet: { id: text(body, "id"), name: text(body, "name"), status: text(body, "status"), campaignId: text(body, "campaign_id") },
  };
}

/** One object of this operation's marker, as the ad account's own lists report it. */
export type AccountObject = { id: string; name: string; status: string; effectiveStatus: string; adSetId: string; accountId: string };

export type AccountLookup =
  | { ok: true; ads: AccountObject[]; creatives: { id: string; name: string }[] }
  | { ok: false; error: string };

/**
 * Every ad and creative in the ad account whose name is exactly the operation's marker name. It reads the account's own edges, not one
 * ad set, so an ad created in another ad set is still found. A read that does not finish returns ok: false.
 */
export async function lookupPausedAdObjects(
  credentials: MetaCredentials,
  adAccountId: string,
  name: string,
  transport: Transport,
): Promise<AccountLookup> {
  if (!adAccountId.startsWith("act_")) return { ok: false, error: "The ad account id must start with act_." };
  const ads = await readAllRows(
    credentials,
    transport,
    `${GRAPH}/${adAccountId}/ads?fields=id,name,status,effective_status,adset_id,account_id&limit=100`,
  );
  if (!ads.ok) return ads;
  const creatives = await readAllRows(credentials, transport, `${GRAPH}/${adAccountId}/adcreatives?fields=id,name&limit=100`);
  if (!creatives.ok) return creatives;
  return {
    ok: true,
    ads: ads.rows
      .filter((row) => text(row, "name") === name)
      .map((row) => ({
        id: text(row, "id"),
        name: text(row, "name"),
        status: text(row, "status"),
        effectiveStatus: text(row, "effective_status"),
        adSetId: text(row, "adset_id"),
        accountId: text(row, "account_id"),
      })),
    creatives: creatives.rows.filter((row) => text(row, "name") === name).map((row) => ({ id: text(row, "id"), name: text(row, "name") })),
  };
}

export type CreateReply = { kind: "created"; id: string } | { kind: "refused"; error: string } | { kind: "uncertain"; error: string };

/** One POST. It is never retried here: a retry is a separate, reconciled attempt. */
async function sendCreateOnce(credentials: MetaCredentials, transport: Transport, url: string, body: unknown, label: string): Promise<CreateReply> {
  let reply;
  try {
    reply = await transport({ method: "POST", url, headers: authHeaders(credentials.accessToken), body: JSON.stringify(body) });
  } catch {
    return { kind: "uncertain", error: `No reply came from Meta for the ${label}. It may have been created.` };
  }
  let json: unknown = null;
  try {
    json = reply.body ? JSON.parse(reply.body) : null;
  } catch {
    json = null;
  }
  const id = text(json, "id");
  if (reply.status >= 200 && reply.status < 300) {
    return id ? { kind: "created", id } : { kind: "uncertain", error: `Meta answered the ${label} without its id. It may have been created.` };
  }
  if (reply.status >= 400 && reply.status < 500 && reply.status !== 429) {
    return { kind: "refused", error: `Meta refused the ${label} (status ${reply.status}). Nothing was created.` };
  }
  return { kind: "uncertain", error: `Meta answered the ${label} with status ${reply.status}. It may have been created.` };
}

export type PausedCreativeInput = {
  adAccountId: string;
  name: string;
  pageId: string;
  videoId: string;
  message: string;
  link: string;
};

export function createPausedCreative(credentials: MetaCredentials, input: PausedCreativeInput, transport: Transport): Promise<CreateReply> {
  return sendCreateOnce(
    credentials,
    transport,
    `${GRAPH}/${input.adAccountId}/adcreatives`,
    {
      name: input.name,
      object_story_spec: {
        page_id: input.pageId,
        video_data: {
          video_id: input.videoId,
          message: input.message,
          title: input.name,
          call_to_action: { type: "LEARN_MORE", value: { link: input.link } },
        },
      },
    },
    "creative",
  );
}

export type PausedAdObjectInput = { adAccountId: string; adSetId: string; creativeId: string; name: string };

/** The ad is created PAUSED. Nothing in this module ever sends a status other than PAUSED for an ad. */
export function createPausedAdObject(credentials: MetaCredentials, input: PausedAdObjectInput, transport: Transport): Promise<CreateReply> {
  return sendCreateOnce(
    credentials,
    transport,
    `${GRAPH}/${input.adAccountId}/ads`,
    { name: input.name, adset_id: input.adSetId, creative: { creative_id: input.creativeId }, status: "PAUSED" },
    "ad",
  );
}

/** What a read of one ad proved. Only `paused` says the ad is a paused ad of this operation. */
export type ReadBack =
  | { kind: "paused"; adId: string; creativeId: string }
  | { kind: "not_paused"; adId: string; status: string }
  | { kind: "not_this_object"; adId: string; reason: string }
  | { kind: "unreadable"; error: string };

/** Reads one ad by id and checks that it is the object of this operation: its account, name and ad set, and its status. */
export async function readPausedAd(
  credentials: MetaCredentials,
  adId: string,
  expect: { adAccountId: string; adSetId: string; name: string },
  transport: Transport,
): Promise<ReadBack> {
  const result = await sendWithRetry(transport, {
    method: "GET",
    url: `${GRAPH}/${adId}?fields=id,name,account_id,adset_id,status,effective_status,creative{id}`,
    headers: authHeaders(credentials.accessToken),
  });
  if (!result.ok) return { kind: "unreadable", error: result.error || "Meta did not return the ad. Its state is not confirmed." };
  const body = result.json;
  if (text(body, "id") !== adId) return { kind: "unreadable", error: "Meta's read did not return the ad that was created." };
  if (text(body, "account_id") !== expect.adAccountId.slice(4)) return { kind: "not_this_object", adId, reason: "The ad belongs to another ad account." };
  if (text(body, "name") !== expect.name) return { kind: "not_this_object", adId, reason: "The ad's name is not this operation's name." };
  if (text(body, "adset_id") !== expect.adSetId) return { kind: "not_this_object", adId, reason: "The ad is in a different ad set from the one chosen." };
  const status = text(body, "status");
  if (status !== "PAUSED") return { kind: "not_paused", adId, status: status || "UNKNOWN" };
  const creativeId = creativeIdOf(body);
  if (!creativeId) return { kind: "unreadable", error: "Meta's read of the paused ad named no creative, so it is not confirmed." };
  return { kind: "paused", adId, creativeId };
}
