// The organic publish guard, on the test database, with a fake transport behind the real Facebook Page channel. No test reaches a network.
// A creative is sent to one destination at most once: a confirmed post is returned, not re-sent; an unknown outcome waits for a person's
// confirmation; a definite refusal can be tried again; two requests send one; an expired claim becomes uncertain, not re-sent; and
// another workspace can neither see nor take the claim.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { Transport, TransportRequest, TransportResponse } from "../providers/http.ts";
import { storeVaultCredential } from "../vault/service.ts";
import { CapabilityDisabledError } from "../providers/capability.ts";
import { FacebookPagesChannel } from "./facebook.ts";
import { acquireClaim, claimsForCreative } from "./publish-claims.ts";
import { getDistributionChannel, registerDistributionChannel } from "./registry.ts";
import { publishCreativeToChannels, type PublishChannelResult } from "./service.ts";

const KEY = "publish-claims-test-key-not-real";
const ORG = "ws_claims_a";
const BRAND = "brand_claims_a";
const USER = "user_claims_a";
const OTHER_ORG = "ws_claims_b";
const OTHER_BRAND = "brand_claims_b";
const OTHER_USER = "user_claims_b";
const CREATIVE = "creative_claims_1";
const PAGE = "page-9";
const CHANNEL = "facebook-pages";
const MEDIA = { bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]) };

const ok = (id: string): TransportResponse => ({ status: 200, body: JSON.stringify({ id }), headers: {} });
const refused: TransportResponse = { status: 400, body: JSON.stringify({ error: { message: "The video is not valid.", code: 100 } }), headers: {} };

