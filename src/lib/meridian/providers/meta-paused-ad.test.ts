import assert from "node:assert/strict";
import test from "node:test";
import type { Transport, TransportRequest, TransportResponse } from "./http.ts";
import { GRAPH } from "./meta.ts";
import { createMetaPausedAd, listMetaAdSets, verifyMetaAdSet, type PausedAdInput } from "./meta-paused-ad.ts";

const TOKEN = "test-token-not-logged";
const ACCOUNT = "act_123";
const OWN_AD_SET = "as_own";
const FOREIGN_AD_SET = "as_foreign";

const INPUT: PausedAdInput = {
  adAccountId: ACCOUNT,
  adSetId: OWN_AD_SET,
  pageId: "page_1",
  videoId: "vid_9",
  link: "https://example.com/offer",
  message: "A short message",
  name: "Repurposed one [Meridian:abc123]",
};

type Fake = {
  transport: Transport;
  posts: { url: string; body: Record<string, unknown> }[];
  reads: string[];
  ads: Map<string, { id: string; name: string; adset: string; status: string; creative: string }>;
};

/**
 * An in-memory Meta. It stores creates and answers reads the way the Graph API does for the endpoints the module uses. Options script a
 * failure: `loseReplyOnAdCreate` creates the ad and then throws, as a dropped connection does; `adStatus` is what an ad reads back as.
 */
function fakeMeta(options: { loseReplyOnAdCreate?: boolean; adStatus?: string; failReadBackAttempts?: number } = {}): Fake {
  const posts: Fake["posts"] = [];
  const reads: string[] = [];
  const ads: Fake["ads"] = new Map();
  const creatives = new Map<string, string>();
  let next = 1;
  let lost = false;
  let readBackFailuresLeft = options.failReadBackAttempts ?? 0;
  const transport: Transport = async (request: TransportRequest): Promise<TransportResponse> => {
    const url = request.url;
    const ok = (json: unknown) => ({ status: 200, body: JSON.stringify(json), headers: {} });
    if (request.method === "POST") {
      const body = JSON.parse(String(request.body ?? "{}")) as Record<string, unknown>;
      posts.push({ url, body });
      if (url === `${GRAPH}/${ACCOUNT}/adcreatives`) {
        const id = `cr_${next++}`;
        creatives.set(id, String(body.name));
        return ok({ id });
      }
      if (url === `${GRAPH}/${ACCOUNT}/ads`) {
        const id = `ad_${next++}`;
        const creative = String((body.creative as { creative_id: string }).creative_id);
        ads.set(id, { id, name: String(body.name), adset: String(body.adset_id), status: String(body.status), creative });
        if (options.loseReplyOnAdCreate && !lost) {
          lost = true;
          throw new Error("connection reset after the ad was created");
        }
        return ok({ id });
      }
      throw new Error(`fake Meta: unexpected POST ${url}`);
    }
    reads.push(url);
    if (url.startsWith(`${GRAPH}/${OWN_AD_SET}?`)) return ok({ id: OWN_AD_SET, account_id: "123", name: "Own set", status: "PAUSED", campaign_id: "cmp_1" });
    if (url.startsWith(`${GRAPH}/${FOREIGN_AD_SET}?`)) return ok({ id: FOREIGN_AD_SET, account_id: "999", name: "Other", status: "PAUSED", campaign_id: "cmp_9" });
    if (url.startsWith(`${GRAPH}/${OWN_AD_SET}/ads?`)) {
      const data = [...ads.values()].filter((ad) => ad.adset === OWN_AD_SET).map((ad) => ({ id: ad.id, name: ad.name, status: ad.status }));
      return ok({ data });
    }
    if (url.startsWith(`${GRAPH}/${ACCOUNT}/adcreatives?`)) {
      return ok({ data: [...creatives.entries()].map(([id, name]) => ({ id, name })) });
    }
    if (url.startsWith(`${GRAPH}/${ACCOUNT}/adsets?`)) {
      return ok({ data: [{ id: OWN_AD_SET, name: "Own set", status: "PAUSED", campaign_id: "cmp_1" }] });
    }
    const adMatch = url.match(new RegExp(`^${GRAPH}/(ad_\\d+)\\?`));
    if (adMatch) {
      if (readBackFailuresLeft > 0) {
        readBackFailuresLeft -= 1;
        throw new Error("connection reset during the read-back");
      }
      const ad = ads.get(adMatch[1]!);
      if (!ad) return { status: 404, body: JSON.stringify({ error: { message: "not found" } }), headers: {} };
      return ok({ id: ad.id, status: options.adStatus ?? ad.status, effective_status: options.adStatus ?? ad.status, adset_id: ad.adset, creative: { id: ad.creative } });
    }
    throw new Error(`fake Meta: unexpected read ${url}`);
  };
  return { transport, posts, reads, ads };
}

