import type { Transport } from "../providers/http.ts";
import { sendWithRetry } from "../providers/http.ts";

export type AlertEvent = {
  id: string;
  organizationId: string;
  code: string;
  severity: "info" | "warning" | "critical";
  detail: string;
  firstSeen: string;
  lastSeen: string;
  acknowledged: boolean;
};

export type DeliveryTarget = { kind: "webhook"; url: string } | { kind: "none" };

export function dedupeAlert(existing: AlertEvent[], incoming: Omit<AlertEvent, "id" | "firstSeen" | "acknowledged"> & { id: string }): AlertEvent[] {
  const prior = existing.find((item) => item.organizationId === incoming.organizationId && item.code === incoming.code && !item.acknowledged);
  if (!prior) {
    return [...existing, { ...incoming, firstSeen: incoming.lastSeen, acknowledged: false }];
  }
  return existing.map((item) => (item.id === prior.id ? { ...item, lastSeen: incoming.lastSeen, detail: incoming.detail } : item));
}

/**
 * The outcome of one webhook request. "sent": the endpoint answered 2xx. "failed": it answered 4xx, so it did not take the alert and a
 * later attempt may try again. "uncertain": no answer arrived (timeout, network error) or the endpoint answered 5xx, so it may have
 * received the alert; nothing is sent again until a person has checked the receiving system.
 */
export type DeliveryOutcome = { status: "sent" | "NOT_CONFIGURED" | "failed" | "uncertain"; error: string };

/**
 * Sends one alert to the webhook, once, with no retry: a POST whose answer is lost may have been received. The request carries an
 * `Idempotency-Key` (`<alert id>:<attempt>`) so a receiver that dedupes can drop a repeat, and the alert id stays in the body.
 */
export async function deliverAlert(
  alert: AlertEvent,
  target: DeliveryTarget,
  transport: Transport,
  options: { idempotencyKey: string },
): Promise<DeliveryOutcome> {
  if (target.kind === "none" || !target.url?.trim()) {
    return { status: "NOT_CONFIGURED", error: "No delivery target is configured. The alert stays in the product." };
  }
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: target.url,
    headers: { "content-type": "application/json", "idempotency-key": options.idempotencyKey },
    body: JSON.stringify({ id: alert.id, code: alert.code, severity: alert.severity, detail: alert.detail }),
  });
  if (result.ok) return { status: "sent", error: "" };
  if (result.status >= 400 && result.status < 500) {
    return { status: "failed", error: result.error || `The webhook answered ${result.status} and did not take the alert.` };
  }
  const reason = result.status === 0 ? result.error || "No answer arrived." : `The webhook answered ${result.status}.`;
  return { status: "uncertain", error: `${reason} The webhook may have received this. Check the receiving system.` };
}
