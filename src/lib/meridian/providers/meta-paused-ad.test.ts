import assert from "node:assert/strict";
import test from "node:test";
import { fakeMeta } from "../../../test-support/lib/meridian/testing/meta-paused-fake.ts";
import type { Transport, TransportRequest, TransportResponse } from "./http.ts";
import { GRAPH } from "./meta.ts";
import {
  createPausedAdObject,
  createPausedCreative,
  listMetaAdSets,
  lookupPausedAdObjects,
  readPausedAd,
  verifyMetaAdSet,
} from "./meta-paused-ad.ts";

const CREDENTIALS = { accessToken: "test-token-not-logged", adAccountId: "act_123" };
const NAME = "Repurposed variation-1 [Meridian:abc]";

function reply(status: number, body: unknown): TransportResponse {
  return { status, body: JSON.stringify(body), headers: {} };
}

/** A transport that answers one POST with `answer`, and still records every request it receives. */
function postAnswer(answer: () => TransportResponse | never): { transport: Transport; posts: TransportRequest[] } {
  const posts: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    if (request.method === "POST") {
      posts.push(request);
      return answer();
    }
    throw new Error("only the POST is scripted here");
  };
  return { transport, posts };
}

const ADS = { adAccountId: "act_123", adSetId: "as_a", name: NAME, pageId: "page_1", videoId: "vid_9", link: "https://example.com/o", message: "m" };

test("a 2xx reply with an id is a created object, and the ad is sent PAUSED", async () => {
  const { transport, posts } = postAnswer(() => reply(200, { id: "ad_new" }));
  const outcome = await createPausedAdObject(CREDENTIALS, { adAccountId: ADS.adAccountId, adSetId: ADS.adSetId, creativeId: "cr_1", name: NAME }, transport);
  assert.deepEqual(outcome, { kind: "created", id: "ad_new" });
  assert.equal(posts.length, 1, "one create, never retried here");
  const body = JSON.parse(String(posts[0]!.body)) as { status: string };
  assert.equal(body.status, "PAUSED");
});

test("a 2xx reply with no id is uncertain: the object may exist", async () => {
  const { transport } = postAnswer(() => reply(200, {}));
  const outcome = await createPausedAdObject(CREDENTIALS, { adAccountId: ADS.adAccountId, adSetId: ADS.adSetId, creativeId: "cr_1", name: NAME }, transport);
  assert.equal(outcome.kind, "uncertain");
});

test("a 5xx or a 429 is uncertain, because Meta may have created the object before it answered", async () => {
  for (const status of [500, 503, 429]) {
    const { transport } = postAnswer(() => reply(status, { error: {} }));
    const outcome = await createPausedAdObject(CREDENTIALS, { adAccountId: ADS.adAccountId, adSetId: ADS.adSetId, creativeId: "cr_1", name: NAME }, transport);
    assert.equal(outcome.kind, "uncertain", `status ${status}`);
  }
});

test("a dropped reply is uncertain, and it is sent once", async () => {
  const { transport, posts } = postAnswer(() => {
    throw new Error("connection reset");
  });
  const outcome = await createPausedCreative(CREDENTIALS, { adAccountId: ADS.adAccountId, name: NAME, pageId: "page_1", videoId: "vid_9", message: "m", link: "https://example.com/o" }, transport);
  assert.equal(outcome.kind, "uncertain");
  assert.equal(posts.length, 1, "a dropped create is not sent a second time here");
});

test("a 4xx refusal, other than 429, is a definite refusal with nothing created", async () => {
  const { transport } = postAnswer(() => reply(400, { error: { message: "invalid" } }));
  const outcome = await createPausedAdObject(CREDENTIALS, { adAccountId: ADS.adAccountId, adSetId: ADS.adSetId, creativeId: "cr_1", name: NAME }, transport);
  assert.equal(outcome.kind, "refused");
});

