import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "./store.ts";
import { recordTelemetry, syncTelemetryToLearning } from "./telemetry-engine.ts";

/**
 * The bridge writes into the production tables, so the schema here keeps their constraints: performance_observations.created_by
 * is not null, and a metric a source may not report is nullable (migrations 0062 and 0063). A bridge that omits a not-null column
 * fails here, the same way it fails on Postgres.
 */
async function bridgeDatabase(): Promise<Sql> {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    create table if not exists unified_performance_telemetry (
      id                   text primary key,
      organization_id      text not null,
      brand_id             text not null,
      publish_job_id       text,
      account_id           text,
      platform             text not null,
      source_type          text not null default 'organic',
      creative_id          text not null default '',
      variant_id           text not null default '',
      external_post_id     text not null default '',
      hook_type            text not null default '',
      angle                text not null default '',
      format               text not null default '',
      views                bigint,
      impressions          bigint,
      reach                bigint,
      clicks               bigint,
      engagements          bigint,
      shares               bigint,
      saves                bigint,
      conversions          bigint,
      spend_cents          bigint,
      revenue_cents        bigint,
      watch_time_seconds   bigint,
      hook_retention_3s    double precision,
      completion_rate      double precision,
      decay_weight         double precision not null default 1.0,
      recorded_at          timestamptz not null default now(),
      created_at           timestamptz not null default now(),
      metadata             jsonb not null default '{}'::jsonb
    );

    create table if not exists performance_observations (
      id text primary key,
      organization_id text not null,
      brand_id text not null,
      creative_id text not null,
      impressions integer,
      clicks integer,
      conversions integer,
      spend_cents integer,
      revenue_cents integer,
      reach integer,
      observed_on text not null,
      source text not null default 'manual',
      created_by text not null,
      external_id text not null default ''
    );

    create unique index if not exists performance_external_idx
      on performance_observations (organization_id, external_id)
      where external_id <> '';

    create table if not exists organic_posts (
      id text primary key,
      organization_id text not null,
      brand_id text not null,
      creative_id text,
      platform text not null,
      external_id text,
      caption text not null default '',
      status text not null default 'draft'
    );

    create table if not exists organic_observations (
      id text primary key,
      organization_id text not null,
      brand_id text not null,
      organic_post_id text not null,
      creative_id text,
      platform text not null,
      views integer,
      reach integer,
      three_second_views integer,
      completion_rate double precision,
      shares integer,
      likes integer,
      comments integer,
      saves integer,
      observed_on date not null default current_date,
      raw_metrics jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists jev_account_profiles (
      id text primary key,
      organization_id text not null,
      brand_id text not null,
      platform text not null,
      account_handle text not null default '',
      post_count integer not null default 0,
      avg_engagement_rate double precision not null default 0,
      top_hooks jsonb not null default '[]',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  return Object.assign(
    async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> => {
      let queryStr = "";
      const params: unknown[] = [];
      for (let i = 0; i < strings.length; i++) {
        queryStr += strings[i];
        if (i < values.length) {
          params.push(values[i]);
          queryStr += `$${params.length}`;
        }
      }
      const res = await pg.query(queryStr, params);
      return res.rows as T[];
    },
    {
      async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
        const res = await pg.query(text, params);
        return res.rows as T[];
      },
    },
  );
}

test("Telemetry bridge: an unreported metric is stored as null, and views never stand in for impressions", async () => {
  const sql = await bridgeDatabase();
  const organizationId = "org_bridge_null";
  const brandId = "brand_bridge_null";

  // Impressions are reported, clicks, conversions and spend are not. Views are larger than impressions, so a max() merge
  // would store 9000 here.
  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "meta",
    sourceType: "paid",
    creativeId: "cr_paid_partial",
    views: 9000,
    impressions: 5000,
  });

  await syncTelemetryToLearning(sql, organizationId, brandId);

  const rows = await sql<{ impressions: number | null; clicks: number | null; conversions: number | null; spend_cents: number | null; created_by: string }>`
    select impressions, clicks, conversions, spend_cents, created_by from performance_observations
    where organization_id = ${organizationId} and creative_id = 'cr_paid_partial'
  `;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0]!.impressions), 5000, "the reported impressions, not the larger view count");
  assert.equal(rows[0]!.clicks, null, "an unreported click count is unknown, not zero");
  assert.equal(rows[0]!.conversions, null, "an unreported conversion count is unknown, not zero");
  assert.equal(rows[0]!.spend_cents, null, "an unreported spend is unknown, not zero");
  assert.equal(rows[0]!.created_by, "telemetry.sync", "the bridge records who wrote the row, as the production column requires");
});

