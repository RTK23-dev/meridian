/**
 * Pure rules for the alerts center. The server decides severity and delivery; this file only words them. Delivery is
 * reported only after the webhook endpoint accepts an event, so a saved target is never described as delivered.
 */
import { statusLabel } from "@/lib/copy";

export type AlertFilter = "open" | "acknowledged" | "all";
export const ALERT_FILTER_OPTIONS: ReadonlyArray<{ value: AlertFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "all", label: "All" },
];

export type AlertRow = {
  id: string;
  code: string;
  severity: string;
  detail: string;
  firstSeen: string;
  lastSeen: string;
  acknowledged: boolean;
  deliveryStatus: string;
};

export type SeverityCopy = { label: string; tone: "danger" | "warning" | "neutral"; icon: "critical" | "warning" | "unknown" };

/** Critical and warning are words and icons, so the severity is not carried by colour alone. */
export function severityCopy(severity: string): SeverityCopy {
  if (severity === "critical") return { label: "Critical", tone: "danger", icon: "critical" };
  if (severity === "warning") return { label: "Warning", tone: "warning", icon: "warning" };
  return { label: severity ? statusLabel(severity) : "Unknown severity", tone: "neutral", icon: "unknown" };
}

export function filterAlerts<T extends { acknowledged: boolean }>(alerts: readonly T[], filter: AlertFilter): T[] {
  if (filter === "open") return alerts.filter((alert) => !alert.acknowledged);
  if (filter === "acknowledged") return alerts.filter((alert) => alert.acknowledged);
  return [...alerts];
}

/** A stored time in this browser's time zone. The server text is shown as it is when it cannot be read as a time. */
export function readableTime(value: string): string {
  if (!value) return "Unknown";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

export function deliveryCopy(status: string): string {
  const key = status.trim().toLowerCase();
  if (key === "not_configured") return "Not delivered. No webhook target is saved.";
  if (key === "pending") return "Waiting for the worker to send it to the saved target.";
  if (key === "sent") return "Delivered. The webhook endpoint accepted it.";
  if (key === "dead") return "Not delivered. Sending stopped after repeated failures.";
  return status ? `Delivery status: ${statusLabel(status)}.` : "Delivery status is not recorded.";
}

/** The server reports the target as "webhook configured" or "not configured". Anything else is treated as not connected. */
export function targetCopy(target: string): { connected: boolean; text: string } {
  if (target === "webhook configured") {
    return { connected: true, text: "A webhook target is saved. An alert counts as delivered only after the endpoint accepts it." };
  }
  return { connected: false, text: "Not connected. No webhook target is saved, so alerts stay in this list only." };
}

/** Count of open alerts in the list. The list holds at most 40 rows, so the count can be a floor. */
export function openAlertSummary(alerts: readonly { acknowledged: boolean }[], listLimit: number): string {
  const open = alerts.filter((alert) => !alert.acknowledged).length;
  const capped = alerts.length >= listLimit;
  return `${open.toLocaleString()} open${capped ? ` (the list shows the newest ${listLimit})` : ""} of ${alerts.length.toLocaleString()} shown.`;
}
