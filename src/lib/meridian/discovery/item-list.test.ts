import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "../learning/store.ts";
import { DISCOVERED_EXCERPT_LIMIT, DISCOVERED_TITLE_LIMIT, listDiscoveredItemsFor } from "./item-list.ts";

async function makeTestDb(): Promise<Sql> {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  const dir = join(process.cwd(), "migrations");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  await db.exec("create table if not exists _migrations (name text primary key)");
  for (const name of names) await db.exec(await readFile(join(dir, name), "utf8"));
  const sql = (async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1] ?? ""}`;
    return (await db.query<T>(text, values)).rows;
  }) as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await db.query<T>(text, params)).rows;
  return sql;
}

async function addItem(
  sql: Sql,
  row: { id: string; brandId: string; discoveredAt: string; title?: string; text?: string },
) {
  await sql`
    insert into discovered_items (id, run_id, organization_id, brand_id, source, url, card_type, title, text_content, metrics, content_hash, discovered_at)
    values (${row.id}, 'run-d', 'org-d', ${row.brandId}, 'website', ${`https://competitor.example/${row.id}`}, 'article',
      ${row.title ?? null}, ${row.text ?? null}, '{}', ${`hash-${row.id}`}, ${row.discoveredAt})
  `;
}

test("a brand's stored pages list newest first, cap the text, and leave out other brands", async () => {
  const sql = await makeTestDb();
  await sql`insert into "user" (id, name, email, "emailVerified") values ('user-d', 'Member', 'member@fixture.example', true)`;
  await sql`insert into "user" (id, name, email, "emailVerified") values ('user-out', 'Outsider', 'outsider@fixture.example', true)`;
  await sql`insert into organizations (id, name, slug, created_by) values ('org-d', 'Org', 'org-d', 'user-d')`;
  await sql`insert into memberships (id, organization_id, user_id, role) values ('mem-d', 'org-d', 'user-d', 'member')`;
  await sql`insert into brands (id, organization_id, name, created_by) values ('brand-d', 'org-d', 'Brand', 'user-d')`;
  await sql`insert into brands (id, organization_id, name, created_by) values ('brand-other', 'org-d', 'Other', 'user-d')`;
  await sql`
    insert into discovery_runs (id, organization_id, brand_id, scope, status)
    values ('run-d', 'org-d', 'brand-d', 'public_page', 'completed')
  `;

  const longText = `Line one\n\n   line two ${"x".repeat(DISCOVERED_EXCERPT_LIMIT + 50)}`;
  await addItem(sql, { id: "item-old", brandId: "brand-d", discoveredAt: "2026-01-01T09:00:00Z", title: "Old page", text: "Older text" });
  await addItem(sql, { id: "item-new", brandId: "brand-d", discoveredAt: "2026-01-02T09:00:00Z", title: "T".repeat(DISCOVERED_TITLE_LIMIT + 20), text: longText });
  await addItem(sql, { id: "item-elsewhere", brandId: "brand-other", discoveredAt: "2026-01-03T09:00:00Z", title: "Not this brand" });

  const items = await listDiscoveredItemsFor(sql, "user-d", "brand-d");
  assert.deepEqual(items.map((item) => item.id), ["item-new", "item-old"], "newest first, and only this brand");
  const newest = items[0];
  assert.ok(newest);
  assert.equal(newest.title.length, DISCOVERED_TITLE_LIMIT, "a long title is capped");
  assert.equal(newest.excerpt.length, DISCOVERED_EXCERPT_LIMIT, "a long excerpt is capped");
  assert.equal(newest.excerpt.startsWith("Line one line two"), true, "whitespace is collapsed to single spaces");
  assert.equal(newest.url, "https://competitor.example/item-new");
  assert.equal(newest.source, "website");
});

test("a person outside the workspace cannot list a brand's stored pages", async () => {
  const sql = await makeTestDb();
  await sql`insert into "user" (id, name, email, "emailVerified") values ('user-owner', 'Owner', 'owner@fixture.example', true)`;
  await sql`insert into "user" (id, name, email, "emailVerified") values ('user-stranger', 'Stranger', 'stranger@fixture.example', true)`;
  await sql`insert into organizations (id, name, slug, created_by) values ('org-s', 'Org', 'org-s', 'user-owner')`;
  await sql`insert into memberships (id, organization_id, user_id, role) values ('mem-s', 'org-s', 'user-owner', 'owner')`;
  await sql`insert into brands (id, organization_id, name, created_by) values ('brand-s', 'org-s', 'Brand', 'user-owner')`;
  await assert.rejects(listDiscoveredItemsFor(sql, "user-stranger", "brand-s"), /not available to you/);
});
