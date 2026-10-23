import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "../learning/store.ts";
import { brandProductionQueue, BRAND_QUEUE_RECENT } from "./brand-queue.ts";

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

async function addUser(sql: Sql, id: string) {
  await sql`insert into "user" (id, name, email, "emailVerified") values (${id}, ${id}, ${`${id}@fixture.example`}, true)`;
}

async function addJob(
  sql: Sql,
  row: { id: string; organizationId: string; brandId: string | null; status: string; createdAt: string; payload?: string; lastError?: string },
) {
  await sql`
    insert into jobs (id, organization_id, brand_id, job_type, idempotency_key, status, attempts, max_attempts, last_error, payload, created_at)
    values (${row.id}, ${row.organizationId}, ${row.brandId}, 'factory.learn', ${`key-${row.id}`}, ${row.status}, 1, 5,
      ${row.lastError ?? ""}, ${row.payload ?? "{}"}, ${row.createdAt})
  `;
}

test("the brand queue counts only this brand's jobs, and reads a failure's own reason", async () => {
  const sql = await makeTestDb();
  await addUser(sql, "user-member");
  await addUser(sql, "user-viewer");
  await addUser(sql, "user-outsider");
  await sql`insert into organizations (id, name, slug, created_by) values ('org-q', 'Org', 'org-q', 'user-member')`;
  await sql`insert into organizations (id, name, slug, created_by) values ('org-other', 'Other', 'org-other', 'user-outsider')`;
  await sql`insert into memberships (id, organization_id, user_id, role) values ('mem-m', 'org-q', 'user-member', 'member')`;
  await sql`insert into memberships (id, organization_id, user_id, role) values ('mem-v', 'org-q', 'user-viewer', 'viewer')`;
  await sql`insert into brands (id, organization_id, name, created_by) values ('brand-q', 'org-q', 'Lather Co', 'user-member')`;
  await sql`insert into brands (id, organization_id, name, created_by) values ('brand-other', 'org-q', 'Second brand', 'user-member')`;

  await addJob(sql, { id: "job-1", organizationId: "org-q", brandId: "brand-q", status: "queued", createdAt: "2026-01-01T10:00:00Z" });
  await addJob(sql, { id: "job-2", organizationId: "org-q", brandId: "brand-q", status: "queued", createdAt: "2026-01-01T10:01:00Z" });
  await addJob(sql, { id: "job-3", organizationId: "org-q", brandId: "brand-q", status: "running", createdAt: "2026-01-01T10:02:00Z" });
  await addJob(sql, {
    id: "job-4",
    organizationId: "org-q",
    brandId: "brand-q",
    status: "dead",
    createdAt: "2026-01-01T10:03:00Z",
    lastError: "Provider rejected the request: quota exceeded.",
  });
  await addJob(sql, { id: "job-5", organizationId: "org-q", brandId: "brand-q", status: "succeeded", createdAt: "2026-01-01T10:04:00Z" });
  await addJob(sql, { id: "job-other", organizationId: "org-q", brandId: "brand-other", status: "queued", createdAt: "2026-01-01T10:05:00Z" });

  const queue = await brandProductionQueue(sql, "user-member", "brand-q");
  assert.equal(queue.counts.queued, 2);
  assert.equal(queue.counts.running, 1);
  assert.equal(queue.counts.dead, 1);
  assert.equal(queue.counts.succeeded, 1);
  assert.equal(queue.counts.retry, 0, "a status with no jobs is zero, never missing");
  assert.equal(queue.counts.cancelled, 0);
  assert.equal(queue.total, 5, "the other brand's job is not counted");

  assert.equal(queue.recent.length, 5);
  assert.equal(queue.recent[0]?.id, "job-5", "the most recent job comes first");
  const failed = queue.recent.find((job) => job.id === "job-4");
  assert.equal(failed?.error, "Provider rejected the request: quota exceeded.", "a failure shows its own reason");
  assert.equal(queue.recent.some((job) => job.id === "job-other"), false);
});

test("the queue keeps at most the recent page of jobs, and never returns a payload value", async () => {
  const sql = await makeTestDb();
  await addUser(sql, "user-member");
  await sql`insert into organizations (id, name, slug, created_by) values ('org-p', 'Org', 'org-p', 'user-member')`;
  await sql`insert into memberships (id, organization_id, user_id, role) values ('mem-p', 'org-p', 'user-member', 'member')`;
  await sql`insert into brands (id, organization_id, name, created_by) values ('brand-p', 'org-p', 'Brand', 'user-member')`;
  for (let index = 0; index < BRAND_QUEUE_RECENT + 3; index += 1) {
    await addJob(sql, {
      id: `job-p-${index}`,
      organizationId: "org-p",
      brandId: "brand-p",
      status: "queued",
      createdAt: `2026-01-02T10:${String(index).padStart(2, "0")}:00Z`,
      payload: JSON.stringify({ prompt: "SECRET-PROMPT-TEXT", reel: "A" }),
    });
  }
  const queue = await brandProductionQueue(sql, "user-member", "brand-p");
  assert.equal(queue.total, BRAND_QUEUE_RECENT + 3, "the counts cover every job");
  assert.equal(queue.recent.length, BRAND_QUEUE_RECENT, "only the recent page is returned");
  assert.deepEqual(queue.recent[0]?.payloadKeys.sort(), ["prompt", "reel"], "payload field names are shown");
  assert.equal(JSON.stringify(queue).includes("SECRET-PROMPT-TEXT"), false, "no payload value is returned");
});

test("a viewer may read the brand's queue, and a person outside the workspace may not", async () => {
  const sql = await makeTestDb();
  await addUser(sql, "user-owner");
  await addUser(sql, "user-viewer");
  await addUser(sql, "user-outsider");
  await sql`insert into organizations (id, name, slug, created_by) values ('org-v', 'Org', 'org-v', 'user-owner')`;
  await sql`insert into memberships (id, organization_id, user_id, role) values ('mem-vo', 'org-v', 'user-owner', 'owner')`;
  await sql`insert into memberships (id, organization_id, user_id, role) values ('mem-vv', 'org-v', 'user-viewer', 'viewer')`;
  await sql`insert into brands (id, organization_id, name, created_by) values ('brand-v', 'org-v', 'Brand', 'user-owner')`;

  const viewed = await brandProductionQueue(sql, "user-viewer", "brand-v");
  assert.equal(viewed.total, 0, "an empty brand reads as zero jobs, not as an error");

  await assert.rejects(brandProductionQueue(sql, "user-outsider", "brand-v"), /not available to you/);
  await assert.rejects(brandProductionQueue(sql, "user-viewer", "brand-missing"), /Brand not found/);
});
