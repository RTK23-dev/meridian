// Measuring a repurpose run's published variations, on PGlite with an injected reader. The reader answers what the Facebook Page would report;
// no test reaches Facebook. The tests cover what is stored from an observed reading, a missing metric (stored as null, never zero), a repeat
// read on the same day (stored once), each reading that is not observed (stored nothing, with its reason), and the workspace and run scope.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startEngineRequest } from "../../../engine/jobs/orchestrator-sql.ts";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import type { OrganicMetricsReading } from "../distribution/types.ts";
import { measureRepurposeRun, pullRepurposeMeasurements, type RepurposeRunScope } from "./repurpose-pull.ts";

const WS = "ws_repurpose_measure";
const OTHER_WS = "ws_repurpose_measure_other";
const BRAND = "brand_repurpose_measure";
const USER = "user_repurpose_measure";
const REQUEST = "req_01HZ8Z3K7M9P2Q4R6S8T0V1W2Y";
const SESSION = "session_repurpose_measure";
const RUN = "run_repurpose_measure";
const OTHER_RUN = "run_repurpose_measure_two";
const NOW = "2026-10-24T12:00:00.000Z";

let db: TestDatabase;

const SCOPE: RepurposeRunScope = { organizationId: WS, brandId: BRAND, repurposeRunId: RUN };

/** A derived creative with one published Facebook post, made from a variation of the given run. */
async function publishedVariation(runId: string, key: string, externalId: string, organizationId = WS): Promise<{ creativeId: string; variantId: string }> {
  const variantId = `variant_measure_${key}`;
  const creativeId = `creative_measure_${key}`;
  const brandId = organizationId === WS ? BRAND : `${BRAND}_other`;
  await db.sql`
    insert into content_factory_repurpose_variants (id, organization_id, run_id, ordinal, variant_key, treatments, visual, child_edl_id, child_artifact_id, status, rendered_artifact_id)
    values (${variantId}, ${organizationId}, ${runId}, 0, ${key}, '[]', 'fixture', 'edl_child', 'art_child', 'rendered', 'art_rendered')
    on conflict do nothing
  `;
  await db.sql`
    insert into creative_records (id, organization_id, brand_id, origin, title, status, created_by, repurpose_variant_id, source_identifier)
    values (${creativeId}, ${organizationId}, ${brandId}, 'generated', ${key}, 'approved', ${USER}, ${variantId}, ${`repurpose:${variantId}`})
    on conflict do nothing
  `;
  await db.sql`
    insert into organic_posts (id, organization_id, brand_id, creative_id, platform, external_id, post_url, caption, title, aspect_ratio, status, published_at, surface)
    values (${`post_${key}`}, ${organizationId}, ${brandId}, ${creativeId}, 'facebook', ${externalId}, '', '', '', '9:16', 'published', ${NOW}, 'organic')
    on conflict do nothing
  `;
  return { creativeId, variantId };
}

/** The organic observations stored for one creative. A linked metric is written to the unified telemetry table, keyed by its observation key. */
async function observationsFor(creativeId: string): Promise<{ views: number | null; reach: number | null; average_watch_time_seconds: string | null }[]> {
  return db.sql`
    select views, reach, metadata->>'averageWatchTimeSeconds' as average_watch_time_seconds
    from unified_performance_telemetry where creative_id = ${creativeId} and source_type = 'organic'
  `;
}

function observed(views: number | null): OrganicMetricsReading {
  return {
    status: "observed",
    observedAt: NOW,
    metrics: {
      views,
      reach: null,
      threeSecondViews: 800,
      averageWatchTimeSeconds: 7.5,
      completionRate: null,
      likes: 12,
      comments: null,
      shares: 3,
      saves: null,
    },
  };
}

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, WS, BRAND);
  await seedWorkspace(db.sql, OTHER_WS, `${BRAND}_other`);
  await db.sql`insert into "user" (id, name, email, "emailVerified") values (${USER}, 'Measure fixture', 'measure.fixture@example.test', true)`;
  await db.sql`insert into memberships (id, organization_id, user_id, role) values ('mem_measure_admin', ${WS}, ${USER}, 'admin')`;
  await startEngineRequest(db.sql as never, {
    organizationId: WS,
    brandId: BRAND,
    requestId: REQUEST,
    formatId: "ref_repurpose_measure",
    priority: "normal",
    cachedDna: false,
    variantCount: 0,
    requestArtifactId: "art_repurpose_measure",
  });
  await db.sql`
    insert into content_factory_sessions (id, organization_id, brand_id, created_by, title, status, engine_request_id)
    values (${SESSION}, ${WS}, ${BRAND}, ${USER}, 'Measure fixture', 'started', ${REQUEST})
  `;
  for (const runId of [RUN, OTHER_RUN]) {
    await db.sql`
      insert into content_factory_repurpose_runs (id, organization_id, brand_id, session_id, engine_request_id, master_edl_id, settings_digest, settings)
      values (${runId}, ${WS}, ${BRAND}, ${SESSION}, ${REQUEST}, 'edl_measure', ${`digest_${runId}`}, '{}')
    `;
  }
});

after(async () => {
  await db.close();
});