test("Telemetry bridge: views alone are reach, so they make no paid row", async () => {
  const sql = await bridgeDatabase();
  const organizationId = "org_bridge_views";
  const brandId = "brand_bridge_views";

  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "meta",
    sourceType: "paid",
    creativeId: "cr_views_only",
    views: 1200,
  });

  await syncTelemetryToLearning(sql, organizationId, brandId);

  const rows = await sql<{ id: string }>`
    select id from performance_observations
    where organization_id = ${organizationId} and creative_id = 'cr_views_only'
  `;
  assert.equal(rows.length, 0, "no paid metric was reported, so there is nothing to learn from");
});

test("Telemetry bridge: an organic post is written only with its platform post id, and nothing is invented for a missing one", async () => {
  const sql = await bridgeDatabase();
  const organizationId = "org_bridge_posts";
  const brandId = "brand_bridge_posts";

  // The record with a platform post id is a post. Its shares and saves are not reported, so they stay unknown.
  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "instagram",
    sourceType: "organic",
    creativeId: "cr_organic",
    externalPostId: "ig_9001",
    views: 900,
    engagements: 40,
  });
  // A record with no platform post id is not a published post, so no post row is written for it.
  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "instagram",
    sourceType: "organic",
    creativeId: "cr_no_post_id",
    views: 300,
  });

  await syncTelemetryToLearning(sql, organizationId, brandId);

  const posts = await sql<{ id: string; creative_id: string; external_id: string; status: string }>`
    select id, creative_id, external_id, status from organic_posts
    where organization_id = ${organizationId}
  `;
  assert.equal(posts.length, 1, "only the record with a platform post id becomes a post");
  assert.equal(posts[0]!.creative_id, "cr_organic");
  assert.equal(posts[0]!.external_id, "ig_9001", "the platform's own id is the receipt");
  assert.equal(posts[0]!.status, "published");
  assert.ok(!posts[0]!.id.startsWith("post_"), "the row is not keyed by an invented id");

  const observed = await sql<{ views: number | null; reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null }>`
    select views, reach, likes, comments, shares, saves from organic_observations
    where organization_id = ${organizationId}
  `;
  assert.equal(observed.length, 1);
  assert.equal(Number(observed[0]!.views), 900);
  assert.equal(Number(observed[0]!.likes), 40, "the reported engagements");
  assert.equal(observed[0]!.reach, null, "reach is not reported");
  assert.equal(observed[0]!.comments, null, "comments are not reported");
  assert.equal(observed[0]!.shares, null, "shares are not reported");
  assert.equal(observed[0]!.saves, null, "saves are not reported");
});

test("Telemetry bridge: running the sync twice does not duplicate a post or its observation", async () => {
  const sql = await bridgeDatabase();
  const organizationId = "org_bridge_twice";
  const brandId = "brand_bridge_twice";

  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "youtube",
    sourceType: "organic",
    creativeId: "cr_yt",
    externalPostId: "yt_42",
    views: 500,
  });

  await syncTelemetryToLearning(sql, organizationId, brandId);
  await syncTelemetryToLearning(sql, organizationId, brandId);

  const posts = await sql<{ id: string }>`select id from organic_posts where organization_id = ${organizationId}`;
  assert.equal(posts.length, 1);
  const observed = await sql<{ id: string }>`select id from organic_observations where organization_id = ${organizationId}`;
  assert.equal(observed.length, 1);
});