/** A fake Graph API. Each request takes the next scripted answer (an Error is a request that got no reply), and is counted. */
function fakeTransport(script: (TransportResponse | Error)[], gate?: Promise<void>): { transport: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    calls.push(request);
    if (gate) await gate;
    const next = script[Math.min(calls.length - 1, script.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}

describe("organic publish claims", () => {
  let db: TestDatabase;
  const original = getDistributionChannel(CHANNEL)!;
  let priorKey: string | undefined;
  let creativeCounter = 0;
  let creative = CREATIVE;

  async function seedUser(userId: string, organizationId: string): Promise<void> {
    await db.sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${userId}, ${`${userId}@fixture.example`}, true)`;
    await db.sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${userId}`}, ${organizationId}, ${userId}, 'member')`;
  }

  async function seedCreative(id: string, organizationId: string, brandId: string): Promise<void> {
    await db.sql`
      insert into creative_records (id, organization_id, brand_id, origin, created_by, title, raw_text)
      values (${id}, ${organizationId}, ${brandId}, 'generated', 'test', 'A title', 'A caption')
    `;
    await db.sql`update creative_records set status = 'approved' where id = ${id}`;
    await db.sql`
      insert into assets (id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status, kind, variant_index, media_status)
      values (${`asset-${id}`}, ${organizationId}, ${brandId}, ${id}, 1, ${`k/${id}`}, 'h', 'video/mp4', 'test', 'stored', 'video', 0, 'completed')
    `;
  }

  before(async () => {
    priorKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
    db = await createTestDatabase();
    await seedWorkspace(db.sql, ORG, BRAND);
    await seedWorkspace(db.sql, OTHER_ORG, OTHER_BRAND);
    await seedUser(USER, ORG);
    await seedUser(OTHER_USER, OTHER_ORG);
    const credential = await storeVaultCredential(db.sql, ORG, "oauth_token", { accessToken: "page-token-not-real" }, { masterKey: KEY });
    await db.sql`
      insert into platform_accounts (id, organization_id, brand_id, platform, external_account_id, name, credential_id, status)
      values ('pa-claims-fb', ${ORG}, ${BRAND}, 'facebook', ${PAGE}, 'Fixture Page', ${credential.id}, 'connected')
    `;
  });

  after(async () => {
    await db.close();
    if (priorKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = priorKey;
  });

  beforeEach(async () => {
    creativeCounter += 1;
    creative = `${CREATIVE}_${creativeCounter}`;
    await seedCreative(creative, ORG, BRAND);
  });

  afterEach(() => {
    registerDistributionChannel(original);
  });

  function useTransport(transport: Transport): void {
    registerDistributionChannel(new FacebookPagesChannel({ transport }));
  }

  function publish(options: { confirmRetry?: boolean; now?: () => Date } = {}): Promise<PublishChannelResult[]> {
    return publishCreativeToChannels(
      db.sql,
      { organizationId: ORG, brandId: BRAND, creativeId: creative, channelIds: [CHANNEL], userId: USER, confirmRetry: options.confirmRetry },
      { loadMedia: async () => MEDIA, now: options.now },
    );
  }

  async function claim(): Promise<{ status: string; external_id: string; receipt_code: string; error: string; attempt: number } | undefined> {
    const rows = await db.sql<{ status: string; external_id: string; receipt_code: string; error: string; attempt: number }>`
      select status, external_id, receipt_code, error, attempt from organic_publish_claims
      where organization_id = ${ORG} and creative_id = ${creative} and channel_id = ${CHANNEL}
    `;
    return rows[0];
  }

  async function postStatuses(): Promise<string[]> {
    const rows = await db.sql<{ status: string }>`select status from organic_posts where creative_id = ${creative} order by created_at, id`;
    return rows.map((row) => row.status);
  }

  it("a second publish of the same creative and channel after success does not call the provider", async () => {
    const fake = fakeTransport([ok("vid-1")]);
    useTransport(fake.transport);
    const first = await publish();
    assert.equal(first[0]?.status, "published");
    assert.equal(first[0]?.externalId, "vid-1");

    const second = await publish();
    assert.equal(fake.calls.length, 1, "the provider was called once");
    assert.equal(second[0]?.status, "published");
    assert.equal(second[0]?.externalId, "vid-1", "the earlier receipt is returned");
    assert.equal(second[0]?.alreadySent, true);
    assert.deepEqual(await postStatuses(), ["published"], "one receipt row, and the readers still see it");
    assert.equal((await claim())?.status, "published");
  });

  it("a timeout leaves the claim uncertain, and a second call does not send", async () => {
    const fake = fakeTransport([new Error("Provider request timed out after 30 seconds."), ok("vid-never")]);
    useTransport(fake.transport);
    const first = await publish();
    assert.equal(first[0]?.status, "uncertain");
    assert.equal(first[0]?.receiptCode, "UNCONFIRMED");
    assert.match(first[0]?.error ?? "", /Check Facebook first/);
    assert.equal((await claim())?.status, "uncertain");
    assert.equal((await claim())?.receipt_code, "UNCONFIRMED");

    const second = await publish();
    assert.equal(second[0]?.status, "uncertain");
    assert.match(second[0]?.error ?? "", /may have gone out, so nothing was sent now/);
    assert.equal(fake.calls.length, 1, "no second request");
    assert.deepEqual(await postStatuses(), ["uncertain"], "an unknown outcome is never stored as published");
  });

  it("a rate limit (RETRYABLE) is uncertain too", async () => {
    const limited = fakeTransport([{ status: 429, body: JSON.stringify({ error: { message: "slow down", code: 4 } }), headers: {} }]);
    useTransport(limited.transport);
    assert.equal((await publish())[0]?.status, "uncertain");
    assert.equal((await claim())?.receipt_code, "RETRYABLE");
    assert.equal((await publish())[0]?.status, "uncertain");
    assert.equal(limited.calls.length, 1);
  });

  it("an error thrown out of the channel is uncertain, and a thrown disabled-path error is a refusal that sent nothing", async () => {
    let calls = 0;
    const throwing = (error: Error) => ({
      id: CHANNEL,
      platform: "facebook" as const,
      targetType: "organic_post" as const,
      displayName: "Fake",
      checkConnection: () => ({ connected: true }),
      async publish(): Promise<never> {
        calls += 1;
        throw error;
      },
      async fetchMetrics() {
        return { status: "not_implemented" as const, reason: "fake" };
      },
    });
    registerDistributionChannel(throwing(new Error("socket hang up")) as never);
    const first = await publish();
    assert.equal(first[0]?.status, "uncertain");
    assert.equal((await claim())?.receipt_code, "TRANSPORT_ERROR");
    assert.equal((await publish())[0]?.status, "uncertain");
    assert.equal(calls, 1, "a thrown error is not sent again without confirmation");

    creativeCounter += 1;
    creative = `${CREATIVE}_${creativeCounter}`;
    await seedCreative(creative, ORG, BRAND);
    registerDistributionChannel(throwing(new CapabilityDisabledError("publish.instagram")) as never);
    const disabled = await publish();
    assert.equal(disabled[0]?.status, "not_connected", "a disabled path sent nothing, so it is not an unknown outcome");
    assert.equal((await claim())?.status, "refused");
    registerDistributionChannel(throwing(new Error("socket hang up")) as never);
    assert.equal((await publish())[0]?.status, "uncertain", "a refused claim can be taken again without confirmation");
  });

  it("confirmRetry sends once more, and a second confirmed publish after that is the published receipt", async () => {
    const fake = fakeTransport([new Error("no reply"), ok("vid-2")]);
    useTransport(fake.transport);
    assert.equal((await publish())[0]?.status, "uncertain");

    const retried = await publish({ confirmRetry: true });
    assert.equal(retried[0]?.status, "published");
    assert.equal(retried[0]?.externalId, "vid-2");
    assert.equal(fake.calls.length, 2, "exactly one more request");
    assert.equal((await claim())?.attempt, 2);

    const again = await publish({ confirmRetry: true });
    assert.equal(again[0]?.alreadySent, true, "confirmRetry never overrides a confirmed post");
    assert.equal(fake.calls.length, 2);
  });

  it("a definite refusal is failed, and it can be tried again without confirmation", async () => {
    const fake = fakeTransport([refused, ok("vid-3")]);
    useTransport(fake.transport);
    const first = await publish();
    assert.equal(first[0]?.status, "failed");
    assert.equal(first[0]?.receiptCode, "REJECTED");
    assert.equal((await claim())?.status, "failed");

    const second = await publish();
    assert.equal(second[0]?.status, "published");
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(await postStatuses(), ["failed", "published"]);
  });

  it("two concurrent publishes send exactly one request", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeTransport([ok("vid-4")], gate);
    useTransport(fake.transport);
    const both = Promise.all([publish(), publish()]);
    // Both requests have claimed or been refused by the time the one provider call is held open.
    for (let i = 0; i < 200 && fake.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [a, b] = await both;
    assert.equal(fake.calls.length, 1, "one request reached the provider");
    const statuses = [a![0]?.status, b![0]?.status].sort();
    assert.deepEqual(statuses, ["in_progress", "published"]);
    assert.equal((await claim())?.status, "published");
  });

  it("an expired claim becomes uncertain and is not re-sent, even when the caller confirms in the same call", async () => {
    const fake = fakeTransport([ok("vid-5")]);
    useTransport(fake.transport);
    // A request that claimed an hour ago and never finished.
    const stale = await acquireClaim(db.sql, {
      organizationId: ORG, brandId: BRAND, creativeId: creative, channelId: CHANNEL, targetId: PAGE, platform: "facebook",
      createdBy: USER, scheduledFor: null, now: new Date(Date.now() - 60 * 60 * 1000), confirmRetry: false,
    });
    assert.equal(stale.kind, "claimed");

    const first = await publish({ confirmRetry: true });
    assert.equal(first[0]?.status, "uncertain");
    assert.equal(fake.calls.length, 0, "the expired claim was not re-sent");
    assert.equal((await claim())?.status, "uncertain");
    assert.equal((await claim())?.receipt_code, "LEASE_EXPIRED");

    const second = await publish();
    assert.equal(second[0]?.status, "uncertain");
    assert.equal(fake.calls.length, 0);

    // Only a person's confirmation, on a later call, sends it.
    const third = await publish({ confirmRetry: true });
    assert.equal(third[0]?.status, "published");
    assert.equal(fake.calls.length, 1);
  });

  it("a claim that has not expired is in progress, and nothing is sent", async () => {
    const fake = fakeTransport([ok("vid-6")]);
    useTransport(fake.transport);
    await acquireClaim(db.sql, {
      organizationId: ORG, brandId: BRAND, creativeId: creative, channelId: CHANNEL, targetId: PAGE, platform: "facebook",
      createdBy: USER, scheduledFor: null, now: new Date(), confirmRetry: false,
    });
    const result = await publish({ confirmRetry: true });
    assert.equal(result[0]?.status, "in_progress");
    assert.equal(fake.calls.length, 0);
  });

  it("a post that is live but whose receipt row cannot be saved is still recorded on the claim, and is not sent again", async () => {
    const fake = fakeTransport([ok("vid-7")]);
    useTransport(fake.transport);
    await db.exec(`
      create or replace function claims_test_boom() returns trigger as $$ begin raise exception 'receipt insert failed'; end $$ language plpgsql;
      create trigger claims_test_boom before insert on organic_posts for each row execute function claims_test_boom();
    `);
    try {
      const first = await publish();
      assert.equal(first[0]?.status, "published", "the post is live, so it is reported as published");
      assert.equal(first[0]?.externalId, "vid-7");
      assert.match(first[0]?.error ?? "", /receipt row could not be saved/);
      assert.equal((await claim())?.status, "published");
      assert.equal((await claim())?.external_id, "vid-7");
    } finally {
      await db.exec("drop trigger if exists claims_test_boom on organic_posts");
    }
    const second = await publish();
    assert.equal(second[0]?.alreadySent, true);
    assert.equal(fake.calls.length, 1);
  });

  it("a request without a connection records not_connected, sends nothing and writes no claim", async () => {
    const fake = fakeTransport([ok("vid-8")]);
    useTransport(fake.transport);
    await seedCreative("creative_claims_no_connection", ORG, BRAND);
    await db.sql`update platform_accounts set status = 'disconnected' where id = 'pa-claims-fb'`;
    try {
      const result = await publishCreativeToChannels(
        db.sql,
        { organizationId: ORG, brandId: BRAND, creativeId: "creative_claims_no_connection", channelIds: [CHANNEL], userId: USER },
        { loadMedia: async () => MEDIA },
      );
      assert.equal(result[0]?.status, "not_connected");
      assert.equal(fake.calls.length, 0);
      assert.deepEqual(await claimsForCreative(db.sql, { organizationId: ORG, brandId: BRAND, creativeId: "creative_claims_no_connection" }), []);
    } finally {
      await db.sql`update platform_accounts set status = 'connected' where id = 'pa-claims-fb'`;
    }
  });

  it("another workspace cannot publish, see or take the claim", async () => {
    const fake = fakeTransport([ok("vid-9")]);
    useTransport(fake.transport);
    assert.equal((await publish())[0]?.status, "published");

    // Its member cannot reach this brand's creative.
    await assert.rejects(
      publishCreativeToChannels(
        db.sql,
        { organizationId: OTHER_ORG, brandId: BRAND, creativeId: creative, channelIds: [CHANNEL], userId: OTHER_USER },
        { loadMedia: async () => MEDIA },
      ),
      /not available to you/,
    );
    assert.equal(fake.calls.length, 1);

    // The claim is invisible from the other workspace.
    assert.deepEqual(await claimsForCreative(db.sql, { organizationId: OTHER_ORG, brandId: OTHER_BRAND, creativeId: creative }), []);
    assert.equal((await claimsForCreative(db.sql, { organizationId: ORG, brandId: BRAND, creativeId: creative })).length, 1);

    // The same ids in the other workspace are a separate claim: it takes a fresh row and does not see the published one.
    const theirs = await acquireClaim(db.sql, {
      organizationId: OTHER_ORG, brandId: OTHER_BRAND, creativeId: creative, channelId: CHANNEL, targetId: PAGE, platform: "facebook",
      createdBy: OTHER_USER, scheduledFor: null, now: new Date(), confirmRetry: true,
    });
    assert.equal(theirs.kind, "claimed");
    assert.equal((await claim())?.status, "published", "this workspace's claim is untouched");
  });

  it("the claim is keyed on the connected account: another Page is a different destination", async () => {
    const first = await acquireClaim(db.sql, {
      organizationId: ORG, brandId: BRAND, creativeId: creative, channelId: CHANNEL, targetId: "page-A", platform: "facebook",
      createdBy: USER, scheduledFor: null, now: new Date(), confirmRetry: false,
    });
    const second = await acquireClaim(db.sql, {
      organizationId: ORG, brandId: BRAND, creativeId: creative, channelId: CHANNEL, targetId: "page-B", platform: "facebook",
      createdBy: USER, scheduledFor: null, now: new Date(), confirmRetry: false,
    });
    const again = await acquireClaim(db.sql, {
      organizationId: ORG, brandId: BRAND, creativeId: creative, channelId: CHANNEL, targetId: "page-A", platform: "facebook",
      createdBy: USER, scheduledFor: null, now: new Date(), confirmRetry: false,
    });
    assert.equal(first.kind, "claimed");
    assert.equal(second.kind, "claimed");
    assert.equal(again.kind, "in_progress");
  });
});
