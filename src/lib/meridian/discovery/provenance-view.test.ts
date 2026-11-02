// The "Where it was seen" read of a stored Market page, on PGlite. A member of the brand sees every run that observed the page, in order,
// with the run that stored it first. A stranger is refused. A page read through another brand of the same workspace reports no record,
// because the page belongs to the brand it was stored under. Nothing here calls a live API.

import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "../learning/store.ts";
import { itemProvenanceFor } from "./provenance-view.ts";

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

test("a member sees the runs that observed a stored page, first the run that stored it; a stranger and another brand do not", async () => {
  const sql = await makeTestDb();
  await sql`insert into "user" (id, name, email, "emailVerified") values ('user-p', 'Member', 'member@fixture.example', true)`;
  await sql`insert into "user" (id, name, email, "emailVerified") values ('user-p-out', 'Stranger', 'stranger@fixture.example', true)`;
  await sql`insert into organizations (id, name, slug, created_by) values ('org-p', 'Org', 'org-p', 'user-p')`;
  await sql`insert into memberships (id, organization_id, user_id, role) values ('mem-p', 'org-p', 'user-p', 'member')`;
  await sql`insert into brands (id, organization_id, name, created_by) values ('brand-p', 'org-p', 'Brand', 'user-p')`;
  await sql`insert into brands (id, organization_id, name, created_by) values ('brand-p2', 'org-p', 'Other brand', 'user-p')`;
  await sql`insert into discovery_runs (id, organization_id, brand_id, scope, status) values ('run-1', 'org-p', 'brand-p', 'public_page', 'completed')`;
  await sql`insert into discovery_runs (id, organization_id, brand_id, scope, status) values ('run-2', 'org-p', 'brand-p', 'public_page', 'completed')`;
  await sql`
    insert into discovered_items (id, run_id, organization_id, brand_id, source, url, card_type, title, text_content, metrics, content_hash, discovered_at)
    values ('item-p', 'run-1', 'org-p', 'brand-p', 'website', 'https://competitor.example/page', 'article', 'Page', 'Text', '{}', 'hash-p', '2026-01-01T09:00:00Z')
  `;
  await sql`
    insert into discovered_sightings (id, organization_id, brand_id, run_id, record_id, source_key, seen_before, observed_at)
    values ('sight-1', 'org-p', 'brand-p', 'run-1', 'item-p', 'src-key-1', false, '2026-01-01T09:00:00Z')
  `;
  await sql`
    insert into discovered_sightings (id, organization_id, brand_id, run_id, record_id, source_key, seen_before, observed_at)
    values ('sight-2', 'org-p', 'brand-p', 'run-2', 'item-p', 'src-key-1', true, '2026-01-03T09:00:00Z')
  `;

  const provenance = await itemProvenanceFor(sql, "user-p", "brand-p", "item-p");
  assert.ok(provenance, "the member sees the page's provenance");
  assert.equal(provenance.sourceKey, "src-key-1");
  assert.deepEqual(provenance.runIds, ["run-1", "run-2"]);
  assert.deepEqual(
    provenance.observations.map((observation) => observation.seenBefore),
    [false, true],
    "the run that stored the page is first and not 'seen before'; the later run is",
  );
  assert.equal(provenance.firstObservedAt, "2026-01-01T09:00:00.000Z", "a timestamp is ISO text, not a Date's long form");
  assert.equal(provenance.lastObservedAt, "2026-01-03T09:00:00.000Z");

  await assert.rejects(itemProvenanceFor(sql, "user-p-out", "brand-p", "item-p"), /not a member|not available|Brand not found|membership/i);

  const otherBrand = await itemProvenanceFor(sql, "user-p", "brand-p2", "item-p");
  assert.equal(otherBrand, null, "a page of another brand reports no record, so a page id reveals nothing about another brand");

  const missing = await itemProvenanceFor(sql, "user-p", "brand-p", "item-missing");
  assert.equal(missing, null, "a page that does not exist reports no record");
});
