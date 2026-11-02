// The paused-ad operation's recovery, on PGlite with a fake Meta. Each scenario is one of the situations the paused-ad design has to survive:
// concurrent requests, a process that stops before or after an attempt begins, a lost or failed reply, a stale holder whose lease was taken
// over, a changed input, an incomplete search, an ACTIVE ad, and a tenant that is not the owner. No test calls Meta: the fake answers, and
// every create the fake received is counted.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startEngineRequest } from "../../../engine/jobs/orchestrator-sql.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import { createPausedCreative } from "../providers/meta-paused-ad.ts";
import { fakeMeta, type FakeMeta, type FakeMetaOptions } from "../../../test-support/lib/meridian/testing/meta-paused-fake.ts";
import {
  PAUSED_AD_LEASE_MS,
  bindingFingerprint,
  operationName,
  pausedAdKey,
  reconcilePausedAd,
  runPausedAdAttempt,
  sqlPausedAdStore,
  type AcquireResult,
  type PausedAdCandidate,
  type PausedAdContext,
  type PausedAdLease,
  type PausedAdOperation,
  type PausedAdStore,
} from "./repurpose-paused-ad.ts";

const WS = "ws_paused_recovery";
const OTHER_WS = "ws_paused_other";
const BRAND = "brand_paused_recovery";
const REQUEST = "req_01HZPAUSEDRECOVERY000000001";
const SESSION = "session_paused_recovery";
const RUN = "run_paused_recovery";
const VARIANT_ID = "variant_paused_recovery";
const VARIANT_KEY = "variation-1";
const NOW = new Date("2026-10-24T12:00:00.000Z");
const TOKEN_A = "token-holder-a";
const TOKEN_B = "token-holder-b";

let db: TestDatabase;

function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

type Binding = { adSetId: string; pageId: string; destinationUrl: string; message: string; videoId: string };
const DEFAULT_BINDING: Binding = { adSetId: "as_a", pageId: "page_1", destinationUrl: "https://example.com/offer", message: "A message", videoId: "vid_9" };

type Scenario = { adAccountId: string; fake: FakeMeta; store: PausedAdStore; key: string; candidate: PausedAdCandidate };

let accounts = 0;

/** A new ad account, so each scenario is its own operation. Its numeric id is the one the fake's ad sets belong to. */
function scenario(options: FakeMetaOptions = {}): Scenario {
  accounts += 1;
  const numeric = String(900 + accounts);
  const adAccountId = `act_${numeric}`;
  const fake = fakeMeta({ adSetAccountId: numeric, ...options });
  const key = pausedAdKey({ brandId: BRAND, variantId: VARIANT_ID, adAccountId });
  return { adAccountId, fake, store: sqlPausedAdStore(db.sql), key, candidate: candidateFor(adAccountId, key, {}) };
}

function candidateFor(adAccountId: string, key: string, changes: Partial<Binding>): PausedAdCandidate {
  const binding = { ...DEFAULT_BINDING, ...changes };
  const fingerprint = bindingFingerprint({ adAccountId, adSetId: binding.adSetId, pageId: binding.pageId, videoId: binding.videoId, destinationUrl: binding.destinationUrl, message: binding.message });
  return {
    brandId: BRAND,
    variantId: VARIANT_ID,
    adAccountId,
    name: operationName({ variantKey: VARIANT_KEY, key, fingerprint }),
    fingerprint,
    videoId: binding.videoId,
    message: binding.message,
    adSetId: binding.adSetId,
    pageId: binding.pageId,
    destinationUrl: binding.destinationUrl,
  };
}

function ctxOf(s: Scenario, now: Date): PausedAdContext {
  return { credentials: { accessToken: "test-token-not-logged", adAccountId: s.adAccountId }, adAccountId: s.adAccountId, transport: s.fake.transport, now, leaseMs: PAUSED_AD_LEASE_MS };
}

function acquire(s: Scenario, token: string, now: Date, changes: Partial<Binding> = {}, confirmRetry = false): Promise<AcquireResult> {
  return s.store.acquire({
    organizationId: WS,
    key: s.key,
    candidate: changes === undefined ? s.candidate : candidateFor(s.adAccountId, s.key, changes),
    token,
    now,
    leaseMs: PAUSED_AD_LEASE_MS,
    confirmRetry,
  });
}

