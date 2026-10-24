// Creates one PAUSED Meta ad from an uploaded video, inside an ad set the user chose. It creates no campaign and no ad set, and it never
// sets an ad to ACTIVE. The result records only what Meta returned and what a read-back confirmed.
//
// A create that gets no reply may still have been processed by Meta. So each create is sent once, with no automatic retry, and every
// later attempt first looks for an object with the same name in the same place. A lost reply is then recovered, not duplicated.

import { sendWithRetry, type Transport } from "./http.ts";
import { GRAPH, authHeaders, type MetaCredentials } from "./meta.ts";

export type MetaAdSetOption = { id: string; name: string; status: string; campaignId: string };

export type PausedAdInput = {
  /** The brand's saved ad account, as act_<digits>. */
  adAccountId: string;
  /** The ad set the user explicitly chose. Checked to belong to the ad account before anything is created. */
  adSetId: string;
  pageId: string;
  videoId: string;
  /** The destination link the ad sends people to. Required; the creative cannot be built without it. */
  link: string;
  message: string;
  /** The ad and creative name. It carries a Meridian marker, so a retry can find what an earlier attempt created. */
  name: string;
};

export type PausedAdOutcome =
  | { status: "paused"; adId: string; creativeId: string; adSetId: string; reused: boolean }
  | { status: "blocked"; reason: string }
  | { status: "uncertain"; stage: "creative" | "ad"; error: string }
  | { status: "failed"; error: string }
  | { status: "not_paused"; adId: string; verifiedStatus: string };

type Row = Record<string, unknown>;

function text(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : typeof field === "number" ? String(field) : "";
}