test("Telemetry bridge: a later organic measurement of a post reaches learning, and a repeated sync adds nothing", async () => {
  const sql = await bridgeDatabase();
  const organizationId = "org_bridge_organic_later";
  const brandId = "brand_bridge_organic_later";

  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "instagram",
    sourceType: "organic",
    creativeId: "cr_ig_later",
    externalPostId: "ig_later",
    views: 100,
    recordedAt: "2026-10-01T00:00:00.000Z",
  });
  await syncTelemetryToLearning(sql, organizationId, brandId);

  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "instagram",
    sourceType: "organic",
    creativeId: "cr_ig_later",
    externalPostId: "ig_later",
    views: 250,
    recordedAt: "2026-10-02T00:00:00.000Z",
  });
  await syncTelemetryToLearning(sql, organizationId, brandId);
  await syncTelemetryToLearning(sql, organizationId, brandId);

  const rows = await sql<{ views: number | null; observed_on: string }>`
    select views, observed_on::text as observed_on from organic_observations
    where organization_id = ${organizationId}
    order by observed_on
  `;
  assert.equal(rows.length, 2, "both days reach learning, and the repeated sync adds nothing");
  assert.deepEqual(rows.map((row) => Number(row.views)), [100, 250]);
  assert.deepEqual(rows.map((row) => String(row.observed_on).slice(0, 10)), ["2026-10-01", "2026-10-02"]);
});

test("Telemetry bridge: a later paid measurement of a creative reaches learning, and repeated syncs count each measurement once", async () => {
  const sql = await bridgeDatabase();
  const organizationId = "org_bridge_paid_later";
  const brandId = "brand_bridge_paid_later";

  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "meta",
    sourceType: "paid",
    creativeId: "cr_paid_two",
    impressions: 3000,
    clicks: 90,
    spendCents: 1500,
    recordedAt: "2026-10-01T00:00:00.000Z",
  });
  await syncTelemetryToLearning(sql, organizationId, brandId);

  // The second measurement of the same creative, on the next day. The earlier bridge dropped it, because the creative already had a row.
  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "meta",
    sourceType: "paid",
    creativeId: "cr_paid_two",
    impressions: 4200,
    clicks: 130,
    spendCents: 2100,
    recordedAt: "2026-10-02T00:00:00.000Z",
  });
  await syncTelemetryToLearning(sql, organizationId, brandId);
  await syncTelemetryToLearning(sql, organizationId, brandId);

  const rows = await sql<{ impressions: number | null; clicks: number | null; observed_on: string; external_id: string }>`
    select impressions, clicks, observed_on, external_id from performance_observations
    where organization_id = ${organizationId} and creative_id = 'cr_paid_two'
    order by observed_on
  `;
  assert.equal(rows.length, 2, "both measurements reach learning, and the repeated syncs add nothing");
  assert.deepEqual(rows.map((row) => Number(row.impressions)), [3000, 4200]);
  assert.deepEqual(rows.map((row) => Number(row.clicks)), [90, 130]);
  assert.deepEqual(rows.map((row) => row.observed_on), ["2026-10-01", "2026-10-02"], "each measurement keeps its own day");
  assert.equal(new Set(rows.map((row) => row.external_id)).size, 2, "each observation is keyed by its own telemetry row");
  assert.ok(rows.every((row) => row.external_id.startsWith("telemetry:")));
});

