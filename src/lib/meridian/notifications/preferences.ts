export const NOTIFICATION_KINDS = ["learning.update", "performance.recorded", "review.required", "integration.unavailable"] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

export function resolveNotificationPreferences(saved: ReadonlyMap<string, boolean>) {
  return NOTIFICATION_KINDS.map((kind) => ({ kind, enabled: saved.get(kind) ?? true }));
}
