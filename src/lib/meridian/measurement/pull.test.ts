import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import type { Transport } from "../providers/http.ts";
import type { OrganicMetricsReading, OrganicTelemetryMetrics } from "../distribution/types.ts";
import { factoryRunFor, studioTenant, type FactoryTenant } from "../testing/produce-fixtures.ts";
import { MetricLinkError, listLinkedMetrics, recordLinkedMetric, type LinkedMetricRow } from "./creative-linkage.ts";
import { paidInsightsWithTransport, pullRunMeasurements, type MeasurementScope } from "./pull.ts";

// The testing runtime is on for the fixture publisher and the testing artifact store. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

/**
 * A YouTube video's metrics, shaped as the YouTube Analytics API reports them for one video (query with metrics such as views, likes,
 * comments, shares and averageViewDuration: https://developers.google.com/youtube/analytics/reference/reports/query). YouTube reports
 * no saves or reach for a video, so those are not reported: null, never zero. This is a fixture.
 */
function youtubeAnalyticsFixture(): OrganicTelemetryMetrics {
  return {
    views: 120,
    reach: null,
    threeSecondViews: null,
    averageWatchTimeSeconds: 21.5,
    completionRate: null,
    likes: 9,
    comments: 2,
    shares: 4,
    saves: null,
  };
}

/**
 * The insights an ad's insights edge returns, shaped as the Meta Marketing API documents them (https://developers.facebook.com/docs/marketing-api/insights):
 * a `data` list of rows, each with the metrics the request named, numbers as strings, and a date_start. The second row carries no
 * conversion action, so its conversions are not reported. This is a fixture. No request leaves the process.
 */
function metaInsightsFixture(): Transport {
  return async (request) => {
    if (!request.url.includes("/insights")) return { status: 404, body: "{}", headers: {} };
    const body = {
      data: [
        {
          impressions: "1200",
          clicks: "34",
          spend: "12.50",
          actions: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "2" }],
          date_start: "2026-10-01",
          date_stop: "2026-10-01",
        },
        { impressions: "800", clicks: "19", spend: "7.00", date_start: "2026-10-02", date_stop: "2026-10-02" },
      ],
    };
    return { status: 200, body: JSON.stringify(body), headers: {} };
  };
}

