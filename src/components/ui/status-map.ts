export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";
export type StatusKind = "check" | "clock" | "alert" | "activity" | "plug" | "info";

const groups: Record<StatusTone, { labels: string[]; icon: StatusKind }> = {
  success: { labels: ["approved", "connected", "succeeded", "sent", "healthy", "ok", "complete", "completed", "published"], icon: "check" },
  warning: { labels: ["in_review", "in review", "queued", "retry", "retrying", "paused", "proposed", "pending", "waiting"], icon: "clock" },
  danger: { labels: ["failed", "failure", "dead", "rejected", "unhealthy", "error", "blocked"], icon: "alert" },
  info: { labels: ["running", "processing", "active"], icon: "activity" },
  neutral: { labels: ["not_connected", "not connected", "disconnected"], icon: "plug" },
};

export function statusPresentation(status: string): { variant: StatusTone; icon: StatusKind; label: string } {
  const normalized = status.trim().toLowerCase().replaceAll("-", "_");
  for (const [variant, group] of Object.entries(groups) as Array<[StatusTone, typeof groups[StatusTone]]>) {
    if (group.labels.includes(normalized)) return { variant, icon: group.icon, label: statusLabel(status) };
  }
  return { variant: "neutral", icon: "info", label: statusLabel(status) };
}
import { statusLabel } from "../../lib/copy.ts";
