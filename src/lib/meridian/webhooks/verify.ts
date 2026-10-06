import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookDecision =
  | { status: "accepted"; eventId: string }
  | { status: "rejected"; reason: string };

export function signWebhookBody(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyWebhook(input: {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  eventId: string;
  nowMs: number;
  seenEventIds: string[];
  accountKnown: boolean;
}): WebhookDecision {
  if (!input.secret.trim()) return { status: "rejected", reason: "No webhook secret is configured." };
  if (!input.rawBody.trim()) return { status: "rejected", reason: "The payload was empty." };
  const stamped = Number(input.timestamp);
  if (!Number.isFinite(stamped) || Math.abs(input.nowMs - stamped) > 5 * 60 * 1000) {
    return { status: "rejected", reason: "The webhook timestamp is outside the replay window." };
  }
  const expected = Buffer.from(signWebhookBody(input.secret, input.timestamp, input.rawBody));
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
  if (input.seenEventIds.includes(input.eventId)) return { status: "rejected", reason: "This event id was already stored." };
  if (!input.accountKnown) return { status: "rejected", reason: "The account on the webhook is not connected to a workspace." };
  return { status: "accepted", eventId: input.eventId };
}
