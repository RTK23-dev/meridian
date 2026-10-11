import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import {
  activeWebhookOrganizations,
  findStoredWebhookEventIds,
  storeWebhookEvent,
} from "./receive-store.ts";

// Runs against the migrated database the test process uses (embedded, or DATABASE_URL when it is set).

test("migration 0060 leaves one unique rule on webhook_events, scoped to the organization", async () => {
  const sql = await getSql();
  const rules = await sql<{ definition: string }>`
    select pg_get_constraintdef(c.oid) as definition
    from pg_constraint c
    where c.conrelid = 'webhook_events'::regclass and c.contype = 'u'
  `;
  assert.deepEqual(rules.map((rule) => rule.definition), ["UNIQUE (organization_id, provider, event_id)"]);
});

test("the same provider event id is stored once per organization, and a tenant's copy does not hide another's", async () => {
  const sql = await getSql();
  const suffix = randomUUID().slice(0, 8);
  const orgA = `org-scope-a-${suffix}`;
  const orgB = `org-scope-b-${suffix}`;
  const eventId = `evt-${suffix}`;
  try {
    for (const org of [orgA, orgB]) {
      await sql`insert into organizations (id, name, slug, created_by) values (${org}, ${org}, ${org}, 'test-user')`;
    }
    assert.equal(await storeWebhookEvent(sql, { organizationId: orgA, provider: "meta", eventId }), true);
    assert.equal(await storeWebhookEvent(sql, { organizationId: orgB, provider: "meta", eventId }), true);
    assert.equal(await storeWebhookEvent(sql, { organizationId: orgA, provider: "meta", eventId }), false);
    assert.deepEqual(await findStoredWebhookEventIds(sql, { organizationId: orgB, provider: "meta", eventId }), [eventId]);
    assert.deepEqual(await findStoredWebhookEventIds(sql, { organizationId: orgA, provider: "google", eventId }), []);
  } finally {
    await sql`delete from webhook_events where organization_id in (${orgA}, ${orgB})`;
    await sql`delete from organizations where id in (${orgA}, ${orgB})`;
  }
});

test("an account resolves to the organizations with an active connection, not disconnected ones", async () => {
  const sql = await getSql();
  const suffix = randomUUID().slice(0, 8);
  const active = `org-route-active-${suffix}`;
  const gone = `org-route-gone-${suffix}`;
  const account = `acct-${suffix}`;
  try {
    for (const org of [active, gone]) {
      await sql`insert into organizations (id, name, slug, created_by) values (${org}, ${org}, ${org}, 'test-user')`;
    }
    await sql`
      insert into provider_connections (id, organization_id, provider, status, account_id, disconnected_at)
      values (${`pc-${suffix}-a`}, ${active}, 'meta', 'CONNECTED', ${account}, null),
             (${`pc-${suffix}-g`}, ${gone}, 'meta', 'DISCONNECTED', ${account}, now())
    `;
    assert.deepEqual(await activeWebhookOrganizations(sql, { provider: "meta", accountId: account }), [active]);
    assert.deepEqual(await activeWebhookOrganizations(sql, { provider: "meta", accountId: `${account}-none` }), []);
  } finally {
    await sql`delete from provider_connections where organization_id in (${active}, ${gone})`;
    await sql`delete from organizations where id in (${active}, ${gone})`;
  }
});