test("the account lookup finds every object with the marker name, across ad sets, and says it is complete", async () => {
  const fake = fakeMeta();
  fake.seedAd({ id: "ad_in_a", name: NAME, status: "PAUSED", adsetId: "as_a", accountId: "123", creativeId: "cr_x" });
  fake.seedAd({ id: "ad_in_b", name: NAME, status: "PAUSED", adsetId: "as_b", accountId: "123", creativeId: "cr_y" });
  fake.seedAd({ id: "ad_other", name: `${NAME} copy`, status: "PAUSED", adsetId: "as_a", accountId: "123", creativeId: "cr_z" });
  const lookup = await lookupPausedAdObjects(CREDENTIALS, "act_123", NAME, fake.transport);
  assert.equal(lookup.ok, true);
  assert.deepEqual(lookup.ok && lookup.ads.map((ad) => ad.id).sort(), ["ad_in_a", "ad_in_b"], "exact name only, in every ad set");
});

test("a list that fails is incomplete: the lookup says so and names no object as absent", async () => {
  const fake = fakeMeta({ listFailure: true });
  const lookup = await lookupPausedAdObjects(CREDENTIALS, "act_123", NAME, fake.transport);
  assert.equal(lookup.ok, false);
});

test("a list longer than the page limit is incomplete, not a shorter list that looks complete", async () => {
  const fake = fakeMeta({ pageSize: 1 });
  for (let i = 0; i < 60; i += 1) fake.seedAd({ name: `other ${i}`, status: "PAUSED", adsetId: "as_a", accountId: "123", creativeId: "cr" });
  const lookup = await lookupPausedAdObjects(CREDENTIALS, "act_123", NAME, fake.transport);
  assert.equal(lookup.ok, false, "more than 50 pages is not read to the end, so it is not complete");
});

test("a read-back shows the ad as paused only when it is in the chosen ad set, in this account, with this name", async () => {
  const fake = fakeMeta();
  const ad = fake.seedAd({ name: NAME, status: "PAUSED", adsetId: "as_a", accountId: "123", creativeId: "cr_1" });
  const expect = { adAccountId: "act_123", adSetId: "as_a", name: NAME };
  assert.deepEqual(await readPausedAd(CREDENTIALS, ad.id, expect, fake.transport), { kind: "paused", adId: ad.id, creativeId: "cr_1" });
  const otherSet = await readPausedAd(CREDENTIALS, ad.id, { ...expect, adSetId: "as_b" }, fake.transport);
  assert.equal(otherSet.kind, "not_this_object");
  const otherName = await readPausedAd(CREDENTIALS, ad.id, { ...expect, name: "different" }, fake.transport);
  assert.equal(otherName.kind, "not_this_object");
});

test("a read-back that finds the ad ACTIVE reports it as not paused, and does not change it", async () => {
  const fake = fakeMeta({ readBackStatus: "ACTIVE" });
  const ad = fake.seedAd({ name: NAME, status: "ACTIVE", adsetId: "as_a", accountId: "123", creativeId: "cr_1" });
  const read = await readPausedAd(CREDENTIALS, ad.id, { adAccountId: "act_123", adSetId: "as_a", name: NAME }, fake.transport);
  assert.deepEqual(read, { kind: "not_paused", adId: ad.id, status: "ACTIVE" });
  assert.equal(fake.posts.length, 0, "Meridian sent nothing that changes the ad");
});

test("a read-back that fails, or an ad that is missing, is unreadable, not a confirmation and not an absence", async () => {
  const fake = fakeMeta({ readBackFailures: 3 });
  const ad = fake.seedAd({ name: NAME, status: "PAUSED", adsetId: "as_a", accountId: "123", creativeId: "cr_1" });
  assert.equal((await readPausedAd(CREDENTIALS, ad.id, { adAccountId: "act_123", adSetId: "as_a", name: NAME }, fake.transport)).kind, "unreadable");
  assert.equal((await readPausedAd(CREDENTIALS, "ad_missing", { adAccountId: "act_123", adSetId: "as_a", name: NAME }, fake.transport)).kind, "unreadable");
});

test("an ad set that belongs to another ad account is refused before anything is created", async () => {
  const fake = fakeMeta({ adSetAccountId: "999" });
  const check = await verifyMetaAdSet(CREDENTIALS, "act_123", "as_a", fake.transport);
  assert.equal(check.ok, false);
});

test("listing ad sets is read only", async () => {
  const fake = fakeMeta();
  const listed = await listMetaAdSets(CREDENTIALS, "act_123", fake.transport);
  assert.equal(listed.ok, true);
  assert.equal(fake.posts.length, 0);
});

test("the graph base is the one the module sends to", () => {
  assert.match(GRAPH, /^https:\/\/graph\.facebook\.com\//);
});
