// A deterministic, in-memory Meta for the paused-ad tests. It answers the Graph calls the paused-ad path makes, from its own stored objects, and
// it scripts the failures the assignment names: a lost reply, a 5xx after creation, an id-less success, a refusal, a read-back that fails,
// a list that errors, a list longer than the page limit, and an ad that someone changed to ACTIVE. It makes no network call.
//
// Only the calls a test scripts are failures. Every other call behaves as Meta does for an ad account that holds these objects.

import type { Transport, TransportRequest, TransportResponse } from "../providers/http.ts";
import { GRAPH } from "../providers/meta.ts";

export type FakeBehaviour = "ok" | "refuse" | "lose_reply" | "five_hundred" | "no_id";

export type FakeAd = { id: string; name: string; status: string; adsetId: string; accountId: string; creativeId: string };
export type FakeCreative = { id: string; name: string; accountId: string };
export type FakePost = { kind: "creative" | "ad"; url: string; body: Record<string, unknown> };

export type FakeMetaOptions = {
  /** The account every ad set in the fake belongs to, numeric. Default "123". */
  adSetAccountId?: string;
  /** The page size of the account lists. A small size makes long lists page. */
  pageSize?: number;
  /** When true, every account list read fails with a 500. */
  listFailure?: boolean;
  /** How many read-backs of an ad by id fail with a dropped connection before they succeed. */
  readBackFailures?: number;
  /** Behaviours for the next ad creates, in order. Each entry is used once; "ok" is used when the list is empty. */
  adCreates?: FakeBehaviour[];
  /** Behaviours for the next creative creates, in order. */
  creativeCreates?: FakeBehaviour[];
  /** The status a read-back reports for every ad. Default: the status the ad was created with. */
  readBackStatus?: string;
};

export type FakeMeta = {
  transport: Transport;
  posts: FakePost[];
  ads: FakeAd[];
  creatives: FakeCreative[];
  /** Adds an object that someone else created in the account, for example an ad in another ad set. */
  seedAd(ad: Omit<FakeAd, "id"> & { id?: string }): FakeAd;
  /** Makes every account list fail from now on, or stops it failing. */
  failLists(on: boolean): void;
  /** How many reads of each ad id were answered. */
  reads: Map<string, number>;
};

function json(status: number, body: unknown): TransportResponse {
  return { status, body: JSON.stringify(body), headers: {} };
}

function numericOf(accountId: string): string {
  return accountId.replace(/^act_/, "");
}