/** One image creative of the run, with its variant and its link to the run, as the produce stage writes them. */
async function creativeOf(sql: Sql, tenant: FactoryTenant, runId: string, label: string): Promise<string> {
  const creativeId = `creative-${label}-${randomUUID()}`;
  const variantId = `var-${creativeId}`;
  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
      message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
    ) values (
      ${creativeId}, ${tenant.organizationId}, ${tenant.brandId}, 'generated', ${`Fixture ${label}`}, 'Fixture copy', 'Mesh sponge',
      '', '', '', '', '', 'image', '', null, ${tenant.briefId}, 'approved', ${tenant.userId}, '{}'
    )
  `;
  await sql`
    insert into factory_variants (id, organization_id, brand_id, template_id, hook, cta, presenter, length_ms, gate_result, tests_attribute, angle, format, proof)
    values (${variantId}, ${tenant.organizationId}, ${tenant.brandId}, null, '', '', '', 0, 'pass', 'control', '', '', '')
  `;
  await sql`
    insert into factory_creatives (organization_id, brand_id, run_id, variant_id, format, creative_id, production_job_id, provider, created_at)
    values (${tenant.organizationId}, ${tenant.brandId}, ${runId}, ${variantId}, 'image', ${creativeId}, ${`job-${creativeId}`}, 'google_nano_banana', now())
  `;
  return creativeId;
}

async function organicPost(sql: Sql, tenant: FactoryTenant, creativeId: string, externalId: string): Promise<void> {
  await sql`
    insert into organic_posts (id, organization_id, brand_id, creative_id, platform, external_id, status, surface, published_at)
    values (${`post-${externalId}`}, ${tenant.organizationId}, ${tenant.brandId}, ${creativeId}, 'youtube', ${externalId},
      'published', 'organic', now())
  `;
}

async function paidReceipt(sql: Sql, tenant: FactoryTenant, creativeId: string, externalId: string): Promise<void> {
  await sql`
    insert into provider_objects (id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status, surface)
    values (${randomUUID()}, ${tenant.organizationId}, ${tenant.brandId}, 'meta', 'ad', ${creativeId}, ${externalId}, 'paused', 'paid')
  `;
}

/** A run with two creatives: one with an organic post and a paid ad, and one with only an organic post. */
async function measuredRun(sql: Sql, label: string) {
  const tenant = await studioTenant(sql, label);
  const runId = await factoryRunFor(sql, tenant, {
    automation: "full",
    intent: "both",
    formats: ["image"],
    providers: { image: "google_nano_banana" },
    caps: { totalCents: 500 },
  });
  const both = await creativeOf(sql, tenant, runId, "both");
  await organicPost(sql, tenant, both, `yt-${both}`);
  await paidReceipt(sql, tenant, both, `ad-${both}`);
  const organicOnly = await creativeOf(sql, tenant, runId, "organic-only");
  await organicPost(sql, tenant, organicOnly, `yt-${organicOnly}`);
  const scope: MeasurementScope = { organizationId: tenant.organizationId, brandId: tenant.brandId, runId };
  return { tenant, runId, scope, both, organicOnly };
}

function fixtureSources(both: string) {
  return {
    organicMetrics: async (target: { creativeId: string }): Promise<OrganicMetricsReading> =>
      target.creativeId === both
        ? { status: "observed", metrics: youtubeAnalyticsFixture(), observedAt: "2026-10-13T09:00:00.000Z" }
        : { status: "not_connected", reason: "YouTube: no connected account in this fixture. Nothing was stored." },
    paidInsights: paidInsightsWithTransport({
      accessToken: "fixture-meta-token",
      transport: metaInsightsFixture(),
      startDate: "2026-10-01",
      endDate: "2026-10-13",
      currency: "USD",
      timezone: "UTC",
    }),
  };
}

test("every metric row has a creative id and a surface, and a metric the source did not report is null", async () => {
  const sql = await getSql();
  const { tenant, scope, both } = await measuredRun(sql, "measure-rows");
  const outcome = await pullRunMeasurements(sql, scope, fixtureSources(both));
  assert.equal(outcome.organicRows, 1, "the organic post's fixture metrics are stored once");
  assert.equal(outcome.paidRows, 2, "each paid insights row is stored once");

  const rows = await sql<{ creative_id: string; source_type: string }>`
    select creative_id, source_type from unified_performance_telemetry
    where organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId}
  `;
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(row.creative_id.length > 0, "every metric row names its creative");
    assert.ok(row.source_type === "organic" || row.source_type === "paid", "every metric row names its surface");
  }

  const stored = await listLinkedMetrics(sql, scope, [both]);
  const organic = stored.find((row) => row.surface === "organic") as LinkedMetricRow;
  assert.ok(organic);
  assert.equal(organic.metrics.views, 120);
  assert.equal(organic.metrics.shares, 4);
  assert.equal(organic.metrics.saves, null, "saves are not reported, so they are null, not zero");
  assert.equal(organic.metrics.reach, null, "reach is not reported, so it is null");
  assert.equal(organic.metrics.completionRate, null);

  const paid = stored.filter((row) => row.surface === "paid").sort((a, b) => (a.observationKey < b.observationKey ? -1 : 1));
  assert.equal(paid.length, 2);
  assert.equal(paid[0]?.metrics.impressions, 1200);
  assert.equal(paid[0]?.metrics.spendCents, 1250);
  assert.equal(paid[0]?.metrics.conversions, 2);
  assert.equal(paid[1]?.metrics.impressions, 800);
  assert.equal(paid[1]?.metrics.conversions, null, "the row without a conversion action is not reported, so it is null, not zero");
  for (const row of paid) assert.equal(row.externalId, `ad-${both}`, "a paid row is measured on its ad receipt");
});

test("a repeated pull stores no observation twice", async () => {
  const sql = await getSql();
  const { scope, both } = await measuredRun(sql, "measure-repeat");
  await pullRunMeasurements(sql, scope, fixtureSources(both));
  const again = await pullRunMeasurements(sql, scope, fixtureSources(both));
  assert.equal(again.organicRows, 0);
  assert.equal(again.paidRows, 0);
  assert.equal(again.duplicates, 3, "the three observations are already stored");
  assert.equal((await listLinkedMetrics(sql, scope, [both])).length, 3);
});

test("with no live metric client, an organic pull stores nothing and says so", async () => {
  const sql = await getSql();
  const { tenant, scope, both, organicOnly } = await measuredRun(sql, "measure-live-null");
  const outcome = await pullRunMeasurements(sql, scope, { now: new Date("2026-10-13T12:00:00Z") });
  assert.equal(outcome.organicRows, 0);
  assert.equal(outcome.paidRows, 0);
  assert.equal(outcome.notReported, 3, "two organic posts and one paid ad are reported as not reported");
  assert.ok(
    outcome.reasons.some((reason) => /No YouTube account is connected for this brand/.test(reason)),
    "the organic reason is the workspace's not-connected state, and no token is read from the environment",
  );
  assert.ok(outcome.reasons.some((reason) => /connected|token|Nothing was/.test(reason)), "the paid reason is named");
  const rows = await sql<{ n: number }>`
    select count(*)::int as n from unified_performance_telemetry where organization_id = ${tenant.organizationId}
  `;
  assert.equal(rows[0]?.n, 0, "no metric row is written from a source that reported nothing");
  assert.equal((await listLinkedMetrics(sql, scope, [both, organicOnly])).length, 0);
});

test("a paid metric is never written for an organic receipt, and an organic metric never for a paid one", async () => {
  const sql = await getSql();
  const { tenant, both, organicOnly } = await measuredRun(sql, "measure-surface");
  const scope = { organizationId: tenant.organizationId, brandId: tenant.brandId };
  const metrics = {
    views: null, reach: null, impressions: 10, clicks: 1, engagements: null, shares: null, saves: null, conversions: null,
    spendCents: 5, revenueCents: null, watchTimeSeconds: null, hookRetention3s: null, completionRate: null,
  };
  await assert.rejects(
    recordLinkedMetric(sql, {
      ...scope, creativeId: organicOnly, surface: "paid", externalId: `yt-${organicOnly}`, observationKey: "paid:x", recordedAt: new Date().toISOString(), metrics,
    }),
    MetricLinkError,
    "a creative with only an organic post has no paid receipt",
  );
  await assert.rejects(
    recordLinkedMetric(sql, {
      ...scope, creativeId: organicOnly, surface: "organic", externalId: `ad-${organicOnly}`, observationKey: "organic:x", recordedAt: new Date().toISOString(),
      metrics: { ...metrics, impressions: null, clicks: null, spendCents: null, views: 3 },
    }),
    MetricLinkError,
    "the organic metric names an external id that is not an organic post",
  );
  await assert.rejects(
    recordLinkedMetric(sql, {
      ...scope, creativeId: both, surface: "paid", externalId: `yt-${both}`, observationKey: "paid:y", recordedAt: new Date().toISOString(), metrics,
    }),
    MetricLinkError,
    "a paid metric cannot name the organic post's external id",
  );
  await assert.rejects(
    recordLinkedMetric(sql, {
      ...scope, creativeId: both, surface: "organic", externalId: `ad-${both}`, observationKey: "organic:y", recordedAt: new Date().toISOString(),
      metrics: { ...metrics, impressions: null, clicks: null, spendCents: null, views: 3 },
    }),
    MetricLinkError,
    "an organic metric cannot name the paid ad's external id",
  );
  const stored = await sql<{ n: number }>`
    select count(*)::int as n from unified_performance_telemetry where organization_id = ${tenant.organizationId}
  `;
  assert.equal(stored[0]?.n, 0, "no refused row is stored");
});

test("a metric row without a creative id, or without a surface, is refused and nothing is stored", async () => {
  const sql = await getSql();
  const { tenant, both } = await measuredRun(sql, "measure-refused");
  const scope = { organizationId: tenant.organizationId, brandId: tenant.brandId };
  const metrics = {
    views: 5, reach: null, impressions: null, clicks: null, engagements: null, shares: null, saves: null, conversions: null,
    spendCents: null, revenueCents: null, watchTimeSeconds: null, hookRetention3s: null, completionRate: null,
  };
  await assert.rejects(
    recordLinkedMetric(sql, {
      ...scope, creativeId: "", surface: "organic", externalId: `yt-${both}`, observationKey: "k1", recordedAt: new Date().toISOString(), metrics,
    }),
    MetricLinkError,
  );
  await assert.rejects(
    recordLinkedMetric(sql, {
      ...scope, creativeId: both, surface: "hybrid" as unknown as "organic", externalId: `yt-${both}`, observationKey: "k2", recordedAt: new Date().toISOString(), metrics,
    }),
    MetricLinkError,
  );
  const stored = await sql<{ n: number }>`
    select count(*)::int as n from unified_performance_telemetry where organization_id = ${tenant.organizationId}
  `;
  assert.equal(stored[0]?.n, 0);
});
