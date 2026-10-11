import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  signWebhookDelivery,
  verifyDeliverySignature,
  verifyWebhook,
  webhookCanonicalString,
  type WebhookDecision,
  type WebhookSigningFields,
} from "./verify.ts";

const SECRET = "test-secret";
const NOW = 1_700_000_000_000;
const FIELDS: WebhookSigningFields = {
  provider: "meta",
  account: "acct-1",
  eventId: "evt-1",
  timestamp: String(NOW),
  rawBody: JSON.stringify({ type: "ad.updated" }),
};

function signed(fields: WebhookSigningFields = FIELDS, secret = SECRET): string {
  return signWebhookDelivery({ secret, ...fields });
}

/** The database-free check, given the fields the receiver actually received and the signature it was sent with. */
function verifySent(sent: WebhookSigningFields, signature: string, secret = SECRET): WebhookDecision {
  return verifyDeliverySignature({ secret, ...sent, signature, nowMs: NOW });
}

function reason(decision: WebhookDecision): string {
  return decision.status === "rejected" ? decision.reason : decision.status;
}

test("the canonical string is exactly the documented v2 form, with the body hashed", () => {
  const bodyHash = createHash("sha256").update(FIELDS.rawBody, "utf8").digest("hex");
  assert.equal(webhookCanonicalString(FIELDS), `v2\nmeta\nacct-1\nevt-1\n${NOW}\n${bodyHash}`);
});

test("the signature is lowercase hex HMAC-SHA256 of the canonical string, keyed with the secret", () => {
  const expected = createHmac("sha256", SECRET).update(webhookCanonicalString(FIELDS), "utf8").digest("hex");
  assert.equal(signed(), expected);
  assert.match(signed(), /^[0-9a-f]{64}$/);
});

test("a valid v2 delivery is accepted, and the verifier with its database checks passing accepts it too", () => {
  assert.deepEqual(verifySent(FIELDS, signed()), { status: "accepted", eventId: "evt-1" });
  assert.deepEqual(
    verifyWebhook({ secret: SECRET, ...FIELDS, signature: signed(), nowMs: NOW, seenEventIds: [], accountKnown: true }),
    { status: "accepted", eventId: "evt-1" },
  );
});

test("changing the provider, the account or the event id while keeping the signature is refused", () => {
  const signature = signed();
  const changes: Array<{ name: string; sent: WebhookSigningFields }> = [
    { name: "provider", sent: { ...FIELDS, provider: "google" } },
    { name: "account", sent: { ...FIELDS, account: "acct-2" } },
    { name: "event id", sent: { ...FIELDS, eventId: "evt-2" } },
  ];
  for (const { name, sent } of changes) {
    assert.equal(reason(verifySent(sent, signature)), "The webhook signature does not match.", `changing the ${name}`);
  }
});

test("changing the timestamp while keeping the signature is refused", () => {
  const sent = { ...FIELDS, timestamp: String(NOW + 1000) };
  assert.equal(reason(verifySent(sent, signed())), "The webhook signature does not match.");
});

test("an old-format signature, over the timestamp and body only, is refused", () => {
  const oldForm = createHmac("sha256", SECRET).update(`${FIELDS.timestamp}.${FIELDS.rawBody}`).digest("hex");
  assert.equal(reason(verifySent(FIELDS, oldForm)), "The webhook signature does not match.");
});

test("a tampered body is refused", () => {
  const sent = { ...FIELDS, rawBody: JSON.stringify({ type: "ad.updated", amount: 1000 }) };
  assert.equal(reason(verifySent(sent, signed())), "The webhook signature does not match.");
});

test("a signature made with another secret is refused", () => {
  assert.equal(reason(verifySent(FIELDS, signed(FIELDS, "another-secret"))), "The webhook signature does not match.");
});

test("a newline in a routing field is refused as malformed, even when signed over that same value", () => {
  const sent = { ...FIELDS, account: "acct-1\nevt-x" };
  assert.equal(reason(verifySent(sent, signed(sent))), "The webhook headers are malformed.");
});

test("a delivery with no provider or account is refused before the signature is checked", () => {
  assert.equal(reason(verifySent({ ...FIELDS, account: " " }, signed())), "The webhook has no provider or account.");
});

test("once the signature passes, a stored event id and an unknown account are refused in that order", () => {
  const base = { secret: SECRET, ...FIELDS, signature: signed(), nowMs: NOW };
  assert.equal(reason(verifyWebhook({ ...base, seenEventIds: ["evt-1"], accountKnown: true })), "This event id was already stored.");
  assert.equal(
    reason(verifyWebhook({ ...base, seenEventIds: [], accountKnown: false })),
    "The account on the webhook is not connected to a workspace.",
  );
});
