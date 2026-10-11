/**
 * Optimistic cache updates for the decision actions. Each takes the cached list and returns the list the screen should show
 * while the call is in flight. Only the named row changes. A list that is not in the cache yet stays absent, so an update
 * never invents rows. Pure, so the rules can be tested without React.
 */

export function markReviewResolved<T extends { reviews: ReadonlyArray<{ id: string; status: string }> }>(
  data: T | undefined,
  reviewId: string,
  action: "approve" | "reject",
): T | undefined {
  if (!data) return data;
  const status = action === "approve" ? "approved" : "rejected";
  return {
    ...data,
    reviews: data.reviews.map((item) => (item.id === reviewId ? { ...item, status } : item)),
  };
}

export function markOpportunitiesDismissed<T extends { opportunities: ReadonlyArray<{ id: string; status: string }> }>(
  data: T | undefined,
  opportunityIds: readonly string[],
): T | undefined {
  if (!data) return data;
  const ids = new Set(opportunityIds);
  return {
    ...data,
    opportunities: data.opportunities.map((item) => (ids.has(item.id) ? { ...item, status: "dismissed" } : item)),
  };
}

export function markAlertAcknowledged<T extends { alerts: ReadonlyArray<{ id: string; acknowledged: boolean }> }>(
  data: T | undefined,
  alertId: string,
): T | undefined {
  if (!data) return data;
  return {
    ...data,
    alerts: data.alerts.map((alert) => (alert.id === alertId ? { ...alert, acknowledged: true } : alert)),
  };
}