describe("reading a repurpose run's published variations", () => {
  test("an observed reading is stored against its post, and a metric the Page did not report stays null", async () => {
    const { creativeId } = await publishedVariation(RUN, "observed", "fb_observed_1");
    const outcome = await pullRepurposeMeasurements(db.sql, SCOPE, { organicMetrics: async () => observed(1500) });
    assert.equal(outcome.organicRows, 1);
    const rows = await observationsFor(creativeId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.views, 1500);
    assert.equal(rows[0]!.reach, null, "a metric the Page did not report is null, not zero");
    assert.equal(rows[0]!.average_watch_time_seconds, "7.5");
  });

  test("a second read of the same observation on the same day stores nothing new", async () => {
    const { creativeId } = await publishedVariation(RUN, "repeat", "fb_repeat_1");
    await pullRepurposeMeasurements(db.sql, SCOPE, { organicMetrics: async () => observed(200) });
    const again = await pullRepurposeMeasurements(db.sql, SCOPE, { organicMetrics: async () => observed(250) });
    assert.ok(again.duplicates >= 1, "the repeat is counted as a duplicate");
    assert.equal((await observationsFor(creativeId)).length, 1, "one observation for the day, not two");
  });

  test("a reading that is not connected, not implemented or failed stores no number and keeps its reason", async () => {
    const { creativeId } = await publishedVariation(RUN, "not_observed", "fb_not_observed_1");
    const readings: Exclude<OrganicMetricsReading, { status: "observed" }>[] = [
      { status: "not_connected", reason: "No Facebook Page is connected for this brand." },
      { status: "failed", reason: "Facebook Page refused the read." },
      { status: "not_implemented", reason: "This channel has no metric read in this build." },
    ];
    for (const reading of readings) {
      const outcome = await pullRepurposeMeasurements(db.sql, SCOPE, { organicMetrics: async () => reading });
      assert.ok(outcome.reasons.includes(reading.reason), `the reason is kept: ${reading.status}`);
    }
    assert.equal((await observationsFor(creativeId)).length, 0, "no observation is stored for a reading that was not observed");
  });

  test("a reader that throws is a failed reading, not an error that stops the run", async () => {
    const { creativeId } = await publishedVariation(RUN, "throws", "fb_throws_1");
    const outcome = await pullRepurposeMeasurements(db.sql, SCOPE, {
      organicMetrics: async () => {
        throw new Error("network down");
      },
    });
    assert.ok(outcome.reasons.some((reason) => reason.includes("did not return metrics")));
    assert.equal((await observationsFor(creativeId)).length, 0);
  });

  test("only the run's own variations are read, and another workspace's posts are never read", async () => {
    const mine = await publishedVariation(RUN, "scope_mine", "fb_scope_mine");
    const otherRun = await publishedVariation(OTHER_RUN, "scope_other_run", "fb_scope_other_run");
    const other = await publishedVariation(RUN, "scope_other_org", "fb_scope_other_org", OTHER_WS);
    const reads: string[] = [];
    await pullRepurposeMeasurements(db.sql, SCOPE, {
      organicMetrics: async (target) => {
        reads.push(target.externalId);
        return observed(10);
      },
    });
    assert.ok(reads.includes("fb_scope_mine"));
    assert.ok(!reads.includes("fb_scope_other_run"), "a variation of another run is not read");
    assert.ok(!reads.includes("fb_scope_other_org"), "another workspace's post is not read");
    assert.equal((await observationsFor(otherRun.creativeId)).length, 0);
    assert.equal((await observationsFor(other.creativeId)).length, 0);
    assert.ok((await observationsFor(mine.creativeId)).length >= 1);
  });

  test("a platform that has no reader in this build is counted as not reported, and nothing is read from it", async () => {
    await db.sql`
      insert into organic_posts (id, organization_id, brand_id, creative_id, platform, external_id, post_url, caption, title, aspect_ratio, status, published_at, surface)
      values ('post_tiktok_measure', ${WS}, ${BRAND}, ${`creative_measure_observed`}, 'tiktok', 'tt_1', '', '', '', '9:16', 'published', ${NOW}, 'organic')
      on conflict do nothing
    `;
    let read = false;
    const outcome = await pullRepurposeMeasurements(db.sql, SCOPE, {
      organicMetrics: async (target) => {
        if (target.platform === "tiktok") read = true;
        return observed(1);
      },
    });
    assert.equal(read, false);
    assert.ok(outcome.reasons.some((reason) => reason.includes("tiktok")));
  });
});

describe("the admin measurement action", () => {
  test("an admin of the session reads the run's variations, and a run that is not in the session is refused", async () => {
    await publishedVariation(RUN, "action_admin", "fb_action_admin");
    const outcome = await measureRepurposeRun(db.sql, USER, { sessionId: SESSION, runId: RUN }, { organicMetrics: async () => observed(9) });
    assert.ok(outcome.organicRows + outcome.duplicates >= 1, "the variation was read");
    await assert.rejects(measureRepurposeRun(db.sql, USER, { sessionId: SESSION, runId: "run_not_in_session" }, { organicMetrics: async () => observed(9) }));
  });

  test("a user with no membership in the session's workspace is refused before anything is read", async () => {
    let read = false;
    await assert.rejects(
      measureRepurposeRun(db.sql, "user_without_membership", { sessionId: SESSION, runId: RUN }, {
        organicMetrics: async () => {
          read = true;
          return observed(1);
        },
      }),
    );
    assert.equal(read, false);
  });
});
