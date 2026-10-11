import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { handleWebhookReceive, type WebhookReceiveDeps } from "./receive-handler.ts";
import { signWebhookBody } from "./verify.ts";

const SECRET = "test-webhook-secret";
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const URL = "https://meridian.test/api/webhooks/receive";

type Connection = { provider: string; accountId: string; organizationId: string; disconnected?: boolean };
type StoredEvent = { organizationId: string; provider: string; eventId: string };
type QueuedJob = { organizationId: string; idempotencyKey: string };

/**
 * An in-memory stand-in for the three statements the receiver runs. The unique rule on webhook_events is the
 * organization-scoped one from migration 0060, so a second organization can store the same provider event id.
 */
function fakeWebhookDb(connections: Connection[]) {
  const events: StoredEvent[] = [];
  const jobs: QueuedJob[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").toLowerCase();
    if (text.includes("from provider_connections")) {
      const [provider, accountId] = values as string[];
      const organizationIds = connections
        .filter((row) => !row.disconnected && row.provider === provider && row.accountId === accountId)
        .map((row) => row.organizationId);
      return [...new Set(organizationIds)].slice(0, 2).map((organization_id) => ({ organization_id }));
    }
    if (text.includes("from webhook_events")) {
      const [organizationId, provider, eventId] = values as string[];
      const seen = events.some((row) => row.organizationId === organizationId && row.provider === provider && row.eventId === eventId);
      return seen ? [{ event_id: eventId }] : [];
    }
    if (text.includes("insert into webhook_events")) {
      assert.match(text, /on conflict \(organization_id, provider, event_id\) do nothing/);
      const [, organizationId, provider, eventId] = values as string[];
      if (events.some((row) => row.organizationId === organizationId && row.provider === provider && row.eventId === eventId)) return [];
      events.push({ organizationId, provider, eventId });
      return [{ id: "event-row" }];
    }
    if (text.includes("insert into jobs")) {
      const [, organizationId, idempotencyKey] = values as string[];
      jobs.push({ organizationId, idempotencyKey });
      return [];
    }
    throw new Error(`The fake database does not answer this statement: ${text}`);
  }) as unknown as Sql;
  return { sql, events, jobs };
}

function delivery(input: { account?: string; eventId?: string; signedWith?: string; body?: object } = {}): Request {
  const rawBody = JSON.stringify(input.body ?? { type: "ad.updated" });
  const timestamp = String(NOW);
  return new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-meridian-provider": "meta",
      "x-meridian-account": input.account ?? "acct-1",
      "x-meridian-event": input.eventId ?? "evt-1",
      "x-meridian-timestamp": timestamp,
      "x-meridian-signature": signWebhookBody(input.signedWith ?? SECRET, timestamp, rawBody),
    },
    body: rawBody,
  });
}

function depsFor(db: { sql: Sql }): WebhookReceiveDeps {
  return { sql: async () => db.sql, secret: SECRET, nowMs: NOW };
}

test("an account connected to two organizations is refused with 409, nothing is stored, and the log says why", async (t) => {
  const db = fakeWebhookDb([
    { provider: "meta", accountId: "acct-1", organizationId: "org-a" },
    { provider: "meta", accountId: "acct-1", organizationId: "org-b" },
  ]);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  const response = await handleWebhookReceive(delivery(), depsFor(db));
  assert.equal(response.status, 409);
  assert.deepEqual(db.events, []);
  assert.deepEqual(db.jobs, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /account acct-1: the account is connected to more than one organization/);
});

test("an unsigned delivery to an account connected to two organizations is 401, so the 409 does not reveal the connection", async (t) => {
  const db = fakeWebhookDb([
    { provider: "meta", accountId: "acct-1", organizationId: "org-a" },
    { provider: "meta", accountId: "acct-1", organizationId: "org-b" },
  ]);
  t.mock.method(console, "warn", () => {});
  const response = await handleWebhookReceive(delivery({ signedWith: "not-the-secret" }), depsFor(db));
  assert.equal(response.status, 401);
  assert.equal(await response.text(), "The webhook signature does not match.");
  assert.deepEqual(db.events, []);
});

test("an account connected to one organization stores the event for that organization and queues it there", async () => {
  // A disconnected connection in another organization does not count as a second destination.
  const db = fakeWebhookDb([
    { provider: "meta", accountId: "acct-1", organizationId: "org-a" },
    { provider: "meta", accountId: "acct-1", organizationId: "org-b", disconnected: true },
  ]);
  const response = await handleWebhookReceive(delivery(), depsFor(db));
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "queued");
  assert.deepEqual(db.events, [{ organizationId: "org-a", provider: "meta", eventId: "evt-1" }]);
  assert.deepEqual(db.jobs.map((job) => job.organizationId), ["org-a"]);
});

test("the same provider event id delivered to two organizations is stored once per organization", async () => {
  const db = fakeWebhookDb([
    { provider: "meta", accountId: "acct-a", organizationId: "org-a" },
    { provider: "meta", accountId: "acct-b", organizationId: "org-b" },
  ]);
  const first = await handleWebhookReceive(delivery({ account: "acct-a", eventId: "evt-shared" }), depsFor(db));
  const second = await handleWebhookReceive(delivery({ account: "acct-b", eventId: "evt-shared" }), depsFor(db));
  assert.equal(first.status, 202);
  assert.equal(second.status, 202, "org-b's copy of the event is not blocked by org-a's");
  assert.deepEqual(db.events.map((row) => row.organizationId), ["org-a", "org-b"]);

  // A redelivery to the same organization is still a duplicate.
  const again = await handleWebhookReceive(delivery({ account: "acct-a", eventId: "evt-shared" }), depsFor(db));
  assert.equal(again.status, 401);
  assert.equal(await again.text(), "This event id was already stored.");
  assert.equal(db.events.length, 2);
});

test("an account with no active connection is still 401 and stores nothing", async () => {
  const db = fakeWebhookDb([{ provider: "meta", accountId: "acct-1", organizationId: "org-a", disconnected: true }]);
  const response = await handleWebhookReceive(delivery({ account: "acct-unknown" }), depsFor(db));
  assert.equal(response.status, 401);
  assert.equal(await response.text(), "The account on the webhook is not connected to a workspace.");
  assert.deepEqual(db.events, []);
  assert.deepEqual(db.jobs, []);
});
