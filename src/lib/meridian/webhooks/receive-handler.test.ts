import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "../learning/store.ts";
import { handleWebhookReceive, WEBHOOK_BODY_LIMIT_BYTES, type WebhookReceiveDeps } from "./receive-handler.ts";
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
  return { sql, events, jobs, opens: 0 };
}

function delivery(
  input: { account?: string; eventId?: string; signedWith?: string; body?: object; rawBody?: string; contentType?: string | null } = {},
): Request {
  const rawBody = input.rawBody ?? JSON.stringify(input.body ?? { type: "ad.updated" });
  const timestamp = String(NOW);
  const headers: Record<string, string> = {
    "x-meridian-provider": "meta",
    "x-meridian-account": input.account ?? "acct-1",
    "x-meridian-event": input.eventId ?? "evt-1",
    "x-meridian-timestamp": timestamp,
    "x-meridian-signature": signWebhookBody(input.signedWith ?? SECRET, timestamp, rawBody),
  };
  if (input.contentType !== null) headers["content-type"] = input.contentType ?? "application/json";
  // Bytes, not a string: Node would add a text/plain content type to a string body.
  return new Request(URL, { method: "POST", headers, body: new TextEncoder().encode(rawBody) });
}

/** Counts how often the handler opens the database, so a refused request can be shown not to have reached it. */
function depsFor(db: { sql: Sql; opens: number }): WebhookReceiveDeps {
  return {
    sql: async () => {
      db.opens += 1;
      return db.sql;
    },
    secret: SECRET,
    nowMs: NOW,
  };
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
  assert.equal(await response.text(), "recorded");
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

const ONE_ORG = [{ provider: "meta", accountId: "acct-1", organizationId: "org-a" }];

test("a declared body over 256 KB is refused with 413 before the body is read or the database is opened", async () => {
  const db = fakeWebhookDb(ONE_ORG);
  const request = new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(WEBHOOK_BODY_LIMIT_BYTES + 1) },
    body: "{}",
  });
  const response = await handleWebhookReceive(request, depsFor(db));
  assert.equal(response.status, 413);
  assert.equal(request.bodyUsed, false, "the body was never read");
  assert.equal(db.opens, 0);
  assert.deepEqual(db.events, []);
});

test("a body with no Content-Length is cut off at 256 KB while it streams, and refused with 413", async () => {
  const db = fakeWebhookDb(ONE_ORG);
  let pulls = 0;
  let cancelled = false;
  // A body of up to 1,000 chunks of 64 KB each: the 256 KB cap is passed on the fifth chunk.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls > 1000) controller.close();
      else controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  const response = await handleWebhookReceive(request, depsFor(db));
  assert.equal(response.status, 413);
  assert.equal(cancelled, true, "the rest of the body was not read");
  assert.ok(pulls < 10, `read ${pulls} of 1000 chunks before refusing`);
  assert.equal(db.opens, 0);
});

test("a body of exactly 256 KB with a valid signature is accepted and stored", async () => {
  const db = fakeWebhookDb(ONE_ORG);
  const prefix = '{"pad":"';
  const suffix = '"}';
  const rawBody = prefix + "x".repeat(WEBHOOK_BODY_LIMIT_BYTES - prefix.length - suffix.length) + suffix;
  assert.equal(new TextEncoder().encode(rawBody).byteLength, WEBHOOK_BODY_LIMIT_BYTES);
  const response = await handleWebhookReceive(delivery({ rawBody }), depsFor(db));
  assert.equal(response.status, 202);
  assert.deepEqual(db.events.map((row) => row.organizationId), ["org-a"]);
});

test("a Content-Length that is not a number is refused with 400 before the body is read", async () => {
  const db = fakeWebhookDb(ONE_ORG);
  const request = new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "12abc" },
    body: "{}",
  });
  const response = await handleWebhookReceive(request, depsFor(db));
  assert.equal(response.status, 400);
  assert.equal(request.bodyUsed, false);
  assert.equal(db.opens, 0);
});

test("a body that is not application/json is refused with 415 before anything is read", async () => {
  const db = fakeWebhookDb(ONE_ORG);
  for (const contentType of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded", null]) {
    const request = delivery({ contentType });
    const response = await handleWebhookReceive(request, depsFor(db));
    assert.equal(response.status, 415, `content-type ${contentType ?? "(missing)"}`);
    assert.equal(request.bodyUsed, false, `content-type ${contentType ?? "(missing)"}: the body was never read`);
  }
  assert.equal(db.opens, 0);
  assert.deepEqual(db.events, []);
});

test("application/json with a charset parameter is accepted", async () => {
  const db = fakeWebhookDb(ONE_ORG);
  const response = await handleWebhookReceive(delivery({ contentType: "application/json; charset=utf-8" }), depsFor(db));
  assert.equal(response.status, 202);
});
