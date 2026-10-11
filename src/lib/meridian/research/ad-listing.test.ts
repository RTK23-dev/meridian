import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { loadResearchAds } from "./ad-listing.ts";

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();

/** A research ad's media id is the stored asset for its media key. Media that is not stored gives null. */
async function mediaAssetIdFollowsStoredMedia(sql: Sql) {
  const tenant = await studioTenant(sql, `research-${Math.random().toString(36).slice(2, 8)}`);
  const suffix = Math.random().toString(36).slice(2, 8);
  const jobId = `job-${suffix}`;
  const runId = `run-${suffix}`;
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, payload, max_attempts)
    values (${jobId}, ${tenant.organizationId}, ${tenant.brandId}, 'research.collect', ${`idem-${suffix}`}, 'succeeded', '{}', 1)
  `;
  await sql`
    insert into research_collection_runs (id, organization_id, brand_id, job_id, search_terms, country, status, created_by)
    values (${runId}, ${tenant.organizationId}, ${tenant.brandId}, ${jobId}, 'sponge', 'US', 'succeeded', ${tenant.userId})
  `;
  const insertAd = (id: string, externalId: string, mediaKey: string, brandId: string, organizationId: string) => sql`
    insert into research_ads (id, organization_id, brand_id, collection_run_id, external_id, advertiser, original_url, captured_at, media_status, media_storage_key)
    values (${id}, ${organizationId}, ${brandId}, ${runId}, ${externalId}, 'Acme', 'https://example.test/ad', now(), ${mediaKey ? "stored" : "pending"}, ${mediaKey})
  `;
  const storedKey = `brand/${tenant.brandId}/research/${suffix}`;
  await insertAd(`ra-stored-${suffix}`, `ext-a-${suffix}`, storedKey, tenant.brandId, tenant.organizationId);
  await insertAd(`ra-none-${suffix}`, `ext-b-${suffix}`, "", tenant.brandId, tenant.organizationId);
  await insertAd(`ra-unavail-${suffix}`, `ext-c-${suffix}`, `brand/${tenant.brandId}/research/${suffix}-missing`, tenant.brandId, tenant.organizationId);
  const storedAsset = `as-research-${suffix}`;
  await sql`
    insert into assets (id, organization_id, brand_id, version, storage_key, content_hash, mime_type, source, status, kind, media_status)
    values (${storedAsset}, ${tenant.organizationId}, ${tenant.brandId}, 1, ${storedKey}, 'h', 'video/mp4', 'meta_ad_library', 'stored', 'video', 'completed'),
           (${`as-research-u-${suffix}`}, ${tenant.organizationId}, ${tenant.brandId}, 1, ${`brand/${tenant.brandId}/research/${suffix}-missing`}, 'h', 'video/mp4', 'meta_ad_library', 'unavailable', 'video', 'failed')
  `;

  const ads = await loadResearchAds(sql, tenant.organizationId, tenant.brandId);
  const byId = new Map(ads.map((ad) => [ad.id, ad]));
  assert.equal(byId.get(`ra-stored-${suffix}`)?.mediaAssetId, storedAsset, "stored media returns its asset id");
  assert.equal(byId.get(`ra-none-${suffix}`)?.mediaAssetId, null, "an ad with no media key yields null");
  assert.equal(byId.get(`ra-unavail-${suffix}`)?.mediaAssetId, null, "media whose asset is not stored yields null");
}

const TARGETS = ["PGlite", "PostgreSQL"] as const;
for (const target of TARGETS) {
  test(`the market research ads return the stored media asset id, or null, on ${target}`, async (t) => {
    if (target === "PostgreSQL" && !PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL research check was not run");
      return;
    }
    if (target === "PGlite") {
      await mediaAssetIdFollowsStoredMedia(await getSql());
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await mediaAssetIdFollowsStoredMedia(createPoolSql(pool));
    } finally {
      await pool.end();
    }
  });
}
