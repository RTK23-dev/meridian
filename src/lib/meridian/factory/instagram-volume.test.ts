// The Instagram volume source of Factory Gather, on the PGlite test database. Every Apify answer is recorded (fixtures built from
// the documented shapes, see sources/apify/fixtures.ts). No test sends a request.

import assert from "node:assert/strict";
import test from "node:test";
import { executeReelSnapshot } from "../organic/reel-snapshot.ts";
import { INSTAGRAM_VOLUME_CONFIG } from "../sources/apify/config.ts";
import {
  ACTORS,
  HASHTAG_PHOTO_ITEM,
  UNREADABLE_ITEM,
  creatorReelSet,
  hashtagReelItem,
  recordedApifyClient,
} from "../sources/apify/fixtures.ts";
import { FACTORY_TEST_BRAND, FACTORY_TEST_ORG, FACTORY_TEST_RUN, makeFactoryTestSql, seedFactoryRun } from "../testing/factory-fixtures.ts";
import { gatherInstagramVolume } from "./instagram-volume.ts";
import type { Sql } from "../learning/store.ts";

const GATHERED_AT = new Date("2026-10-15T09:00:00.000Z");
/** Twelve reels of one creator: the median of the view counts is 6,500. */
const TWELVE_VIEWS = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000];

function answersFor(creatorViews: Array<number | null> = TWELVE_VIEWS) {
  return {
    [ACTORS.niche]: { items: [hashtagReelItem(1), hashtagReelItem(2), HASHTAG_PHOTO_ITEM, UNREADABLE_ITEM] },
    [ACTORS.creator]: { items: creatorReelSet("fixture_creator_a", creatorViews) },
  };
}

function gather(sql: Sql, client: ReturnType<typeof recordedApifyClient>, at: Date = GATHERED_AT) {
  return gatherInstagramVolume(
    sql,
    { organizationId: FACTORY_TEST_ORG, brandId: FACTORY_TEST_BRAND, runId: FACTORY_TEST_RUN, niche: "skincare", now: () => at },
    client,
  );
}

test("with no Apify key the source is not connected, and no request is written or sent", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: {}, level: 0, niche: "skincare", website: "", country: "us" });
  const client = recordedApifyClient({}, { connected: false, reason: "Apify has no key for this workspace." });

  const result = await gather(sql, client);
  assert.deepEqual(result, { state: "not_connected", reason: "Apify has no key for this workspace.", items: 0 });
  assert.equal(client.calls.length, 0);

  const requests = await sql<{ n: number }>`select count(*)::int as n from instagram_volume_requests where organization_id = ${FACTORY_TEST_ORG}`;
  assert.equal(requests[0]?.n, 0);
  const reels = await sql<{ n: number }>`select count(*)::int as n from discovered_organic_reels where organization_id = ${FACTORY_TEST_ORG}`;
  assert.equal(reels[0]?.n, 0, "no candidate is stored without a source");
});

