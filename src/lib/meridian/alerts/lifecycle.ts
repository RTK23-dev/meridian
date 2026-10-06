import type { AlertEvent, DeliveryTarget } from "./deliver.ts";

export const MAX_DELIVERY_ATTEMPTS = 3;

export function alertSeverity(code: string): AlertEvent["severity"] {
  if (code.endsWith(".stopped") || code === "storage.failed" || code === "dead_letter.growth") return "critical";
  return "warning";
}

export function acknowledgeAlert(alert: AlertEvent): AlertEvent {
  return { ...alert, acknowledged: true };
}

export function deliveryUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === "https:") return true;
    if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

/** Send, wait, or dead-letter. A missing target is not a delivered page. */
export function deliveryPlan(
  attempts: { status: string }[],
  target: DeliveryTarget,
): { action: "send" | "dead" | "skip"; status: "pending" | "dead" | "NOT_CONFIGURED" | "sent" } {
  if (attempts.some((item) => item.status === "sent")) return { action: "skip", status: "sent" };
  if (target.kind === "none" || !("url" in target) || !target.url?.trim()) return { action: "skip", status: "NOT_CONFIGURED" };
  if (!deliveryUrlAllowed(target.url)) return { action: "dead", status: "dead" };
  const failed = attempts.filter((item) => item.status === "failed").length;
  if (failed >= MAX_DELIVERY_ATTEMPTS) return { action: "dead", status: "dead" };
  return { action: "send", status: "pending" };
}
