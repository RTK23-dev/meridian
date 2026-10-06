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

export async function deliverAlert(
  alert: AlertEvent,
  target: DeliveryTarget,
  transport: Transport,
): Promise<{ status: "sent" | "NOT_CONFIGURED" | "failed"; error: string }> {
  if (target.kind === "none" || !target.url?.trim()) {
    return { status: "NOT_CONFIGURED", error: "No delivery target is configured. The alert stays in the product." };
  }
  const result = await sendWithRetry(transport, {
    method: "POST",
    url: target.url,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: alert.id, code: alert.code, severity: alert.severity, detail: alert.detail }),
  });
  if (!result.ok) return { status: "failed", error: result.error || "The delivery target did not accept the alert." };
  return { status: "sent", error: "" };
}