test("a gather run stores the video candidates with their baseline, their rating and their checkpoints", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: {}, level: 0, niche: "skincare", website: "", country: "us" });
  const client = recordedApifyClient(answersFor());

  const result = await gather(sql, client);
  assert.deepEqual(result, { state: "ok", reason: "", items: 2 }, "two video candidates; the photo and the unreadable item are not stored");

  assert.equal(client.calls.length, 2, "one hashtag request and one creator request");
  assert.equal(client.calls[0]?.actorId, ACTORS.niche);
  assert.deepEqual(client.calls[0]?.input, { hashtags: ["skincare"], resultsType: "posts", resultsLimit: INSTAGRAM_VOLUME_CONFIG.candidatesPerRun });
  assert.equal(client.calls[0]?.maxItems, INSTAGRAM_VOLUME_CONFIG.candidatesPerRun);
  assert.equal(client.calls[1]?.actorId, ACTORS.creator);
  assert.deepEqual(client.calls[1]?.input, { username: ["fixture_creator_a"], resultsLimit: 30, skipPinnedPosts: true });

  const reels = await sql<{ creator_median_views: number | null; views_metric: string; run_id: string; creator_baseline_reason: string }>`
    select creator_median_views::int as creator_median_views, views_metric, run_id, creator_baseline_reason
    from discovered_organic_reels where organization_id = ${FACTORY_TEST_ORG}
  `;
  assert.equal(reels.length, 2);
  for (const reel of reels) {
    assert.equal(reel.creator_median_views, 6500, "the creator's median of the twelve reels");
    assert.equal(reel.views_metric, "videoPlayCount");
    assert.equal(reel.run_id, FACTORY_TEST_RUN);
    assert.equal(reel.creator_baseline_reason, "");
  }

  const baselines = await sql<{ baseline_status: string; median: number; sample: number }>`
    select baseline_status, median_views::int as median, reel_sample_size::int as sample
    from creator_snapshots where organization_id = ${FACTORY_TEST_ORG}
  `;
  assert.deepEqual(baselines, [{ baseline_status: "measured", median: 6500, sample: 12 }]);

  // Both candidates are 1.9x their creator's median with a comment count, so they are rated C. Intent is never stored.
  const ratings = await sql<{ rating_tier: string | null; rating_reason: string; checkpoint_hours: number; intent_missing: boolean }>`
    select rating_tier, rating_reason, checkpoint_hours, intent_score is null as intent_missing
    from discovered_reel_ratings where organization_id = ${FACTORY_TEST_ORG}
  `;
  assert.equal(ratings.length, 2);
  for (const rating of ratings) {
    assert.equal(rating.rating_tier, "C");
    assert.equal(rating.rating_reason, "");
    assert.equal(rating.checkpoint_hours, 0);
    assert.equal(rating.intent_missing, true);
  }

  const checkpoints = await sql<{ n: number }>`
    select count(*)::int as n from discovered_reel_snapshots where organization_id = ${FACTORY_TEST_ORG} and checkpoint_hours = 0
  `;
  assert.equal(checkpoints[0]?.n, 2);

  // The +24 h and +72 h checkpoints are queued, each at its time after the discovery.
  const at24 = new Date(GATHERED_AT.getTime() + 24 * 3600 * 1000).toISOString();
  const at72 = new Date(GATHERED_AT.getTime() + 72 * 3600 * 1000).toISOString();
  const jobs24 = await sql<{ n: number }>`
    select count(*)::int as n from jobs
    where organization_id = ${FACTORY_TEST_ORG} and job_type = 'organic.reel_snapshot' and run_after = ${at24}::timestamptz
  `;
  const jobs72 = await sql<{ n: number }>`
    select count(*)::int as n from jobs
    where organization_id = ${FACTORY_TEST_ORG} and job_type = 'organic.reel_snapshot' and run_after = ${at72}::timestamptz
  `;
  assert.equal(jobs24[0]?.n, 2);
  assert.equal(jobs72[0]?.n, 2);

  const requests = await sql<{ purpose: string; status: string; requested: number; returned: number }>`
    select purpose, status, requested_results::int as requested, returned_items::int as returned
    from instagram_volume_requests where organization_id = ${FACTORY_TEST_ORG} and purpose = 'candidates'
  `;
  assert.deepEqual(requests, [{ purpose: "candidates", status: "ok", requested: INSTAGRAM_VOLUME_CONFIG.candidatesPerRun, returned: 4 }]);
});

test("the weekly cap stops a second gather before any request is sent", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: {}, level: 0, niche: "skincare", website: "", country: "us" });
  await gather(sql, recordedApifyClient(answersFor()));

  const second = recordedApifyClient(answersFor());
  const result = await gather(sql, second);
  assert.equal(result.state, "ok");
  assert.equal(result.items, 0);
  assert.match(result.reason, /weekly limit of 1000 candidates/);
  assert.equal(second.calls.length, 0, "the cap is checked before the request is written or sent");
});

test("a failed hashtag request is failed, keeps its place in the weekly cap, and stores no candidate", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: {}, level: 0, niche: "skincare", website: "", country: "us" });
  const client = recordedApifyClient({ [ACTORS.niche]: { failed: "Apify answered 402: no credit left." } });

  const result = await gather(sql, client);
  assert.equal(result.state, "failed");
  assert.equal(result.items, 0);
  assert.match(result.reason, /#skincare: Apify answered 402/);

  const requests = await sql<{ status: string; requested: number }>`
    select status, requested_results::int as requested from instagram_volume_requests
    where organization_id = ${FACTORY_TEST_ORG} and purpose = 'candidates'
  `;
  assert.deepEqual(requests, [{ status: "failed", requested: INSTAGRAM_VOLUME_CONFIG.candidatesPerRun }]);
  const reels = await sql<{ n: number }>`select count(*)::int as n from discovered_organic_reels where organization_id = ${FACTORY_TEST_ORG}`;
  assert.equal(reels[0]?.n, 0);
});

