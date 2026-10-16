/**
 * One stored row per observation of a creative on a surface (migration 0098). The migration runs on a fresh PGlite after the earlier
 * migrations: it keeps the earliest row of each duplicate, leaves the rows that are not duplicates, and refuses a new duplicate. The
 * concurrent test races two writers for one ad-day on the test database.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { getSql } from "../../db.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { recordLinkedMetric, type LinkedMetrics } from "./creative-linkage.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");
const INDEX = "unified_performance_telemetry_observation_uidx";

function metricsOf(views: number): LinkedMetrics {
  return {
    views, reach: null, impressions: null, clicks: null, engagements: null, shares: null, saves: null, conversions: null,
    spendCents: null, revenueCents: null, watchTimeSeconds: null, hookRetention3s: null, completionRate: null,
  };
}

test("migration 0098 keeps the earliest row of each duplicate observation, and then refuses a new duplicate", async () => {
  const pg = new PGlite({ extensions: { vector } });
  try {
    await pg.waitReady;
    const files = (await readdir(migrationsDir)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
    const target = files.find((file) => file.startsWith("0098_"));
    assert.ok(target, "the observation migration exists");
    for (const file of files.slice(0, files.indexOf(target))) {
      await pg.exec(await readFile(join(migrationsDir, file), "utf8"));
    }

    const row = (id: string, source: string, creative: string, key: string | null, createdAt: string) => pg.query(
      `insert into unified_performance_telemetry (id, organization_id, brand_id, platform, source_type, creative_id, external_post_id, recorded_at, created_at, metadata)
       values ($1, 'org-mig', 'brand-mig', 'meta', $2, $3, 'ad-1', '2026-01-01T00:00:00Z', $4, $5::jsonb)`,
      [id, source, creative, createdAt, JSON.stringify(key === null ? {} : { observationKey: key, surface: source })],
    );
    const dayKey = "paid:ad-1:2026-01-01";
    await row("keep", "paid", "c1", dayKey, "2026-01-01T00:00:00Z");
    await row("drop-later", "paid", "c1", dayKey, "2026-01-02T00:00:00Z");
    await row("other-surface", "organic", "c1", dayKey, "2026-01-02T00:00:00Z");
    await row("other-creative", "paid", "c2", dayKey, "2026-01-02T00:00:00Z");
    await row("unkeyed-1", "paid", "c1", null, "2026-01-03T00:00:00Z");
    await row("unkeyed-2", "paid", "c1", null, "2026-01-03T00:00:00Z");

    await pg.exec(await readFile(join(migrationsDir, target), "utf8"));

    const left = await pg.query<{ id: string }>(`select id from unified_performance_telemetry order by id`);
    assert.deepEqual(
      left.rows.map((item) => item.id),
      ["keep", "other-creative", "other-surface", "unkeyed-1", "unkeyed-2"],
      "the earliest row of the duplicate is kept, and only that duplicate is removed; other surfaces, creatives and unkeyed rows stay",
    );

    const index = await pg.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = $1`, [INDEX]);
    assert.equal(index.rows.length, 1, "the unique key exists");
    assert.match(index.rows[0]?.indexdef ?? "", /UNIQUE INDEX/);
    assert.match(index.rows[0]?.indexdef ?? "", /creative_id, source_type/);
    assert.match(index.rows[0]?.indexdef ?? "", /observationKey/);

    await assert.rejects(
      row("new-duplicate", "paid", "c1", dayKey, "2026-01-04T00:00:00Z"),
      (error: unknown) => {
        assert.match(String((error as Error).message), /duplicate key|unique/i, "a new duplicate is refused by the database");
        return true;
      },
    );
    await row("new-unkeyed", "paid", "c1", null, "2026-01-04T00:00:00Z");
  } finally {
    await pg.close();
  }
});

test("two writers that race for one ad-day store one row: the first is recorded, the other is a duplicate", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, `observation-race-${randomUUID().slice(0, 8)}`);
  const creativeId = `creative-race-${randomUUID().slice(0, 8)}`;
  const adId = `ad-race-${randomUUID().slice(0, 8)}`;
  await sql`
    insert into provider_objects (id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status)
    values (${`receipt-${creativeId}`}, ${tenant.organizationId}, ${tenant.brandId}, 'meta', 'ad', ${creativeId}, ${adId}, 'paused')
  `;
  const input = {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    creativeId,
    surface: "paid" as const,
    externalId: adId,
    observationKey: `paid:${adId}:2026-03-01`,
    recordedAt: "2026-03-01T00:00:00.000Z",
    metrics: metricsOf(100),
  };

  const raced = await Promise.all([recordLinkedMetric(sql, input), recordLinkedMetric(sql, input)]);
  assert.deepEqual(raced.map((result) => result.status).sort(), ["duplicate", "recorded"], "exactly one writer records the ad-day");

  const again = await recordLinkedMetric(sql, input);
  assert.equal(again.status, "duplicate", "a later repeat of the same ad-day is a duplicate too");

  const stored = await sql<{ n: number }>`
    select count(*)::int as n from unified_performance_telemetry
    where organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId} and creative_id = ${creativeId}
      and source_type = 'paid' and metadata->>'observationKey' = ${input.observationKey}
  `;
  assert.equal(Number(stored[0]?.n), 1, "one stored row for the ad-day");
});
