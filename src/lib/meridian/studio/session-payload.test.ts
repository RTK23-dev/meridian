import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { loadSession } from "./session.server.ts";

enableAppAliases();

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();

// A 1x1 PNG. The bytes are stored in asset_blobs, and the payload must not carry them.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * The studio payload carries asset ids and the asset status, and no image bytes. The screen loads media from
 * /api/assets/<assetId>. A stored file is served, an unavailable one is reported as not stored, and the usage counts
 * are the ones the generation gate counts.
 */
async function payloadCarriesIdsNotBytes(sql: Sql) {
  const tenant = await studioTenant(sql, `payload-${Math.random().toString(36).slice(2, 8)}`);
  const suffix = Math.random().toString(36).slice(2, 8);
  const creativeId = `cr-${suffix}`;
  const storedAssetId = `as-stored-${suffix}`;
  const missingAssetId = `as-missing-${suffix}`;
  const storedKey = `brand/${tenant.brandId}/image/${suffix}`;
  await sql`
    insert into creative_records (id, organization_id, brand_id, origin, title, status, created_by)
    values (${creativeId}, ${tenant.organizationId}, ${tenant.brandId}, 'generated', 'Fixture creative', 'in_review', ${tenant.userId})
  `;
  await sql`
    insert into assets (id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status, kind, byte_size, variant_index, media_status, width, height)
    values (${storedAssetId}, ${tenant.organizationId}, ${tenant.brandId}, ${creativeId}, 1, ${storedKey}, ${suffix}, 'image/png', 'test', 'stored', 'image', 68, 0, 'completed', 1, 1)
  `;
  await sql`
    insert into asset_blobs (storage_key, organization_id, brand_id, body, mime_type, checksum, byte_size, version, lifecycle)
    values
      (${storedKey}, ${tenant.organizationId}, ${tenant.brandId}, ${PNG_BASE64}, 'image/png', ${suffix}, 68, 1, 'stored'),
      (${`${storedKey}.frame.0.png`}, ${tenant.organizationId}, ${tenant.brandId}, ${PNG_BASE64}, 'image/png', ${suffix}, 68, 1, 'stored')
  `;
  await sql`
    insert into assets (id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status, kind, byte_size, variant_index, media_status)
    values (${missingAssetId}, ${tenant.organizationId}, ${tenant.brandId}, ${creativeId}, 1, ${`brand/${tenant.brandId}/video/${suffix}`}, ${suffix}, 'video/mp4', 'test', 'unavailable', 'video', 0, 1, 'failed')
  `;
  // Two runs in the last day (one still running) and one older run that the daily count must not include.
  await sql`
    insert into generation_runs (id, organization_id, brand_id, prompt_version, image_provider, video_provider, status, created_by, created_at)
    values
      (${`gr1-${suffix}`}, ${tenant.organizationId}, ${tenant.brandId}, 'v', 'p', 'p', 'completed', ${tenant.userId}, now()),
      (${`gr2-${suffix}`}, ${tenant.organizationId}, ${tenant.brandId}, 'v', 'p', 'p', 'running', ${tenant.userId}, now()),
      (${`gr3-${suffix}`}, ${tenant.organizationId}, ${tenant.brandId}, 'v', 'p', 'p', 'completed', ${tenant.userId}, now() - interval '3 days')
  `;

  const session = await loadSession(sql, tenant.organizationId, tenant.brandId, "member");
  const json = JSON.stringify(session);
  assert.equal(json.includes(PNG_BASE64), false, "the payload carries no image bytes");
  assert.equal(json.includes("data:image"), false, "the payload carries no data URLs");
  assert.equal(json.includes("base64"), false, "the payload carries no base64 field");

  const stored = session.variants.find((variant) => variant.assetId === storedAssetId);
  assert.ok(stored, "the stored image is listed with its asset id");
  assert.equal(stored.assetStatus, "stored");
  assert.equal(stored.creativeId, creativeId);
  assert.equal("preview" in stored, false, "no preview field");
  assert.equal("frames" in stored, false, "no frames field");

  const missing = session.variants.find((variant) => variant.assetId === missingAssetId);
  assert.ok(missing, "the unavailable video is still listed, so the screen can say it is not stored");
  assert.equal(missing.assetStatus, "unavailable");

  assert.deepEqual(session.usage, { runsToday: 2, running: 1 }, "usage counts the workspace runs in the last day and in progress");
}

const TARGETS = ["PGlite", "PostgreSQL"] as const;
for (const target of TARGETS) {
  test(`the studio payload has asset ids and no image bytes on ${target}`, async (t) => {
    if (target === "PostgreSQL" && !PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL payload check was not run");
      return;
    }
    if (target === "PGlite") {
      await payloadCarriesIdsNotBytes(await getSql());
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await payloadCarriesIdsNotBytes(createPoolSql(pool));
    } finally {
      await pool.end();
    }
  });
}
