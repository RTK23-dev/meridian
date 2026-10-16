import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import type { Transport } from "../providers/http.ts";
import { storeVaultCredential } from "../vault/service.ts";
import { TRIAL_CHECK_MAX_CHECKS } from "./trial.ts";
import { TRIAL_CHECK_JOB, recordTrialStep, runTrialCheckJob } from "./trial-check.ts";

// These run on PGlite, the default test database. Most fixtures connect no Instagram account, so each check records that the reel could
// not be read and schedules the next check. The read tests connect a fixture account and pass a fixture transport, so nothing is sent.

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function seedPublishedPost(sql: Sql, organizationId: string, brandId: string): Promise<string> {
  const id = `post-${unique()}`;
  await sql`
    insert into organic_posts (id, organization_id, brand_id, platform, external_id, status, surface, published_at)
    values (${id}, ${organizationId}, ${brandId}, 'instagram', '18000000000000010', 'published', 'organic', now())
  `;
  return id;
}

async function trialRow(sql: Sql, trialId: string) {
  const rows = await sql<{ feed_status: string; checks: number; last_error: string; media_id: string }>`
    select feed_status, checks, last_error, media_id from organic_trial_reels where id = ${trialId}
  `;
  return rows[0];
}

test("a trial step is recorded once, and its first check is queued a day later under a stable key", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, `trial-record-${unique()}`);
  const postId = await seedPublishedPost(sql, tenant.organizationId, tenant.brandId);
  const input = {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    organicPostId: postId,
    mediaId: "18000000000000010",
    graduationStrategy: "MANUAL" as const,
  };

  const trialId = await recordTrialStep(sql, input);
  const again = await recordTrialStep(sql, input);
  assert.equal(again, trialId, "a second record of the same post is the same trial row");

  const row = await trialRow(sql, trialId);
  assert.equal(row.feed_status, "waiting");
  assert.equal(row.checks, 0);
  assert.equal(row.media_id, "18000000000000010");

  const jobs = await sql<{ job_type: string; run_after_later: boolean; payload: string }>`
    select job_type, run_after > now() as run_after_later, payload from jobs
    where organization_id = ${tenant.organizationId} and idempotency_key = ${`trial-check:${trialId}:0`}
  `;
  assert.equal(jobs.length, 1, "one check is queued for the step, however many times the step is recorded");
  assert.equal(jobs[0].job_type, TRIAL_CHECK_JOB);
  assert.equal(jobs[0].run_after_later, true, "the first check waits a day");
  assert.equal(JSON.parse(jobs[0].payload).trialId, trialId);
});

test("a check with no connected account records why the reel was not read, and queues the next check", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, `trial-check-${unique()}`);
  const postId = await seedPublishedPost(sql, tenant.organizationId, tenant.brandId);
  const trialId = await recordTrialStep(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    organicPostId: postId,
    mediaId: "18000000000000010",
    graduationStrategy: "SS_PERFORMANCE",
  });
  const job = { organization_id: tenant.organizationId, brand_id: tenant.brandId };

  const result = await runTrialCheckJob(sql, job, { trialId });
  assert.equal(result, "waiting:checks=1");

  const row = await trialRow(sql, trialId);
  assert.equal(row.checks, 1);
  assert.equal(row.feed_status, "waiting", "a check that could not read the reel does not change the feed step");
  assert.match(row.last_error, /not connected|connected/i, "the reason is recorded, not hidden");

  const next = await sql<{ n: number }>`
    select count(*)::int as n from jobs where organization_id = ${tenant.organizationId} and idempotency_key = ${`trial-check:${trialId}:1`}
  `;
  assert.equal(next[0].n, 1, "the next check is queued under the new count");
});

test("checks stop at the limit, and a check past the limit reads nothing", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, `trial-limit-${unique()}`);
  const postId = await seedPublishedPost(sql, tenant.organizationId, tenant.brandId);
  const trialId = await recordTrialStep(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    organicPostId: postId,
    mediaId: "18000000000000010",
    graduationStrategy: "MANUAL",
  });
  await sql`update organic_trial_reels set checks = ${TRIAL_CHECK_MAX_CHECKS - 1} where id = ${trialId}`;
  const job = { organization_id: tenant.organizationId, brand_id: tenant.brandId };

  assert.equal(await runTrialCheckJob(sql, job, { trialId }), `waiting:checks=${TRIAL_CHECK_MAX_CHECKS}`);
  const final = await sql<{ n: number }>`
    select count(*)::int as n from jobs where organization_id = ${tenant.organizationId} and idempotency_key = ${`trial-check:${trialId}:${TRIAL_CHECK_MAX_CHECKS}`}
  `;
  assert.equal(final[0].n, 0, "the last check does not queue another");
  assert.equal(await runTrialCheckJob(sql, job, { trialId }), "waiting:stopped-at-check-limit", "a check past the limit reads nothing");
  assert.equal((await trialRow(sql, trialId)).checks, TRIAL_CHECK_MAX_CHECKS);
});

test("a check cannot read a trial of another workspace, or a trial with no id", async () => {
  const sql = await getSql();
  const home = await studioTenant(sql, `trial-home-${unique()}`);
  const other = await studioTenant(sql, `trial-other-${unique()}`);
  const postId = await seedPublishedPost(sql, home.organizationId, home.brandId);
  const trialId = await recordTrialStep(sql, {
    organizationId: home.organizationId,
    brandId: home.brandId,
    organicPostId: postId,
    mediaId: "18000000000000010",
    graduationStrategy: "MANUAL",
  });

  const foreign = { organization_id: other.organizationId, brand_id: other.brandId };
  assert.equal(await runTrialCheckJob(sql, foreign, { trialId }), "missing");
  assert.equal((await trialRow(sql, trialId)).checks, 0, "the home trial was not touched");
  await assert.rejects(runTrialCheckJob(sql, { organization_id: home.organizationId, brand_id: home.brandId }, {}), /needs a trial reel/);
});

