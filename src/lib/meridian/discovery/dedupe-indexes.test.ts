/**
 * Brand-scoped dedupe, enforced by the database (the discovery dedupe migration). Each backend runs the same checks: a duplicate content hash in
 * one brand is refused, another brand may keep the same content, a store that loses a race is seen before, and a second run over
 * the same page stores nothing new. The migration itself is checked on PostgreSQL: it runs on a scratch schema that holds the
 * earlier migrations, keeps the earliest row of each duplicate, moves its sightings, and then refuses a new duplicate. The migration
 * is found by its name suffix, so a renumbered file is still the one under test.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { openTestBackends } from "../../../test-support/lib/meridian/credentials/test-databases.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../../../test-support/lib/meridian/testing/durable-image-fixtures.ts";
import { crawlLadderPage } from "./crawler.ts";
import { contentHashOf, type RecordProvenance } from "./content-identity.ts";
import { storeDiscoveredItem } from "./item-store.ts";
import { DiscoveryService, type PageCrawler } from "./service.ts";
import type { DiscoveredItem } from "./types.ts";

const backends = await openTestBackends();
after(async () => {
  for (const backend of backends) await backend.close();
});

const ITEM_INDEX = "discovered_items_brand_content_hash_uidx";
const EVIDENCE_INDEX = "discovered_page_evidence_brand_content_hash_uidx";

type Tenant = { organizationId: string; brandId: string; userId: string };

async function insertBrand(sql: Sql, tenant: Tenant): Promise<string> {
  const brandId = `brand-dedupe-${randomUUID().slice(0, 8)}`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${tenant.organizationId}, ${brandId}, ${tenant.userId})`;
  return brandId;
}

async function insertRun(sql: Sql, tenant: Tenant, runId: string, brandId = tenant.brandId): Promise<void> {
  await sql`
    insert into discovery_runs (id, organization_id, brand_id, scope, status, started_at)
    values (${runId}, ${tenant.organizationId}, ${brandId}, 'url_list', 'completed', now())
  `;
}

async function insertItem(sql: Sql, input: { id: string; runId: string; tenant: Tenant; brandId?: string; hash: string; at?: string }) {
  await sql`
    insert into discovered_items (id, run_id, organization_id, brand_id, source, url, canonical_url, card_type, metrics, content_hash, discovered_at)
    values (${input.id}, ${input.runId}, ${input.tenant.organizationId}, ${input.brandId ?? input.tenant.brandId}, 'website',
            'https://shop.example/x', 'https://shop.example/x', 'article', '{}'::jsonb, ${input.hash}, ${input.at ?? new Date().toISOString()})
  `;
}

async function insertEvidence(sql: Sql, input: { id: string; runId: string; tenant: Tenant; kind: string; hash: string | null; pageUrl?: string }) {
  await sql`
    insert into discovered_page_evidence (
      id, organization_id, brand_id, run_id, source_key, page_url, kind, payload, state, observed_at, adapter_id, content_hash, source_status
    ) values (
      ${input.id}, ${input.tenant.organizationId}, ${input.tenant.brandId}, ${input.runId}, 'source-key', ${input.pageUrl ?? "https://shop.example/x"},
      ${input.kind}, '{}'::jsonb, 'OBSERVED', now(), 'website', ${input.hash}, 'HEALTHY'
    )
  `;
}

/** A client that hides the first duplicate check, as if another run had stored the content after that check. */
function raceAfterCheck(sql: Sql): Sql {
  let hidden = false;
  const wrapped = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (!hidden && text.includes("select id from discovered_items")) {
      hidden = true;
      return Promise.resolve([]);
    }
    return (sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values);
  };
  return wrapped as unknown as Sql;
}

