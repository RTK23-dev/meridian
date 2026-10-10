import type { QueryClient } from "@tanstack/react-query";
import {
  accountsQueryOptions,
  alertsQueryOptions,
  assetsQueryOptions,
  brandQueryOptions,
  calibrationQueryOptions,
  factoryQueryOptions,
  integrationsQueryOptions,
  intelligenceQueryOptions,
  jobsQueryOptions,
  learningQueryOptions,
  libraryQueryOptions,
  machineQueryOptions,
  marketQueryOptions,
  notificationsQueryOptions,
  opportunitiesQueryOptions,
  providerSettingsQueryOptions,
  reviewsQueryOptions,
  studioQueryOptions,
  telemetryQueryOptions,
  usageQueryOptions,
} from "./hooks";

export type PrefetchScope = {
  userId: string | null | undefined;
  organizationId: string | null | undefined;
};

/** Each warmer prefetches one query the target screen reads. */
type Warmer = (queryClient: QueryClient) => Promise<void>;

/**
 * Warms the cache for the screen a link points to, so the click renders from cache. Each entry is built by the same
 * option factory the screen's hook uses. Screens with filter or page state (audit, webhooks) are not warmed.
 */
export function prefetchScreen(queryClient: QueryClient, scope: PrefetchScope, to: string): void {
  for (const warm of screenWarmers(scope, to)) void warm(queryClient);
}

export function screenWarmers({ userId, organizationId }: PrefetchScope, to: string): Warmer[] {
  if (!userId) return [];
  const brand = to.match(/^\/brands\/([^/]+)(?:\/([^/?#]+))?\/?$/);
  if (brand) {
    const brandId = brand[1];
    if (brandId === "new") return [];
    switch (brand[2] ?? "") {
      case "": return [(qc) => qc.prefetchQuery(brandQueryOptions(userId, brandId)), (qc) => qc.prefetchQuery(machineQueryOptions(userId, brandId))];
      case "market": return [(qc) => qc.prefetchQuery(marketQueryOptions(userId, brandId))];
      case "intelligence": return [(qc) => qc.prefetchQuery(intelligenceQueryOptions(userId, brandId))];
      case "opportunities": return [(qc) => qc.prefetchQuery(opportunitiesQueryOptions(userId, brandId))];
      case "reviews": return [(qc) => qc.prefetchQuery(reviewsQueryOptions(userId, brandId))];
      case "studio": return [(qc) => qc.prefetchQuery(studioQueryOptions(userId, brandId))];
      case "library": return [(qc) => qc.prefetchQuery(libraryQueryOptions(userId, brandId))];
      case "learning": return [(qc) => qc.prefetchQuery(learningQueryOptions(userId, brandId)), (qc) => qc.prefetchQuery(telemetryQueryOptions(userId, brandId))];
      case "calibration": return [(qc) => qc.prefetchQuery(calibrationQueryOptions(userId, brandId))];
      case "brain": return [(qc) => qc.prefetchQuery(brandQueryOptions(userId, brandId)), (qc) => qc.prefetchQuery(assetsQueryOptions(userId, brandId))];
      case "products": return [(qc) => qc.prefetchQuery(brandQueryOptions(userId, brandId))];
      case "accounts": return [(qc) => qc.prefetchQuery(accountsQueryOptions(userId, brandId))];
      case "factory": return [(qc) => qc.prefetchQuery(factoryQueryOptions(userId, brandId))];
      default: return [];
    }
  }
  if (!organizationId) return [];
  switch (to) {
    case "/integrations": return [(qc) => qc.prefetchQuery(integrationsQueryOptions(userId, organizationId))];
    case "/jobs": return [(qc) => qc.prefetchQuery(jobsQueryOptions(userId, organizationId))];
    case "/usage": return [(qc) => qc.prefetchQuery(usageQueryOptions(userId, organizationId))];
    case "/alerts": return [(qc) => qc.prefetchQuery(alertsQueryOptions(userId, organizationId))];
    case "/notifications": return [(qc) => qc.prefetchQuery(notificationsQueryOptions(userId, organizationId))];
    case "/settings": return [(qc) => qc.prefetchQuery(providerSettingsQueryOptions(userId, organizationId)), (qc) => qc.prefetchQuery(alertsQueryOptions(userId, organizationId))];
    default: return [];
  }
}
