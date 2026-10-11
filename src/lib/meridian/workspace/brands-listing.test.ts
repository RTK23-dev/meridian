import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { persistBrandLogo } from "../brand/logo-store.ts";
import { studioTenant, PNG_BASE64 } from "../testing/durable-image-fixtures.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";

// The brands listing imports modules that use the "@/" alias, so the alias hook is registered before it is loaded.
enableAppAliases();
const { loadWorkspaceBrands } = await import("./brands-listing.ts");

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();
const BACKFILL = fileURLToPath(new URL("../../../../migrations/0053_brand_logo_blobs.sql", import.meta.url));

/**
 * A stored logo is served by its asset id, so the bootstrap lists it. A logo whose bytes are not stored, a brand with no logo,
 * a deleted brand and another workspace's brand are not offered a logo. A logo stored before the bytes were copied is served
 * once the backfill has run.
 */
async function logosAreListedOnlyWhenServable(sql: Sql) {
  const tenant = await studioTenant(sql, `logo-${Math.random().toString(36).slice(2, 8)}`);
  const other = await studioTenant(sql, `logo-other-${Math.random().toString(36).slice(2, 8)}`);
  const suffix = Math.random().toString(36).slice(2, 8);
  const plainBrand = `brand-plain-${suffix}`;
  const deletedBrand = `brand-deleted-${suffix}`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${plainBrand}, ${tenant.organizationId}, 'Plain', ${tenant.userId})`;
  await sql`insert into brands (id, organization_id, name, created_by, deleted_at) values (${deletedBrand}, ${tenant.organizationId}, 'Deleted', ${tenant.userId}, now())`;

  const bytes = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));
  const logoAssetId = `as-logo-${suffix}`;
  const { storageKey } = await persistBrandLogo(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    assetId: logoAssetId,
    base64: PNG_BASE64,
    bytes,
    mime: "image/png",
    contentHashValue: suffix,
  });
  const [blob] = await sql<{ checksum: string; byte_size: number }>`select checksum, byte_size from asset_blobs where storage_key = ${storageKey}`;
  assert.equal(blob?.checksum, createHash("sha256").update(bytes).digest("hex"), "the stored bytes carry their SHA-256, which the asset route checks");
  assert.equal(Number(blob?.byte_size), bytes.byteLength, "the stored length is the byte length, not the base64 length");

  // A logo row whose bytes were never copied to asset_blobs (the way logos were stored before this change).
  const legacyAssetId = `as-legacy-${suffix}`;
  await sql`
    insert into assets (id, organization_id, brand_id, version, storage_key, content_hash, mime_type, source, status, body, byte_size, label)
    values (${legacyAssetId}, ${tenant.organizationId}, ${plainBrand}, 1, ${`brand/${plainBrand}/logo/legacy-${suffix}`}, 'x', 'image/png', 'logo_upload', 'stored', ${PNG_BASE64}, ${bytes.byteLength}, 'logo')
  `;

  let brands = await loadWorkspaceBrands(sql, tenant.organizationId);
  const byId = new Map(brands.map((brand) => [brand.id, brand]));
  assert.equal(byId.get(tenant.brandId)?.logoAssetId, logoAssetId, "a stored, servable logo is listed by its asset id");
  assert.equal(byId.get(plainBrand)?.logoAssetId, null, "a logo whose bytes are not stored is not offered, and a brand with none gets null");
  assert.equal(byId.has(deletedBrand), false, "a deleted brand is not listed");
  assert.equal(brands.some((brand) => brand.id === other.brandId), false, "another workspace's brand is not listed");

  // The backfill copies the legacy logo's bytes, with the checksum and length the asset route checks. It can run again.
  await sql.query(await readFile(BACKFILL, "utf8"), []);
  await sql.query(await readFile(BACKFILL, "utf8"), []);
  brands = await loadWorkspaceBrands(sql, tenant.organizationId);
  const after = new Map(brands.map((brand) => [brand.id, brand]));
  assert.equal(after.get(plainBrand)?.logoAssetId, legacyAssetId, "after the backfill the legacy logo is served by its asset id");
  const [legacyBlob] = await sql<{ checksum: string; byte_size: number; lifecycle: string }>`
    select checksum, byte_size, lifecycle from asset_blobs where storage_key = ${`brand/${plainBrand}/logo/legacy-${suffix}`}
  `;
  assert.equal(legacyBlob?.checksum, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(Number(legacyBlob?.byte_size), bytes.byteLength);
  assert.equal(legacyBlob?.lifecycle, "stored");
}

const TARGETS = ["PGlite", "PostgreSQL"] as const;
for (const target of TARGETS) {
  test(`the brand list offers only servable logos, and the backfill serves legacy ones, on ${target}`, async (t) => {
    if (target === "PostgreSQL" && !PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL logo check was not run");
      return;
    }
    if (target === "PGlite") {
      await logosAreListedOnlyWhenServable(await getSql());
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await logosAreListedOnlyWhenServable(createPoolSql(pool));
    } finally {
      await pool.end();
    }
  });
}