/** Every row of a Graph list, following its paging. A failed page stops the read, so nothing is reused or created on a partial list. */
async function readAll(credentials: MetaCredentials, transport: Transport, firstUrl: string): Promise<{ ok: true; rows: Row[] } | { ok: false; error: string }> {
  const rows: Row[] = [];
  let url: string | null = firstUrl;
  for (let page = 0; url && page < 100; page += 1) {
    const result = await sendWithRetry(transport, { method: "GET", url, headers: authHeaders(credentials.accessToken) });
    if (!result.ok) return { ok: false, error: result.error || "Meta did not answer the read. Nothing was sent." };
    const body = result.json && typeof result.json === "object" ? (result.json as { data?: unknown; paging?: { next?: string } }) : {};
    if (Array.isArray(body.data)) for (const row of body.data) if (row && typeof row === "object") rows.push(row as Row);
    url = body.paging?.next ?? null;
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
  const result = await readAll(credentials, transport, `${GRAPH}/${adAccountId}/adsets?fields=id,name,status,campaign_id&limit=100`);
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

/** Creates the paused ad, or finds the one an earlier attempt created. Creates are sent once; a retry reconciles by name first. */
export async function createMetaPausedAd(
  credentials: MetaCredentials,
  input: PausedAdInput,
  transport: Transport,
): Promise<PausedAdOutcome> {
  if (!input.adAccountId.startsWith("act_")) {
    return { status: "blocked", reason: "The ad account id must start with act_. Nothing was created." };
  }
  if (!input.pageId || !input.videoId || !input.link) {
    return { status: "blocked", reason: "The ad needs a Page, an uploaded video and a destination link. Nothing was created." };
  }
  const destination = await verifyMetaAdSet(credentials, input.adAccountId, input.adSetId, transport);
  if (!destination.ok) return { status: "blocked", reason: destination.error };

  // An ad from an earlier attempt, found by name in this ad set. More than one match is ambiguous, so nothing is reused or created.
  const existing = await readAll(credentials, transport, `${GRAPH}/${input.adSetId}/ads?fields=id,name,status&limit=100`);
  if (!existing.ok) return { status: "failed", error: existing.error };
  const matches = existing.rows.filter((row) => text(row, "name") === input.name);
  if (matches.length > 1) return { status: "blocked", reason: "More than one ad with this name is in the ad set. Nothing was created." };
  if (matches.length === 1) return confirmPaused(credentials, transport, text(matches[0], "id"), input.adSetId, true);

  // The creative: reuse one with this name, or create it once.
  const creativeList = await readAll(credentials, transport, `${GRAPH}/${input.adAccountId}/adcreatives?fields=id,name&limit=100`);
  if (!creativeList.ok) return { status: "failed", error: creativeList.error };
  const creativeMatches = creativeList.rows.filter((row) => text(row, "name") === input.name);
  if (creativeMatches.length > 1) return { status: "blocked", reason: "More than one creative with this name exists. Nothing was created." };
  let creativeId = text(creativeMatches[0], "id");
  if (!creativeId) {
    const created = await sendOnce(credentials, transport, `${GRAPH}/${input.adAccountId}/adcreatives`, {
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
    });
    if (created.kind === "uncertain") return { status: "uncertain", stage: "creative", error: created.error };
    if (created.kind === "failed") return { status: "failed", error: created.error };
    creativeId = created.id;
  }

  const ad = await sendOnce(credentials, transport, `${GRAPH}/${input.adAccountId}/ads`, {
    name: input.name,
    adset_id: input.adSetId,
    creative: { creative_id: creativeId },
    status: "PAUSED",
  });
  if (ad.kind === "uncertain") return { status: "uncertain", stage: "ad", error: ad.error };
  if (ad.kind === "failed") return { status: "failed", error: ad.error };
  return confirmPaused(credentials, transport, ad.id, input.adSetId, false, creativeId);
}

/** Reads the ad back. The result is "paused" only when Meta reports the ad as PAUSED; anything else is reported as not paused. */
async function confirmPaused(
  credentials: MetaCredentials,
  transport: Transport,
  adId: string,
  adSetId: string,
  reused: boolean,
  knownCreativeId = "",
): Promise<PausedAdOutcome> {
  const result = await sendWithRetry(transport, {
    method: "GET",
    url: `${GRAPH}/${adId}?fields=id,status,effective_status,adset_id,creative{id}`,
    headers: authHeaders(credentials.accessToken),
  });
  // The ad may already exist, so a failed read-back is uncertain, never a clean failure: the next attempt reconciles by name.
  if (!result.ok) return { status: "uncertain", stage: "ad", error: "Meta created or found the ad, but the read-back failed. The next attempt confirms it before anything else is created." };
  const status = text(result.json, "status");
  if (status !== "PAUSED") return { status: "not_paused", adId, verifiedStatus: status || "unknown" };
  const creative = result.json && typeof result.json === "object" ? (result.json as { creative?: unknown }).creative : undefined;
  return { status: "paused", adId, creativeId: knownCreativeId || text(creative, "id"), adSetId, reused };
}

/** One create, with no retry. An error with no reply is "uncertain": Meta may have created the object. */
async function sendOnce(
  credentials: MetaCredentials,
  transport: Transport,
  url: string,
  body: unknown,
): Promise<{ kind: "created"; id: string } | { kind: "failed"; error: string } | { kind: "uncertain"; error: string }> {
  let reply;
  try {
    reply = await transport({ method: "POST", url, headers: authHeaders(credentials.accessToken), body: JSON.stringify(body) });
  } catch {
    return { kind: "uncertain", error: "No reply came from Meta. It may have created the object, so the next attempt looks for it before creating another." };
  }
  let json: unknown = null;
  try {
    json = reply.body ? JSON.parse(reply.body) : null;
  } catch {
    json = null;
  }
  const id = text(json, "id");
  if (reply.status >= 200 && reply.status < 300 && id) return { kind: "created", id };
  // A server error, or a success with no id, may still have created the object. It is uncertain, so the claim is kept and the next attempt
  // looks for it by name. Only a refusal (a 4xx or another status) is a definite failure with nothing created.
  if (reply.status >= 500 || (reply.status >= 200 && reply.status < 300)) {
    return { kind: "uncertain", error: `Meta answered with status ${reply.status} without confirming the object. It may exist, so the next attempt looks for it before creating another.` };
  }
  return { kind: "failed", error: `Meta did not create the object (status ${reply.status}). Nothing was stored.` };
}
