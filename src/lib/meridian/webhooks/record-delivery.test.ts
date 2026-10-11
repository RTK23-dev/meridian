import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { recordWebhookDelivery } from "./receive-store.ts";

// Runs against the migrated database the test process uses (embedded, or DATABASE_URL when it is set). The in-memory fake
// in receive-handler.test.ts cannot check that the ON CONFLICT targets match the real unique indexes, so these do.

async function counts(sql: Sql, organizationId: string, eventId: string): Promise<{ events: number; jobs: number }> {
  const events = await sql<{ count: number }>`
    select count(*) as count from webhook_events where organization_id = ${organizationId} and event_id = ${eventId}
  `;
  const jobs = await sql<{ count: number }>`
    select count(*) as count from jobs where organization_id = ${organizationId} and idempotency_key = ${`webhook:meta:${eventId}`}
  `;
  return { events: Number(events[0]?.count), jobs: Number(jobs[0]?.count) };
}

async function cleanup(sql: Sql, organizationIds: string[]): Promise<void> {
  for (const id of organizationIds) {
    await sql`delete from jobs where organization_id = ${id}`;
    await sql`delete from webhook_events where organization_id = ${id}`;
    await sql`delete from organizations where id = ${id}`;
  }
}

async function seed(sql: Sql, organizationId: string): Promise<void> {
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
}

test("a delivery records its event and its job together, and a repeat stores nothing new", async () => {
  const sql = await getSql();
  const suffix = randomUUID().slice(0, 8);
  const org = `org-record-${suffix}`;
  const eventId = `evt-${suffix}`;
  try {
    await seed(sql, org);
    assert.equal(await recordWebhookDelivery(sql, { organizationId: org, provider: "meta", eventId }), true);
    assert.equal(await recordWebhookDelivery(sql, { organizationId: org, provider: "meta", eventId }), false);
    assert.deepEqual(await counts(sql, org, eventId), { events: 1, jobs: 1 });
    const [job] = await sql<{ job_type: string; status: string; payload: string }>`
      select job_type, status, payload from jobs where organization_id = ${org} and idempotency_key = ${`webhook:meta:${eventId}`}
    `;
    assert.equal(job?.job_type, "webhook.received");
    assert.equal(job?.status, "queued");
    assert.deepEqual(JSON.parse(job?.payload ?? "{}"), { eventId, provider: "meta" });
  } finally {
    await cleanup(sql, [org]);
  }
});

test("two deliveries of one event that race each other store one event and one job", async () => {
  const sql = await getSql();
  const suffix = randomUUID().slice(0, 8);
  const org = `org-race-${suffix}`;
  const eventId = `evt-race-${suffix}`;
  try {
    await seed(sql, org);
    const results = await Promise.all([
      recordWebhookDelivery(sql, { organizationId: org, provider: "meta", eventId }),
      recordWebhookDelivery(sql, { organizationId: org, provider: "meta", eventId }),
    ]);
    assert.equal(results.filter(Boolean).length, 1, "exactly one of the two deliveries stored the event");
    assert.deepEqual(await counts(sql, org, eventId), { events: 1, jobs: 1 });
  } finally {
    await cleanup(sql, [org]);
  }
});

test("a repeat of an event stored without its job gets the job, and stores no second event", async () => {
  const sql = await getSql();
  const suffix = randomUUID().slice(0, 8);
  const org = `org-repair-${suffix}`;
  const eventId = `evt-repair-${suffix}`;
  try {
    await seed(sql, org);
    await sql`insert into webhook_events (id, organization_id, provider, event_id) values (${randomUUID()}, ${org}, 'meta', ${eventId})`;
    assert.deepEqual(await counts(sql, org, eventId), { events: 1, jobs: 0 });
    assert.equal(await recordWebhookDelivery(sql, { organizationId: org, provider: "meta", eventId }), false);
    assert.deepEqual(await counts(sql, org, eventId), { events: 1, jobs: 1 });
  } finally {
    await cleanup(sql, [org]);
  }
});

test("the same event recorded for two organizations is stored and queued once for each", async () => {
  const sql = await getSql();
  const suffix = randomUUID().slice(0, 8);
  const orgA = `org-both-a-${suffix}`;
  const orgB = `org-both-b-${suffix}`;
  const eventId = `evt-both-${suffix}`;
  try {
    await seed(sql, orgA);
    await seed(sql, orgB);
    assert.equal(await recordWebhookDelivery(sql, { organizationId: orgA, provider: "meta", eventId }), true);
    assert.equal(await recordWebhookDelivery(sql, { organizationId: orgB, provider: "meta", eventId }), true);
    assert.deepEqual(await counts(sql, orgA, eventId), { events: 1, jobs: 1 });
    assert.deepEqual(await counts(sql, orgB, eventId), { events: 1, jobs: 1 });
  } finally {
    await cleanup(sql, [orgA, orgB]);
  }
});