const CREDENTIALS = { accessToken: TOKEN, adAccountId: ACCOUNT };

test("a paused ad is created once inside the chosen ad set, and every request says PAUSED, never ACTIVE", async () => {
  const fake = fakeMeta();
  const outcome = await createMetaPausedAd(CREDENTIALS, INPUT, fake.transport);
  assert.equal(outcome.status, "paused");
  assert.equal(outcome.status === "paused" && outcome.reused, false);
  assert.equal(fake.posts.length, 2, "one creative and one ad, each sent once");
  const adPost = fake.posts.find((post) => post.url.endsWith("/ads"));
  assert.equal(adPost?.body.status, "PAUSED");
  assert.equal(adPost?.body.adset_id, OWN_AD_SET);
  assert.ok(!JSON.stringify(fake.posts).includes("ACTIVE"), "nothing is ever sent as ACTIVE");
  assert.equal(fake.ads.size, 1);
});

test("an ad set that belongs to another ad account is refused before anything is created", async () => {
  const fake = fakeMeta();
  const outcome = await createMetaPausedAd(CREDENTIALS, { ...INPUT, adSetId: FOREIGN_AD_SET }, fake.transport);
  assert.equal(outcome.status, "blocked");
  assert.equal(fake.posts.length, 0, "no create was sent");
  const check = await verifyMetaAdSet(CREDENTIALS, ACCOUNT, FOREIGN_AD_SET, fake.transport);
  assert.equal(check.ok, false);
});

test("a lost reply after the ad was created is recovered by name on the next attempt, with no second ad", async () => {
  const fake = fakeMeta({ loseReplyOnAdCreate: true });
  const first = await createMetaPausedAd(CREDENTIALS, INPUT, fake.transport);
  assert.equal(first.status, "uncertain");
  assert.equal(first.status === "uncertain" && first.stage, "ad");
  assert.equal(fake.ads.size, 1, "Meta created the ad before the reply was lost");

  const second = await createMetaPausedAd(CREDENTIALS, INPUT, fake.transport);
  assert.equal(second.status, "paused");
  assert.equal(second.status === "paused" && second.reused, true, "the earlier ad was found, not created again");
  assert.equal(fake.ads.size, 1, "still exactly one ad");
  const adPosts = fake.posts.filter((post) => post.url.endsWith("/ads")).length;
  assert.equal(adPosts, 1, "the ad was posted once across both attempts");
});

test("when Meta reads the ad back as not paused, the result says so and does not claim a paused ad", async () => {
  const fake = fakeMeta({ adStatus: "ACTIVE" });
  const outcome = await createMetaPausedAd(CREDENTIALS, INPUT, fake.transport);
  assert.equal(outcome.status, "not_paused");
  assert.equal(outcome.status === "not_paused" && outcome.verifiedStatus, "ACTIVE");
});

test("without an ad account id, a Page, a video or a link, nothing is sent", async () => {
  const fake = fakeMeta();
  assert.equal((await createMetaPausedAd(CREDENTIALS, { ...INPUT, adAccountId: "123" }, fake.transport)).status, "blocked");
  assert.equal((await createMetaPausedAd(CREDENTIALS, { ...INPUT, link: "" }, fake.transport)).status, "blocked");
  assert.equal((await createMetaPausedAd(CREDENTIALS, { ...INPUT, pageId: "" }, fake.transport)).status, "blocked");
  assert.equal(fake.posts.length, 0);
});

test("listing ad sets is a read only: it names each ad set and creates nothing", async () => {
  const fake = fakeMeta();
  const listed = await listMetaAdSets(CREDENTIALS, ACCOUNT, fake.transport);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.ok && listed.adSets, [{ id: OWN_AD_SET, name: "Own set", status: "PAUSED", campaignId: "cmp_1" }]);
  assert.equal(fake.posts.length, 0);
});

test("a failed read-back after the ad was created is uncertain, and the next attempt confirms that ad without creating another", async () => {
  // sendWithRetry makes three attempts at a read, so the read-back fails for all three before the result is uncertain.
  const fake = fakeMeta({ failReadBackAttempts: 3 });
  const first = await createMetaPausedAd(CREDENTIALS, INPUT, fake.transport);
  assert.equal(first.status, "uncertain", "the ad may exist, so the result is not a clean failure");
  assert.equal(first.status === "uncertain" && first.stage, "ad");
  assert.equal(fake.ads.size, 1);

  const second = await createMetaPausedAd(CREDENTIALS, INPUT, fake.transport);
  assert.equal(second.status, "paused");
  assert.equal(second.status === "paused" && second.reused, true);
  assert.equal(fake.ads.size, 1, "no second ad was created");
  assert.equal(fake.posts.filter((post) => post.url.endsWith("/ads")).length, 1, "the ad was posted once");
});