function claimedOf(result: AcquireResult): { lease: PausedAdLease; operation: PausedAdOperation } {
  assert.ok(result.kind === "claimed" || result.kind === "reconcile", `expected a claim or a reconciliation, got ${result.kind}`);
  return { lease: (result as { lease: PausedAdLease }).lease, operation: result.operation };
}

async function eventsOf(key: string): Promise<{ event: string; detail: string; lease_epoch: number }[]> {
  return db.sql<{ event: string; detail: string; lease_epoch: number }>`
    select e.event, e.detail, e.lease_epoch from content_factory_repurpose_publication_events e
    join content_factory_repurpose_publications p on p.id = e.publication_id
    where p.organization_id = ${WS} and p.idempotency_key = ${key}
    order by e.created_at, e.id
  `;
}

function creativePosts(s: Scenario): number {
  return s.fake.posts.filter((post) => post.kind === "creative").length;
}
function adPosts(s: Scenario): number {
  return s.fake.posts.filter((post) => post.kind === "ad").length;
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await seedWorkspace(db.sql, OTHER_WS);
  await db.sql`insert into "user" (id, name, email, "emailVerified") values ('user_paused_recovery', 'Recovery fixture', 'recovery.fixture@example.test', true)`;
  await startEngineRequest(db.sql as never, {
    organizationId: WS,
    brandId: BRAND,
    requestId: REQUEST,
    formatId: "ref_paused_recovery",
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: "art_paused_recovery_request",
  });
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id)
    values (${SESSION}, ${WS}, ${BRAND}, 'user_paused_recovery', 'Recovery fixture', 'started', ${REQUEST})
  `;
  await db.sql`
    insert into content_factory_repurpose_runs (id, organization_id, brand_id, session_id, engine_request_id, master_edl_id, settings_digest, settings)
    values (${RUN}, ${WS}, ${BRAND}, ${SESSION}, ${REQUEST}, 'edl_fixture', 'digest_paused_recovery', '{}')
  `;
  await db.sql`
    insert into content_factory_repurpose_variants (id, organization_id, run_id, ordinal, variant_key, treatments, visual, child_edl_id, child_artifact_id, status, rendered_artifact_id)
    values (${VARIANT_ID}, ${WS}, ${RUN}, 0, ${VARIANT_KEY}, '[]', 'fixture', 'edl_child', 'art_child', 'rendered', 'art_rendered_fixture')
  `;
});

after(async () => {
  await db.close();
});

describe("one operation per variation and account", () => {
  test("two concurrent requests for one variation and account: one claims, the others are told it is in progress, and nothing is sent", async () => {
    const s = scenario();
    const results = await Promise.all([acquire(s, "t1", NOW), acquire(s, "t2", NOW), acquire(s, "t3", NOW)]);
    assert.equal(results.filter((result) => result.kind === "claimed").length, 1, "exactly one request claims the operation");
    assert.equal(results.filter((result) => result.kind === "in_progress").length, 2, "the others are told it is in progress");
    assert.equal(s.fake.posts.length, 0, "a claim sends nothing by itself");
  });

  test("the bound inputs are the claim's own: a request with a different ad set, Page, link or text is a conflict, and changes nothing", async () => {
    const s = scenario();
    const claimed = claimedOf(await acquire(s, TOKEN_A, NOW));
    assert.equal(claimed.operation.adSetId, "as_a");

    for (const changes of [{ adSetId: "as_b" }, { pageId: "page_2" }, { destinationUrl: "https://example.com/other" }, { message: "a different text" }]) {
      const result = await acquire(s, "t_other", at(1), changes);
      assert.equal(result.kind, "conflict", `a change to ${Object.keys(changes)[0]} is a conflict`);
    }
    const stored = await s.store.load(WS, s.key);
    assert.equal(stored?.adSetId, "as_a", "the original ad set is still recorded");
    assert.equal(stored?.pageId, "page_1");
    assert.equal(stored?.destinationUrl, "https://example.com/offer");
    assert.equal(s.fake.posts.length, 0);
  });
});

describe("a process that stops or stalls", () => {
  test("a process that stops before any create is taken over once its lease expires, and the stale holder can no longer act", async () => {
    const s = scenario();
    const stale = claimedOf(await acquire(s, TOKEN_A, NOW));
    const taker = await acquire(s, TOKEN_B, at(11));
    assert.equal(taker.kind, "claimed", "an expired claim with no create sent is taken over");
    const claimed = claimedOf(taker);
    assert.equal(claimed.operation.leaseEpoch, 2);

    const outcome = await runPausedAdAttempt(s.store, claimed.lease, claimed.operation, ctxOf(s, at(11)));
    assert.equal(outcome.status, "created_paused");
    assert.equal(creativePosts(s), 1);
    assert.equal(adPosts(s), 1);

    // The stale holder resumes. Its lease is gone, so its write is refused and it sends nothing.
    const late = await runPausedAdAttempt(s.store, stale.lease, stale.operation, ctxOf(s, at(12)));
    assert.equal(late.status, "in_progress");
    assert.equal(creativePosts(s), 1, "the stale holder sent no creative");
    assert.equal(adPosts(s), 1, "the stale holder sent no ad");
    assert.ok((await eventsOf(s.key)).some((event) => event.event === "fenced"), "the refused write is recorded");
  });

  test("a process that stops after recording that a create may begin is reconciled, not created again, and nothing is concluded absent too early", async () => {
    const s = scenario();
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    assert.equal((await s.store.beginCreative(holder.lease, NOW, PAUSED_AD_LEASE_MS)), true, "the attempt is recorded before any create");
    // The process stops here: nothing was sent, and the lease expires.

    const early = await acquire(s, TOKEN_B, at(11));
    assert.equal(early.kind, "reconcile", "an expired attempt is reconciled, never created from");
    const tooSoon = await reconcilePausedAd(s.store, claimedOf(early).lease, claimedOf(early).operation, ctxOf(s, at(11)));
    assert.equal(tooSoon.status, "uncertain", "a search this soon after the attempt started does not conclude absence");
    assert.equal(s.fake.posts.length, 0, "reconciliation sent nothing");

    const later = await acquire(s, "token-c", at(16));
    assert.equal(later.kind, "reconcile");
    const absent = await reconcilePausedAd(s.store, claimedOf(later).lease, claimedOf(later).operation, ctxOf(s, at(16)));
    assert.equal(absent.status, "absent", "after the window and a complete search, absence is recorded");
    assert.equal(s.fake.posts.length, 0, "absence alone never creates anything");
    assert.ok((await eventsOf(s.key)).some((event) => event.event === "reconciled_absent" && event.detail === "attempt:1"));

    // Without a confirmation, a new attempt is not started, and the reconciliation that was taken is finished. With the confirmation, the
    // new attempt runs once.
    const unconfirmed = claimedOf(await acquire(s, "token-d", at(17), {}, false));
    assert.equal((await reconcilePausedAd(s.store, unconfirmed.lease, unconfirmed.operation, ctxOf(s, at(17)))).status, "absent");
    const retried = await acquire(s, "token-e", at(17), {}, true);
    assert.equal(retried.kind, "claimed", "the confirmed retry is claimed");
    const outcome = await runPausedAdAttempt(s.store, claimedOf(retried).lease, claimedOf(retried).operation, ctxOf(s, at(17)));
    assert.equal(outcome.status, "created_paused");
    assert.equal(creativePosts(s), 1, "one creative in total");
    assert.equal(adPosts(s), 1, "one ad in total");
  });

  test("a stale holder that resumes after a reconciliation began cannot record its creative, and the creative is found by name later", async () => {
    const s = scenario();
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    assert.equal(await s.store.beginCreative(holder.lease, NOW, PAUSED_AD_LEASE_MS), true);

    const reconciling = await acquire(s, TOKEN_B, at(11));
    assert.equal(reconciling.kind, "reconcile");
    await reconcilePausedAd(s.store, claimedOf(reconciling).lease, claimedOf(reconciling).operation, ctxOf(s, at(11)));

    // The stalled request's create reaches Meta now, after the reconciliation has started.
    const creative = await createPausedCreative(
      { accessToken: "test-token-not-logged", adAccountId: s.adAccountId },
      { adAccountId: s.adAccountId, name: s.candidate.name, pageId: "page_1", videoId: "vid_9", message: "A message", link: "https://example.com/offer" },
      s.fake.transport,
    );
    assert.equal(creative.kind, "created");
    assert.equal(await s.store.recordCreative(holder.lease, (creative as { id: string }).id), false, "the stale holder cannot record it");
    assert.equal(s.fake.posts.filter((post) => post.kind === "ad").length, 0, "the stale holder never reaches the ad step");

    const later = await acquire(s, "token-c", at(16));
    const found = await reconcilePausedAd(s.store, claimedOf(later).lease, claimedOf(later).operation, ctxOf(s, at(16)));
    assert.equal(found.status, "absent", "no ad exists, and the creative is recorded");
    const stored = await s.store.load(WS, s.key);
    assert.equal(stored?.creativeId, (creative as { id: string }).id, "the creative found by name is recorded, not created again");

    const retried = claimedOf(await acquire(s, "token-d", at(17), {}, true));
    const outcome = await runPausedAdAttempt(s.store, retried.lease, retried.operation, ctxOf(s, at(17)));
    assert.equal(outcome.status, "created_paused");
    assert.equal(creativePosts(s), 1, "the creative was never sent twice");
    assert.equal(adPosts(s), 1);
  });
});

describe("a reply that was lost, or a read that failed, after Meta created the ad", () => {
  test("Meta accepts the ad but the reply is lost: the next request finds the ad by name and verifies it, with no second ad", async () => {
    const s = scenario({ adCreates: ["lose_reply"] });
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    const first = await runPausedAdAttempt(s.store, holder.lease, holder.operation, ctxOf(s, NOW));
    assert.equal(first.status, "uncertain");
    assert.equal(adPosts(s), 1);
    assert.equal(s.fake.ads.length, 1, "Meta created the ad before the reply was lost");

    const next = await acquire(s, TOKEN_B, at(11));
    assert.equal(next.kind, "reconcile", "an uncertain ad is only reconciled");
    const reconciled = await reconcilePausedAd(s.store, claimedOf(next).lease, claimedOf(next).operation, ctxOf(s, at(11)));
    assert.equal(reconciled.status, "already_created");
    assert.equal(reconciled.status === "already_created" && reconciled.reconciled, true);
    assert.equal(adPosts(s), 1, "the ad was sent once across both requests");
    assert.equal(s.fake.ads.length, 1);
  });

  test("Meta returns a 5xx after creating the ad: the outcome is uncertain, and reconciliation verifies the same ad", async () => {
    const s = scenario({ adCreates: ["five_hundred"] });
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    assert.equal((await runPausedAdAttempt(s.store, holder.lease, holder.operation, ctxOf(s, NOW))).status, "uncertain");
    const next = claimedOf(await acquire(s, TOKEN_B, at(11)));
    assert.equal((await reconcilePausedAd(s.store, next.lease, next.operation, ctxOf(s, at(11)))).status, "already_created");
    assert.equal(adPosts(s), 1);
  });

  test("Meta answers the create without an object id: the outcome is uncertain, not a failure, and the ad is found once", async () => {
    const s = scenario({ adCreates: ["no_id"] });
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    assert.equal((await runPausedAdAttempt(s.store, holder.lease, holder.operation, ctxOf(s, NOW))).status, "uncertain");
    const next = claimedOf(await acquire(s, TOKEN_B, at(11)));
    assert.equal((await reconcilePausedAd(s.store, next.lease, next.operation, ctxOf(s, at(11)))).status, "already_created");
    assert.equal(adPosts(s), 1);
  });

  test("the read-back fails after the ad was created: the outcome is uncertain, and a later read confirms the same ad", async () => {
    const s = scenario({ readBackFailures: 3 });
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    const first = await runPausedAdAttempt(s.store, holder.lease, holder.operation, ctxOf(s, NOW));
    assert.equal(first.status, "uncertain");
    assert.equal(first.status === "uncertain" && first.stage, "ad");
    const next = claimedOf(await acquire(s, TOKEN_B, at(11)));
    assert.equal((await reconcilePausedAd(s.store, next.lease, next.operation, ctxOf(s, at(11)))).status, "already_created");
    assert.equal(adPosts(s), 1, "the failed read did not send another ad");
  });

  test("the receipt cannot be written after a paused ad exists: the ad is kept and the next request verifies it, with no second create", async () => {
    const s = scenario();
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    const failing: PausedAdStore = {
      ...s.store,
      verify: async () => {
        throw new Error("database unavailable while recording the receipt");
      },
    };
    await assert.rejects(runPausedAdAttempt(failing, holder.lease, holder.operation, ctxOf(s, NOW)));
    assert.equal(s.fake.ads.length, 1, "the ad exists in Meta");
    const next = claimedOf(await acquire(s, TOKEN_B, at(11)));
    assert.equal((await reconcilePausedAd(s.store, next.lease, next.operation, ctxOf(s, at(11)))).status, "already_created");
    assert.equal(adPosts(s), 1);
  });
});

describe("the outcomes that must not be guessed", () => {
  test("a search that cannot finish is uncertain, never absent, and the next search that does finish verifies the ad", async () => {
    const s = scenario({ adCreates: ["lose_reply"] });
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    await runPausedAdAttempt(s.store, holder.lease, holder.operation, ctxOf(s, NOW));

    s.fake.failLists(true);
    const next = claimedOf(await acquire(s, TOKEN_B, at(11)));
    const failed = await reconcilePausedAd(s.store, next.lease, next.operation, ctxOf(s, at(11)));
    assert.equal(failed.status, "uncertain", "a failed search is not a proof that nothing was created");
    assert.equal((await eventsOf(s.key)).some((event) => event.event === "reconciled_absent"), false);

    s.fake.failLists(false);
    const again = claimedOf(await acquire(s, "token-c", at(12)));
    assert.equal((await reconcilePausedAd(s.store, again.lease, again.operation, ctxOf(s, at(12)))).status, "already_created");
  });

  test("a search of an account with more pages than the limit is incomplete, and is not read as the whole account", async () => {
    const s = scenario({ adCreates: ["lose_reply"], pageSize: 1 });
    for (let i = 0; i < 60; i += 1) s.fake.seedAd({ name: `unrelated ${i}`, status: "PAUSED", adsetId: "as_a", accountId: String(900 + accounts), creativeId: "cr" });
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    await runPausedAdAttempt(s.store, holder.lease, holder.operation, ctxOf(s, NOW));
    const next = claimedOf(await acquire(s, TOKEN_B, at(11)));
    const outcome = await reconcilePausedAd(s.store, next.lease, next.operation, ctxOf(s, at(11)));
    assert.equal(outcome.status, "uncertain", "the list was cut short, so the ad could be on a later page");
    assert.equal(adPosts(s), 1);
  });

  test("the ad was created in ad set A, and a retry that asks for ad set B is refused; reconciliation under A verifies the ad in A", async () => {
    const s = scenario({ adCreates: ["lose_reply"] });
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    await runPausedAdAttempt(s.store, holder.lease, holder.operation, ctxOf(s, NOW));

    const asB = await acquire(s, "token-b", at(11), { adSetId: "as_b" });
    assert.equal(asB.kind, "conflict", "the retry for ad set B does not change the operation");
    const confirmed = await acquire(s, "token-c", at(11), {}, true);
    assert.equal(confirmed.kind, "reconcile", "a confirmation without a recorded absence is still a reconciliation");
    const reconciled = await reconcilePausedAd(s.store, claimedOf(confirmed).lease, claimedOf(confirmed).operation, ctxOf(s, at(11)));
    assert.equal(reconciled.status, "already_created");
    const stored = await s.store.load(WS, s.key);
    assert.equal(stored?.adSetId, "as_a");
    assert.equal(s.fake.ads[0]?.adsetId, "as_a");
  });

  test("an operation that is already verified returns its receipt, sends nothing, and reports a different request as not matching", async () => {
    const s = scenario();
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    assert.equal((await runPausedAdAttempt(s.store, holder.lease, holder.operation, ctxOf(s, NOW))).status, "created_paused");
    const same = await acquire(s, "token-b", at(1));
    assert.equal(same.kind, "verified");
    const different = await acquire(s, "token-c", at(1), { adSetId: "as_b" });
    assert.equal(different.kind, "verified", "a verified ad is returned as it is");
    assert.equal(different.operation.fingerprint, s.candidate.fingerprint, "the stored inputs are not replaced");
    assert.equal(creativePosts(s), 1);
    assert.equal(adPosts(s), 1);
  });

  test("a definite refusal releases the operation, and corrected inputs create it once", async () => {
    const s = scenario({ adCreates: ["refuse"] });
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    const refused = await runPausedAdAttempt(s.store, holder.lease, holder.operation, ctxOf(s, NOW));
    assert.equal(refused.status, "refused");
    assert.equal((await s.store.load(WS, s.key))?.state, "refused");

    const corrected = claimedOf(await acquire(s, TOKEN_B, at(1), { adSetId: "as_b" }));
    assert.equal(corrected.operation.attempt, 2);
    assert.equal(corrected.operation.creativeId, "", "a creative for the refused inputs is not reused");
    const outcome = await runPausedAdAttempt(s.store, corrected.lease, corrected.operation, ctxOf(s, at(1)));
    assert.equal(outcome.status, "created_paused");
    assert.equal(outcome.status === "created_paused" && outcome.receipt.adSetId, "as_b");
    const reopened = (await eventsOf(s.key)).find((event) => event.event === "reopened");
    assert.ok(reopened?.detail.includes('"adSetId":"as_a"'), "the refused inputs are kept in the events table");
  });

  test("an ad that is ACTIVE in Meta is reported as unexpected, is never changed, and is not recreated", async () => {
    const s = scenario({ readBackStatus: "ACTIVE" });
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    const outcome = await runPausedAdAttempt(s.store, holder.lease, holder.operation, ctxOf(s, NOW));
    assert.equal(outcome.status, "unexpected");
    assert.equal(outcome.status === "unexpected" && outcome.verifiedStatus, "ACTIVE");
    const stored = await s.store.load(WS, s.key);
    assert.equal(stored?.state, "unexpected");
    const again = await acquire(s, "token-b", at(20), {}, true);
    assert.equal(again.kind, "unexpected", "a later request reports it and does not create or change it");
    assert.equal(creativePosts(s), 1);
    assert.equal(adPosts(s), 1, "nothing was sent to change the ad");
  });
});

describe("tenancy and the database's own rules", () => {
  test("another workspace cannot read, find, release or change an operation, and cannot claim a variation it does not own", async () => {
    const s = scenario();
    const holder = claimedOf(await acquire(s, TOKEN_A, NOW));
    assert.equal((await runPausedAdAttempt(s.store, holder.lease, holder.operation, ctxOf(s, NOW))).status, "created_paused");

    assert.equal(await s.store.load(OTHER_WS, s.key), null);
    assert.equal(await s.store.find(OTHER_WS, VARIANT_ID, s.adAccountId), null);
    assert.ok(await s.store.find(WS, VARIANT_ID, s.adAccountId), "the owner still finds its receipt");

    const forged = { organizationId: OTHER_WS, key: s.key, token: TOKEN_A, epoch: holder.operation.leaseEpoch };
    assert.equal(await s.store.refuse(forged, "forged"), false);
    assert.equal(await s.store.markUncertain(forged, "forged"), false);
    assert.equal(await s.store.markUnexpected(forged, "ad_x", "ACTIVE", "forged"), false);
    assert.equal((await s.store.load(WS, s.key))?.state, "verified", "the owner's operation is unchanged");

    await assert.rejects(
      s.store.acquire({ organizationId: OTHER_WS, key: s.key, candidate: s.candidate, token: "token-x", now: NOW, leaseMs: PAUSED_AD_LEASE_MS, confirmRetry: false }),
      /not in this workspace/,
    );
  });

  test("the table refuses rows that break the state rules, whatever code writes them", async () => {
    const rows = [
      { name: "verified without PAUSED", state: "verified", status: "ACTIVE", external: "ad_x", lease: null, creative: "cr_x" },
      { name: "refused with an ad id", state: "refused", status: null, external: "ad_x", lease: null, creative: null },
      { name: "a live state without a lease", state: "claimed", status: null, external: "", lease: null, creative: null },
      { name: "unexpected but PAUSED", state: "unexpected", status: "PAUSED", external: "ad_x", lease: null, creative: null },
    ];
    for (const [index, row] of rows.entries()) {
      const account = `act_rule_${index}`;
      await assert.rejects(
        db.sql`
          insert into content_factory_repurpose_publications (
            id, organization_id, brand_id, variant_id, platform, kind, platform_account_id, external_id, idempotency_key,
            ad_set_id, page_id, destination_url, state, verified_status, meta_creative_id, input_fingerprint, operation_name, lease_token, lease_epoch
          ) values (${`pad_rule_${index}`}, ${WS}, ${BRAND}, ${VARIANT_ID}, 'meta', 'meta_paused_ad', ${account}, ${row.external},
            ${`${BRAND}:${VARIANT_ID}:${account}:meta_paused_ad`}, 'as_a', 'page_1', 'https://example.com', ${row.state}, ${row.status},
            ${row.creative}, 'fp', 'name', ${row.lease}, 1)
        `,
        /check constraint/,
        row.name,
      );
    }
  });
});