test("Telemetry bridge: a measurement bridged by the earlier code is adopted by its key, so it is not counted twice", async () => {
  const sql = await bridgeDatabase();
  const organizationId = "org_bridge_legacy";
  const brandId = "brand_bridge_legacy";

  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "meta",
    sourceType: "paid",
    creativeId: "cr_legacy",
    impressions: 3000,
    clicks: 90,
    spendCents: 1500,
    recordedAt: "2026-10-01T00:00:00.000Z",
  });
  // The row the earlier code wrote for that measurement: one observation per creative, with no key, and conversions not reported.
  await sql`
    insert into performance_observations (
      id, organization_id, brand_id, creative_id, impressions, clicks, conversions, spend_cents, revenue_cents, reach,
      observed_on, source, created_by, external_id
    ) values (
      'obs-legacy', ${organizationId}, ${brandId}, 'cr_legacy', 3000, 90, null, 1500, null, null,
      '2026-10-01', 'meta', 'telemetry.sync', ''
    )
  `;
  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "meta",
    sourceType: "paid",
    creativeId: "cr_legacy",
    impressions: 4200,
    clicks: 130,
    spendCents: 2100,
    recordedAt: "2026-10-02T00:00:00.000Z",
  });

  await syncTelemetryToLearning(sql, organizationId, brandId);
  await syncTelemetryToLearning(sql, organizationId, brandId);

  const rows = await sql<{ id: string; impressions: number | null; external_id: string }>`
    select id, impressions, external_id from performance_observations
    where organization_id = ${organizationId} and creative_id = 'cr_legacy'
    order by observed_on
  `;
  assert.equal(rows.length, 2, "only the new measurement is added to the one the earlier code wrote");
  assert.equal(rows[0]!.id, "obs-legacy", "the earlier row is kept, not copied");
  assert.ok(rows[0]!.external_id.startsWith("telemetry:"), "the earlier row is adopted by its measurement's key");
  assert.deepEqual(rows.map((row) => Number(row.impressions)), [3000, 4200]);
});

test("Telemetry bridge: a later measurement with an unreported metric stores that metric as null, not zero", async () => {
  const sql = await bridgeDatabase();
  const organizationId = "org_bridge_later_null";
  const brandId = "brand_bridge_later_null";

  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "meta",
    sourceType: "paid",
    creativeId: "cr_later_null",
    impressions: 1000,
    clicks: 20,
    conversions: 2,
    spendCents: 500,
    recordedAt: "2026-10-01T00:00:00.000Z",
  });
  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "meta",
    sourceType: "paid",
    creativeId: "cr_later_null",
    impressions: 1500,
    recordedAt: "2026-10-02T00:00:00.000Z",
  });

  await syncTelemetryToLearning(sql, organizationId, brandId);

  const rows = await sql<{ impressions: number | null; clicks: number | null; conversions: number | null; spend_cents: number | null }>`
    select impressions, clicks, conversions, spend_cents from performance_observations
    where organization_id = ${organizationId} and creative_id = 'cr_later_null'
    order by observed_on
  `;
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[1]!.impressions), 1500);
  assert.equal(rows[1]!.clicks, null, "a click count the second measurement did not report is unknown, not zero");
  assert.equal(rows[1]!.conversions, null);
  assert.equal(rows[1]!.spend_cents, null);
});

test("Telemetry bridge: an organic row stored on the sync day is adopted, and the measurement day is kept", async () => {
  const sql = await bridgeDatabase();
  const organizationId = "org_bridge_organic_legacy";
  const brandId = "brand_bridge_organic_legacy";

  await recordTelemetry(sql, {
    organizationId,
    brandId,
    platform: "instagram",
    sourceType: "organic",
    creativeId: "cr_organic_legacy",
    externalPostId: "ig_legacy",
    views: 900,
    engagements: 40,
    recordedAt: "2026-10-01T00:00:00.000Z",
  });
  await syncTelemetryToLearning(sql, organizationId, brandId);
  await sql`
    update organic_observations
    set observed_on = '2026-10-03', raw_metrics = '{}'::jsonb
    where organization_id = ${organizationId}
  `;

  await syncTelemetryToLearning(sql, organizationId, brandId);

  const rows = await sql<{ id: string; observed_on: string; raw_metrics: { observationKey?: string } }>`
    select id, observed_on::text as observed_on, raw_metrics from organic_observations
    where organization_id = ${organizationId}
  `;
  assert.equal(rows.length, 1, "the earlier row is adopted instead of copied");
  assert.equal(String(rows[0]!.observed_on).slice(0, 10), "2026-10-01");
  assert.ok(rows[0]!.raw_metrics.observationKey?.startsWith("telemetry:"));
});
