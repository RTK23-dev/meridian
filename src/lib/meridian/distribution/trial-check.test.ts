import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { TRIAL_CHECK_MAX_CHECKS } from "./trial.ts";
import { TRIAL_CHECK_JOB, recordTrialStep, runTrialCheckJob } from "./trial-check.ts";

// These run on PGlite, the default test database. No Instagram account is connected in these fixtures, so each check records that the
// reel could not be read and schedules the next check. Nothing is sent: no token is stored and no request is made.

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