export function fakeMeta(options: FakeMetaOptions = {}): FakeMeta {
  const adSetAccount = options.adSetAccountId ?? "123";
  const pageSize = options.pageSize ?? 100;
  const posts: FakePost[] = [];
  const ads: FakeAd[] = [];
  const creatives: FakeCreative[] = [];
  const reads = new Map<string, number>();
  const adCreates = [...(options.adCreates ?? [])];
  const creativeCreates = [...(options.creativeCreates ?? [])];
  let readBackFailuresLeft = options.readBackFailures ?? 0;
  let next = 1;

  function nextId(prefix: string): string {
    return `${prefix}_${next++}`;
  }

  function list(rows: unknown[], url: string): TransportResponse {
    const parsed = new URL(url);
    const offset = Number(parsed.searchParams.get("after") ?? "0");
    const page = rows.slice(offset, offset + pageSize);
    const more = offset + pageSize < rows.length;
    const nextUrl = more ? `${parsed.origin}${parsed.pathname}?${new URLSearchParams({ ...Object.fromEntries(parsed.searchParams), after: String(offset + pageSize) })}` : undefined;
    return json(200, { data: page, ...(nextUrl ? { paging: { next: nextUrl } } : {}) });
  }

  function create(kind: "creative" | "ad", request: TransportRequest, behaviour: FakeBehaviour): TransportResponse {
    const body = JSON.parse(String(request.body ?? "{}")) as Record<string, unknown>;
    posts.push({ kind, url: request.url, body });
    const accountId = numericOf(request.url.match(/\/(act_\d+)\//)?.[1] ?? "");
    if (kind === "creative") {
      if (behaviour === "refuse") return json(400, { error: { message: "invalid creative" } });
      const creative = { id: nextId("cr"), name: String(body.name), accountId };
      creatives.push(creative);
      return replyFor(behaviour, { id: creative.id });
    }
    if (behaviour === "refuse") return json(400, { error: { message: "invalid ad" } });
    const ad: FakeAd = {
      id: nextId("ad"),
      name: String(body.name),
      status: String(body.status ?? ""),
      adsetId: String(body.adset_id ?? ""),
      accountId,
      creativeId: String((body.creative as { creative_id?: string } | undefined)?.creative_id ?? ""),
    };
    ads.push(ad);
    return replyFor(behaviour, { id: ad.id });
  }

  /** The object is created before the reply is decided, so a lost or failed reply still leaves the object in the account. */
  function replyFor(behaviour: FakeBehaviour, body: { id: string }): TransportResponse {
    if (behaviour === "lose_reply") throw new LostReply();
    if (behaviour === "five_hundred") return json(500, { error: { message: "server error after the create" } });
    if (behaviour === "no_id") return json(200, {});
    return json(200, body);
  }

  let listsFail = options.listFailure ?? false;
  const transport: Transport = async (request: TransportRequest): Promise<TransportResponse> => {
    if (listsFail && request.method === "GET" && /\/act_\d+\/(ads|adcreatives)\?/.test(request.url)) {
      return json(500, { error: { message: "list failed" } });
    }
    if (request.method === "POST") {
      if (request.url.endsWith("/adcreatives")) return create("creative", request, creativeCreates.shift() ?? "ok");
      if (request.url.endsWith("/ads")) return create("ad", request, adCreates.shift() ?? "ok");
      throw new Error(`fake Meta: unexpected POST ${request.url}`);
    }

    const url = request.url;
    const adSetMatch = url.match(new RegExp(`^${GRAPH}/(as_[\\w-]+)\\?`));
    if (adSetMatch) return json(200, { id: adSetMatch[1], account_id: adSetAccount, name: "set", status: "PAUSED", campaign_id: "cmp" });

    const accountList = url.match(new RegExp(`^${GRAPH}/(act_\\d+)/(ads|adcreatives|adsets)\\?`));
    if (accountList) {
      const [, accountId, edge] = accountList;
      if (edge === "ads") {
        return list(ads.filter((ad) => ad.accountId === numericOf(accountId!)).map((ad) => ({ id: ad.id, name: ad.name, status: ad.status, effective_status: ad.status, adset_id: ad.adsetId, account_id: ad.accountId })), url);
      }
      if (edge === "adcreatives") {
        return list(creatives.filter((creative) => creative.accountId === numericOf(accountId!)).map((creative) => ({ id: creative.id, name: creative.name })), url);
      }
      return list([{ id: "as_one", name: "set", status: "PAUSED", campaign_id: "cmp" }], url);
    }

    const adRead = url.match(new RegExp(`^${GRAPH}/(ad_\\d+)\\?`));
    if (adRead) {
      const id = adRead[1]!;
      reads.set(id, (reads.get(id) ?? 0) + 1);
      if (readBackFailuresLeft > 0) {
        readBackFailuresLeft -= 1;
        throw new Error("connection reset during the read-back");
      }
      const ad = ads.find((candidate) => candidate.id === id);
      if (!ad) return json(404, { error: { message: "object does not exist" } });
      return json(200, {
        id: ad.id,
        name: ad.name,
        account_id: ad.accountId,
        adset_id: ad.adsetId,
        status: options.readBackStatus ?? ad.status,
        effective_status: options.readBackStatus ?? ad.status,
        creative: { id: ad.creativeId },
      });
    }
    throw new Error(`fake Meta: unexpected read ${url}`);
  };

  return {
    transport,
    posts,
    ads,
    creatives,
    reads,
    failLists(on) {
      listsFail = on;
    },
    seedAd(ad) {
      const created: FakeAd = { id: ad.id ?? nextId("ad"), name: ad.name, status: ad.status, adsetId: ad.adsetId, accountId: ad.accountId, creativeId: ad.creativeId };
      ads.push(created);
      return created;
    },
  };
}

/** The reply was lost after Meta created the object. The transport raises, as a dropped connection does. */
export class LostReply extends Error {
  constructor() {
    super("connection reset after the create reached Meta");
  }
}