for (const { name, sql } of backends) {
  test(`[${name}] a second item with the same content hash in one brand is refused by the database`, async () => {
    const tenant = await studioTenant(sql, `dedupe-item-${name}`);
    const runId = `run-dedupe-a-${randomUUID()}`;
    await insertRun(sql, tenant, runId);
    const hash = contentHashOf(["same content", randomUUID()]);
    await insertItem(sql, { id: `item-a-${randomUUID()}`, runId, tenant, hash });

    await assert.rejects(
      insertItem(sql, { id: `item-b-${randomUUID()}`, runId, tenant, hash }),
      (error: unknown) => {
        assert.match(String((error as Error).message), new RegExp(ITEM_INDEX), "the unique index names the conflict");
        return true;
      },
    );

    const otherBrand = await insertBrand(sql, tenant);
    await insertItem(sql, { id: `item-c-${randomUUID()}`, runId, tenant, brandId: otherBrand, hash });
    const rows = await sql<{ n: number }>`select count(*)::int as n from discovered_items where content_hash = ${hash}`;
    assert.equal(Number(rows[0]?.n), 2, "one row per brand, so the same content is kept once for each brand");
  });

  test(`[${name}] a second evidence record with the same content hash in one brand is refused, and a null hash is not keyed`, async () => {
    const tenant = await studioTenant(sql, `dedupe-ev-${name}`);
    const runId = `run-dedupe-e-${randomUUID()}`;
    await insertRun(sql, tenant, runId);
    const hash = contentHashOf(["https://shop.example/x", "meta", randomUUID()]);
    await insertEvidence(sql, { id: `ev-a-${randomUUID()}`, runId, tenant, kind: "meta", hash });

    await assert.rejects(
      insertEvidence(sql, { id: `ev-b-${randomUUID()}`, runId, tenant, kind: "open_graph", hash }),
      (error: unknown) => {
        assert.match(String((error as Error).message), new RegExp(EVIDENCE_INDEX));
        return true;
      },
    );

    // Rows written before the hash existed have no key, so they do not conflict with each other.
    await insertEvidence(sql, { id: `ev-n1-${randomUUID()}`, runId, tenant, kind: "meta", hash: null, pageUrl: "https://shop.example/n1" });
    await insertEvidence(sql, { id: `ev-n2-${randomUUID()}`, runId, tenant, kind: "meta", hash: null, pageUrl: "https://shop.example/n2" });
  });

  test(`[${name}] a store that loses a race to another run is seen before, and records a sighting, not a second record`, async () => {
    const tenant = await studioTenant(sql, `dedupe-race-${name}`);
    const first = `run-race-1-${randomUUID()}`;
    const second = `run-race-2-${randomUUID()}`;
    await insertRun(sql, tenant, first);
    await insertRun(sql, tenant, second);
    const provenance = (runId: string): RecordProvenance => ({
      organizationId: tenant.organizationId, brandId: tenant.brandId, runId, adapterId: "website", sourceStatus: "HEALTHY",
    });
    const hash = contentHashOf(["https://shop.example/race", "Race card", ""]);
    const item = (id: string): DiscoveredItem => ({
      id, runId: "", url: "https://shop.example/race", canonicalUrl: "https://shop.example/race", source: "website", cardType: "article",
      title: "Race card", metrics: {}, contentHash: hash, sourceLocation: "https://shop.example/race", discoveredAt: new Date().toISOString(),
    });

    const stored = await storeDiscoveredItem(sql, provenance(first), item(`item-first-${randomUUID()}`));
    assert.equal(stored, "stored");

    // The second run's check sees nothing, so its insert meets the unique index instead.
    const raced = await storeDiscoveredItem(raceAfterCheck(sql), provenance(second), item(`item-second-${randomUUID()}`));
    assert.equal(raced, "seen_before");

    const rows = await sql<{ n: number }>`select count(*)::int as n from discovered_items where content_hash = ${hash} and brand_id = ${tenant.brandId}`;
    assert.equal(Number(rows[0]?.n), 1, "one stored record for the content");
    const sightings = await sql<{ run_id: string; seen_before: boolean }>`
      select run_id, seen_before from discovered_sightings where run_id = ${second}
    `;
    assert.deepEqual(sightings.map((row) => row.seen_before), [true], "the second run records that it saw the record, not that it stored it");
  });

  test(`[${name}] a second run over the same public page stores nothing new`, async () => {
    const tenant = await studioTenant(sql, `dedupe-run-${name}`);
    const page = "https://shop.example/dedupe";
    const html = `<!doctype html><html><head><title>Dedupe page</title><meta name="description" content="One page."></head>
      <body><div class="feed"><article class="feed-item card"><h3>Launch week</h3><p>Pre-order today.</p></article></div></body></html>`;
    const crawl: PageCrawler = ((url: string, runId: string, allowedHosts?: string[]) =>
      crawlLadderPage(url, runId, allowedHosts, { fetchHtml: async (target: string) => ({ url: target, html }) })) as PageCrawler;
    const service = new DiscoveryService(undefined, crawl);
    const run = { organizationId: tenant.organizationId, brandId: tenant.brandId, scope: "url_list" as const, seeds: [page], sql };

    const first = await service.startDiscoveryRun(run);
    assert.ok(first.items.length >= 1, "the first run stores the page");
    const second = await service.startDiscoveryRun(run);
    assert.equal(second.items.length, 0, "the second run stores no item");
    const evidence = await sql<{ n: number }>`select count(*)::int as n from discovered_page_evidence where run_id = ${second.run.id}`;
    assert.equal(Number(evidence[0]?.n), 0, "and no evidence");
    assert.ok((second.run.progress.seenBefore ?? 0) > 0, "everything the second run matched is counted as seen before");
  });
}

// --- The dedupe migration on a scratch schema (PostgreSQL only) -------------------------------------------------------------

const pgUrl = process.env.MERIDIAN_PG_TEST_URL?.trim();
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");