// --- Read slots: each read takes a claimed slot, so concurrent checks cannot read past the limit -------------------------------------

const MEDIA_ID = "18000000000000010";
const VAULT_KEY = "trial-check-test-vault-key";

/** Runs `run` with the vault key the connection reads, then restores the environment. */
async function withVaultKey<T>(run: () => Promise<T>): Promise<T> {
  const prior = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = VAULT_KEY;
  try {
    return await run();
  } finally {
    if (prior === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = prior;
  }
}

/** A connected Instagram account for the brand, with a stored token. */
async function connectInstagram(sql: Sql, tenant: { organizationId: string; brandId: string }): Promise<void> {
  const credential = await storeVaultCredential(sql, tenant.organizationId, "oauth_token", { accessToken: `token-${unique()}` }, { masterKey: VAULT_KEY });
  await sql`
    insert into platform_accounts (id, organization_id, brand_id, platform, external_account_id, name, credential_id, status)
    values (${`acct-${unique()}`}, ${tenant.organizationId}, ${tenant.brandId}, 'instagram', '17841400000000001', 'Fixture reel account', ${credential.id}, 'connected')
  `;
}

/** A fixture transport that answers the media read with the media id, after a short delay, and counts each read it receives. */
function instagramTransport(options: { fail?: boolean } = {}): { transport: Transport; state: { calls: number } } {
  const state = { calls: 0 };
  const transport: Transport = async () => {
    state.calls += 1;
    if (options.fail) throw new Error("socket hang up");
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ id: MEDIA_ID, media_product_type: "REELS", is_shared_to_feed: false, permalink: "https://www.instagram.com/reel/fixture/" }),
    };
  };
  return { transport, state };
}

async function trialWithChecks(sql: Sql, tenant: { organizationId: string; brandId: string }, checks: number): Promise<string> {
  const postId = await seedPublishedPost(sql, tenant.organizationId, tenant.brandId);
  const trialId = await recordTrialStep(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    organicPostId: postId,
    mediaId: MEDIA_ID,
    graduationStrategy: "MANUAL",
  });
  await sql`update organic_trial_reels set checks = ${checks} where id = ${trialId}`;
  return trialId;
}

test("concurrent checks of one reel never read past the limit: three slots left make three reads, however many runs race", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, `trial-claim-${unique()}`);
  const trialId = await trialWithChecks(sql, tenant, TRIAL_CHECK_MAX_CHECKS - 3);
  const job = { organization_id: tenant.organizationId, brand_id: tenant.brandId };

  await withVaultKey(async () => {
    await connectInstagram(sql, tenant);
    const fixture = instagramTransport();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => runTrialCheckJob(sql, job, { trialId }, { transport: fixture.transport })),
    );

    assert.equal(fixture.state.calls, 3, "Instagram was called once for each slot that was left, and for no more");
    assert.equal((await trialRow(sql, trialId)).checks, TRIAL_CHECK_MAX_CHECKS, "the count stops at the limit");
    assert.equal(results.filter((result) => /:checks=\d+$/.test(result)).length, 3, "three runs read the reel");
    assert.equal(results.filter((result) => result.endsWith(":stopped-at-check-limit")).length, 7, "the other runs read nothing");
    const last = await sql<{ n: number }>`
      select count(*)::int as n from jobs where organization_id = ${tenant.organizationId} and idempotency_key = ${`trial-check:${trialId}:${TRIAL_CHECK_MAX_CHECKS}`}
    `;
    assert.equal(last[0]?.n, 0, "the read that took the last slot does not queue another check");
  });
});

test("a read that Instagram never answers gives its slot back, is not counted, and fails the job so the queue tries it again", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, `trial-release-${unique()}`);
  const trialId = await trialWithChecks(sql, tenant, 2);
  const job = { organization_id: tenant.organizationId, brand_id: tenant.brandId };

  await withVaultKey(async () => {
    await connectInstagram(sql, tenant);
    const down = instagramTransport({ fail: true });
    let message = "";
    await assert.rejects(runTrialCheckJob(sql, job, { trialId }, { transport: down.transport }), (error: unknown) => {
      message = (error as Error).message;
      assert.ok(message.length > 0, "the failure has a reason");
      return true;
    });
    assert.equal(down.state.calls, 1, "one read was attempted");

    const after = await trialRow(sql, trialId);
    assert.equal(after.checks, 2, "the read that got no answer is not counted");
    assert.equal(after.last_error, message, "the reason is recorded on the reel");
    assert.equal(after.feed_status, "waiting", "the feed step is unchanged");
    const queued = await sql<{ n: number }>`
      select count(*)::int as n from jobs where organization_id = ${tenant.organizationId} and idempotency_key = ${`trial-check:${trialId}:3`}
    `;
    assert.equal(queued[0]?.n, 0, "no next check is queued for a read that did not happen");

    const up = instagramTransport();
    const result = await runTrialCheckJob(sql, job, { trialId }, { transport: up.transport });
    assert.ok(result.endsWith(":checks=3"), "the slot that was given back is claimed by the next read");
    assert.equal((await trialRow(sql, trialId)).checks, 3);
  });
});
