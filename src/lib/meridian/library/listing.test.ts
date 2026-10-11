import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { loadLibraryCreatives } from "./listing.ts";

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();

/** A creative with a stored image gets that asset's id. A creative whose asset is not stored, or that has none, gets null. */
async function assetIdsFollowStoredFiles(sql: Sql) {
  const tenant = await studioTenant(sql, `library-${Math.random().toString(36).slice(2, 8)}`);
  const other = await studioTenant(sql, `library-other-${Math.random().toString(36).slice(2, 8)}`);
  const suffix = Math.random().toString(36).slice(2, 8);
  const stored = `cr-stored-${suffix}`;
  const unavailable = `cr-unavail-${suffix}`;
  const bare = `cr-bare-${suffix}`;
  const competitor = `cr-comp-${suffix}`;
  const foreign = `cr-foreign-${suffix}`;
  const insertCreative = (id: string, brandId: string, organizationId: string, userId: string, origin: string, createdAt: string) => sql`
    insert into creative_records (id, organization_id, brand_id, origin, title, status, created_by, created_at)
    values (${id}, ${organizationId}, ${brandId}, ${origin}, ${`Title ${id}`}, 'in_review', ${userId}, ${createdAt}::timestamptz)
  `;
  await insertCreative(stored, tenant.brandId, tenant.organizationId, tenant.userId, "generated", "2026-01-04T00:00:00Z");
  await insertCreative(unavailable, tenant.brandId, tenant.organizationId, tenant.userId, "generated", "2026-01-03T00:00:00Z");
  await insertCreative(bare, tenant.brandId, tenant.organizationId, tenant.userId, "own", "2026-01-02T00:00:00Z");
  await insertCreative(competitor, tenant.brandId, tenant.organizationId, tenant.userId, "competitor", "2026-01-05T00:00:00Z");
  await insertCreative(foreign, other.brandId, other.organizationId, other.userId, "generated", "2026-01-06T00:00:00Z");
  const storedAsset = `as-stored-${suffix}`;
  await sql`
    insert into assets (id, organization_id, brand_id, creative_id, version, storage_key, content_hash, mime_type, source, status, kind, variant_index, media_status)
    values (${storedAsset}, ${tenant.organizationId}, ${tenant.brandId}, ${stored}, 1, ${`k/${suffix}/a`}, 'h', 'image/png', 'test', 'stored', 'image', 0, 'completed'),
           (${`as-unavail-${suffix}`}, ${tenant.organizationId}, ${tenant.brandId}, ${unavailable}, 1, ${`k/${suffix}/b`}, 'h', 'video/mp4', 'test', 'unavailable', 'video', 0, 'failed')
  `;

  const rows = await loadLibraryCreatives(sql, tenant.organizationId, tenant.brandId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get(stored)?.assetId, storedAsset, "a stored asset's id is returned");
  assert.equal(byId.get(stored)?.assetKind, "image");
  assert.equal(byId.get(stored)?.assetMediaStatus, "completed");
  assert.equal(byId.get(unavailable)?.assetId, null, "an asset that is not stored yields no id");
  assert.equal(byId.get(bare)?.assetId, null, "a creative with no asset yields null, not an empty string");
  assert.equal(byId.has(competitor), false, "competitor observations stay out of the library");
  assert.equal(byId.has(foreign), false, "another workspace's creatives are not listed");
}

const TARGETS = ["PGlite", "PostgreSQL"] as const;
for (const target of TARGETS) {
  test(`the library listing returns the stored asset id, or null, on ${target}`, async (t) => {
    if (target === "PostgreSQL" && !PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL library check was not run");
      return;
    }
    if (target === "PGlite") {
      await assetIdsFollowStoredFiles(await getSql());
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await assetIdsFollowStoredFiles(createPoolSql(pool));
    } finally {
      await pool.end();
    }
  });
}
