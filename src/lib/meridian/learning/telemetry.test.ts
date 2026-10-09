import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "./store.ts";
import {
  recordTelemetry,
  getTelemetryRecords,
  summarizeTelemetry,
  calculateTelemetryFeaturePosteriors,
  syncTelemetryToLearning,
} from "./telemetry-engine.ts";

test("Telemetry Engine: records multi-channel telemetry with decay weights and enforces tenant isolation", async () => {
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
  `);

  const sql: Sql = Object.assign(
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

  const orgId = "org_telemetry_test";
  const brandA = "brand_alpha";
  const brandB = "brand_beta";

  // Ingest fresh organic record for brand A
  const rec1 = await recordTelemetry(sql, {
    organizationId: orgId,
    brandId: brandA,
    platform: "tiktok",
    sourceType: "organic",
    creativeId: "cr_101",
    hookType: "contrarian",
    angle: "founder_story",
    views: 10000,
    reach: 8500,
    engagements: 1200,
    shares: 340,
    saves: 210,
    hookRetention3s: 0.65,
    completionRate: 0.38,
    recordedAt: new Date().toISOString(),
  });

  assert.ok(rec1.id);
  assert.ok(rec1.decayWeight > 0.99); // fresh -> weight ~1.0
  assert.equal(rec1.views, 10000);

  // Ingest older record (28 days ago, with 14-day half-life -> ~2 half-lives -> ~0.25 weight)
  const twentyEightDaysAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const recOld = await recordTelemetry(sql, {
    organizationId: orgId,
    brandId: brandA,
    platform: "instagram",
    sourceType: "organic",
    creativeId: "cr_102",
    hookType: "question",
    views: 5000,
    hookRetention3s: 0.40,
    recordedAt: twentyEightDaysAgo,
  }, 14);

  assert.ok(Math.abs(recOld.decayWeight - 0.25) < 0.05, `Expected decay weight ~0.25, got ${recOld.decayWeight}`);

  // Brand B query returns empty (tenant isolation)
  const brandBRecords = await getTelemetryRecords(sql, orgId, brandB);
  assert.equal(brandBRecords.length, 0);

  // Brand A query returns 2 records
  const brandARecords = await getTelemetryRecords(sql, orgId, brandA);
  assert.equal(brandARecords.length, 2);

  // Summary aggregation
  const summary = summarizeTelemetry(brandARecords);
  assert.equal(summary.totalRecords, 2);
  assert.equal(summary.totalViews, 15000);
  assert.ok(summary.avgHookRetention3s > 0.5);
  assert.equal(summary.byPlatform.tiktok.shares, 340);
});

test("Telemetry Engine: calculates Bayesian feature posteriors with credible intervals and lift", () => {
  const records = [
    {
      id: "1",
      organizationId: "org1",
      brandId: "b1",
      publishJobId: null,
      accountId: null,
      platform: "tiktok",
      sourceType: "organic" as const,
      creativeId: "c1",
      variantId: "v1",
      externalPostId: "p1",
      hookType: "contrarian",
      angle: "founder_story",
      format: "short",
      views: 10000,
      impressions: 10000,
      reach: 9000,
      clicks: 400,
      engagements: 1500,
      shares: 300,
      saves: 200,
      conversions: 20,
      spendCents: 0,
      revenueCents: 0,
      watchTimeSeconds: 150000,
      hookRetention3s: 0.70, // High retention
      completionRate: 0.40,
      decayWeight: 1.0,
      recordedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      metadata: {},
    },
    {
      id: "2",
      organizationId: "org1",
      brandId: "b1",
      publishJobId: null,
      accountId: null,
      platform: "tiktok",
      sourceType: "organic" as const,
      creativeId: "c2",
      variantId: "v2",
      externalPostId: "p2",
      hookType: "question",
      angle: "how_to",
      format: "short",
      views: 10000,
      impressions: 10000,
      reach: 9000,
      clicks: 150,
      engagements: 500,
      shares: 50,
      saves: 40,
      conversions: 5,
      spendCents: 0,
      revenueCents: 0,
      watchTimeSeconds: 80000,
      hookRetention3s: 0.30, // Lower retention
      completionRate: 0.15,
      decayWeight: 1.0,
      recordedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      metadata: {},
    },
  ];

  const posteriors = calculateTelemetryFeaturePosteriors(records, "hookType");
  assert.equal(posteriors.length, 2);

  const contrarian = posteriors.find((p) => p.featureValue === "contrarian");
  const question = posteriors.find((p) => p.featureValue === "question");

  assert.ok(contrarian);
  assert.ok(question);

  // Contrarian should have higher posterior mean than question
  assert.ok(contrarian.posterior.mean > question.posterior.mean);

  // Credible interval low should be less than high
  assert.ok(contrarian.credibleInterval90.low < contrarian.credibleInterval90.high);
  assert.ok(question.credibleInterval90.low < question.credibleInterval90.high);

  // Contrarian should have positive lift and high probability of beating baseline
  assert.ok(contrarian.lift > 0);
  assert.ok(contrarian.probabilityBeatsBaseline > 0.9);
});

test("Telemetry Engine: syncs unified telemetry into JEV profile benchmarks dynamically", async () => {
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
      impressions integer not null default 0,
      clicks integer not null default 0,
      conversions integer not null default 0,
      spend_cents integer not null default 0,
      revenue_cents integer,
      observed_on text not null,
      source text not null default 'manual'
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

  const sql: Sql = Object.assign(
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

  const orgId = "org_sync_test";
  const brandId = "brand_sync_test";

  // Ingest telemetry records
  await recordTelemetry(sql, {
    organizationId: orgId,
    brandId,
    platform: "instagram",
    creativeId: "cr_sync_1",
    hookType: "shock_stat",
    views: 8000,
    impressions: 8000,
    clicks: 300,
    engagements: 900,
    hookRetention3s: 0.72,
  });

  await recordTelemetry(sql, {
    organizationId: orgId,
    brandId,
    platform: "instagram",
    creativeId: "cr_sync_2",
    hookType: "shock_stat",
    views: 9500,
    impressions: 9500,
    clicks: 410,
    engagements: 1100,
    hookRetention3s: 0.75,
  });

  // Run closed loop sync
  const result = await syncTelemetryToLearning(sql, orgId, brandId);
  assert.equal(result.syncedRecords, 2);

  // Check that performance_observations were populated
  const observations = await sql`
    select * from performance_observations
    where organization_id = ${orgId} and brand_id = ${brandId}
  `;
  assert.equal(observations.length, 2);

  // Check that jev_account_profiles was updated with the top hook
  const profiles = await sql`
    select * from jev_account_profiles
    where organization_id = ${orgId} and brand_id = ${brandId}
  `;
  assert.equal(profiles.length, 1);
  assert.ok(profiles[0].top_hooks);
});