test("a creator with too few view counts is not rated, and the baseline's reason is stored on the reel", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: {}, level: 0, niche: "skincare", website: "", country: "us" });
  await gather(sql, recordedApifyClient(answersFor([1000, 2000, 3000])));

  const reels = await sql<{ creator_median_views: number | null; creator_baseline_reason: string }>`
    select creator_median_views::int as creator_median_views, creator_baseline_reason
    from discovered_organic_reels where organization_id = ${FACTORY_TEST_ORG}
  `;
  assert.equal(reels.length, 2);
  for (const reel of reels) {
    assert.equal(reel.creator_median_views, null, "no median is made from three reels");
    assert.match(reel.creator_baseline_reason, /Only 3 of the last 3 reels report a view count; 10 are needed/);
  }

  const ratings = await sql<{ rating_tier: string | null; rating_reason: string }>`
    select rating_tier, rating_reason from discovered_reel_ratings where organization_id = ${FACTORY_TEST_ORG}
  `;
  assert.equal(ratings.length, 2);
  for (const rating of ratings) {
    assert.equal(rating.rating_tier, null, "not rated, not C");
    assert.match(rating.rating_reason, /baseline is not known/);
  }
});

test("a +24 h checkpoint records the reel's views and re-rates it with the stored checkpoints", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: {}, level: 0, niche: "skincare", website: "", country: "us" });
  await gather(sql, recordedApifyClient(answersFor()));

  const reel = await sql<{ id: string }>`
    select id from discovered_organic_reels where organization_id = ${FACTORY_TEST_ORG} and permalink like '%FIXTURE_H1%'
  `;
  const reelId = reel[0]?.id ?? "";
  assert.ok(reelId, "the first hashtag reel is stored");

  // The reel actor answers with the same reel one day later: 20,000 views. The document is built from the documented shape.
  const later = recordedApifyClient({ [ACTORS.creator]: { items: [{ ...hashtagReelItem(1), videoPlayCount: 20000 }] } });
  const summary = await executeReelSnapshot(
    sql,
    { id: "job-snapshot-1", organization_id: FACTORY_TEST_ORG, brand_id: FACTORY_TEST_BRAND },
    { reelId, checkpointHours: 24 },
    later,
    () => new Date(GATHERED_AT.getTime() + 24 * 3600 * 1000),
  );
  assert.equal(summary.startsWith("snapshot:24h:views:20000:tier:"), true, summary);

  const checkpoint = await sql<{ views: number; hours: number }>`
    select views_count::int as views, hours_since_post::float as hours from discovered_reel_snapshots
    where reel_id = ${reelId} and checkpoint_hours = 24
  `;
  assert.equal(checkpoint.length, 1);
  assert.equal(checkpoint[0]?.views, 20000);
  assert.ok((checkpoint[0]?.hours ?? 0) > 0, "hours since the post are measured from the post time");

  const ratings = await sql<{ n: number }>`
    select count(*)::int as n from discovered_reel_ratings where reel_id = ${reelId} and checkpoint_hours = 24
  `;
  assert.equal(ratings[0]?.n, 1, "one rating is stored for the checkpoint");
});

test("a checkpoint whose reel is not returned by Apify throws, so the job shows as failed and nothing is stored", async () => {
  const sql = await makeFactoryTestSql();
  await seedFactoryRun(sql, { settings: {}, level: 0, niche: "skincare", website: "", country: "us" });
  await gather(sql, recordedApifyClient(answersFor()));
  const reel = await sql<{ id: string }>`select id from discovered_organic_reels where organization_id = ${FACTORY_TEST_ORG} limit 1`;

  const other = recordedApifyClient({ [ACTORS.creator]: { items: [creatorReelSet("someone_else", [5])[0]] } });
  await assert.rejects(
    executeReelSnapshot(
      sql,
      { id: "job-snapshot-2", organization_id: FACTORY_TEST_ORG, brand_id: FACTORY_TEST_BRAND },
      { reelId: reel[0]?.id ?? "", checkpointHours: 72 },
      other,
    ),
    /no item for this reel/,
  );
  const stored = await sql<{ n: number }>`select count(*)::int as n from discovered_reel_snapshots where checkpoint_hours = 72`;
  assert.equal(stored[0]?.n, 0);
});