test("the dedupe migration keeps the earliest row of each duplicate, moves its sightings, and then refuses a new duplicate", { skip: pgUrl ? false : "MERIDIAN_PG_TEST_URL is not set" }, async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  const schema = `migdedupe_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  try {
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}", public`);
    const files = (await readdir(migrationsDir)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
    const dedupe = files.find((file) => file.endsWith("_discovery_dedupe_indexes.sql"));
    assert.ok(dedupe, "the dedupe migration exists");
    for (const file of files.slice(0, files.indexOf(dedupe))) {
      await client.query(await readFile(join(migrationsDir, file), "utf8"));
    }

    const org = `org-mig-${randomUUID().slice(0, 8)}`;
    const brand = `brand-mig-${randomUUID().slice(0, 8)}`;
    const run = `run-mig-${randomUUID().slice(0, 8)}`;
    await client.query(`insert into organizations (id, name, slug, created_by) values ($1, $1, $1, 'test-user')`, [org]);
    await client.query(`insert into brands (id, organization_id, name, created_by) values ($1, $2, $1, 'test-user')`, [brand, org]);
    await client.query(`insert into discovery_runs (id, organization_id, brand_id, scope, status) values ($1, $2, $3, 'url_list', 'completed')`, [run, org, brand]);

    const hash = contentHashOf(["migrated duplicate"]);
    const insertItem = (id: string, at: string) => client.query(
      `insert into discovered_items (id, run_id, organization_id, brand_id, source, url, card_type, metrics, content_hash, discovered_at)
       values ($1, $2, $3, $4, 'website', 'https://shop.example/m', 'article', '{}'::jsonb, $5, $6)`,
      [id, run, org, brand, hash, at],
    );
    await insertItem("item-keep", "2026-01-01T00:00:00Z");
    await insertItem("item-drop", "2026-01-02T00:00:00Z");
    await client.query(
      `insert into discovered_sightings (id, organization_id, brand_id, run_id, record_id, source_key, seen_before)
       values ('sight-1', $1, $2, $3, 'item-drop', 'source-key', true)`,
      [org, brand, run],
    );

    const evidenceHash = contentHashOf(["migrated evidence"]);
    const insertEvidence = (id: string, kind: string, observed: string, hashValue: string | null, pageUrl = "https://shop.example/m") => client.query(
      `insert into discovered_page_evidence (id, organization_id, brand_id, run_id, source_key, page_url, kind, payload, observed_at, content_hash)
       values ($1, $2, $3, $4, 'source-key', $8, $5, '{}'::jsonb, $6, $7)`,
      [id, org, brand, run, kind, observed, hashValue, pageUrl],
    );
    await insertEvidence("ev-keep", "meta", "2026-01-01T00:00:00Z", evidenceHash);
    await insertEvidence("ev-drop", "open_graph", "2026-01-02T00:00:00Z", evidenceHash);
    await insertEvidence("ev-null-1", "json_ld", "2026-01-03T00:00:00Z", null, "https://shop.example/n1");
    await insertEvidence("ev-null-2", "meta", "2026-01-03T00:00:00Z", null, "https://shop.example/n2");

    await client.query(await readFile(join(migrationsDir, dedupe), "utf8"));

    const items = await client.query(`select id from discovered_items where content_hash = $1`, [hash]);
    assert.deepEqual(items.rows.map((row) => row.id), ["item-keep"], "the earliest item is kept");
    const sightings = await client.query(`select record_id from discovered_sightings where id = 'sight-1'`);
    assert.deepEqual(sightings.rows.map((row) => row.record_id), ["item-keep"], "the duplicate's sighting now points at the kept item");
    const evidence = await client.query(`select id from discovered_page_evidence where content_hash = $1`, [evidenceHash]);
    assert.deepEqual(evidence.rows.map((row) => row.id), ["ev-keep"], "the earliest evidence is kept");
    const unkeyed = await client.query(`select count(*)::int as n from discovered_page_evidence where content_hash is null`);
    assert.equal(Number(unkeyed.rows[0].n), 2, "rows without a hash are not deleted");

    const indexes = await client.query(`select indexname, indexdef from pg_indexes where schemaname = $1 and indexname in ($2, $3, 'discovered_items_brand_content_hash_idx')`, [schema, ITEM_INDEX, EVIDENCE_INDEX]);
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef as string]));
    assert.match(byName.get(ITEM_INDEX) ?? "", /UNIQUE INDEX .*\(organization_id, brand_id, content_hash\)/);
    assert.match(byName.get(EVIDENCE_INDEX) ?? "", /UNIQUE INDEX .*\(organization_id, brand_id, content_hash\)/);
    assert.equal(byName.has("discovered_items_brand_content_hash_idx"), false, "the non-unique index it replaces is gone");

    await assert.rejects(insertItem("item-new", "2026-01-04T00:00:00Z"), /duplicate key|unique/i, "a new duplicate is refused");
  } finally {
    await client.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await client.end();
  }
});
