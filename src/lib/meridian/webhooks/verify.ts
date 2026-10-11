import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type WebhookDecision =
  | { status: "accepted"; eventId: string }
  | { status: "rejected"; reason: string };

/** The fields a v2 signature binds. Each one is part of the canonical string, so changing any of them breaks the signature. */
export interface WebhookSigningFields {
  provider: string;
  account: string;
  eventId: string;
  /** Unix time in milliseconds, as sent in x-meridian-timestamp. */
  timestamp: string;
  /** The raw request body, as the UTF-8 bytes the sender transmits. */
  rawBody: string;
}

/**
 * The canonical string a v2 signature covers. Six lines, joined with LF and no trailing newline:
 *
 *   v2
 *   <provider>
 *   <account>
 *   <eventId>
 *   <timestamp>
 *   <lowercase hex SHA-256 of the raw body>
 *
 * Binding the routing headers means a delivery cannot be re-addressed to another account or provider while its
 * signature is kept. The body is hashed, so the signature does not depend on how a proxy reflows the body.
 */
export function webhookCanonicalString(input: WebhookSigningFields): string {
  const bodyHash = createHash("sha256").update(input.rawBody, "utf8").digest("hex");
  return ["v2", input.provider, input.account, input.eventId, input.timestamp, bodyHash].join("\n");
}

/**
 * Signs one delivery: lowercase hex HMAC-SHA256 of the canonical string, keyed with the webhook secret. Senders and the
 * verifier both use this function, so the format cannot drift between them.
 */
export function signWebhookDelivery(input: WebhookSigningFields & { secret: string }): string {
  return createHmac("sha256", input.secret).update(webhookCanonicalString(input), "utf8").digest("hex");
}

/**
 * The checks that need no database: the secret, the body, the routing headers, the replay window, the v2 signature over
 * the canonical string, the JSON and the event id. The receiver runs these before it opens the database, so a refused
 * delivery never reaches it. A signature made in the old form (over the timestamp and body only) does not verify.
 */
export function verifyDeliverySignature(input: WebhookSigningFields & {
  secret: string;
  signature: string;
  eventId: string;
  nowMs: number;
}): WebhookDecision {
  if (!input.secret.trim()) return { status: "rejected", reason: "No webhook secret is configured." };
  if (!input.rawBody.trim()) return { status: "rejected", reason: "The payload was empty." };
  if (!input.provider.trim() || !input.account.trim()) {
    return { status: "rejected", reason: "The webhook has no provider or account." };
  }
  // A newline inside a field would let two different field sets produce the same canonical string.
  if (/[\r\n]/.test(input.provider + input.account + input.eventId + input.timestamp)) {
    return { status: "rejected", reason: "The webhook headers are malformed." };
  }
  const stamped = Number(input.timestamp);
  if (!Number.isFinite(stamped) || Math.abs(input.nowMs - stamped) > 5 * 60 * 1000) {
    return { status: "rejected", reason: "The webhook timestamp is outside the replay window." };
  }
  const expected = Buffer.from(signWebhookDelivery(input));
  const presented = Buffer.from(input.signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return { status: "rejected", reason: "The webhook signature does not match." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return { status: "rejected", reason: "The payload is not JSON." };
  }
  if (!parsed || typeof parsed !== "object") return { status: "rejected", reason: "The payload is not an object." };
  if (!input.eventId.trim()) return { status: "rejected", reason: "The webhook has no event id." };
  return { status: "accepted", eventId: input.eventId };
}

/**
 * The full decision: the database-free checks, then whether the event id is already stored for the organization and
 * whether the account is connected. The receiver does the two database checks itself, so it can answer them in order.
 */
export function verifyWebhook(input: WebhookSigningFields & {
  secret: string;
  signature: string;
  eventId: string;
  nowMs: number;
  seenEventIds: string[];
  accountKnown: boolean;
}): WebhookDecision {
  const delivery = verifyDeliverySignature(input);
  if (delivery.status === "rejected") return delivery;
  if (input.seenEventIds.includes(input.eventId)) return { status: "rejected", reason: "This event id was already stored." };
  if (!input.accountKnown) return { status: "rejected", reason: "The account on the webhook is not connected to a workspace." };
  return delivery;
}
